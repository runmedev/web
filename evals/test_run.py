import json
import tempfile
import unittest
from pathlib import Path

from run import (
    DEFAULT_CASES,
    drive_file_id,
    load_cases,
    missing_answer_evidence,
    plugin_marketplace,
)


class EvalCaseTest(unittest.TestCase):
    def test_ported_cases_are_complete_and_secret_free(self) -> None:
        cases = load_cases(DEFAULT_CASES)

        self.assertEqual(
            [case.case_id for case in cases],
            [
                "google-drive-first-cell",
                "open-google-drive-notebook-by-name",
                "add-markdown-cell",
            ],
        )
        source = DEFAULT_CASES.read_text(encoding="utf-8").casefold()
        self.assertNotIn("private_key", source)
        self.assertNotIn("service_account_file", source)

    def test_duplicate_case_ids_are_rejected(self) -> None:
        payload = [
            {
                "id": "duplicate",
                "description": "first",
                "notebook_url": "https://drive.google.com/file/d/one/view",
                "prompt": "first",
                "expected_answer_contains": ["first"],
            },
            {
                "id": "duplicate",
                "description": "second",
                "notebook_url": "https://drive.google.com/file/d/two/view",
                "prompt": "second",
                "expected_answer_contains": ["second"],
            },
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cases.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate eval case id"):
                load_cases(path)

    def test_drive_file_id_accepts_path_and_query_references(self) -> None:
        self.assertEqual(
            drive_file_id("https://drive.google.com/file/d/abc_123/view"),
            "abc_123",
        )
        self.assertEqual(
            drive_file_id("https://drive.google.com/open?id=abc_123"),
            "abc_123",
        )

    def test_answer_evidence_is_case_insensitive(self) -> None:
        self.assertEqual(
            missing_answer_evidence(
                "Opened EVAL_READ with Notebook For Read Test",
                ("eval_read", "notebook for read test"),
            ),
            [],
        )
        self.assertEqual(
            missing_answer_evidence("Opened eval_read", ("eval_read", "heading")),
            ["heading"],
        )

    def test_plugin_marketplace_is_discovered_from_catalog(self) -> None:
        self.assertEqual(
            plugin_marketplace(
                {
                    "marketplaces": [
                        {"name": "bundled", "plugins": [{"name": "browser"}]},
                        {"name": "primary", "plugins": [{"name": "runme"}]},
                    ]
                },
                "runme",
            ),
            "primary",
        )


if __name__ == "__main__":
    unittest.main()
