import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import ocr


def line(text, y, height=0.03, x=0.1, width=0.8, confidence=1.0):
    return dict(text=text, x=x, y=y, width=width, height=height, confidence=confidence)


def encoded(blocks):
    return json.dumps({"blocks": blocks}).encode()


class MainTextTests(unittest.TestCase):
    def test_caption_and_short_last_line_survive_tiny_background(self):
        background = [line("small screenshot detail", 0.05 + n * 0.015, 0.008) for n in range(25)]
        caption = [line("A prominent heading", 0.6, 0.04), line("First complete explanation line.", 0.65),
                   line("Second explanation line.", 0.69), line("End.", 0.73, 0.024, width=0.07)]
        page = ocr.page_from_blocks(background + caption, 1)
        self.assertEqual(page["text"], "\n".join(item["text"] for item in caption))
        self.assertIn("small screenshot detail", page["allText"])

    def test_top_list_and_lower_callout_are_not_cropped_by_position(self):
        main = [line(f"{n + 1}. A complete course name", 0.10 + n * 0.05) for n in range(5)]
        main += [line("SAVE THIS", 0.4, 0.05, x=0.3, width=0.4),
                 line("for later reading", 0.47, 0.035, x=0.25, width=0.5),
                 line("Follow for more resources", 0.56, 0.025, x=0.3, width=0.4)]
        background = [line("small code", 0.05 + n * 0.07, 0.008, x=0.02, width=0.15) for n in range(7)]
        background += [line("profile name", 0.61, 0.019, x=0.4, width=0.2)]
        page = ocr.page_from_blocks(background + main, 1)
        self.assertEqual(page["text"], "\n".join(item["text"] for item in main))

    def test_uniform_legible_text_keeps_separate_paragraphs(self):
        blocks = [line("Top paragraph.", 0.1), line("Middle paragraph.", 0.45), line("Last paragraph.", 0.8)]
        self.assertEqual(ocr.page_from_blocks(blocks, 1)["text"], "Top paragraph.\nMiddle paragraph.\nLast paragraph.")

    def test_single_line_and_blank_image_are_valid_pages(self):
        self.assertEqual(ocr.page_from_blocks([line("日本語の見出し", 0.4)], 3),
                         {"index": 3, "text": "日本語の見出し", "allText": "日本語の見出し"})
        self.assertEqual(ocr.page_from_blocks([], 2), {"index": 2, "text": "", "allText": ""})

    def test_order_is_top_to_bottom_then_left_to_right_on_same_row(self):
        blocks = [line("bottom", 0.5), line("right", 0.101, x=0.6, width=0.3),
                  line("left", 0.1, x=0.1, width=0.3)]
        self.assertEqual(ocr.page_from_blocks(blocks, 1)["allText"], "left\nright\nbottom")

    def test_selection_never_rewrites_recognized_words(self):
        text = "Raw  spacing & an OCR eror stays."
        self.assertEqual(ocr.page_from_blocks([line(text, 0.1)], 1)["text"], text)

    def test_isolated_logo_does_not_replace_caption(self):
        blocks = [line("LOGO", 0.1, 0.05, width=0.2)]
        blocks += [line("tiny screenshot", 0.22 + n * 0.02, 0.008) for n in range(10)]
        caption = [line("A useful main heading", 0.6, 0.04)]
        caption += [line("A complete explanation with several important words.", 0.65 + n * 0.04) for n in range(3)]
        self.assertEqual(ocr.page_from_blocks(blocks + caption, 1)["text"], "\n".join(item["text"] for item in caption))


