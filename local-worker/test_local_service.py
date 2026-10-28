import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import checkpoints
import local_service
import worker

KEY = 'test-local-engine-authorization-key-123456789'


def model(root, name, *, speech=False):
    path = Path(root) / name
    path.mkdir()
    (path / 'config.json').write_text('{}')
    (path / ('weights.npz' if speech else 'model.safetensors')).write_bytes(b'weights')
    if not speech:
        (path / 'tokenizer.json').write_text('{}')
    return path


def configuration(root):
    return {'api_url': 'http://127.0.0.1:4477', 'engine_key': KEY,
            'runtime_dir': str(Path(root) / 'runtime'),
            'speech_model_path': str(model(root, 'speech', speech=True)),
            'insights_model_path': str(model(root, 'insights')), 'poll_seconds': 2}


class LocalClientTests(unittest.TestCase):
    def test_accepts_only_literal_loopback_http_origins(self):
        for origin in ('http://127.0.0.1:4477', 'http://127.0.0.1:4477/', 'http://[::1]:4477'):
            with self.subTest(origin=origin):
                self.assertEqual(local_service.LocalClient(origin, KEY).origin, origin.rstrip('/'))
        for origin in ('https://example.chatgpt.site', 'http://example.com:4477', 'http://localhost:4477',
                       'https://127.0.0.1:4477', 'http://127.0.0.1', 'http://127.0.0.1:0',
                       'http://user:secret@127.0.0.1:4477', 'http://127.0.0.1:4477/api',
                       'http://127.0.0.1:4477?token=x', 'http://127.0.0.1:4477/#x',
                       'http://127.0.0.1.example.com:4477', 'http://127.1:4477'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                local_service.LocalClient(origin, KEY)

    def test_local_authorization_never_uses_sites_transport(self):
        client = local_service.LocalClient('http://127.0.0.1:4477', KEY)
        with patch('requests.Session.request') as request:
            request.return_value.status_code = 200
            request.return_value.content = b'{}'
            request.return_value.json.return_value = {'ok': True}
            self.assertEqual(client.request('POST', '/api/worker/heartbeat', {'engine': 'local'}), {'ok': True})
            headers = request.call_args.kwargs['headers']
            self.assertEqual(headers['Authorization'], 'Bearer ' + KEY)
            self.assertEqual(headers['X-Cliptext-Engine-Key'], KEY)
            self.assertFalse(any(key.lower().startswith('oai-') for key in headers))
            self.assertFalse(request.call_args.kwargs['allow_redirects'])
            self.assertFalse(client.session().trust_env)

    def test_credential_bearing_redirect_and_auth_rejection_are_not_retried(self):
        for status in (302, 401, 403):
            with self.subTest(status=status), patch('requests.Session.request') as request:
                request.return_value.status_code = status
                client = local_service.LocalClient('http://127.0.0.1:4477', KEY)
                with self.assertRaises(worker.SiteError) as error:
                    client.request('POST', '/api/worker/claim', {})
                self.assertEqual(error.exception.status, status)
                self.assertEqual(request.call_count, 1)

    def test_paths_cannot_escape_worker_namespace(self):
        client = local_service.LocalClient('http://127.0.0.1:4477', KEY)
        for path in ('/api/jobs', '//outside.example/path', '/api/worker/../jobs',
                     '/api/worker/claim?x=1', '/api/worker/%2e%2e/jobs', '/api/worker/jobs#x'):
            with self.subTest(path=path), self.assertRaises(ValueError):
                client.request('GET', path, {})

    def test_invalid_authorization_is_rejected_before_transport(self):
        for key in (None, '', 'short', 'x' * 257, KEY + '\r\nInjected: true'):
            with self.subTest(key=key), self.assertRaises(ValueError):
                local_service.LocalClient('http://127.0.0.1:4477', key)

    def test_get_requests_do_not_send_a_fetch_incompatible_body(self):
        client = local_service.LocalClient('http://127.0.0.1:4477', KEY)
        with patch('requests.Session.request') as request:
            request.return_value.status_code = 200
            request.return_value.content = b'{}'
            request.return_value.json.return_value = {}
            client.request('GET', '/api/worker/jobs/test-job', {})
            self.assertNotIn('data', request.call_args.kwargs)


class WorkerBridgeTests(unittest.TestCase):
    def test_private_config_has_no_hosted_fields_or_oversized_input(self):
        for value in ({'site_url': 'https://example.chatgpt.site'}, {'site_bearer': 'secret'}, [],
                      {'supervisor_pid': True}, {'supervisor_pid': 0}, {'supervisor_pid': '123'}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                local_service.read_config(io.StringIO(json.dumps(value)))
        with self.assertRaises(ValueError):
            local_service.read_config(io.StringIO('x' * (local_service.MAX_CONFIG_BYTES + 1)))

    def test_explicit_models_do_not_construct_sites_client_or_use_ambient_cache(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'HF_HOME': '/ambient/cache'}):
            config = configuration(directory)
            with patch('worker.SiteClient', side_effect=AssertionError('No Site client')):
                runner = local_service.create_worker(config)
            self.assertIsInstance(runner.client, local_service.LocalClient)
            self.assertEqual(runner.speech_model_path, Path(config['speech_model_path']).resolve())
            self.assertEqual(os.environ['HF_HOME'], str(Path(config['runtime_dir']).resolve() / 'huggingface'))
            self.assertEqual(os.environ['HF_HUB_OFFLINE'], '1')

    def test_cached_media_uses_explicit_model_without_download_or_source_resolution(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            config = configuration(directory)
            runner = local_service.create_worker(config)
            job = {'id': 'local-fixture', 'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'leaseToken': 'fresh-local-lease'}
            checkpoint = checkpoints.job_directory(runner.root, job['id'])
            media = checkpoint / 'media.mp4'; media.write_bytes(b'fixture')
            checkpoints.atomic_json(checkpoint / 'state.json', {'media': media.name, 'metadata': {'title': 'Fixture'},
                'classification': 'video', 'resolvedUrl': job['url']})
            with patch('worker.prepare_model', side_effect=AssertionError('Models cannot download')), \
                 patch('worker.retrieve_media', side_effect=AssertionError('Media is already local')), \
                 patch('worker.retrieve_image_post', side_effect=AssertionError('Classification is already known')), \
                 patch('worker.audio_from_media', return_value=(media, 2)), \
                 patch('worker.transcribe_file', return_value={'transcript': 'Local speech', 'language': 'en', 'segments': []}) as transcribe, \
                 patch.object(runner, 'update') as update, contextlib.redirect_stdout(io.StringIO()):
                runner.process(job)
            self.assertEqual(transcribe.call_args.args[1], Path(config['speech_model_path']).resolve())
            self.assertEqual(update.call_args.args[1]['transcript'], 'Local speech')

    def test_incomplete_or_relative_models_fail_before_work_starts(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ):
            config = configuration(directory)
            for field in ('speech_model_path', 'insights_model_path'):
                broken = {**config, field: '.'}
                with self.subTest(field=field), self.assertRaises(ValueError):
                    local_service.create_worker(broken)
            (Path(config['insights_model_path']) / 'tokenizer.json').unlink()
            with self.assertRaises(ValueError):
                local_service.create_worker(config)

    def test_supervisor_loss_stops_only_the_registered_engine_children(self):
        with patch('local_service.STOP') as stop, patch('local_service.os.getppid', return_value=1), \
             patch('local_service.stop_worker') as shutdown:
            stop.is_set.return_value = False
            local_service.monitor_supervisor(12345)
            shutdown.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
