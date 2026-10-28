from pathlib import Path
import json
import plistlib
import tempfile
import unittest
from unittest.mock import patch

import service

ENGINE_KEY = "unit-test-mac-only-engine-key-123456789"


class FakeKeyring:
    def __init__(self):
        self.items = {}

    def set_password(self, name, account, value):
        self.items[(name, account)] = value

    def get_password(self, name, account):
        return self.items.get((name, account))


class DurableCredentialTests(unittest.TestCase):
    def test_launch_path_includes_only_resolved_existing_node_and_fixed_tools(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            node = root / "nvm" / "bin" / "node"
            node.parent.mkdir(parents=True)
            node.write_text("a local executable placeholder")
            node.chmod(0o700)
            with patch("service.shutil.which", return_value=str(node)):
                self.assertEqual(service.runtime_search_path("/engine/venv/bin/python"), "/engine/venv/bin:" + str(node.parent) + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
            with patch("service.shutil.which", return_value=str(root / "missing-node")):
                self.assertEqual(service.runtime_search_path("/engine/venv/bin/python"), "/engine/venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")

    def test_secret_is_only_in_keychain_not_public_config_or_plist(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            secret = "test-secret-do-not-persist"
            result = service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": secret, "engine_key": ENGINE_KEY, "runtime_dir": temporary}, backend)
            for key in ("public_config", "launch_agent_plist"):
                self.assertNotIn(secret, Path(result[key]).read_text())
                self.assertNotIn(ENGINE_KEY, Path(result[key]).read_text())
            self.assertNotIn(secret, json.dumps(result))
            self.assertNotIn(ENGINE_KEY, json.dumps(result))
            loaded = service.read_service_configuration(Path(result["public_config"]), backend)
            self.assertEqual(loaded["site_bearer"], secret)
            self.assertEqual(loaded["engine_key"], ENGINE_KEY)
            self.assertEqual(set(json.loads(Path(result["public_config"]).read_text())), service.PUBLIC_KEYS)
            plist = plistlib.loads(Path(result["launch_agent_plist"]).read_bytes())
            self.assertTrue(plist["RunAtLoad"])
            self.assertTrue(plist["KeepAlive"])
            self.assertNotIn("site_bearer", plist["EnvironmentVariables"])
            self.assertNotIn("engine_key", plist["EnvironmentVariables"])

    def test_config_cannot_select_another_sites_keychain_item(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            result = service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": "secret", "engine_key": ENGINE_KEY, "runtime_dir": temporary}, backend)
            path = Path(result["public_config"])
            data = json.loads(path.read_text())
            data["site_url"] = "https://another.example.chatgpt.site"
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                service.read_service_configuration(path, backend)

    def test_plaintext_credential_in_configuration_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            result = service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": "secret", "engine_key": ENGINE_KEY, "runtime_dir": temporary}, backend)
            path = Path(result["public_config"])
            data = json.loads(path.read_text())
            data["site_bearer"] = "secret"
            path.write_text(json.dumps(data))
            with self.assertRaises(ValueError):
                service.read_service_configuration(path, backend)

    def test_missing_engine_key_fails_before_keychain_is_changed(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            with self.assertRaises(ValueError):
                service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": "existing-secret", "runtime_dir": temporary}, backend)
            self.assertEqual(backend.items, {})

    def test_legacy_service_requires_engine_key_migration(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            result = service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": "existing-secret", "engine_key": ENGINE_KEY, "runtime_dir": temporary}, backend)
            public_path = Path(result["public_config"])
            public = json.loads(public_path.read_text())
            del backend.items[(public["keychain_service"], service.ENGINE_KEY_ACCOUNT)]
            with self.assertRaisesRegex(RuntimeError, "engine key is unavailable"):
                service.read_service_configuration(public_path, backend)
            self.assertEqual(backend.get_password(public["keychain_service"], public["keychain_account"]), "existing-secret")

    def test_setup_can_upgrade_existing_site_credential_without_public_schema_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            backend = FakeKeyring()
            _label, item, account = service.service_identity("https://private.example.chatgpt.site")
            backend.set_password(item, account, "existing-secret")
            result = service.prepare_service({"site_url": "https://private.example.chatgpt.site", "site_bearer": "existing-secret", "engine_key": ENGINE_KEY, "runtime_dir": temporary}, backend)
            loaded = service.read_service_configuration(Path(result["public_config"]), backend)
            self.assertEqual(loaded["site_bearer"], "existing-secret")
            self.assertEqual(loaded["engine_key"], ENGINE_KEY)
            self.assertEqual(set(json.loads(Path(result["public_config"]).read_text())), service.PUBLIC_KEYS)


if __name__ == "__main__":
    unittest.main()
