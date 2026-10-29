from __future__ import annotations
import importlib.util
from pathlib import Path
import re
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location('cliptext_shortcuts', Path(__file__).resolve().parents[1] / 'generate.py')
generator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generator)

class WorkflowSafetyTests(unittest.TestCase):
    def setUp(self):
        self.workflows = {name: generator.build(name) for name in ['Save to Cliptext', 'Sync Cliptext']}
    def test_both_have_one_explicit_local_folder_question(self):
        for workflow in self.workflows.values():
            questions = workflow['WFWorkflowImportQuestions']
            self.assertEqual(len(questions), 1)
            self.assertEqual(questions[0]['ParameterKey'], 'WFFolder')
            self.assertEqual(questions[0]['ActionIndex'], 0)
            self.assertIn('On My iPhone', questions[0]['Text'])
            first = workflow['WFWorkflowActions'][0]
            self.assertEqual(first['WFWorkflowActionIdentifier'], 'is.workflow.actions.file.createfolder')
            self.assertEqual(first['WFWorkflowActionParameters']['WFFilePath'], 'Cliptext')
            self.assertNotIn('WFFolder', first['WFWorkflowActionParameters'])
    def test_shared_request_is_persisted_before_prompt_or_network(self):
        actions = self.workflows['Save to Cliptext']['WFWorkflowActions']
        first_save = next(i for i, a in enumerate(actions) if a['WFWorkflowActionIdentifier'].endswith('documentpicker.save'))
        first_prompt = next(i for i, a in enumerate(actions) if a['WFWorkflowActionIdentifier'].endswith('.ask'))
        first_network = next(i for i, a in enumerate(actions) if a['WFWorkflowActionIdentifier'].endswith('.downloadurl'))
        self.assertLess(first_save, first_prompt)
        self.assertLess(first_save, first_network)
        self.assertFalse(actions[first_save]['WFWorkflowActionParameters']['WFSaveFileOverwrite'])
    def test_generic_templates_have_no_address_or_capability(self):
        for workflow in self.workflows.values():
            serialized = repr(workflow)
            self.assertNotRegex(serialized, r'https://[a-z0-9][a-z0-9.-]*\.ts\.net')
            self.assertNotIn('Bearer ey', serialized)
            self.assertNotIn('fileProviderDomainID', serialized)
            self.assertNotIn('com.apple.CloudDocs', serialized)
    def test_ids_are_unique_and_control_groups_are_balanced(self):
        for workflow in self.workflows.values():
            seen, groups = set(), []
            for action in workflow['WFWorkflowActions']:
                parameters = action['WFWorkflowActionParameters']
                identifier = parameters['UUID']
                uuid.UUID(identifier)
                self.assertNotIn(identifier, seen)
                seen.add(identifier)
                mode = parameters.get('WFControlFlowMode')
                if mode == 0: groups.append(parameters['GroupingIdentifier'])
                elif mode == 1: self.assertEqual(groups[-1], parameters['GroupingIdentifier'])
                elif mode == 2: self.assertEqual(groups.pop(), parameters['GroupingIdentifier'])
            self.assertEqual(groups, [])
    def test_action_references_only_point_backward(self):
        def visit(value):
            if isinstance(value, dict):
                if value.get('Type') == 'ActionOutput': yield value['OutputUUID']
                for child in value.values(): yield from visit(child)
            elif isinstance(value, list):
                for child in value: yield from visit(child)
        for workflow in self.workflows.values():
            seen = set()
            for action in workflow['WFWorkflowActions']:
                for reference in visit(action['WFWorkflowActionParameters']): self.assertIn(reference, seen)
                seen.add(action['WFWorkflowActionParameters']['UUID'])
    def test_text_tokens_have_valid_ranges_and_attachment_types(self):
        def visit(value):
            if isinstance(value, dict):
                if value.get('WFSerializationType') == 'WFTextTokenString':
                    content = value['Value']; text = content['string'].encode('utf-16-le')
                    for range_, attachment in content['attachmentsByRange'].items():
                        offset = int(re.fullmatch(r'\{(\d+), 1\}', range_).group(1))
                        self.assertEqual(text[2 * offset:2 * offset + 2], '\ufffc'.encode('utf-16-le'))
                        self.assertIn(attachment['Type'], ['ActionOutput', 'Variable', 'ExtensionInput'])
                for child in value.values(): visit(child)
            elif isinstance(value, list):
                for child in value: visit(child)
        for workflow in self.workflows.values(): visit(workflow)
    def test_only_scoped_post_network_action(self):
        for workflow in self.workflows.values():
            actions = workflow['WFWorkflowActions']
            posts = [a['WFWorkflowActionParameters'] for a in actions if a['WFWorkflowActionIdentifier'].endswith('.downloadurl')]
            self.assertEqual(len(posts), 1)
            self.assertEqual(posts[0]['WFHTTPMethod'], 'POST')
            self.assertIn('/api/shortcut/links', repr(posts[0]['WFURL']))
            self.assertIn('Mac Origin', repr(posts[0]['WFURL']))
            self.assertEqual(posts[0]['WFHTTPBodyType'], 'File')
            self.assertIn('Submission Token', repr(posts[0]['WFHTTPHeaders']))
    def test_archival_requires_all_three_receipt_checks(self):
        for workflow in self.workflows.values():
            active = []
            for action in workflow['WFWorkflowActions']:
                parameters = action['WFWorkflowActionParameters']
                if parameters.get('WFControlFlowMode') == 0: active.append(parameters)
                if action['WFWorkflowActionIdentifier'].endswith('.file.move'):
                    controls = repr(active)
                    self.assertIn('Library ID', controls)
                    self.assertIn('Pending ID', controls)
                    self.assertEqual(sum(p.get('WFCondition') == 100 for p in active), 1)
                    self.assertFalse(parameters['WFReplaceExisting'])
                if parameters.get('WFControlFlowMode') == 2: active.pop()
    def test_no_deletion_or_app_browser_launch_actions(self):
        forbidden = ['file.delete', 'openurl', 'openapp', 'runjavascript', 'runscript', 'askllm']
        for workflow in self.workflows.values():
            for action in workflow['WFWorkflowActions']:
                self.assertFalse(any(word in action['WFWorkflowActionIdentifier'] for word in forbidden))
            self.assertTrue(workflow['WFWorkflowActions'][-1]['WFWorkflowActionIdentifier'].endswith('.nothing'))
            self.assertFalse(workflow['WFWorkflowHasOutputFallback'])
    def test_save_is_share_sheet_and_sync_is_not(self):
        self.assertIn('ActionExtension', self.workflows['Save to Cliptext']['WFWorkflowTypes'])
        self.assertEqual(self.workflows['Sync Cliptext']['WFWorkflowTypes'], [])

