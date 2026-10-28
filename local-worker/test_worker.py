import unittest
import contextlib
import io
import tempfile
from unittest.mock import patch

import worker

ENGINE_KEY = "unit-test-mac-only-engine-key-123456789"


class URLSafetyTests(unittest.TestCase):
    def test_accepts_public_tiktok_share_links(self):
        for value in ["https://vt.tiktok.com/AbCdEf12/", "https://www.tiktok.com/@example_creator/video/7000000000000000001"]:
            self.assertEqual(worker.validate_tiktok_url(value), value)

    def test_rejects_unrelated_hosts_credentials_ports_and_non_https(self):
        for value in ["http://vt.tiktok.com/a", "https://tiktok.com.evil.example/a", "https://user:password@www.tiktok.com/a", "https://www.tiktok.com:444/a", "https://127.0.0.1/a", "https://tiktok.com", "file:///tmp/a"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.validate_tiktok_url(value)

    def test_error_redacts_secret_and_media_address(self):
        result = worker.safe_error(RuntimeError("secret-abc " + ENGINE_KEY + " https://video.example/file?token=123 Bearer abc"), ["secret-abc", ENGINE_KEY])
        self.assertNotIn("secret-abc", result)
        self.assertNotIn("token=123", result)
        self.assertNotIn("Bearer abc", result)
        self.assertNotIn(ENGINE_KEY, result)


class CredentialBoundaryTests(unittest.TestCase):
    def test_disallows_cross_origin_worker_paths(self):
        client = worker.SiteClient("https://example.chatgpt.site", "secret", ENGINE_KEY)
        for path in ["https://evil.example/", "//evil.example/", "/api/worker/../../other", "/api/worker/claim?redirect=evil"]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                client.request("POST", path, {})

    def test_does_not_follow_credential_bearing_redirect(self):
        client = worker.SiteClient("https://example.chatgpt.site", "secret", ENGINE_KEY)
        with patch("requests.Session.request") as request:
            request.return_value.status_code = 302
            with self.assertRaises(worker.SiteError):
                client.request("POST", "/api/worker/claim", {})
            self.assertIs(request.call_args.kwargs["allow_redirects"], False)

    def test_engine_key_is_required_and_cannot_reuse_site_bearer(self):
        for value in (None, "", "short", "a" * 31, "a" * 257, "a" * 32 + "\r\nInjected: true", ENGINE_KEY):
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.SiteClient("https://example.chatgpt.site", ENGINE_KEY, value)

    def test_every_worker_request_has_independent_engine_authorization(self):
        client = worker.SiteClient("https://example.chatgpt.site", "site-transport-secret", ENGINE_KEY)
        with patch("requests.Session.request") as request:
            request.return_value.status_code = 200
            request.return_value.content = b"{}"
            request.return_value.json.return_value = {}
            self.assertEqual(client.request("POST", "/api/worker/claim", {}), {})
            headers = request.call_args.kwargs["headers"]
            self.assertEqual(headers["OAI-Sites-Authorization"], "Bearer site-transport-secret")
            self.assertEqual(headers["X-Cliptext-Engine-Key"], ENGINE_KEY)
            self.assertIs(request.call_args.kwargs["allow_redirects"], False)

    def test_rejected_result_logs_only_safe_http_metadata(self):
        for status in (400, 403):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                runner = worker.Worker({"site_url": "https://example.chatgpt.site", "site_bearer": "sensitive-service-token", "engine_key": ENGINE_KEY, "runtime_dir": directory})
                output = io.StringIO()
                with patch.object(runner.client, "request", side_effect=worker.SiteError(status)), contextlib.redirect_stdout(output):
                    runner.process({"id": "test-job", "url": "https://vt.tiktok.com/test/", "leaseToken": "sensitive-lease-token"})
                lines = output.getvalue()
                self.assertIn(f'"http_status": {status}', lines)
                self.assertNotIn("sensitive-service-token", lines)
                self.assertNotIn("sensitive-lease-token", lines)
                self.assertNotIn(ENGINE_KEY, lines)

    def test_engine_key_is_redacted_from_processing_error(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = worker.Worker({"site_url": "https://example.chatgpt.site", "site_bearer": "sensitive-service-token", "engine_key": ENGINE_KEY, "runtime_dir": directory})
            output = io.StringIO()
            with patch.object(runner, "update", side_effect=[RuntimeError("Error " + ENGINE_KEY), None]), contextlib.redirect_stdout(output):
                runner.process({"id": "test-job", "url": "https://vt.tiktok.com/test/", "leaseToken": "sensitive-lease-token"})
            self.assertIn("[redacted]", output.getvalue())
            self.assertNotIn(ENGINE_KEY, output.getvalue())


class ModelReportingTests(unittest.TestCase):
    def test_heartbeat_reports_selected_repository_including_runtime_override(self):
        class OneHeartbeat:
            def __init__(self):
                self.finished = False

            def is_set(self):
                return self.finished

            def wait(self, _seconds):
                self.finished = True

        for repository in ("mlx-community/whisper-large-v3-mlx", "mlx-community/whisper-small-mlx", "mlx-community/whisper-large-v3-turbo"):
            with self.subTest(repository=repository), tempfile.TemporaryDirectory() as directory:
                runner = worker.Worker({"site_url": "https://example.chatgpt.site", "site_bearer": "site-transport-secret", "engine_key": ENGINE_KEY, "runtime_dir": directory, "model_repo": repository})
                runner.set_state("busy", {"id": "test-job", "leaseToken": "test-lease"})
                with patch("worker.STOP", OneHeartbeat()), patch.object(runner.client, "request", return_value={}) as request:
                    runner.heartbeat()
                request.assert_called_once_with("POST", "/api/worker/heartbeat", {
                    "engine": repository, "status": "busy", "activeJobId": "test-job", "activeLeaseToken": "test-lease"
                }, attempts=1)


if __name__ == "__main__":
    unittest.main()
