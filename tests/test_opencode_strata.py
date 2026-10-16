"""Mocked subprocess coverage for the optional OpenCode/Strata launcher."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "opencode-strata.sh"


class OpenCodeStrataLauncherTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory(prefix="opencode-strata-test-")
        self.addCleanup(self.temp_dir.cleanup)
        self.root = Path(self.temp_dir.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.curl_record = self.root / "curl-argv.json"
        self.opencode_record = self.root / "opencode.json"

        curl_stub = self.bin_dir / "curl"
        curl_stub.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "Path(os.environ['CURL_RECORD']).write_text(json.dumps(sys.argv[1:]))\n"
            "mode = os.environ.get('CURL_MODE', 'ok')\n"
            "if mode == 'down':\n"
            "    raise SystemExit(7)\n"
            "if mode == 'large':\n"
            "    sys.stdout.write('x' * (1024 * 1024 + 1))\n"
            "else:\n"
            "    body = os.environ.get('CURL_BODY', '{\"object\":\"list\",\"data\":[{\"id\":\"qwen3.8-flash-next-q2_0\",\"object\":\"model\",\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]}}]}')\n"
            "    sys.stdout.write(body)\n",
            encoding="utf-8",
        )
        curl_stub.chmod(0o755)

        opencode_stub = self.bin_dir / "opencode"
        opencode_stub.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            "from pathlib import Path\n"
            "Path(os.environ['OPENCODE_RECORD']).write_text(json.dumps({\n"
            "    'argv': sys.argv[1:],\n"
            "    'config': os.environ.get('OPENCODE_CONFIG_CONTENT'),\n"
            "}))\n",
            encoding="utf-8",
        )
        opencode_stub.chmod(0o755)

    def make_env(self, **extra: str) -> dict[str, str]:
        env = os.environ.copy()
        env["PATH"] = f"{self.bin_dir}{os.pathsep}{env.get('PATH', '')}"
        env["CURL_RECORD"] = str(self.curl_record)
        env["OPENCODE_RECORD"] = str(self.opencode_record)
        for key in ("STRATA_BASE_URL", "STRATA_CONTEXT", "STRATA_OUTPUT", "CURL_MODE", "CURL_BODY"):
            env.pop(key, None)
        env.update(extra)
        return env

    def run_launcher(self, *args: str, **env_overrides: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [str(LAUNCHER), *args],
            cwd=ROOT,
            env=self.make_env(**env_overrides),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_strata_config_overrides_global_models_and_forwards_arguments_verbatim(self) -> None:
        prompt = "Use $HOME; keep 'quotes' and spaces"
        result = self.run_launcher(
            "run",
            prompt,
            "--title",
            "name with spaces",
            OPENCODE_CONFIG_CONTENT=json.dumps(
                {
                    "plugin": ["oh-my-openagent@latest"],
                    "model": "ollama/gemma4:26b",
                    "small_model": "ollama/llama3.2:3b-ctx8k",
                }
            ),
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invoked = json.loads(self.opencode_record.read_text(encoding="utf-8"))
        model_id = "qwen3.8-flash-next-q2_0"
        qualified_model = f"strata/{model_id}"
        self.assertEqual(
            invoked["argv"],
            ["--pure", "--model", qualified_model, "run", prompt, "--title", "name with spaces"],
        )
        config = json.loads(invoked["config"])
        self.assertEqual(config["plugin"], [])
        self.assertEqual(config["enabled_providers"], ["strata"])
        self.assertEqual(config["model"], qualified_model)
        self.assertEqual(config["small_model"], qualified_model)
        self.assertEqual(config["permission"], {"task": "deny"})
        strata = config["provider"]["strata"]
        self.assertEqual(strata["options"]["baseURL"], "http://127.0.0.1:18080/v1")
        model = strata["models"][model_id]
        self.assertEqual(model["modalities"], {"input": ["text"], "output": ["text"]})
        self.assertTrue(model["tool_call"])
        self.assertEqual(model["limit"], {"context": 32768, "output": 8192})
        curl_args = json.loads(self.curl_record.read_text(encoding="utf-8"))
        self.assertIn("--connect-timeout", curl_args)
        self.assertIn("--max-time", curl_args)
        self.assertEqual(curl_args[-1], "http://127.0.0.1:18080/v1/models")

    def test_loopback_endpoint_and_context_overrides_are_applied(self) -> None:
        result = self.run_launcher(
            STRATA_BASE_URL="http://127.0.0.1:9000/v1",
            STRATA_CONTEXT="65536",
            STRATA_OUTPUT="4096",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invoked = json.loads(self.opencode_record.read_text(encoding="utf-8"))
        config = json.loads(invoked["config"])
        strata = config["provider"]["strata"]
        model_id = "qwen3.8-flash-next-q2_0"
        self.assertEqual(strata["options"]["baseURL"], "http://127.0.0.1:9000/v1")
        self.assertEqual(strata["models"][model_id]["limit"], {"context": 65536, "output": 4096})
        self.assertEqual(invoked["argv"][2], f"strata/{model_id}")
        curl_args = json.loads(self.curl_record.read_text(encoding="utf-8"))
        self.assertEqual(curl_args[-1], "http://127.0.0.1:9000/v1/models")

    def test_unavailable_server_fails_actionably_without_starting_opencode(self) -> None:
        result = self.run_launcher(CURL_MODE="down")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("GET http://127.0.0.1:18080/v1/models", result.stderr)
        self.assertIn("Start Strata", result.stderr)
        self.assertFalse(self.opencode_record.exists())

    def test_invalid_model_list_fails_without_starting_opencode(self) -> None:
        result = self.run_launcher(
            CURL_BODY='{"data":[{"id":"image-model","architecture":{"input_modalities":["text"],"output_modalities":["image"]}}]}'
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not advertise a text-to-text model", result.stderr)
        self.assertFalse(self.opencode_record.exists())

    def test_first_text_model_is_selected_after_non_text_entry(self) -> None:
        result = self.run_launcher(
            CURL_BODY=(
                '{"data":['
                '{"id":"image-model","architecture":{"input_modalities":["text"],"output_modalities":["image"]}},'
                '{"id":"qwen3.8-flash-next-q2_0","architecture":{"input_modalities":["text"],"output_modalities":["text"]}},'
                '{"id":"later-text-model","architecture":{"input_modalities":["text"],"output_modalities":["text"]}}'
                ']}'
            )
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        invoked = json.loads(self.opencode_record.read_text(encoding="utf-8"))
        config = json.loads(invoked["config"])
        expected = "strata/qwen3.8-flash-next-q2_0"
        self.assertEqual(invoked["argv"][2], expected)
        self.assertEqual(config["model"], expected)
        self.assertEqual(config["small_model"], expected)
        self.assertIn("qwen3.8-flash-next-q2_0", config["provider"]["strata"]["models"])
        self.assertNotIn("later-text-model", config["provider"]["strata"]["models"])

    def test_empty_non_string_and_malformed_model_ids_fail_closed(self) -> None:
        for model_id in ("", None, 17, "not a model/id"):
            with self.subTest(model_id=model_id):
                body = json.dumps(
                    {
                        "data": [
                            {
                                "id": model_id,
                                "architecture": {
                                    "input_modalities": ["text"],
                                    "output_modalities": ["text"],
                                },
                            }
                        ]
                    }
                )
                result = self.run_launcher(CURL_BODY=body)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("empty, non-string, or malformed model ID", result.stderr)
                self.assertFalse(self.opencode_record.exists())

    def test_malformed_later_model_id_also_rejects_the_response(self) -> None:
        result = self.run_launcher(
            CURL_BODY=(
                '{"data":['
                '{"id":"qwen3.8-flash-next-q2_0","architecture":{"input_modalities":["text"],"output_modalities":["text"]}},'
                '{"id":null,"architecture":{"input_modalities":["text"],"output_modalities":["text"]}}'
                ']}'
            )
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("empty, non-string, or malformed model ID", result.stderr)
        self.assertFalse(self.opencode_record.exists())

    def test_oversized_models_response_is_rejected(self) -> None:
        result = self.run_launcher(CURL_MODE="large")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exceeds the 1 MiB limit", result.stderr)
        self.assertFalse(self.opencode_record.exists())

    def test_invalid_json_from_server_fails_without_starting_opencode(self) -> None:
        result = self.run_launcher(CURL_BODY="not-json")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("returned invalid JSON", result.stderr)
        self.assertFalse(self.opencode_record.exists())

    def test_non_loopback_or_malformed_endpoint_is_rejected_before_request(self) -> None:
        for endpoint in (
            "https://127.0.0.1:18080/v1",
            "http://example.com:18080/v1",
            "http://127.0.0.1:70000/v1",
            "http://127.0.0.1:18080/v1/",
        ):
            with self.subTest(endpoint=endpoint):
                self.curl_record.unlink(missing_ok=True)
                self.opencode_record.unlink(missing_ok=True)
                result = self.run_launcher(STRATA_BASE_URL=endpoint)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("STRATA_BASE_URL", result.stderr)
                self.assertFalse(self.curl_record.exists())
                self.assertFalse(self.opencode_record.exists())

    def test_invalid_context_and_output_are_rejected_before_request(self) -> None:
        for overrides in (
            {"STRATA_CONTEXT": "0"},
            {"STRATA_CONTEXT": "32k"},
            {"STRATA_CONTEXT": "1000000000"},
            {"STRATA_CONTEXT": "8192", "STRATA_OUTPUT": "8192"},
            {"STRATA_OUTPUT": "invalid"},
        ):
            with self.subTest(overrides=overrides):
                self.curl_record.unlink(missing_ok=True)
                self.opencode_record.unlink(missing_ok=True)
                result = self.run_launcher(**overrides)
                self.assertNotEqual(result.returncode, 0)
                self.assertRegex(result.stderr, r"STRATA_(CONTEXT|OUTPUT)")
                self.assertFalse(self.curl_record.exists())
                self.assertFalse(self.opencode_record.exists())


if __name__ == "__main__":
    unittest.main()
