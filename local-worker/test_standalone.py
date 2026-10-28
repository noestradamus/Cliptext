import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import insights
import ocr
import standalone


def model(root, name):
    directory = root / name
    directory.mkdir()
    (directory / "config.json").write_text("{}")
    (directory / "model.safetensors").write_bytes(b"synthetic-model")
    return directory


def run_cli(arguments):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code = standalone.main(arguments)
    return code, json.loads(output.getvalue())


class StandaloneTests(unittest.TestCase):
    def test_transcription_reuses_explicit_local_weights_without_site_or_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "speech.mp4"; source.write_bytes(b"synthetic-media")
            weights = model(root, "speech-model")
            output = root / "output"
            speech = {"transcript": "A useful local transcript.", "segments": [], "language": "en"}
            with patch("worker.audio_from_media", return_value=(source, 4.0)), patch("worker.transcribe_file", return_value=speech) as transcribe, patch("worker.prepare_model", side_effect=AssertionError("No downloads")), patch("worker.SiteClient", side_effect=AssertionError("No Site client")):
                code, result = run_cli(["transcribe", "--input", str(source), "--speech-model", str(weights), "--output-dir", str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(result["transcript"], speech["transcript"])
            transcribe.assert_called_once_with(source, weights)
            self.assertEqual(json.loads((output / "result.json").read_text())["status"], "completed")
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")

    def test_media_url_is_rejected_before_processing_or_downloading(self):
        with tempfile.TemporaryDirectory() as temporary, patch("worker.audio_from_media") as process, patch("worker.prepare_model") as download, patch("worker.SiteClient") as site:
            code, result = run_cli(["transcribe", "--input", "https://example.com/private.mp4", "--speech-model", temporary, "--output-dir", temporary])
            self.assertEqual(code, 1)
            self.assertIn("local file", result["error"])
            process.assert_not_called(); download.assert_not_called(); site.assert_not_called()

    def test_relative_or_missing_model_is_an_error_not_automatic_setup(self):
        with tempfile.TemporaryDirectory() as temporary, patch("worker.transcribe_file") as process, patch("worker.prepare_model") as download:
            root = Path(temporary).resolve()
            source = root / "speech.wav"; source.write_bytes(b"fixture")
            for weights in ("relative-model", str(root / "missing")):
                code, result = run_cli(["transcribe", "--input", str(source), "--speech-model", weights, "--output-dir", str(root / "output")])
                self.assertEqual(code, 1)
                self.assertEqual(result["status"], "failed")
            process.assert_not_called(); download.assert_not_called()

    def test_summary_fallback_is_not_reported_as_successful_model_inference(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "source.txt"; source.write_text("Price products according to customer value.")
            weights = model(root, "insights-model")
            output = root / "output"
            with patch("insights.generate_insights", return_value={"engine": insights.FALLBACK_NAME}):
                code, result = run_cli(["insights", "--input", str(source), "--insights-model", str(weights), "--output-dir", str(output)])
            self.assertEqual(code, 1)
            self.assertEqual(result["status"], "failed")
            self.assertIn("fallback was not accepted", result["error"])

    def test_json_extraction_can_be_used_as_local_summary_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "extraction.json"; source.write_text(json.dumps({"transcript": "Customer value guides pricing."}))
            weights = model(root, "insights-model")
            answer = {"engine": insights.MODEL_NAME, "title": "Customer Value Pricing", "insights": {"summary": "Customer value guides pricing."}}
            with patch("insights.generate_insights", return_value=answer) as generate:
                code, result = run_cli(["insights", "--input", str(source), "--insights-model", str(weights), "--output-dir", str(root / "output")])
            self.assertEqual(code, 0)
            self.assertEqual(generate.call_args.args[0]["job"]["transcript"], "Customer value guides pricing.")
            self.assertEqual(result["engine"], insights.MODEL_NAME)

    def test_ocr_requires_precompiled_helper_before_native_recognition(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.environ, {}, clear=True), patch("ocr.ocr_images") as recognize, patch("ocr._run") as run:
            root = Path(temporary).resolve()
            source = root / "image.png"; source.write_bytes(b"fixture")
            code, result = run_cli(["ocr", "--input", str(source), "--output-dir", str(root / "output")])
            self.assertEqual(code, 1)
            self.assertIn("precompiled", result["error"])
            recognize.assert_not_called(); run.assert_not_called()

    def test_ocr_preserves_order_and_full_text_from_local_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            helper = root / "vision-ocr"; helper.write_bytes(b"fixture"); helper.chmod(0o700)
            sources = [root / "second.png", root / "first.png"]
            for source in sources: source.write_bytes(b"fixture")
            pages = [{"index": 1, "text": "Second", "allText": "Second plus detail"}, {"index": 2, "text": "First", "allText": "First plus detail"}]
            with patch.dict(os.environ, {"CLIPTEXT_VISION_OCR_HELPER": str(helper)}), patch("ocr.ocr_images", return_value=pages) as recognize:
                code, result = run_cli(["ocr", "--input", str(sources[0]), "--input", str(sources[1]), "--output-dir", str(root / "output")])
            self.assertEqual(code, 0)
            self.assertEqual(result["transcript"], "Second\n\nFirst")
            self.assertEqual(result["pages"], pages)
            self.assertEqual(recognize.call_args.args[0], sources)

    def test_thumbnail_passes_first_frame_mode_without_retrieving_platform_metadata(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = root / "video.mp4"; source.write_bytes(b"fixture")
            output = root / "output"
            with patch("worker.encode_preview", return_value=output / "preview.jpg") as encode, patch("worker.retrieve_preview", side_effect=AssertionError("No network")):
                code, result = run_cli(["thumbnail", "--input", str(source), "--first-frame", "--output-dir", str(output)])
            self.assertEqual(code, 0)
            self.assertEqual(result["preview"]["kind"], "first_frame")
            encode.assert_called_once_with(source, output, first_frame=True)

    def test_doctor_does_not_accept_external_python_or_tools_as_bundled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            helper = root / "vision-ocr"; helper.write_bytes(b"fixture"); helper.chmod(0o700)
            options = argparse.Namespace(require_bundle=True, speech_model=None, insights_model=None)
            spec = types.SimpleNamespace(origin="/external/packages/module.py")
            with patch.dict(os.environ, {"CLIPTEXT_BUNDLE_ROOT": str(root), "CLIPTEXT_VISION_OCR_HELPER": str(helper)}), patch("standalone.platform.system", return_value="Darwin"), patch("standalone.platform.machine", return_value="arm64"), patch("standalone.shutil.which", return_value="/opt/homebrew/bin/tool"), patch("standalone.importlib.util.find_spec", return_value=spec), patch("standalone.importlib.metadata.version", return_value="fixture"):
                result = standalone.doctor(options)
            self.assertFalse(result["ready"])
            self.assertFalse(result["python"]["bundled"])
            self.assertFalse(result["tools"]["ffmpeg"]["bundled"])


class PackagedOCRHelperTests(unittest.TestCase):
    def test_precompiled_helper_is_used_without_source_or_compiler(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            helper = root / "vision-ocr"; helper.write_bytes(b"native-fixture"); helper.chmod(0o700)
            with patch.dict(os.environ, {"CLIPTEXT_VISION_OCR_HELPER": str(helper)}), patch("ocr.platform.system", return_value="Darwin"), patch("ocr._run") as run:
                self.assertEqual(ocr._helper(root / "runtime", 1), helper)
            run.assert_not_called()

    def test_bad_explicit_helper_fails_closed_without_compiling(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            no_execute = root / "not-executable"; no_execute.write_bytes(b"fixture"); no_execute.chmod(0o600)
            for value in ("", "relative-tool", str(root / "missing"), str(no_execute)):
                with self.subTest(value=value), patch.dict(os.environ, {"CLIPTEXT_VISION_OCR_HELPER": value}), patch("ocr.platform.system", return_value="Darwin"), patch("ocr._run") as run:
                    with self.assertRaisesRegex(ocr.OCRError, "packaged"):
                        ocr._helper(root, 1)
                    run.assert_not_called()

    def test_packaged_helper_upgrade_invalidates_ocr_observation_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            helper = root / "vision-ocr"; helper.write_bytes(b"version-one"); helper.chmod(0o700)
            source = root / "source.jpg"; source.write_bytes(b"image-fixture")
            block = {"text": "Cached text", "confidence": 1, "x": .1, "y": .1, "width": .5, "height": .05}
            with patch.dict(os.environ, {"CLIPTEXT_VISION_OCR_HELPER": str(helper)}), patch("ocr.platform.system", return_value="Darwin"), patch("ocr._run", return_value=json.dumps({"blocks": [block]}).encode()) as run:
                ocr.ocr_images([source], root, root)
                ocr.ocr_images([source], root, root)
                self.assertEqual(run.call_count, 1)
                helper.write_bytes(b"version-two")
                ocr.ocr_images([source], root, root)
                self.assertEqual(run.call_count, 2)


if __name__ == "__main__":
    unittest.main()
