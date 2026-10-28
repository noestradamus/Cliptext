import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import worker


ENGINE_KEY = "unit-test-mac-only-engine-key-123456789"
JOB = {"id": "image-job", "url": "https://www.tiktok.com/@creator/photo/7000000000000000001", "leaseToken": "text-lease"}
FRAME_JOB = {**JOB, "leaseToken": "independent-frame-lease"}


class WorkerImageTests(unittest.TestCase):
    def make_worker(self, root):
        return worker.Worker({"site_url": "https://example.chatgpt.site", "site_bearer": "synthetic-site-secret",
                              "engine_key": ENGINE_KEY, "runtime_dir": root})

    def test_tiktok_photo_urls_keep_existing_url_boundaries(self):
        self.assertEqual(worker.validate_video_url(JOB["url"] + "?photo_id=123"), JOB["url"])
        for value in [JOB["url"].replace("tiktok.com", "tiktok.com.evil.test"),
                      JOB["url"].replace("/photo/", "/photo/../photo/"),
                      JOB["url"].replace("/photo/", "/%2e%2e/photo/"),
                      JOB["url"] + "/extra", JOB["url"].replace("https://", "https://user:pass@")]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.validate_video_url(value)

    def test_cover_title_normalizes_only_first_page_main_text(self):
        pages = [{"index": 1, "text": "  Main heading\n\tA useful explanation  ", "allText": "Unselected background"},
                 {"index": 2, "text": "Later caption"}]
        self.assertEqual(worker.image_post_title(pages, "Original caption #tag"), "Main heading A useful explanation")

    def test_long_cover_title_ends_at_a_word_or_line_boundary(self):
        heading = "Recognized heading " * 8
        text = heading + "\nexplanation-that-would-cross-the-limit"
        title = worker.image_post_title([{"text": text}], "Fallback")
        self.assertEqual(title, heading.strip())
        self.assertLessEqual(len(title), 160)
        self.assertTrue(" ".join(text.split()).startswith(title))

    def test_blank_cover_keeps_metadata_title_without_using_later_pages(self):
        pages = [{"text": " \n\t", "allText": "Background text"}, {"text": "Later-page caption"}]
        self.assertEqual(worker.image_post_title(pages, "Original metadata title"), "Original metadata title")
        self.assertIsNone(worker.image_post_title(pages, None))

    def test_unicode_cover_titles_preserve_characters_and_obey_the_bound(self):
        self.assertEqual(worker.image_post_title([{"text": "日本語の見出し\n大切な説明\t🧠"}], "Fallback"), "日本語の見出し 大切な説明 🧠")
        self.assertEqual(worker.image_post_title([{"text": "見出し" * 60}], "Fallback"), ("見出し" * 60)[:160])

    def test_carousel_preserves_result_and_originals_without_waiting_for_preview(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            pages = [{"index": 1, "text": "主な見出し", "allText": "主な見出し\n背景"}, {"index": 2, "text": "", "allText": ""}]
            paths = []
            def retrieve(_url, directory):
                paths.extend([directory / "first.jpg", directory / "second.jpg"])
                for path in paths: path.write_bytes(b"original")
                return {"paths": paths, "metadata": {"title": "Image post", "creator": "Creator"}, "contentKind": "carousel"}
            with patch("worker.retrieve_image_post", side_effect=retrieve), patch("worker.recognize_image_post", return_value=(pages, "Apple Vision")) as ocr, patch("worker.retrieve_media") as audio, patch("worker.transcribe_file") as speech, patch.object(runner, "update") as update, patch.object(runner, "identify", return_value=False), patch("worker.encode_slide", side_effect=lambda path, *args: path), patch.object(runner.client, "upload_slide") as upload, patch.object(runner, "process_preview") as preview, contextlib.redirect_stdout(io.StringIO()):
                runner.process(JOB)
            audio.assert_not_called(); speech.assert_not_called(); preview.assert_not_called()
            self.assertEqual(upload.call_count, 2)
            completion = update.call_args.args[1]
            self.assertEqual(completion["pages"], pages)
            self.assertEqual(completion["title"], "主な見出し")
            self.assertTrue(all(path.exists() for path in paths))
            self.assertTrue(json.loads((runner.root / 'jobs' / JOB['id'] / 'state.json').read_text())['finished'])
            self.assertEqual(runner.state["status"], "idle")

    def test_normal_video_lazily_loads_whisper_and_has_no_ocr_payload(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            media = Path(temporary) / "video.mp4"; media.write_bytes(b"video")
            result = {"transcript": "Speech", "language": "en", "segments": [{"start": 0, "end": 1, "text": "Speech"}]}
            with patch("worker.retrieve_image_post", return_value=None), patch("worker.retrieve_media", return_value=(media, {"title": "Video"})), patch("worker.audio_from_media", return_value=(media, 12)), patch("worker.prepare_model", return_value=Path(temporary) / 'model') as load, patch("worker.transcribe_file", return_value=result) as speech, patch("worker.recognize_image_post") as ocr, patch.object(runner, "update") as update, patch.object(runner, "identify", return_value=False), contextlib.redirect_stdout(io.StringIO()):
                self.assertIsNone(runner.model)
                runner.process({**JOB, "url": "https://youtu.be/abcdefghijk"})
            ocr.assert_not_called(); load.assert_called_once()
            speech.assert_called_once_with(media, runner.model)
            completion = update.call_args.args[1]
            self.assertEqual(completion["contentKind"], "video")
            self.assertEqual(completion["transcript"], result["transcript"])
            self.assertNotIn("pages", completion)

    def test_ocr_failure_keeps_checkpoint_and_does_not_fall_back_to_audio(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            original = Path(temporary) / 'image.jpg'; original.write_bytes(b'original')
            post = {"paths": [original], "metadata": {}, "contentKind": "image"}
            with patch("worker.retrieve_image_post", return_value=post), patch("worker.recognize_image_post", side_effect=ValueError("OCR timed out")), patch("worker.retrieve_media") as audio, patch.object(runner, "update") as update, patch.object(runner, "identify", return_value=False), contextlib.redirect_stdout(io.StringIO()):
                runner.process(JOB)
            self.assertEqual([call.args[1]["status"] for call in update.call_args_list], ["downloading", "transcribing", "failed"])
            audio.assert_not_called()
            self.assertTrue((runner.root / 'jobs' / JOB['id'] / 'state.json').is_file())

    def test_preview_backfill_resolves_first_original_without_ocr_or_video_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "first.jpg"
            post = {"paths": [original, root / "second.jpg"], "metadata": {}, "contentKind": "carousel"}
            with patch("worker.retrieve_image_post", return_value=post) as retrieve, patch("worker.encode_preview") as encode, patch("worker.recognize_image_post") as ocr, patch("yt_dlp.YoutubeDL") as video:
                self.assertEqual(worker.create_preview(JOB["url"], root, None, worker.MAX_BYTES), "thumbnail")
            retrieve.assert_called_once_with(JOB["url"], root, cover_only=True)
            encode.assert_called_once_with(original, root)
            ocr.assert_not_called()
            video.assert_not_called()

    def test_oversized_result_rejection_is_terminal_instead_of_retried_forever(self):
        with tempfile.TemporaryDirectory() as temporary:
            runner = self.make_worker(temporary)
            with patch.object(runner.client, "request", side_effect=worker.SiteError(413)) as request, patch("worker.STOP.wait") as wait:
                with self.assertRaises(worker.SiteError):
                    runner.update(JOB, {"status": "completed"}, final=True)
            request.assert_called_once()
            wait.assert_not_called()

    def test_site_payload_uses_literal_utf8_for_japanese_ocr(self):
        client = worker.SiteClient("https://example.chatgpt.site", "synthetic-secret", ENGINE_KEY)
        payload = {"pages": [{"index": 1, "text": "日本語の見出し", "allText": "背景の文字"}]}
        with patch("requests.Session.request") as request:
            request.return_value.status_code, request.return_value.content = 200, b""
            client.request("PATCH", "/api/worker/jobs/image-job", payload)
        data = request.call_args.kwargs["data"]
        self.assertIsInstance(data, bytes)
        self.assertIn("日本語の見出し".encode("utf-8"), data)
        self.assertEqual(json.loads(data), payload)
        self.assertNotIn("json", request.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
