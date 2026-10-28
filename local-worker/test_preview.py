import contextlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import worker


ENGINE_KEY = "unit-test-mac-only-engine-key-123456789"
JOB = {"id": "preview-job", "url": "https://youtu.be/abcdefghijk", "leaseToken": "preview-lease-token"}


def public_info(**fields):
    return {"id": "abcdefghijk", "extractor_key": "Youtube", "duration": 10,
            "formats": [{"url": "https://rr1.googlevideo.com/video", "acodec": "opus", "vcodec": "h264", "ext": "mp4", "height": 144}],
            **fields}


class PreviewBoundaryTests(unittest.TestCase):
    def test_only_https_platform_cdn_urls_without_credentials_are_accepted(self):
        self.assertEqual(worker.preview_source_url("https://i.ytimg.com/vi/id/hqdefault.jpg", "youtube"), "https://i.ytimg.com/vi/id/hqdefault.jpg")
        for url in ["http://i.ytimg.com/a", "https://ytimg.com.evil.test/a", "https://127.0.0.1/a", "https://localhost/a",
                    "https://user:pass@i.ytimg.com/a", "https://@i.ytimg.com/a", "https://i.ytimg.com:444/a",
                    "https://i.ytimg.com/a#fragment", "https://i.ytimg.com/a\nInjected: bad", "https://i.ytimg.com\\@evil.test/a",
                    "https://scontent.cdninstagram.com/a"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                worker.preview_source_url(url, "youtube")

    def test_thumbnail_download_has_no_redirects_ambient_credentials_or_sensitive_headers(self):
        with tempfile.TemporaryDirectory() as temporary, patch("requests.Session") as constructor:
            session = constructor.return_value.__enter__.return_value
            response = session.get.return_value.__enter__.return_value
            response.status_code = 200
            response.headers = {"Content-Type": "image/jpeg"}
            response.raw.read.side_effect = [b"abc", b"def"]
            destination = Path(temporary) / "image"
            worker.download_preview_source("https://i.ytimg.com/cover.jpg", destination, "youtube", 6,
                                           headers={"User-Agent": "test", "Cookie": "private", "Authorization": "secret"})
            self.assertEqual(destination.read_bytes(), b"abcdef")
            self.assertIs(session.trust_env, False)
            self.assertIs(session.get.call_args.kwargs["allow_redirects"], False)
            self.assertEqual(session.get.call_args.kwargs["headers"], {"User-Agent": "test"})

    def test_thumbnail_rejects_oversize_and_non_image_responses(self):
        for headers, chunks in [({"Content-Type": "image/jpeg", "Content-Length": "7"}, []),
                                ({"Content-Type": "text/html"}, []),
                                ({"Content-Type": "image/jpeg"}, [b"1234567"])]:
            with self.subTest(headers=headers), tempfile.TemporaryDirectory() as temporary, patch("requests.Session") as constructor:
                response = constructor.return_value.__enter__.return_value.get.return_value.__enter__.return_value
                response.status_code, response.headers, response.raw.read.side_effect = 200, headers, chunks
                with self.assertRaises(ValueError):
                    worker.download_preview_source("https://i.ytimg.com/cover.jpg", Path(temporary) / "image", "youtube", 6)

    def test_video_range_download_never_fetches_remaining_video(self):
        with tempfile.TemporaryDirectory() as temporary, patch("requests.Session") as constructor:
            session = constructor.return_value.__enter__.return_value
            response = session.get.return_value.__enter__.return_value
            response.status_code, response.headers = 200, {"Content-Length": "9999999"}
            response.raw.read.side_effect = [b"abcde", b"fg", b"remaining-not-read"]
            destination = Path(temporary) / "prefix"
            worker.download_preview_source("https://rr1.googlevideo.com/video", destination, "youtube", 7, prefix=True)
            self.assertEqual(destination.read_bytes(), b"abcdefg")
            self.assertEqual(session.get.call_args.kwargs["headers"]["Range"], "bytes=0-6")
            self.assertEqual(response.raw.read.call_count, 2)
            self.assertEqual(response.raw.read.call_args.args[0], 2)

    def test_thumbnail_precedes_local_first_frame(self):
        with tempfile.TemporaryDirectory() as temporary, patch("yt_dlp.YoutubeDL") as constructor:
            root = Path(temporary)
            media = root / "video.mp4"
            media.write_bytes(b"local video")
            constructor.return_value.__enter__.return_value.extract_info.return_value = public_info(thumbnail="https://i.ytimg.com/cover.jpg")
            with patch("worker.download_preview_source") as download, patch("worker.encode_preview") as encode:
                self.assertEqual(worker.create_preview(JOB["url"], root, media, 1000), "thumbnail")
            self.assertEqual(download.call_args.args[3], 1000)
            encode.assert_called_once_with(root / "thumbnail-source", root)

    def test_failed_thumbnail_reuses_local_video_without_video_download(self):
        with tempfile.TemporaryDirectory() as temporary, patch("yt_dlp.YoutubeDL") as constructor:
            root = Path(temporary)
            media = root / "video.mp4"
            media.write_bytes(b"local video")
            constructor.return_value.__enter__.return_value.extract_info.return_value = public_info(thumbnail="https://i.ytimg.com/cover.jpg")
            with patch("worker.download_preview_source", side_effect=ValueError("Unavailable")) as download, patch("worker.encode_preview") as encode:
                self.assertEqual(worker.create_preview(JOB["url"], root, media, 1000), "first_frame")
            download.assert_called_once()
            encode.assert_called_once_with(media, root, first_frame=True)

    def test_smallest_video_prefix_is_bounded_and_bad_prefix_does_not_trigger_full_download(self):
        with tempfile.TemporaryDirectory() as temporary, patch("yt_dlp.YoutubeDL") as constructor:
            info = public_info()
            info["formats"] = [dict(info["formats"][0], height=720, url="https://rr1.googlevideo.com/large"),
                               dict(info["formats"][0], height=144, url="https://rr1.googlevideo.com/small")]
            constructor.return_value.__enter__.return_value.extract_info.return_value = info
            with patch("worker.download_preview_source") as download, patch("worker.encode_preview", side_effect=ValueError("Incomplete")):
                with self.assertRaises(ValueError):
                    worker.create_preview(JOB["url"], Path(temporary), None, 3000)
            download.assert_called_once()
            self.assertEqual(download.call_args.args[0], "https://rr1.googlevideo.com/small")
            self.assertEqual(download.call_args.args[3], 3000)
            self.assertIs(download.call_args.kwargs["prefix"], True)

    def test_hard_timeout_kills_preview_process_group(self):
        with tempfile.TemporaryDirectory() as temporary, patch("worker.subprocess.Popen") as constructor, patch("worker.os.killpg") as kill:
            process = constructor.return_value
            process.pid = 123456
            process.wait.side_effect = [subprocess.TimeoutExpired("preview", 90), 0]
            with self.assertRaises(subprocess.TimeoutExpired):
                worker.retrieve_preview(JOB["url"], Path(temporary))
            self.assertIs(constructor.call_args.kwargs["start_new_session"], True)
            kill.assert_called_once_with(123456, worker.signal.SIGKILL)


class PreviewLifecycleTests(unittest.TestCase):
    def make_worker(self, directory):
        return worker.Worker({"site_url": "https://example.chatgpt.site", "site_bearer": "site-secret",
                              "engine_key": ENGINE_KEY, "runtime_dir": directory})

    def test_upload_has_binary_body_kind_independent_lease_and_engine_authorization(self):
        with tempfile.TemporaryDirectory() as temporary, patch("requests.Session.request") as request:
            preview = Path(temporary) / "preview.jpg"
            preview.write_bytes(b"\xff\xd8\xfffixture\xff\xd9")
            request.return_value.status_code, request.return_value.content = 200, b""
            self.make_worker(temporary).client.upload_preview(JOB, preview, "thumbnail")
            values = request.call_args.kwargs
            self.assertEqual(values["data"], preview.read_bytes())
            self.assertNotIn("json", values)
            self.assertEqual(values["headers"]["Content-Type"], "image/jpeg")
            self.assertEqual(values["headers"]["X-Cliptext-Preview-Kind"], "thumbnail")
            self.assertEqual(values["headers"]["X-Cliptext-Frame-Lease"], JOB["leaseToken"])
            self.assertEqual(values["headers"]["X-Cliptext-Engine-Key"], ENGINE_KEY)
            self.assertIs(values["allow_redirects"], False)

    def test_preview_failure_changes_only_preview_state_and_does_not_leak_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            output = io.StringIO()
            def fail(*args, **kwargs):
                self.assertEqual(runner.state, {"status": "loading", "activeJobId": None, "activeLeaseToken": None})
                raise RuntimeError("https://secret.example/?token=private " + ENGINE_KEY)
            with patch("worker.retrieve_preview", side_effect=fail), patch.object(runner.client, "request") as request, patch.object(runner, "update") as update, contextlib.redirect_stdout(output):
                runner.process_preview(JOB)
            update.assert_not_called()
            request.assert_called_once_with("PATCH", "/api/worker/frames/preview-job", {"leaseToken": JOB["leaseToken"], "status": "unavailable"}, attempts=1)
            self.assertNotIn("private", output.getvalue())
            self.assertNotIn(ENGINE_KEY, output.getvalue())

    def test_lost_preview_lease_does_not_mark_another_owners_attempt_unavailable(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            with patch("worker.retrieve_preview", side_effect=worker.SiteError(409)), patch.object(runner.client, "request") as request, contextlib.redirect_stdout(io.StringIO()):
                runner.process_preview(JOB)
            request.assert_not_called()

    def test_thumbnail_failure_after_completed_upload_never_fails_transcript(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            media = root / "video.mp4"
            media.write_bytes(b"media")
            runner = self.make_worker(temporary)
            with patch("worker.retrieve_media", return_value=(media, {})), patch.object(runner, "identify", return_value=False), patch("worker.prepare_model", return_value=root / "model"), patch("worker.audio_from_media", return_value=(media, 5)), patch("worker.transcribe_file", return_value={"transcript": "Hello", "language": "en", "segments": []}), patch.object(runner, "update") as update, patch.object(runner.client, "request", side_effect=worker.SiteError(500)), contextlib.redirect_stdout(io.StringIO()):
                runner.process(JOB)
            self.assertEqual([call.args[1]["status"] for call in update.call_args_list], ["downloading", "transcribing", "completed"])


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg is needed for actual frame decoding")
class ActualFrameTests(unittest.TestCase):
    def test_decodes_first_red_frame_before_blue_frame_and_contains_dimensions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "colors.mp4"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=900x1200:r=2:d=0.5", "-f", "lavfi", "-i", "color=c=blue:s=900x1200:r=2:d=0.5", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]", "-c:v", "libx264", "-y", str(source)], check=True, timeout=20)
            preview = worker.encode_preview(source, root, first_frame=True)
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "json", str(preview)], check=True, capture_output=True, text=True, timeout=10)
            stream = json.loads(probe.stdout)["streams"][0]
            self.assertEqual((stream["width"], stream["height"]), (480, 640))
            self.assertLessEqual(preview.stat().st_size, worker.MAX_PREVIEW_BYTES)
            pixels = subprocess.run(["ffmpeg", "-v", "error", "-i", str(preview), "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], check=True, capture_output=True, timeout=10).stdout
            self.assertGreater(pixels[0], 240)
            self.assertLess(pixels[1], 15)
            self.assertLess(pixels[2], 15)


if __name__ == "__main__":
    unittest.main()
