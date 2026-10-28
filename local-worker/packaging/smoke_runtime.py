#!/usr/bin/env python3
"""Run inside the restrictive macOS smoke sandbox using bundled Python only."""
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    bundle = root / 'Cliptext Engine'
    fixtures = root / 'fixtures'
    output = root / 'results'
    output.mkdir(mode=0o700, exist_ok=True)
    environment = {
        'PATH': str(bundle / 'bin') + ':/usr/bin:/bin:/usr/sbin:/sbin',
        'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8',
        'TMPDIR': str(root / 'tmp'), 'XDG_CACHE_HOME': str(root / 'cache'),
        'HF_HOME': str(root / 'cache' / 'huggingface'),
        'TIKTOKEN_CACHE_DIR': str(root / 'cache' / 'tiktoken'),
        'NUMBA_CACHE_DIR': str(root / 'cache' / 'numba'),
        'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
        'HF_HUB_DISABLE_TELEMETRY': '1', 'PYTHONNOUSERSITE': '1',
        'PYTHONDONTWRITEBYTECODE': '1', 'TOKENIZERS_PARALLELISM': 'false',
    }
    report = {
        'format': 'cliptext-engine-smoke', 'version': 1, 'passed': False,
        'isolation': json.loads((root / 'isolation.json').read_text()),
        'physicalCleanMacTest': False, 'tests': [],
    }

    def record(name: str, started: float, **values):
        entry = {'name': name, 'passed': True, 'seconds': round(time.monotonic() - started, 3), **values}
        report['tests'].append(entry)
        print(json.dumps(entry), flush=True)

    def command(name: str, arguments: list[str], timeout=300) -> dict:
        started = time.monotonic()
        result = subprocess.run(arguments, env=environment, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=timeout)
        (output / (name + '.stdout.log')).write_text(result.stdout)
        (output / (name + '.stderr.log')).write_text(result.stderr)
        if result.returncode:
            raise RuntimeError(f'{name} exited {result.returncode}; inspect the saved logs.')
        try:
            value = json.loads(result.stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f'{name} did not return JSON; inspect the saved logs.') from None
        return {'started': started, 'value': value}

    try:
        started = time.monotonic()
        try:
            with socket.socket() as connection:
                connection.settimeout(2)
                connection.connect(('1.1.1.1', 443))
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EACCES):
                raise RuntimeError('Network failed without proving sandbox denial.') from error
        else:
            raise RuntimeError('Sandbox did not block the network control.')
        with_network = False
        try:
            with Path('/opt/homebrew/bin/python3').open('rb'):
                with_network = True
        except PermissionError:
            pass
        if with_network:
            raise RuntimeError('Sandbox did not block the Homebrew control.')
        try:
            subprocess.run(['/usr/bin/xcrun', '--version'], check=False, capture_output=True)
        except PermissionError:
            pass
        else:
            raise RuntimeError('Sandbox did not block the developer-tool control.')
        for immutable in (bundle, root / 'models'):
            sentinel = immutable / '.write-control'
            try:
                sentinel.write_text('This write must be denied by the test sandbox.')
            except PermissionError:
                pass
            else:
                sentinel.unlink()
                raise RuntimeError('Sandbox did not keep the package and models read-only.')
        record('isolation-controls', started, networkDenied=True, homebrewDenied=True, xcrunDenied=True,
               bundleReadOnly=True, modelsReadOnly=True)

        engine = str(bundle / 'cliptext-engine')
        speech_model = str(root / 'models' / 'whisper-large-v3')
        insight_model = str(root / 'models' / 'qwen3-4b')
        result = command('doctor', [engine, 'doctor', '--require-bundle', '--speech-model', speech_model, '--insights-model', insight_model])
        if not result['value'].get('ready'):
            raise RuntimeError('The relocated engine doctor is not ready.')
        report['doctor'] = result['value']
        record('doctor', result['started'], bundled=True)

        result = command('speech', [engine, 'transcribe', '--input', str(fixtures / 'speech.wav'),
                         '--speech-model', speech_model, '--output-dir', str(output / 'speech')], timeout=600)
        value = result['value']
        text = value.get('transcript', '').casefold()
        expected = json.loads((fixtures / 'expectations.json').read_text()).get('speechWords', [])
        if not text.strip() or not value.get('segments') or not all(word.casefold() in text for word in expected):
            raise RuntimeError('Speech output did not match the checked reference content.')
        record('speech', result['started'], characters=len(text), segments=len(value['segments']), model='Whisper large-v3')

        result = command('ocr', [engine, 'ocr', '--input', str(fixtures / 'slide.jpg'), '--output-dir', str(output / 'ocr')])
        value = result['value']
        expected = json.loads((fixtures / 'expectations.json').read_text()).get('ocrWords', [])
        text = value.get('transcript', '').casefold()
        if value.get('ocrEngine') != 'Apple Vision' or not text.strip() or not all(word.casefold() in text for word in expected):
            raise RuntimeError('OCR output did not match the checked image content.')
        record('ocr', result['started'], characters=len(text), engine=value['ocrEngine'])

        result = command('insights', [engine, 'insights', '--input', str(fixtures / 'insights.txt'),
                         '--insights-model', insight_model, '--output-dir', str(output / 'insights')], timeout=300)
        value = result['value']
        summary = value.get('insights', {}).get('summary', '')
        title = value.get('title', '')
        if (value.get('engine') != 'Qwen3 4B Instruct 2507 · local MLX' or not title or not summary
                or len(summary) > 100 or len(summary.split()) > 16 or '\n' in summary
                or len(title) > 70 or len(value.get('suggestions', {}).get('tags', [])) > 3):
            raise RuntimeError('Actual local Qwen output or output bounds failed.')
        record('insights', result['started'], engine=value['engine'], title=title, summary=summary)

        result = command('thumbnail', [engine, 'thumbnail', '--input', str(fixtures / 'video.mp4'),
                         '--first-frame', '--output-dir', str(output / 'thumbnail')])
        image = Path(result['value']['preview']['path'])
        probe = command('thumbnail-probe', [str(bundle / 'bin' / 'ffprobe'), '-v', 'error', '-show_entries',
                        'stream=codec_name,width,height', '-of', 'json', str(image)])
        streams = probe['value'].get('streams', [])
        if (len(streams) != 1 or streams[0].get('codec_name') != 'mjpeg' or
                not 0 < streams[0].get('width', 0) <= 640 or not 0 < streams[0].get('height', 0) <= 640
                or not 0 < image.stat().st_size <= 150 * 1024):
            raise RuntimeError('First-frame JPEG did not pass the actual codec/dimension/size probe.')
        record('thumbnail', result['started'], bytes=image.stat().st_size, **streams[0])

        result = command('javascript', [str(bundle / 'bin' / 'node'), '-e',
                         'console.log(JSON.stringify({ok:6*7===42,version:process.version,executable:process.execPath}))'])
        if not result['value'].get('ok') or not Path(result['value']['executable']).is_relative_to(bundle):
            raise RuntimeError('The bundled JavaScript runtime failed.')
        record('javascript', result['started'], **result['value'])
        report['passed'] = True
    except Exception as error:
        report['failure'] = str(error)
        print(json.dumps({'failed': str(error)}), flush=True)
    finally:
        (root / 'smoke-report.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