class InputPolicyTests(unittest.TestCase):
    def test_supported_links(self):
        urls = ['https://www.tiktok.com/@sample_creator/video/1234567890123456789',
                'https://www.tiktok.com/@sample_creator/photo/1234567890123456789?x=one',
                'https://vt.tiktok.com/AbCdEfG12/', 'https://vm.tiktok.com/AbCdEfG12/',
                'https://www.tiktok.com/t/AbCdEf12/', 'https://m.tiktok.com/t/AbCdEf12/?share=1',
                'https://www.youtu.be/abcdefghijk',
                'https://youtu.be/abcdefghijk?si=sample', 'https://www.youtube.com/watch?v=abcdefghijk&feature=share',
                'https://www.youtube.com/shorts/abcdefghijk', 'https://www.instagram.com/p/AbCdEfGh1/?img_index=2',
                'https://www.instagram.com/reel/AbCdEfGh1/']
        for url in urls: self.assertIsNotNone(re.fullmatch(generator.SUPPORTED_URL, url, re.I), url)
    def test_rejects_wrong_hosts_credentials_and_profiles(self):
        urls = ['http://vt.tiktok.com/AbCdEfG12/', 'https://tiktok.com.evil.test/@sample/video/1234567890123456789',
                'https://user:password@www.tiktok.com/@sample/video/1234567890123456789',
                'https://www.tiktok.com/@sample_creator', 'https://instagram.com/sample_creator/',
                'https://youtube.com/playlist?list=one', 'https://www.instagram.com:444/p/AbCdEfGh1/']
        for url in urls: self.assertIsNone(re.fullmatch(generator.SUPPORTED_URL, url, re.I), url)
    def test_origin_policy_is_exact_trusted_tailscale_hostname(self):
        self.assertIsNotNone(re.fullmatch(generator.ORIGIN_PATTERN, 'https://sample-mac.example-tailnet.ts.net'))
        for origin in ['http://sample-mac.example-tailnet.ts.net', 'https://sample-mac.example-tailnet.ts.net.evil.test',
                       'https://user@sample-mac.example-tailnet.ts.net', 'https://sample-mac.example-tailnet.ts.net/path',
                       'https://sample-mac.example-tailnet.ts.net?token=one', 'https://example.test']:
            self.assertIsNone(re.fullmatch(generator.ORIGIN_PATTERN, origin), origin)
    def test_generated_request_id_has_valid_version_and_variant(self):
        replacement = r'\g<1>-\g<2>-5\g<3>-8\g<4>-\g<5>'
        seen = set()
        for i in range(1000):
            digest = generator.hashlib.sha256(('sample-url-date-random-' + str(i)).encode()).hexdigest()
            identifier = re.sub(generator.UUID_FROM_HASH, replacement, digest)
            parsed = uuid.UUID(identifier)
            self.assertEqual(parsed.version, 5)
            self.assertEqual(parsed.variant, uuid.RFC_4122)
            self.assertNotIn(identifier, seen); seen.add(identifier)

if __name__ == '__main__': unittest.main()
