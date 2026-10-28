import contextlib
import io
import json
from pathlib import Path
import tempfile
import subprocess
import types
import unittest
from unittest.mock import patch, Mock

import checkpoints
import insights
import ocr
import worker
import local_processes

KEY = 'unit-test-mac-only-engine-key-123456789'
JOB = {'id': 'resume-job', 'url': 'https://www.youtube.com/watch?v=abcdefghijk', 'leaseToken': 'old-lease'}


def runner(root):
    return worker.Worker({'runtime_dir': root, 'site_url': 'https://example.chatgpt.site', 'site_bearer': 'synthetic-site', 'engine_key': KEY})


class CheckpointTests(unittest.TestCase):
    def test_cached_video_resumes_without_resolving_or_classifying_source_again(self):
        with tempfile.TemporaryDirectory() as root:
            job = {**JOB, 'url': 'https://vt.tiktok.com/AbCdEf12/', 'leaseToken': 'fresh-lease'}
            directory = checkpoints.job_directory(Path(root), job['id'])
            media = directory / 'saved.mp4'; media.write_bytes(b'complete-media')
            # Includes an old checkpoint lacking resolvedUrl/classification.
            checkpoints.atomic_json(directory / 'state.json', {'job': JOB, 'media': media.name, 'metadata': {'title': 'Saved title'}})
            value = runner(root); value.model = Path(root) / 'cached-model'
            with patch('image_posts._resolve_tiktok_share', side_effect=AssertionError('Source must not be resolved')) as resolve, patch('worker.retrieve_image_post', side_effect=AssertionError('Source must not be classified')) as classify, patch('worker.retrieve_media', side_effect=AssertionError('Source must not be downloaded')) as retrieve, patch.object(value, 'identify', side_effect=AssertionError('Already identified')), patch('worker.audio_from_media', return_value=(media, 5)), patch('worker.transcribe_file', return_value={'transcript': 'Recovered speech', 'segments': [], 'language': 'en'}), patch.object(value, 'update') as update, contextlib.redirect_stdout(io.StringIO()):
                value.process(job)
            resolve.assert_not_called(); classify.assert_not_called(); retrieve.assert_not_called()
            self.assertEqual(update.call_args_list[0].args[0]['leaseToken'], 'fresh-lease')
            self.assertEqual(update.call_args_list[0].args[1]['status'], 'downloading')
            self.assertEqual(update.call_args.args[1]['transcript'], 'Recovered speech')
            self.assertEqual(checkpoints.read_json(directory / 'state.json')['classification'], 'video')

    def test_cached_carousel_resumes_without_resolving_or_extracting_source_again(self):
        with tempfile.TemporaryDirectory() as root:
            job = {**JOB, 'url': 'https://vt.tiktok.com/AbCdEf12/', 'leaseToken': 'fresh-lease'}
            directory = checkpoints.job_directory(Path(root), job['id'])
            paths = [directory / 'first.jpg', directory / 'second.jpg']
            for path in paths: path.write_bytes(b'complete-image')
            post = {'paths': [path.name for path in paths], 'metadata': {'title': 'Saved carousel'}, 'contentKind': 'carousel'}
            checkpoints.atomic_json(directory / 'state.json', {'job': JOB, 'post': post})
            value = runner(root)
            pages = [{'index': 1, 'text': 'First'}, {'index': 2, 'text': 'Second'}]
            with patch('image_posts._resolve_tiktok_share', side_effect=AssertionError('Source must not be resolved')) as resolve, patch('worker.retrieve_image_post', side_effect=AssertionError('Source must not be extracted')) as retrieve, patch.object(value, 'identify', side_effect=AssertionError('Already identified')), patch('worker.recognize_image_post', return_value=(pages, 'Apple Vision')), patch('worker.encode_slide', side_effect=lambda path, *_: path), patch.object(value.client, 'upload_slide') as upload, patch.object(value, 'update') as update, contextlib.redirect_stdout(io.StringIO()):
                value.process(job)
            resolve.assert_not_called(); retrieve.assert_not_called()
            self.assertEqual(update.call_args_list[0].args[0]['leaseToken'], 'fresh-lease')
            self.assertEqual(update.call_args.args[1]['pages'], pages)
            self.assertEqual(upload.call_count, 2)

    def test_truncated_slide_cache_is_reencoded_and_replaced_only_after_validation(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); image = root / 'original.jpg'; image.write_bytes(b'original')
            destination = root / 'viewer-01.jpg'; destination.write_bytes(b'\xff\xd8\xfftruncated')
            complete = b'\xff\xd8\xffcomplete\xff\xd9'
            encoded_paths = []
            def run(command, **_):
                if command[0] == 'ffmpeg':
                    encoded = Path(command[-1]); encoded_paths.append(encoded)
                    self.assertNotEqual(encoded, destination)
                    self.assertFalse(destination.exists())
                    encoded.write_bytes(complete)
                    return subprocess.CompletedProcess(command, 0)
                return subprocess.CompletedProcess(command, 0, stdout=json.dumps({'streams': [{'codec_name': 'mjpeg', 'width': 1000, 'height': 1500}]}))
            with patch('worker.ffmpeg_executable', side_effect=lambda name: name), patch('worker.subprocess.run', side_effect=run):
                self.assertEqual(worker.encode_slide(image, root, 1), destination)
            self.assertEqual(destination.read_bytes(), complete)
            self.assertEqual(len(encoded_paths), 1)
            self.assertFalse(encoded_paths[0].exists())

    def test_interrupted_slide_encode_does_not_leave_a_reusable_partial_cache(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); image = root / 'original.jpg'; image.write_bytes(b'original')
            def interrupted(command, **_):
                Path(command[-1]).write_bytes(b'\xff\xd8\xffpartial')
                raise subprocess.TimeoutExpired(command, 15)
            with patch('worker.ffmpeg_executable', side_effect=lambda name: name), patch('worker.subprocess.run', side_effect=interrupted):
                with self.assertRaises(subprocess.TimeoutExpired): worker.encode_slide(image, root, 1)
            self.assertFalse((root / 'viewer-01.jpg').exists())
            self.assertEqual(list(root.glob('.viewer-*')), [])

    def test_slide_cache_validation_rejects_oversized_dimensions(self):
        with tempfile.TemporaryDirectory() as root:
            image = Path(root) / 'image.jpg'; image.write_bytes(b'\xff\xd8\xffvalid-markers\xff\xd9')
            response = subprocess.CompletedProcess([], 0, stdout=json.dumps({'streams': [{'codec_name': 'mjpeg', 'width': 1601, 'height': 1500}]}))
            with patch('worker.subprocess.run', return_value=response):
                self.assertFalse(worker.valid_slide(image))

    def test_shutdown_targets_only_registered_dedicated_groups(self):
        with patch.object(local_processes, '_children', set()), patch('local_processes.subprocess.Popen') as constructor, patch('local_processes.os.killpg') as kill:
            child = constructor.return_value
            child.pid = 12345; child.poll.return_value = None
            local_processes.start(['synthetic-helper'], start_new_session=True)
            local_processes.stop_all()
            kill.assert_called_once_with(12345, local_processes.signal.SIGKILL)
            with self.assertRaises(ValueError): local_processes.start(['synthetic-helper'])

    def test_atomic_checkpoint_unicode_roundtrip_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'nested' / 'state.json'
            checkpoints.atomic_json(path, {'text': '日本語🧊'})
            self.assertEqual(checkpoints.read_json(path), {'text': '日本語🧊'})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(list(path.parent.glob('.checkpoint-*')), [])

    def test_job_path_and_local_file_cannot_escape_or_follow_symlinks(self):
        with tempfile.TemporaryDirectory() as root:
            for value in ['../outside', '', 'a/b', 'a?b']:
                with self.assertRaises(ValueError): checkpoints.job_directory(Path(root), value)
            directory = checkpoints.job_directory(Path(root), 'valid-id')
            outside = Path(root) / 'outside'; outside.write_text('x')
            (directory / 'symlink').symlink_to(outside)
            self.assertIsNone(checkpoints.local_file(directory, '../outside'))
            self.assertIsNone(checkpoints.local_file(directory, 'symlink'))

    def test_new_lease_replays_saved_result_without_download_or_transcription(self):
        with tempfile.TemporaryDirectory() as root:
            directory = checkpoints.job_directory(Path(root), JOB['id'])
            payload = {'status': 'completed', 'contentKind': 'video', 'transcript': 'Saved expensive result'}
            checkpoints.atomic_json(directory / 'state.json', {'job': JOB, 'result': payload, 'waitingForClaim': True})
            resumed = runner(root)
            with patch.object(resumed, 'update') as update, patch('worker.retrieve_media') as retrieve, patch('worker.transcribe_file') as speech, contextlib.redirect_stdout(io.StringIO()):
                resumed.process({**JOB, 'leaseToken': 'new-lease'})
            retrieve.assert_not_called(); speech.assert_not_called()
            self.assertEqual(update.call_args.args[0]['leaseToken'], 'new-lease')
            self.assertEqual(update.call_args.args[1], payload)
            self.assertTrue(checkpoints.read_json(directory / 'state.json')['finished'])

    def test_failed_upload_leaves_durable_result_then_recovers_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            directory = checkpoints.job_directory(Path(root), JOB['id'])
            result = {'status': 'completed', 'contentKind': 'video', 'transcript': 'Saved result'}
            checkpoints.atomic_json(directory / 'state.json', {'job': JOB, 'result': result})
            first = runner(root)
            with patch.object(first.client, 'request', side_effect=worker.SiteError(503)), contextlib.redirect_stdout(io.StringIO()):
                first.process(JOB)
            saved = checkpoints.read_json(directory / 'state.json')
            self.assertEqual(saved['result'], result)
            self.assertNotIn('failed', saved)
            second = runner(root)
            with patch.object(second.client, 'request', return_value={'job': {'status': 'transcribing'}}) as request, patch('worker.retrieve_media') as retrieve, contextlib.redirect_stdout(io.StringIO()):
                self.assertTrue(second.resume_one())
            retrieve.assert_not_called()
            self.assertEqual(request.call_args.args[2]['transcript'], 'Saved result')

    def test_ocr_restart_reuses_completed_slide_and_invalidates_changed_image(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); first = root / '1.jpg'; second = root / '2.jpg'
            first.write_bytes(b'first'); second.write_bytes(b'second')
            blocks = {'blocks': [{'text': 'Hello', 'confidence': .9, 'x': .1, 'y': .1, 'width': .7, 'height': .1}]}
            data = json.dumps(blocks).encode()
            with patch('ocr._helper', return_value=Path('helper-v1')), patch('ocr._run', side_effect=[data, ocr.OCRError('Interrupted')]):
                with self.assertRaises(ocr.OCRError): ocr.ocr_images([first, second], root, root / 'cache')
            with patch('ocr._helper', return_value=Path('helper-v1')), patch('ocr._run', return_value=data) as native:
                pages = ocr.ocr_images([first, second], root, root / 'cache')
                self.assertEqual(len(pages), 2); self.assertEqual(native.call_count, 1)
                first.write_bytes(b'changed')
                ocr.ocr_images([first, second], root, root / 'cache')
                self.assertEqual(native.call_count, 2)

    def test_identity_unifies_share_forms_without_usernames_for_key(self):
        first = worker.canonical_identity('https://www.tiktok.com/@one/photo/7000000000000000001')
        second = worker.canonical_identity('https://www.tiktok.com/@two/video/7000000000000000001')
        self.assertEqual((first['platform'], first['postId']), (second['platform'], second['postId']))
        self.assertIsNone(worker.canonical_identity('https://vt.tiktok.com/AbCdEf12/'))
        self.assertEqual(worker.canonical_identity('https://youtu.be/abcdefghijk')['postId'], 'abcdefghijk')

    def test_authenticated_pool_is_reused_without_ambient_credentials(self):
        client = runner(tempfile.gettempdir()).client
        self.assertIs(client.session(), client.session())
        self.assertFalse(client.session().trust_env)

    def test_preview_lane_does_not_replace_active_transcription_heartbeat(self):
        with tempfile.TemporaryDirectory() as root:
            value = runner(root); value.set_state('busy', JOB)
            with patch('worker.retrieve_preview', side_effect=ValueError()), patch.object(value.client, 'request'), contextlib.redirect_stdout(io.StringIO()):
                value.process_preview({**JOB, 'leaseToken': 'frame-only'})
            self.assertEqual(value.state['activeLeaseToken'], 'old-lease')


