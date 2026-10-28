import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import image_posts as images

IG = 'https://www.instagram.com/p/ExamplePost12/'
TT = 'https://www.tiktok.com/@example_creator/photo/7000000000000000003'
CDN = 'https://scontent.cdninstagram.com/'


def instagram(entries=None, **extra):
    value = {'id': 'test', 'extractor_key': 'Instagram', 'title': 'Post', 'channel': 'creator', **extra}
    if entries is not None:
        value.update({'_type': 'playlist', 'entries': entries})
    return value


def image_entry(name, **extra):
    return {'thumbnails': [{'url': CDN + name}], 'formats': [], **extra}


class ImagePostBoundaryTests(unittest.TestCase):
    def test_supported_exact_post_forms_and_tracking_removed(self):
        self.assertEqual(images.normalize_post_url(TT + '?share=tracking#fragment'), ('tiktok', TT))
        self.assertEqual(images.normalize_post_url(IG + '?img_index=6'), ('instagram', IG))
        self.assertEqual(images.normalize_post_url('https://vt.tiktok.com/ABCD/'), ('tiktok', 'https://vt.tiktok.com/ABCD/'))
        for url in ['https://evil.test/image.jpg', 'https://www.tiktok.com/@user', 'https://www.instagram.com/user/',
                    'http://www.instagram.com/p/abcdef/', 'https://name:secret@www.instagram.com/p/abcdef/',
                    'https://www.tiktok.com/x/../@user/photo/12345678901', 'https://www.tiktok.com/@u/photo/%2f12345678901',
                    'https://www.instagram.com/p/abcdef/\\evil', 'https://www.instagram.com:444/p/abcdef/']:
            with self.subTest(url=url), self.assertRaises(images.ImagePostError):
                images.normalize_post_url(url)

    def test_only_platform_image_cdns_without_credentials_or_fragments(self):
        self.assertEqual(images._cdn_url(CDN + 'image.jpg', 'instagram'), CDN + 'image.jpg')
        for url in ['http://scontent.cdninstagram.com/i', 'https://cdninstagram.com.evil.test/i',
                    'https://127.0.0.1/i', 'https://secret@scontent.cdninstagram.com/i',
                    'https://scontent.cdninstagram.com/i#frag', 'https://scontent.cdninstagram.com:8443/i',
                    'https://scontent.cdninstagram.com/i\nHeader:secret', 'https://p16.tiktokcdn.com/i']:
            with self.subTest(url=url), self.assertRaises(images.ImagePostError):
                images._cdn_url(url, 'instagram')

    def test_short_links_are_validated_before_each_redirect(self):
        with patch('requests.Session') as constructor:
            session = constructor.return_value.__enter__.return_value
            response = session.head.return_value.__enter__.return_value
            response.status_code = 302
            response.headers = {'Location': TT + '?share=1'}
            self.assertEqual(images._resolve_tiktok_share('https://vt.tiktok.com/ABCD/'), TT)
            self.assertIs(session.trust_env, False)
            self.assertIs(session.head.call_args.kwargs['allow_redirects'], False)
            response.headers = {'Location': 'https://127.0.0.1/private'}
            with self.assertRaises(images.ImagePostError):
                images._resolve_tiktok_share('https://vt.tiktok.com/ABCD/')
            self.assertEqual(session.head.call_count, 2)

    def test_resolution_preference_and_missing_dimension_tiebreaker(self):
        self.assertEqual(images._ordered_candidates([
            {'url': CDN + '150.jpg'}, {'url': CDN + '360.jpg'}, {'url': CDN + 'original.jpg'},
        ], 'instagram')[0], CDN + 'original.jpg')
        self.assertEqual(images._ordered_candidates([
            {'url': CDN + 'original.jpg', 'width': 1074, 'height': 1350},
            {'url': CDN + 'small.jpg', 'width': 150, 'height': 150},
        ], 'instagram')[0], CDN + 'original.jpg')

    def test_download_disables_redirects_credentials_and_proxies(self):
        with tempfile.TemporaryDirectory() as temporary, patch('requests.Session') as constructor:
            session = constructor.return_value.__enter__.return_value
            response = session.get.return_value.__enter__.return_value
            response.status_code, response.headers = 200, {'Content-Type': 'image/jpeg'}
            response.raw.read.side_effect = [b'abc', b'def', b'']
            path = Path(temporary) / 'image'
            budget = {'remaining': 6}
            images._download_image(CDN + 'original.jpg', path, 'instagram', budget)
            self.assertEqual(path.read_bytes(), b'abcdef')
            self.assertEqual(budget['remaining'], 0)
            self.assertIs(session.trust_env, False)
            self.assertIs(session.get.call_args.kwargs['allow_redirects'], False)
            self.assertNotIn('headers', session.get.call_args.kwargs)
            self.assertNotIn('cookies', session.get.call_args.kwargs)

    def test_oversize_content_type_redirect_and_empty_rejected(self):
        cases = [(200, {'Content-Type': 'image/jpeg', 'Content-Length': '7'}, []),
                 (200, {'Content-Type': 'image/jpeg'}, [b'1234567']),
                 (200, {'Content-Type': 'text/html'}, []),
                 (200, {'Content-Type': 'image/jpeg'}, [b'']),
                 (302, {'Content-Type': 'image/jpeg'}, [])]
        for status, headers, chunks in cases:
            with self.subTest(status=status, headers=headers), tempfile.TemporaryDirectory() as temporary, patch('requests.Session') as constructor:
                response = constructor.return_value.__enter__.return_value.get.return_value.__enter__.return_value
                response.status_code, response.headers, response.raw.read.side_effect = status, headers, chunks
                with self.assertRaises(images.ImagePostError):
                    images._download_image(CDN + 'original.jpg', Path(temporary) / 'image', 'instagram', {'remaining': 6})

    def test_claimed_image_type_and_huge_dimensions_are_checked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'image'
            path.write_bytes(b'<svg>unsafe</svg>')
            with self.assertRaises(images.ImagePostError):
                images._validate_image(path)
            path.write_bytes(b'\xff\xd8\xff' + b'x' * 20)
            for stream in [{'codec_name': 'h264', 'width': 100, 'height': 100},
                           {'codec_name': 'mjpeg', 'width': 10000, 'height': 10000}]:
                with patch('image_posts.shutil.which', return_value='/ffprobe'), patch('image_posts.subprocess.run') as run:
                    run.return_value.stdout = json.dumps({'streams': [stream]})
                    with self.assertRaises(images.ImagePostError): images._validate_image(path)
                    self.assertIn('file,pipe', run.call_args.args[0])


