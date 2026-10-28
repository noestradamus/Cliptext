import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import worker


class VideoURLTests(unittest.TestCase):
    def test_canonicalizes_supported_single_video_links(self):
        cases = {
            "https://vt.tiktok.com:443/AbCdEf12/?utm=one#share": "https://vt.tiktok.com/AbCdEf12/",
            "https://m.tiktok.com/@author/video/7000000000000000001?share=1": "https://m.tiktok.com/@author/video/7000000000000000001",
            "https://www.tiktok.com/t/ABCdef12/": "https://www.tiktok.com/t/ABCdef12/",
            "https://youtu.be/BaW_jenozKc?t=1": "https://www.youtube.com/watch?v=BaW_jenozKc",
            "https://www.youtu.be:443/BaW_jenozKc/": "https://www.youtube.com/watch?v=BaW_jenozKc",
            "https://m.youtube.com/watch?feature=share&v=BaW_jenozKc&list=ignored#share": "https://www.youtube.com/watch?v=BaW_jenozKc",
            "https://youtube.com/shorts/BaW_jenozKc/": "https://www.youtube.com/watch?v=BaW_jenozKc",
            "https://instagram.com/reel/Chunk8-jurw/?igsh=tracking": "https://www.instagram.com/reel/Chunk8-jurw/",
            "https://m.instagram.com:443/reels/Chunk8-jurw": "https://www.instagram.com/reel/Chunk8-jurw/",
            "https://www.instagram.com/p/Chunk8-jurw/#track": "https://www.instagram.com/p/Chunk8-jurw/",
        }
        for value, expected in cases.items():
            with self.subTest(value=value):
                self.assertEqual(worker.validate_video_url(value), expected)

    def test_rejects_untrusted_authorities_traversal_and_collections(self):
        values = [
            "http://youtu.be/BaW_jenozKc", "https://youtube.com.evil.test/watch?v=BaW_jenozKc",
            "https://user@youtu.be/BaW_jenozKc", "https://user:pass@instagram.com/reel/Chunk8-jurw/",
            "https://youtube.com:444/watch?v=BaW_jenozKc", "https://youtu.be/BaW_jenozKc\\@evil.test",
            "https://youtube.com/watch?v=BaW_jenozKc&v=BaW_jenozKc", "https://youtube.com/watch?v=short",
            "https://youtube.com/playlist?list=123", "https://youtube.com/@author", "https://youtube.com/live/BaW_jenozKc",
            "https://instagram.com/author/", "https://instagram.com/reel/a/", "https://instagram.com/reel/" + "a" * 65 + "/",
            "https://instagram.com/../reel/Chunk8-jurw/", "https://instagram.com/%2e%2e/reel/Chunk8-jurw/",
            "https://instagram.com/reel%2fChunk8-jurw/", "https://instagram.com/%252e%252e/reel/Chunk8-jurw/",
            "https://tiktok.com/@name", "https://vt.tiktok.com/a", "https://tiktok.com/../@author/video/7000000000000000001",
            "https://@youtu.be/BaW_jenozKc", "https:////youtu.be/BaW_jenozKc", "https://youtu.be/BaW_jenozKc?bad=%zz",
            "https://www.youtube.com/shorts/../BaW_jenozKc", "https://www.youtube.com/shorts/%2e%2e/BaW_jenozKc",
        ]
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                worker.validate_video_url(value)

    def test_tiktok_compatibility_alias_does_not_accept_other_platforms(self):
        with self.assertRaises(ValueError):
            worker.validate_tiktok_url("https://youtu.be/BaW_jenozKc")


def video_info(key="Youtube", **fields):
    return {"id": "BaW_jenozKc", "extractor_key": key, "title": "Public test", "uploader": "Creator", "duration": 10,
            "formats": [{"url": "https://media.example/audio", "acodec": "opus", "vcodec": "none"}], **fields}