class InsightsTests(unittest.TestCase):
    def payload(self):
        return {'job': {'title': 'Learn Python', 'transcript': 'Python makes automation easier. Learn Python with free lessons. Visit https://example.org/lessons for the course.'}, 'collections': [{'id': 'learning', 'name': 'Python learning'}], 'tags': ['python', 'gardening']}

    def assert_compact(self, value):
        self.assertLessEqual(len(value), 100)
        self.assertLessEqual(len(value.split()), 16)
        self.assertNotIn('\n', value)
        self.assertNotIn('\r', value)

    def test_title_normalizes_caption_decoration_and_bounds(self):
        value = insights.compact_title("Title: You won't believe: Python\nautomation basics #learning https://example.org")
        self.assertEqual(value, 'Python automation basics')
        long = insights.compact_title('Python automation examples and useful practical coding techniques for everyday office work and more')
        self.assertLessEqual(len(long), 70)
        self.assertLessEqual(len(long.split()), 10)
        self.assertNotIn('\n', long)
        self.assertEqual(insights.compact_title('学𠮷' * 50), ('学𠮷' * 50)[:70])
        self.assertEqual(insights.compact_title('🧊 Python automation basics ✨'), 'Python automation basics')
        self.assertEqual(insights.compact_title('無料の大学講座！次の文は含めません。'), '無料の大学講座')

    def test_generated_title_is_separate_and_source_grounded(self):
        result = insights.validate_generated({'title': 'Python automation basics', 'summary': 'Learn Python automation.',
            'takeaways': ['Learn Python with free lessons.'], 'collectionId': 'learning', 'tags': ['python']}, self.payload())
        self.assertEqual(result['title'], 'Python automation basics')
        self.assertEqual(result['insights']['summary'], 'Learn Python automation.')
        self.assertEqual(result['insights']['takeaways'], ['Learn Python with free lessons.'])
        self.assertEqual(result['suggestions'], {'collectionId': 'learning', 'tags': ['python']})
        for unsupported in ('Unrelated investment schemes', '99 Python courses'):
            with self.subTest(title=unsupported):
                self.assertEqual(insights.generated_title(unsupported, self.payload()['job']['transcript']), insights.source_title(self.payload()['job']['transcript']))

    def test_title_fallback_uses_source_language_not_social_caption(self):
        payload = {'job': {'title': 'VIRAL CAPTION follow me #sponsored',
                           'transcript': '無料の大学講座で学ぶ方法。受講料は不要です。'}, 'collections': [], 'tags': []}
        result = insights.extractive(payload)
        self.assertIn(result['title'], payload['job']['transcript'])
        self.assertNotIn('VIRAL', result['title'])
        self.assertNotIn('#', result['title'])
        self.assertLessEqual(len(result['title']), 70)
        payload['job']['transcript'] = ''
        self.assertEqual(insights.extractive(payload)['title'], 'Untitled post')

    def test_model_prompt_requests_short_source_language_title_without_caption(self):
        tokenizer = Mock()
        tokenizer.apply_chat_template.return_value = 'prompt'
        load = Mock(return_value=(object(), tokenizer))
        generate = Mock(return_value=json.dumps({'title': 'Python automation basics', 'summary': 'Learn Python automation.', 'takeaways': ['Learn Python.']}))
        modules = {'mlx_lm': types.SimpleNamespace(load=load, generate=generate),
                   'mlx_lm.sample_utils': types.SimpleNamespace(make_sampler=Mock(return_value='sampler'))}
        payload = self.payload(); payload['job']['title'] = 'RAW SOCIAL CAPTION #viral'
        with patch.dict('sys.modules', modules), patch.dict('os.environ'):
            result = insights.generate_child(payload, Path('/synthetic-local-model'))
        messages = tokenizer.apply_chat_template.call_args.args[0]
        instruction = messages[0]['content']
        self.assertIn('target 3–8 words', instruction)
        self.assertIn('70 Unicode characters', instruction)
        self.assertIn('source language', instruction)
        self.assertIn('maximum 100 Unicode characters and 16 words', instruction)
        self.assertIn('tags (up to 3 short tags)', instruction)
        self.assertNotIn('RAW SOCIAL CAPTION', messages[1]['content'])
        self.assertEqual(result['title'], 'Python automation basics')
        self.assertEqual(load.call_args.kwargs['tokenizer_config'], {'trust_remote_code': False})

    def test_child_result_revalidation_keeps_top_level_title(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root); model = root / 'models' / 'insights'; model.mkdir(parents=True)
            (model / 'config.json').write_text('{}')
            output = insights.validate_generated({'title': 'Python automation basics', 'summary': 'Learn Python automation.', 'takeaways': ['Learn Python.']}, self.payload())
            def start(command, **_):
                checkpoints.atomic_json(Path(command[2]) / 'result.json', output)
                process = Mock(); process.wait.return_value = 0
                return process
            with patch('insights.start_local_process', side_effect=start):
                result = insights.generate_insights(self.payload(), root)
            self.assertEqual(result['title'], 'Python automation basics')
            self.assertEqual(result['engine'], insights.MODEL_NAME)

    def test_generated_long_summary_is_capped_without_changing_other_insights(self):
        takeaways = ['Learn Python with free lessons.']
        result = insights.validate_generated({'summary': 'Useful practical automation advice ' * 80,
            'takeaways': takeaways, 'resources': [{'label': 'Python'}],
            'collectionId': 'learning', 'tags': ['python']}, self.payload())
        self.assert_compact(result['insights']['summary'])
        self.assertTrue(result['insights']['summary'].endswith('…'))
        self.assertEqual(result['insights']['takeaways'], takeaways)
        self.assertIn({'label': 'Python'}, result['insights']['resources'])
        self.assertEqual(result['suggestions'], {'collectionId': 'learning', 'tags': ['python']})

    def test_summary_removes_list_prefix_collapses_lines_and_keeps_first_sentence(self):
        value = insights.compact_summary('  1.\n  Python makes\t\nautomation easier.\nA second sentence should disappear. ')
        self.assertEqual(value, 'Python makes automation easier.')
        self.assert_compact(value)
        self.assertEqual(insights.compact_summary('• One useful sentence! Another follows.'), 'One useful sentence!')

    def test_summary_caps_words_even_when_character_count_is_small(self):
        value = insights.compact_summary(' '.join(['go'] * 20))
        self.assertEqual(value, ' '.join(['go'] * 16) + '…')
        self.assert_compact(value)

    def test_summary_cjk_sentence_boundaries_and_unicode_character_limit(self):
        self.assertEqual(insights.compact_summary('無料の講座を紹介します。次の文は含めません。'), '無料の講座を紹介します。')
        self.assertEqual(insights.compact_summary('学びを始めよう！次の文は含めません。'), '学びを始めよう！')
        value = insights.compact_summary('学🧊' * 60)
        self.assertEqual(value, ('学🧊' * 60)[:99] + '…')
        self.assert_compact(value)

    def test_character_cap_ends_at_word_boundary_and_reserves_ellipsis(self):
        value = insights.compact_summary('automation ' * 15)
        self.assertEqual(value, ' '.join(['automation'] * 9) + '…')
        self.assert_compact(value)
        self.assertEqual(insights.compact_summary('a' * 100), 'a' * 100)
        self.assertEqual(insights.compact_summary('a' * 101), 'a' * 99 + '…')

    def test_fallback_summary_obeys_identical_compact_bounds(self):
        payload = self.payload()
        payload['job']['transcript'] = 'Useful automation guidance ' * 80 + '. More useful automation guidance follows.'
        result = insights.extractive(payload)
        self.assert_compact(result['insights']['summary'])
        self.assertTrue(result['insights']['summary'].endswith('…'))
        self.assertEqual(result['engine'], insights.FALLBACK_NAME)
        self.assertGreater(len(result['insights']['takeaways'][0]), 100)

    def test_fallback_uses_source_sentences_and_existing_collection(self):
        payload = self.payload(); result = insights.extractive(payload)
        self.assertEqual(result['engine'], insights.FALLBACK_NAME)
        for point in result['insights']['takeaways']: self.assertIn(point, payload['job']['transcript'])
        self.assertEqual(result['suggestions']['collectionId'], 'learning')
        self.assertEqual(result['suggestions']['tags'], ['python'])

    def test_unrelated_first_collection_is_not_a_default_for_pricing(self):
        payload = self.payload()
        payload['job'] = {'title': 'Design #viral original caption', 'transcript': 'A baker doubles his prices, loses half his customers, and earns the same money in half the time. Quality improves. The price you charge is how valuable your work is.'}
        payload['collections'] = [{'id': 'design', 'name': 'Design'}, {'id': 'marketing', 'name': 'Marketing'}]
        generated = {'summary': 'Price signals value.', 'takeaways': ['Charge for the value of your work.'], 'collectionId': 'design', 'tags': ['pricing']}
        self.assertIsNone(insights.validate_generated(generated, payload)['suggestions']['collectionId'])
        self.assertEqual(insights.extractive(payload)['suggestions']['collectionId'], 'marketing')
        generated['collectionId'] = 'marketing'
        self.assertEqual(insights.validate_generated(generated, payload)['suggestions']['collectionId'], 'marketing')
        payload['collections'] = payload['collections'][:1]
        self.assertIsNone(insights.extractive(payload)['suggestions']['collectionId'])

    def test_design_source_and_multilingual_evidence_remain_supported(self):
        source = 'Design rule in ten seconds. Messy design: make one element the hero. Change size and color intensity to create hierarchy: one big, two medium, the rest small.'
        payload = {'job': {'transcript': source}, 'collections': [{'id': 'design', 'name': 'Design'}]}
        generated = {'summary': 'Create hierarchy with one hero element.', 'takeaways': ['Make one element the hero.'], 'collectionId': 'design'}
        self.assertEqual(insights.validate_generated(generated, payload)['suggestions']['collectionId'], 'design')
        self.assertEqual(insights.extractive(payload)['suggestions']['collectionId'], 'design')
        self.assertTrue(insights.collection_matches_source('Design', '見出しの配色とレイアウトを改善します。'))
        self.assertTrue(insights.collection_matches_source('学習', '大学で学習する方法を説明します。'))
        self.assertFalse(insights.collection_matches_source('Design', 'See https://example.org/design for a baking recipe.'))
        payload['collections'].append({'id': 'another', 'name': 'Design notes'})
        self.assertIsNone(insights.extractive(payload)['suggestions']['collectionId'])

    def test_generated_suggested_tags_are_three_unique_normalized_values(self):
        result = insights.validate_generated({'title': 'Python automation basics', 'summary': 'Learn Python.',
            'takeaways': ['Learn Python.'], 'tags': ['#Python', 'PYTHON', 'Automation', 'learning', 'hidden', 'also-hidden']}, self.payload())
        self.assertEqual(result['suggestions']['tags'], ['python', 'automation', 'learning'])
        self.assertEqual(insights.suggested_tags([None, 'bad,tag', '＃ＡＩ', 'ai', '日本語', 'last', 'hidden']), ['ai', '日本語', 'last'])

    def test_fallback_suggested_tags_obey_three_tag_cap_with_or_without_existing_labels(self):
        payload = self.payload()
        payload['job']['transcript'] = 'Python automation learning research education. Python automation learning research education.'
        payload['tags'] = ['PYTHON', 'python', 'automation', 'learning', 'research', 'education']
        self.assertEqual(insights.extractive(payload)['suggestions']['tags'], ['python', 'automation', 'learning'])
        payload['tags'] = []
        self.assertEqual(len(insights.extractive(payload)['suggestions']['tags']), 3)

    def test_untrusted_generated_resources_cannot_invent_links_or_names(self):
        result = insights.validate_generated({'summary': 'A course guide.', 'takeaways': ['Learn Python.'], 'resources': [{'label': 'Invented school', 'url': 'https://evil.example'}, {'label': 'Python', 'url': 'https://evil.example'}], 'collectionId': 'invented', 'tags': ['Python', 'Bad,tag']}, self.payload())
        self.assertIsNone(result['suggestions']['collectionId'])
        self.assertEqual(result['suggestions']['tags'], ['python'])
        self.assertNotIn('evil.example', json.dumps(result))
        self.assertNotIn('Invented school', json.dumps(result))

    def test_missing_model_is_offline_extractively_usable(self):
        with tempfile.TemporaryDirectory() as root, patch('insights.subprocess.Popen') as process:
            result = insights.generate_insights(self.payload(), Path(root))
            self.assertEqual(result['engine'], insights.FALLBACK_NAME)
            process.assert_not_called()

    def test_insight_outbox_replay_avoids_reinference(self):
        with tempfile.TemporaryDirectory() as root:
            value = runner(root); payload = self.payload()
            claim = {**payload, 'job': {**payload['job'], 'id': 'insight-job'}, 'leaseToken': 'lease', 'sourceRevision': 2}
            result = insights.extractive(payload)
            path = Path(root) / 'insights-outbox' / 'insight-job.json'
            checkpoints.atomic_json(path, {'claim': claim, 'sourceRevision': 2, 'result': result})
            with patch.object(value.client, 'request') as request, patch('insights.generate_insights') as generate:
                value.replay_insights()
            generate.assert_not_called(); self.assertFalse(path.exists())
            self.assertEqual(request.call_args.args[2]['sourceRevision'], 2)
            self.assertEqual(request.call_args.args[2]['title'], result['title'])

    def test_legacy_insight_outbox_regenerates_missing_or_caption_title(self):
        for old_title in (None, 'Long social caption #viral ' * 20):
            with self.subTest(title=old_title), tempfile.TemporaryDirectory() as root:
                value = runner(root); payload = self.payload()
                claim = {**payload, 'job': {**payload['job'], 'id': 'insight-job'}, 'leaseToken': 'lease', 'sourceRevision': 2}
                old_result = insights.extractive(payload)
                if old_title is None: old_result.pop('title')
                else: old_result['title'] = old_title
                new_result = {**insights.extractive(payload), 'title': 'Python automation basics'}
                path = Path(root) / 'insights-outbox' / 'insight-job.json'
                checkpoints.atomic_json(path, {'claim': claim, 'sourceRevision': 2, 'result': old_result})
                with patch('insights.generate_insights', return_value=new_result) as generate, patch.object(value.client, 'request') as request, contextlib.redirect_stdout(io.StringIO()):
                    value.replay_insights()
                generate.assert_called_once_with(claim, value.root, value.insights_model)
                self.assertEqual(request.call_args.args[2]['title'], 'Python automation basics')
                self.assertFalse(path.exists())

    def test_reused_title_outbox_retains_fresh_lease_after_failed_upload(self):
        with tempfile.TemporaryDirectory() as root:
            value = runner(root); payload = self.payload()
            old = {**payload, 'job': {**payload['job'], 'id': 'insight-job'}, 'leaseToken': 'old-lease', 'sourceRevision': 2}
            fresh = {**old, 'leaseToken': 'fresh-lease'}
            path = Path(root) / 'insights-outbox' / 'insight-job.json'
            checkpoints.atomic_json(path, {'claim': old, 'sourceRevision': 2, 'result': insights.extractive(payload)})
            with patch('insights.generate_insights') as generate, patch.object(value.client, 'request', side_effect=worker.SiteError(503)), contextlib.redirect_stdout(io.StringIO()):
                value.process_insights(fresh)
            generate.assert_not_called()
            self.assertEqual(checkpoints.read_json(path)['claim']['leaseToken'], 'fresh-lease')

    def test_insight_old_revision_cannot_resurrect_after_conflict(self):
        with tempfile.TemporaryDirectory() as root:
            value = runner(root); path = Path(root) / 'insights-outbox' / 'insight-job.json'
            checkpoints.atomic_json(path, {'claim': {'job': {'id': 'insight-job'}, 'leaseToken': 'old', 'sourceRevision': 1}, 'result': insights.extractive(self.payload())})
            with patch.object(value.client, 'request', side_effect=worker.SiteError(409)):
                value.replay_insights()
            self.assertFalse(path.exists())


if __name__ == '__main__': unittest.main()