class ImagePostExtractionTests(unittest.TestCase):
    def extract_ig(self, raw):
        with patch('yt_dlp.YoutubeDL') as constructor:
            extractor = constructor.return_value.__enter__.return_value
            extractor.extract_info.return_value = raw
            result = images._post_images(IG, 'instagram')
            self.assertIs(constructor.call_args.args[0]['ignore_no_formats_error'], True)
            self.assertEqual(constructor.call_args.args[0]['proxy'], '')
            self.assertIsNone(constructor.call_args.args[0]['cookiesfrombrowser'])
            return result

    def test_instagram_preserves_all_slides_in_source_order(self):
        result = self.extract_ig(instagram([image_entry('one'), image_entry('two'), image_entry('three')]))
        self.assertEqual(result['slides'], [[CDN + 'one'], [CDN + 'two'], [CDN + 'three']])
        self.assertEqual(result['metadata']['creator'], 'creator')

    def test_normal_video_and_video_only_carousel_use_existing_path(self):
        self.assertIsNone(self.extract_ig(instagram(formats=[{'url': 'video'}])))
        self.assertIsNone(self.extract_ig(instagram([{'formats': [{'url': 'a'}]}, {'formats': [{'url': 'b'}]}])))
        self.assertIsNone(self.extract_ig(instagram(formats=[], duration=1, thumbnails=[{'url': CDN + 'cover'}])))
        with patch('image_posts.subprocess.Popen') as process:
            self.assertIsNone(images.retrieve_image_post('https://youtu.be/abcdefghijk', Path('/unused')))
            process.assert_not_called()

    def test_mixed_empty_missing_and_oversize_carousels_rejected(self):
        for raw in [instagram([image_entry('one'), {'formats': [{'url': 'video'}]}]),
                    instagram([]), instagram([image_entry('one'), {}]),
                    instagram([image_entry('one')] * 36)]:
            with self.subTest(raw=raw), self.assertRaises(images.ImagePostError):
                self.extract_ig(raw)

    def test_tiktok_raw_adapter_isolates_private_api_and_keeps_order(self):
        urls = ['https://p16.tiktokcdn.com/one.jpg', 'https://p16.tiktokcdn.com/two.jpg']
        raw = {'desc': 'Post', 'author': {'uniqueId': 'creator'}, 'imagePost': {'images': [
            {'imageURL': {'urlList': [url]}} for url in urls]}}
        with patch('yt_dlp.YoutubeDL') as constructor, patch('image_posts._resolve_tiktok_share', return_value=TT):
            ie = constructor.return_value.__enter__.return_value.get_info_extractor.return_value
            ie._extract_web_data_and_status.return_value = (raw, 0)
            result = images._post_images(TT, 'tiktok')
            self.assertEqual(result['slides'], [[url] for url in urls])
            self.assertIn('/video/', ie._extract_web_data_and_status.call_args.args[0])
            ie._extract_web_data_and_status.return_value = ({'video': {}}, 0)
            self.assertIsNone(images._post_images(TT, 'tiktok'))
            ie._extract_web_data_and_status.return_value = ({'imagePost': {'images': []}}, 0)
            with self.assertRaises(images.ImagePostError): images._post_images(TT, 'tiktok')

    def test_tiktok_video_classification_does_not_export_session_bound_streams(self):
        with tempfile.TemporaryDirectory() as temporary, patch('yt_dlp.YoutubeDL') as constructor, patch('image_posts._resolve_tiktok_share', return_value=TT):
            cache = Path(temporary)
            ie = constructor.return_value.__enter__.return_value.get_info_extractor.return_value
            ie._extract_web_data_and_status.return_value = ({'video': {'playAddr': 'session-bound-stream'}}, 0)
            ie._parse_aweme_video_web.side_effect = AssertionError('The downloader must extract streams in its own session')
            self.assertIsNone(images._post_images(TT, 'tiktok', cache_dir=cache))
            ie._parse_aweme_video_web.assert_not_called()
            self.assertFalse((cache / 'video-info.json').exists())

    def test_original_failure_uses_next_candidate_but_does_not_skip_slide(self):
        post = {'slides': [[CDN + 'original', CDN + 'fallback'], [CDN + 'second']], 'metadata': {'title': 'Test', 'creator': 'owner'}}
        attempted = []
        def download(url, path, platform, budget):
            attempted.append(url)
            if url.endswith('original'): raise images.ImagePostError('Temporary retrieval failure.')
            path.write_bytes(url.encode())
        with tempfile.TemporaryDirectory() as temporary, patch('image_posts._post_images', return_value=post), patch('image_posts._download_image', side_effect=download), patch('image_posts._validate_image', return_value='.jpg'):
            result = images._retrieve(IG, Path(temporary))
            self.assertEqual(result['paths'], ['slide-01.jpg', 'slide-02.jpg'])
            self.assertEqual(result['contentKind'], 'carousel')
            self.assertEqual(attempted, [CDN + 'original', CDN + 'fallback', CDN + 'second'])
        with tempfile.TemporaryDirectory() as temporary, patch('image_posts._post_images', return_value=post), patch('image_posts._download_image', side_effect=RuntimeError('private query token')):
            with self.assertRaisesRegex(images.ImagePostError, 'No slides were omitted'):
                images._retrieve(IG, Path(temporary))

    def test_timeout_kills_child_group_and_preserves_checkpoint_directory(self):
        with tempfile.TemporaryDirectory() as temporary, patch('image_posts.subprocess.Popen') as constructor, patch('image_posts.os.killpg') as kill:
            process = constructor.return_value
            process.pid = 1234
            process.wait.side_effect = [subprocess.TimeoutExpired('retrieve', 180), 0]
            with self.assertRaisesRegex(images.ImagePostError, 'timed out'):
                images.retrieve_image_post(IG, Path(temporary))
            kill.assert_called_once_with(1234, images.signal.SIGKILL)
            self.assertTrue((Path(temporary) / 'image-post').is_dir())
            self.assertIs(constructor.call_args.kwargs['start_new_session'], True)
            self.assertFalse(set(constructor.call_args.kwargs['env']) - {'PATH', 'LANG', 'LC_ALL'})

    def test_result_paths_are_returned_as_paths_in_scratch_directory(self):
        with tempfile.TemporaryDirectory() as temporary, patch('image_posts.subprocess.Popen') as constructor:
            def launch(args, **_):
                root = Path(args[-1]); (root / 'slide-01.jpg').write_bytes(b'image')
                (root / 'result.json').write_text(json.dumps({'post': {'paths': ['slide-01.jpg'], 'metadata': {'title': 'Post', 'creator': ''}, 'contentKind': 'image'}}))
                process = Mock(); process.wait.return_value = 0
                return process
            constructor.side_effect = launch
            result = images.retrieve_image_post(IG, Path(temporary))
            self.assertEqual(result['contentKind'], 'image')
            self.assertIsInstance(result['paths'][0], Path)
            self.assertTrue(result['paths'][0].is_file())


if __name__ == '__main__': unittest.main()
