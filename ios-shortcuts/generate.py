#!/usr/bin/env python3
"""Build credential-free Apple Shortcuts; signing uses Apple's local CLI only.

Local-parent folder bookmarks are selected by the human during import. No iCloud path,
user bearer capability, browser script, or third-party action is embedded.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parent
NAMESPACE = uuid.UUID('bcb87726-8145-45d9-bb2f-2c0d9dff26cf')
ORIGIN_PATTERN = r'^https://[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$'
TOKEN_PATTERN = r'^[A-Za-z0-9_-]{32,256}$'
UUID_FROM_HASH = r'^(.{8})(.{4}).(.{3}).(.{3})(.{12}).*$'
SUPPORTED_URL = (r'^https://(?:(?:www\.|m\.)?tiktok\.com/@[^/\s]+/(?:video|photo)/[0-9]{10,25}'
                 r'|(?:www\.|m\.)?tiktok\.com/t/[A-Za-z0-9_-]{4,80}/?'
                 r'|(?:vt|vm)\.tiktok\.com/[A-Za-z0-9_-]{4,80}/?'
                 r'|(?:www\.|m\.)?youtube\.com/(?:watch\?[^\s]*v=[A-Za-z0-9_-]{11}[^\s]*|shorts/[A-Za-z0-9_-]{11})'
                 r'|(?:www\.)?youtu\.be/[A-Za-z0-9_-]{11}'
                 r'|(?:www\.|m\.)?instagram\.com/(?:p|reel|reels)/[A-Za-z0-9_-]{5,64}/?)(?:[/?#][^\s]*)?$')

def uid(label: str) -> str:
    return str(uuid.uuid5(NAMESPACE, label)).upper()

def attachment(value: dict) -> dict:
    return {'Value': value, 'WFSerializationType': 'WFTextTokenAttachment'}

def output(identifier: str, name: str = 'Result') -> dict:
    return {'OutputUUID': identifier, 'Type': 'ActionOutput', 'OutputName': name}

def variable(name: str) -> dict:
    return {'Type': 'Variable', 'VariableName': name}

def token_text(*parts: str | dict) -> dict:
    if len(parts) == 1 and isinstance(parts[0], dict) and parts[0].get('WFSerializationType') == 'WFTextTokenString':
        return parts[0]
    text, attachments, position = '', {}, 0
    for part in parts:
        if isinstance(part, str):
            text += part
            position += len(part.encode('utf-16-le')) // 2
        else:
            attachments['{%d, 1}' % position] = part
            text += '\ufffc'
            position += 1
    return {'Value': {'string': text, 'attachmentsByRange': attachments}, 'WFSerializationType': 'WFTextTokenString'}

def dictionary(fields: list[tuple[str, str | dict]]) -> dict:
    items = []
    for key, value in fields:
        items.append({'WFItemType': 0, 'WFKey': token_text(key), 'WFValue': token_text(value)})
    return {'Value': {'WFDictionaryFieldValueItems': items}, 'WFSerializationType': 'WFDictionaryFieldValue'}

class Builder:
    def __init__(self, name: str):
        self.name, self.actions, self.stack, self.labels = name, [], [], {}
    def add(self, identifier: str, label: str, **parameters) -> str:
        self.labels[label] = self.labels.get(label, 0) + 1
        action_id = uid(self.name + ':' + label + ':' + str(self.labels[label]))
        parameters = {'UUID': action_id, **parameters}
        self.actions.append({'WFWorkflowActionIdentifier': 'is.workflow.actions.' + identifier, 'WFWorkflowActionParameters': parameters})
        return action_id
    def set(self, name: str, value: dict, label: str | None = None):
        self.add('setvariable', label or 'set-' + name, WFVariableName=name, WFInput=attachment(value))
    def value(self, dictionary_value: dict, key: str, label: str) -> str:
        return self.add('getvalueforkey', label, WFGetDictionaryValueType='Value', WFDictionaryKey=key, WFInput=attachment(dictionary_value))
    def condition(self, value: dict, code: int, label: str, equals: str | dict | None = None):
        group = uid(self.name + ':if:' + label)
        params = {'GroupingIdentifier': group, 'WFControlFlowMode': 0, 'WFCondition': code,
                  'WFInput': {'Type': 'Variable', 'Variable': attachment(value)}}
        if equals is not None: params['WFConditionalActionString'] = token_text(equals)
        self.add('conditional', 'if-' + label, **params)
        self.stack.append(('conditional', group, label))
    def otherwise(self):
        kind, group, label = self.stack[-1]
        self.add(kind, 'otherwise-' + label, GroupingIdentifier=group, WFControlFlowMode=1)
    def end(self):
        kind, group, label = self.stack.pop()
        self.add(kind, 'end-' + label, GroupingIdentifier=group, WFControlFlowMode=2)
    def repeat(self, value: dict, label: str):
        group = uid(self.name + ':repeat:' + label)
        self.add('repeat.each', 'repeat-' + label, GroupingIdentifier=group, WFControlFlowMode=0, WFInput=attachment(value))
        self.stack.append(('repeat.each', group, label))
    def stop(self, label: str): self.add('exit', 'stop-' + label)
    def text(self, label: str, *parts: str | dict) -> str:
        return self.add('gettext', label, WFTextActionText=token_text(*parts))
    def save_text(self, value: dict, folder: dict, path: str | dict, label: str, overwrite: bool = False):
        return self.add('documentpicker.save', label, WFInput=attachment(value), WFFolder=attachment(folder),
                        WFAskWhereToSave=False, WFFileDestinationPath=token_text(path), WFSaveFileOverwrite=overwrite)
    def validate(self, value: dict, pattern: str, label: str, message: str):
        matched = self.add('text.match', 'validate-' + label, text=token_text(value), WFMatchTextPattern=pattern, WFMatchTextCaseSensitive=False)
        self.condition(output(matched, 'Matches'), 101, 'invalid-' + label)
        self.add('alert', 'alert-invalid-' + label, WFAlertActionTitle='Cliptext', WFAlertActionMessage=message, WFAlertActionCancelButtonShown=False)
        self.stop('invalid-' + label)
        self.end()

    def workflow(self) -> dict:
        if self.stack: raise ValueError('Unbalanced control flow')
        return {'WFWorkflowName': self.name, 'WFWorkflowClientVersion': '2600',
                'WFWorkflowMinimumClientVersion': 1106, 'WFWorkflowMinimumClientVersionString': '1106',
                'WFWorkflowIcon': {'WFWorkflowIconGlyphNumber': 61488, 'WFWorkflowIconStartColor': 255473663},
                'WFWorkflowActions': self.actions, 'WFWorkflowHasOutputFallback': False,
                'WFWorkflowHasShortcutInputVariables': self.name == 'Save to Cliptext',
                'WFWorkflowInputContentItemClasses': ['WFURLContentItem', 'WFStringContentItem', 'WFSafariWebPageContentItem'] if self.name == 'Save to Cliptext' else [],
                'WFWorkflowOutputContentItemClasses': [], 'WFWorkflowTypes': ['ActionExtension'] if self.name == 'Save to Cliptext' else [],
                'WFQuickActionSurfaces': [],
                'WFWorkflowImportQuestions': [{'Category': 'Parameter', 'ParameterKey': 'WFFolder', 'ActionIndex': 0,
                    'Text': 'Choose a local parent folder in On My iPhone. A Cliptext folder will be created inside it. Choose the SAME parent for Save to Cliptext and Sync Cliptext. Do not select iCloud Drive.'}]}

def build(name: str) -> dict:
    b = Builder(name)
    # The File action's WFFile chooser accepts files only. Create Folder exposes
    # a genuine WFFolder bookmark picker and returns the same Cliptext child for
    # both templates when their import questions select the same local parent.
    folder = b.add('file.createfolder', 'local-folder', WFFilePath='Cliptext')
    b.set('Cliptext Folder', output(folder, 'Folder'))
    pending = b.add('file.createfolder', 'pending-folder', WFFolder=attachment(variable('Cliptext Folder')), WFFilePath='pending')
    b.set('Pending Folder', output(pending, 'Folder'))
    sent = b.add('file.createfolder', 'sent-folder', WFFolder=attachment(variable('Cliptext Folder')), WFFilePath='sent')
    b.set('Sent Folder', output(sent, 'Folder'))
    if name == 'Save to Cliptext':
        urls = b.add('detect.link', 'shared-urls', WFInput=attachment({'Type': 'ExtensionInput'}))
        b.repeat(output(urls, 'URLs'), 'new-shared-links')
        b.set('Shared URL', variable('Repeat Item'))
        matched = b.add('text.match', 'supported-url', text=token_text(variable('Shared URL')), WFMatchTextPattern=SUPPORTED_URL, WFMatchTextCaseSensitive=False)
        b.condition(output(matched, 'Matches'), 100, 'supported-link')
        date = b.add('date', 'current-date', WFDateActionMode='Current Date')
        formatted = b.add('format.date', 'request-time', WFDate=token_text(output(date, 'Date')), WFDateFormatStyle='Custom', WFDateFormat='yyyyMMddHHmmssSSSSSS')
        random = b.add('number.random', 'request-random', WFRandomNumberMinimum=0, WFRandomNumberMaximum=2147483647)
        entropy = b.text('request-identity-material', variable('Shared URL'), '\n', output(formatted, 'Formatted Date'), '\n', output(random, 'Random Number'))
        digest = b.add('hash', 'request-digest', WFHashType='SHA256', WFInput=attachment(output(entropy, 'Text')))
        request_id = b.add('text.replace', 'request-id', WFInput=token_text(output(digest, 'Hash')), WFReplaceTextFind=UUID_FROM_HASH,
                           WFReplaceTextReplace='$1-$2-5$3-8$4-$5', WFReplaceTextRegularExpression=True, WFReplaceTextCaseSensitive=False)
        b.set('New Request ID', output(request_id, 'Updated Text'))
        request = b.add('dictionary', 'new-request', WFItems=dictionary([('requestId', variable('New Request ID')), ('url', variable('Shared URL'))]))
        serialized = b.add('detect.text', 'serialize-request', WFInput=attachment(output(request, 'Dictionary')))
        b.save_text(output(serialized, 'Text'), variable('Pending Folder'), token_text(variable('New Request ID'), '.json'), 'persist-request-before-network')
        b.end()
        b.end()
    # Configuration comes AFTER the newly shared request has been durably saved.
    existing = b.add('documentpicker.open', 'read-local-connection', WFFile=attachment(variable('Cliptext Folder')), WFGetFilePath='cliptext-connection.json', WFFileErrorIfNotFound=False, WFGetFolderContents=False)
    b.condition(output(existing, 'File'), 101, 'needs-connection')
    asked = b.add('ask', 'ask-connection', WFAskActionPrompt='Paste the Shortcut connection JSON from Cliptext on your Mac.', WFInputType='Text', WFAllowsMultilineText=True)
    parsed = b.add('detect.dictionary', 'parse-new-connection', WFInput=attachment(output(asked, 'Provided Input')))
    b.set('Connection', output(parsed, 'Dictionary'))
    b.otherwise()
    parsed_existing = b.add('detect.dictionary', 'parse-existing-connection', WFInput=attachment(output(existing, 'File')))
    b.set('Connection', output(parsed_existing, 'Dictionary'))
    b.end()
    origin = b.value(variable('Connection'), 'origin', 'connection-origin')
    b.validate(output(origin, 'Dictionary Value'), ORIGIN_PATTERN, 'mac-origin', 'Use the HTTPS .ts.net connection JSON copied from your Mac. Shared links are still in the local pending folder.')
    b.set('Mac Origin', output(origin, 'Dictionary Value'))
    token = b.value(variable('Connection'), 'token', 'connection-token')
    b.validate(output(token, 'Dictionary Value'), TOKEN_PATTERN, 'capability', 'Copy a new Shortcut connection from your Mac. Shared links are still in the local pending folder.')
    b.set('Submission Token', output(token, 'Dictionary Value'))
    library = b.value(variable('Connection'), 'libraryId', 'connection-library')
    b.validate(output(library, 'Dictionary Value'), r'^[A-Za-z0-9_-]{1,128}$', 'library', 'The connection has no valid library identifier. Copy a new connection from your Mac.')
    b.set('Library ID', output(library, 'Dictionary Value'))
    config_text = b.add('detect.text', 'serialize-connection', WFInput=attachment(variable('Connection')))
    b.save_text(output(config_text, 'Text'), variable('Cliptext Folder'), 'cliptext-connection.json', 'save-local-connection', overwrite=True)
    files = b.add('file.getfoldercontents', 'pending-files', WFFolder=attachment(variable('Pending Folder')), Recursive=False)
    b.repeat(output(files, 'Folder Contents'), 'pending-links')
    b.set('Pending File', variable('Repeat Item'))
    payload = b.add('detect.dictionary', 'pending-request-json', WFInput=attachment(variable('Pending File')))
    b.set('Pending Request', output(payload, 'Dictionary'))
    request_id = b.value(variable('Pending Request'), 'requestId', 'pending-request-id')
    b.set('Pending ID', output(request_id, 'Dictionary Value'))
    # Native dictionary-to-text serialization escapes arbitrary URL characters.
    serialized = b.add('detect.text', 'serialize-pending-request', WFInput=attachment(variable('Pending Request')))
    body = b.text('one-item-batch-json', '{"links":[', output(serialized, 'Text'), ']}')
    response = b.add('downloadurl', 'submit-one-pending-link', WFURL=token_text(variable('Mac Origin'), '/api/shortcut/links'),
                     WFHTTPMethod='POST', WFHTTPBodyType='File', WFRequestVariable=attachment(output(body, 'Text')),
                     WFHTTPHeaders=dictionary([('Content-Type', 'application/json'), ('Authorization', token_text('Bearer ', variable('Submission Token')))]))
    response_json = b.add('detect.dictionary', 'parse-receipt', WFInput=attachment(output(response, 'Contents of URL')))
    response_library = b.value(output(response_json, 'Dictionary'), 'libraryId', 'receipt-library')
    b.condition(output(response_library, 'Dictionary Value'), 4, 'same-library', variable('Library ID'))
    receipts = b.value(output(response_json, 'Dictionary'), 'receipts', 'receipt-items')
    b.repeat(output(receipts, 'Dictionary Value'), 'matching-receipt')
    b.set('Receipt', variable('Repeat Item'))
    received_id = b.value(variable('Receipt'), 'requestId', 'receipt-request-id')
    b.condition(output(received_id, 'Dictionary Value'), 4, 'same-request', variable('Pending ID'))
    job = b.value(variable('Receipt'), 'jobId', 'receipt-job-id')
    b.condition(output(job, 'Dictionary Value'), 100, 'accepted-job')
    b.add('file.move', 'archive-only-acknowledged-request', WFFile=attachment(variable('Pending File')), WFFolder=attachment(variable('Sent Folder')), WFReplaceExisting=False)
    b.end(); b.end(); b.end(); b.end(); b.end()
    b.add('nothing', 'quiet-completion')
    return b.workflow()

def generate(output: Path, sign: bool = True) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'source'; source.mkdir(exist_ok=True)
    manifest = {'schemaVersion': 1, 'credentialFree': True, 'nativeRuntimeVerified': False, 'artifacts': []}
    for name in ['Save to Cliptext', 'Sync Cliptext']:
        workflow = build(name)
        xml = plistlib.dumps(workflow, fmt=plistlib.FMT_XML, sort_keys=False)
        unsigned = source / (name + '.xml'); unsigned.write_bytes(xml)
        artifact = output / (name + '.shortcut')
        if sign:
            with tempfile.TemporaryDirectory(prefix='cliptext-shortcuts-sign-') as signing_dir:
                signing_input = Path(signing_dir) / (name + '.shortcut')
                signing_input.write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY, sort_keys=False))
                result = subprocess.run(['/usr/bin/shortcuts', 'sign', '--mode', 'anyone', '--input', str(signing_input), '--output', str(artifact)], capture_output=True, text=True, timeout=120)
            if result.returncode:
                raise SystemExit('Apple Shortcuts signing failed: ' + result.stderr.strip())
            if not artifact.is_file() or artifact.stat().st_size == 0: raise RuntimeError('Shortcuts signing produced no artifact')
        manifest['artifacts'].append({'name': name, 'actions': len(workflow['WFWorkflowActions']), 'unsignedSha256': hashlib.sha256(xml).hexdigest(),
            **({'file': artifact.name, 'bytes': artifact.stat().st_size, 'sha256': hashlib.sha256(artifact.read_bytes()).hexdigest()} if sign else {})})
    if sign: (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    parser.add_argument('--no-sign', action='store_true')
    args = parser.parse_args()
    print(json.dumps(generate(args.output, not args.no_sign), indent=2))