class ExtractorBoundaryTests(unittest.TestCase):
    def test_rejects_wrong_extractors_and_playlists_before_download(self):
        for info in [video_info("Generic"), video_info("Instagram"), video_info("Youtube", _type="playlist", entries=[])]:
            with self.subTest(info=info), tempfile.TemporaryDirectory() as directory, patch("yt_dlp.YoutubeDL") as constructor:
                extractor = constructor.return_value.__enter__.return_value
                extractor.extract_info.return_value = info
                with self.assertRaises(ValueError):
                    worker.retrieve_media("https://youtu.be/BaW_jenozKc", Path(directory))
                extractor.process_ie_result.assert_not_called()

    def test_only_expected_platform_redirects_resolve(self):
        extractor = Mock()
        extractor.extract_info.return_value = video_info("TikTok")
        selected = worker.resolve_single_video(extractor, {"_type": "url", "extractor_key": "TikTokVM", "ie_key": "TikTok", "url": "https://www.tiktok.com/@author/video/7000000000000000001"}, "tiktok")
        self.assertEqual(selected["extractor_key"], "TikTok")
        for target, key in [("https://youtu.be/BaW_jenozKc", "Youtube"), ("https://evil.test/video", "Generic"), ("https://www.tiktok.com/@author/video/7000000000000000001", "Generic")]:
            with self.subTest(target=target, key=key), self.assertRaises(ValueError):
                worker.resolve_single_video(extractor, {"_type": "url", "extractor_key": "TikTokVM", "ie_key": key, "url": target}, "tiktok")
        looping = Mock()
        looping.extract_info.return_value = {"_type": "url", "extractor_key": "TikTokVM", "url": "https://vt.tiktok.com/ABCD/"}
        with self.assertRaises(ValueError):
            worker.resolve_single_video(looping, looping.extract_info.return_value, "tiktok")
        self.assertLessEqual(looping.extract_info.call_count, 5)

    def test_instagram_post_selects_first_usable_video_without_images_or_all_entries(self):
        first = video_info("Instagram", id="first")
        second = video_info("Instagram", id="second")
        image = {"id": "image", "formats": [], "url": "https://media.example/image.jpg", "acodec": "none"}
        selected = worker.resolve_single_video(Mock(), {"_type": "playlist", "extractor_key": "Instagram", "entries": [image, first, second]}, "instagram")
        self.assertEqual(selected["id"], "first")
        for key in ("InstagramUser", "Generic"):
            with self.subTest(key=key), self.assertRaises(ValueError):
                worker.resolve_single_video(Mock(), {"_type": "playlist", "extractor_key": key, "entries": [first]}, "instagram")
        with self.assertRaises(ValueError):
            worker.resolve_single_video(Mock(), {"_type": "playlist", "extractor_key": "Instagram", "entries": [image]}, "instagram")

    def test_duration_bytes_live_and_private_limits_precede_download(self):
        for fields in ({"duration": worker.MAX_DURATION + 1}, {"filesize": worker.MAX_BYTES + 1}, {"filesize_approx": worker.MAX_BYTES + 1}, {"is_live": True}, {"live_status": "is_upcoming"}, {"availability": "private"}):
            with self.subTest(fields=fields), self.assertRaises(ValueError):
                worker.resolve_single_video(Mock(), video_info(**fields), "youtube")

    def test_silent_video_and_images_are_not_audio_candidates(self):
        with self.assertRaisesRegex(worker.UnusableVideoError, "does not contain an audio track"):
            worker.resolve_single_video(Mock(), video_info("Instagram", formats=[{"url": "https://media.example/video", "acodec": "none", "vcodec": "h264"}]), "instagram")
        self.assertFalse(worker.has_usable_media({"ext": "jpg", "url": "https://media.example/image.jpg"}))

    def test_instagram_skips_ineligible_entries_but_not_untrusted_extractors(self):
        valid = video_info("Instagram", id="usable")
        entries = [video_info("Instagram", duration=worker.MAX_DURATION + 1), video_info("Instagram", filesize=worker.MAX_BYTES + 1), video_info("Instagram", availability="private"), valid]
        selected = worker.resolve_single_video(Mock(), {"_type": "playlist", "extractor_key": "Instagram", "entries": entries}, "instagram")
        self.assertEqual(selected["id"], "usable")
        with self.assertRaises(ValueError):
            worker.resolve_single_video(Mock(), {"_type": "playlist", "extractor_key": "Instagram", "entries": [video_info("Generic"), valid]}, "instagram")

    def test_download_is_audio_first_for_youtube_and_bounded_for_every_platform(self):
        for url, key, expected_format in [
            ("https://youtu.be/BaW_jenozKc", "Youtube", "bestaudio/best"),
            ("https://vt.tiktok.com/AbCdEf12/", "TikTok", "best"),
            ("https://www.instagram.com/reel/Chunk8-jurw/", "Instagram", "best"),
        ]:
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory, patch("yt_dlp.YoutubeDL") as constructor:
                root = Path(directory)
                media = root / "media.m4a"
                media.write_bytes(b"a public media fixture")
                extractor = constructor.return_value.__enter__.return_value
                extractor.extract_info.return_value = video_info(key)
                extractor.process_ie_result.return_value = video_info(key)
                extractor.prepare_filename.return_value = str(media)
                result, metadata = worker.retrieve_media(url, root)
                self.assertEqual(result, media.resolve())
                self.assertEqual(metadata, {"title": "Public test", "creator": "Creator"})
                options = constructor.call_args.args[0]
                self.assertEqual(options["format"], expected_format)
                self.assertTrue(options["noplaylist"])
                self.assertFalse(options["cachedir"])
                self.assertEqual(options["max_filesize"], worker.MAX_BYTES)
                extractor.extract_info.assert_called_once_with(worker.validate_video_url(url), download=False, process=False)
                extractor.process_ie_result.assert_called_once()
                with self.assertRaises(ValueError):
                    options["progress_hooks"][0]({"downloaded_bytes": worker.MAX_BYTES + 1})

    def test_tiktok_refreshes_legacy_stream_metadata_in_the_download_session(self):
        url = "https://vt.tiktok.com/AbCdEf12/"
        with tempfile.TemporaryDirectory() as directory, patch("yt_dlp.YoutubeDL") as constructor:
            root = Path(directory)
            worker.atomic_json(root / "video-info.json", video_info("TikTok", id="stale-stream"))
            media = root / "fresh.mp4"
            media.write_bytes(b"fresh public video fixture")
            extractor = constructor.return_value.__enter__.return_value
            fresh = video_info("TikTok", id="fresh-stream")
            events = []

            def extract(*args, **kwargs):
                # TikTok's temporary access cookies live in this extractor session.
                events.append("fresh-session")
                return fresh

            def download(info, **kwargs):
                self.assertEqual(events, ["fresh-session"])
                self.assertEqual(info["id"], "fresh-stream")
                events.append("download")
                return info

            extractor.extract_info.side_effect = extract
            extractor.process_ie_result.side_effect = download
            extractor.prepare_filename.return_value = str(media)
            result, _ = worker.retrieve_media(url, root)
            self.assertEqual(result, media.resolve())
            constructor.assert_called_once()
            extractor.extract_info.assert_called_once_with(url, download=False, process=False)
            extractor.process_ie_result.assert_called_once_with(fresh, download=True)
            self.assertEqual(events, ["fresh-session", "download"])

    def test_fresh_tiktok_metadata_is_validated_before_downloading_despite_legacy_cache(self):
        for fresh in (video_info("Generic"), video_info("TikTok", availability="private"),
                      video_info("TikTok", duration=worker.MAX_DURATION + 1)):
            with self.subTest(fresh=fresh), tempfile.TemporaryDirectory() as directory, patch("yt_dlp.YoutubeDL") as constructor:
                root = Path(directory)
                worker.atomic_json(root / "video-info.json", video_info("TikTok", id="stale-but-eligible"))
                extractor = constructor.return_value.__enter__.return_value
                extractor.extract_info.return_value = fresh
                with self.assertRaises(ValueError):
                    worker.retrieve_media("https://vt.tiktok.com/AbCdEf12/", root)
                extractor.extract_info.assert_called_once()
                extractor.process_ie_result.assert_not_called()

    def test_instagram_keeps_its_validated_video_metadata_handoff(self):
        with tempfile.TemporaryDirectory() as directory, patch("yt_dlp.YoutubeDL") as constructor:
            root = Path(directory)
            saved = video_info("Instagram", id="instagram-video")
            worker.atomic_json(root / "video-info.json", saved)
            media = root / "instagram.mp4"
            media.write_bytes(b"public Instagram video fixture")
            extractor = constructor.return_value.__enter__.return_value
            extractor.process_ie_result.return_value = saved
            extractor.prepare_filename.return_value = str(media)
            result, _ = worker.retrieve_media("https://www.instagram.com/reel/Chunk8-jurw/", root)
            self.assertEqual(result, media.resolve())
            extractor.extract_info.assert_not_called()
            extractor.process_ie_result.assert_called_once_with(saved, download=True)

    def test_public_access_failures_are_actionable_without_signed_urls(self):
        for source, expected in [
            ("Sign in to confirm you’re not a bot https://media.example/file?token=secret", "blocked automatic access"),
            ("Login required; cookies=private-secret", "signed-in"),
            ("HTTP Error 429", "limited"),
            ("Video has been deleted", "unavailable"),
            ("Connection timed out https://media.example/file?token=secret", "connection"),
        ]:
            with self.subTest(source=source):
                message = worker.public_access_error(RuntimeError(source), "youtube")
                self.assertIn(expected, message)
                self.assertNotIn("secret", message)
                self.assertNotIn("https://", message)


if __name__ == "__main__":
    unittest.main()