class OCRBoundaryTests(unittest.TestCase):
    def test_strict_json_and_geometry(self):
        valid = line("valid", 0.2)
        self.assertEqual(ocr._parse(encoded([valid])), [valid])
        bad = [b'{"blocks":[],"blocks":[]}', b'{"blocks":[],"other":1}', b'{"blocks":NaN}',
               encoded([dict(valid, x=True)]), encoded([dict(valid, width=2)]),
               encoded([dict(valid, x=0.9)]), encoded([dict(valid, confidence=float("nan"))]),
               encoded([dict(valid, text="bad\x00text")]), b"[]", b"not JSON"]
        for data in bad:
            with self.subTest(data=data), self.assertRaises(ocr.OCRError):
                ocr._parse(data)

    def test_text_and_block_limits(self):
        for data in [encoded([line("x" * 16385, 0.1)]), encoded([line("a", 0.1)] * 1001),
                     b" " * (ocr.MAX_OUTPUT_BYTES + 1)]:
            with self.assertRaises(ocr.OCRError):
                ocr._parse(data)

    def test_helper_environment_has_no_worker_secrets(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {"CLIPTEXT_KEY": "private", "HTTPS_PROXY": "private"}):
            env = ocr._environment(Path(temporary))
            self.assertNotIn("CLIPTEXT_KEY", env)
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertNotIn("HOME", env)
            self.assertEqual(Path(env["TMPDIR"]).parent, Path(temporary))

    def test_timeout_kills_owned_process_group_and_hides_details(self):
        with tempfile.TemporaryDirectory() as temporary, patch("ocr.subprocess.Popen") as popen, patch("ocr.os.killpg") as kill:
            process = popen.return_value
            process.pid = 1234
            process.wait.side_effect = [subprocess.TimeoutExpired("private image", 1), 0]
            with self.assertRaisesRegex(ocr.OCRError, "timed out") as error:
                ocr._run(["helper", "private image"], Path(temporary), 1)
            self.assertNotIn("private", str(error.exception))
            kill.assert_called_once_with(1234, ocr.signal.SIGKILL)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            self.assertIs(popen.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_total_timeout_prevents_starting_another_image(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "image.jpg"
            source.write_bytes(b"fixture")
            with patch("ocr._helper", return_value=root / "helper"), patch("ocr.time.monotonic", side_effect=[0, ocr.TOTAL_TIMEOUT + 1]), patch("ocr.subprocess.Popen") as popen:
                with self.assertRaisesRegex(ocr.OCRError, "timed out"):
                    ocr.ocr_images([source], root)
                popen.assert_not_called()

    def test_image_order_blank_pages_and_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sources = [root / "second.jpg", root / "first.jpg"]
            for path in sources:
                path.write_bytes(b"fixture")
            with patch("ocr._helper", return_value=root / "helper"), patch("ocr._run", side_effect=[encoded([line("second", 0.1)]), encoded([])]) as run:
                self.assertEqual(ocr.ocr_images(sources, root), [
                    {"index": 1, "text": "second", "allText": "second"},
                    {"index": 2, "text": "", "allText": ""}])
                self.assertEqual([call.args[0][-1] for call in run.call_args_list], [str(p.resolve()) for p in sources])
                self.assertTrue(all(0 < call.args[2] <= ocr.IMAGE_TIMEOUT for call in run.call_args_list))

    def test_failed_slide_does_not_silently_return_partial_post(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "image.jpg"
            source.write_bytes(b"fixture")
            with patch("ocr._helper", return_value=root / "helper"), patch("ocr._run", side_effect=[encoded([]), ocr.OCRError("Failed")]):
                with self.assertRaises(ocr.OCRError):
                    ocr.ocr_images([source, source], root)

    def test_invalid_count_and_missing_or_large_images_do_not_start_native_tool(self):
        with tempfile.TemporaryDirectory() as temporary, patch("ocr._helper") as helper:
            root = Path(temporary)
            for paths in ([], [root / "missing"] * 36, [root / "missing"], [root]):
                with self.assertRaises(ocr.OCRError):
                    ocr.ocr_images(paths, root)
            helper.assert_not_called()

    def test_post_text_limit_matches_backend(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "image.jpg"
            source.write_bytes(b"fixture")
            with patch("ocr._helper", return_value=root / "helper"), patch("ocr._run", return_value=encoded([line("length", 0.1)])), patch("ocr.MAX_TOTAL_TEXT_CHARS", 10):
                with self.assertRaisesRegex(ocr.OCRError, "too much text"):
                    ocr.ocr_images([source, source], root)

    def test_compiled_helper_is_cached_by_source_and_os(self):
        with tempfile.TemporaryDirectory() as temporary, patch("ocr.platform.system", return_value="Darwin"), patch("ocr._run") as run:
            root = Path(temporary)
            with patch("ocr.platform.mac_ver", return_value=("26.1", (), "")):
                first = ocr._helper(root, 10**12)
                self.assertEqual(ocr._helper(root, 10**12), first)
                self.assertEqual(run.call_count, 1)
            with patch("ocr.platform.mac_ver", return_value=("26.2", (), "")):
                self.assertNotEqual(ocr._helper(root, 10**12), first)
                self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
