import json
import tempfile
import time
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import websocket
from codex_driver import CodexEvalControl, EvalControlError
from run import (
    DEFAULT_CASES,
    REDUNDANT_CONFIRMATION_PATTERNS,
    CodexRuntime,
    DriveSession,
    RunmeEvals,
    build_summary,
    category_counts,
    drive_file_id,
    drive_import_failure_message,
    drive_session_needs_refresh,
    failure_mode_for_exception,
    isolated_runtime_environment,
    load_cases,
    load_results_checkpoint,
    missing_answer_evidence,
    notebook_output_text,
    plugin_marketplace,
    present_evidence,
    present_regex_evidence,
    redundant_confirmation_metrics,
    remove_runtime_tree,
    retryable_setup_failure,
    tool_call_evidence,
    tool_evidence_from_turn_items,
    wilson_interval,
)


class EvalCaseTest(unittest.TestCase):
    def test_plugin_configuration_retries_transient_control_failure(self) -> None:
        control = MagicMock()
        control.dispatch.side_effect = [
            EvalControlError("bridge reconnecting"),
            {},
            {},
            {"marketplaces": []},
        ]
        runner = RunmeEvals(
            control=control,
            drive=DriveSession("token", int(time.time() * 1000) + 3_600_000, {}),
            timeout_seconds=300,
        )

        with patch("run.time.sleep"):
            runner.configure_plugins()

        self.assertEqual(control.dispatch.call_count, 4)
        self.assertTrue(
            all(
                call.kwargs["timeout_seconds"] == 60
                for call in control.dispatch.call_args_list
            )
        )

    def test_eval_control_supports_bounded_dispatch_timeout(self) -> None:
        control = CodexEvalControl("http://127.0.0.1:1", timeout_seconds=300)
        with patch.object(
            control, "_evaluate", return_value={"ok": True, "result": {}}
        ) as evaluate:
            control.dispatch({"type": "test"}, timeout_seconds=15)

        expression = evaluate.call_args.args[0]
        self.assertIn(",15000)", expression)
        self.assertEqual(evaluate.call_args.kwargs["timeout_seconds"], 15)

    def test_eval_control_wraps_closed_websocket(self) -> None:
        control = CodexEvalControl("http://127.0.0.1:1")
        with (
            patch.object(
                control,
                "_evaluate_transport",
                side_effect=websocket.WebSocketConnectionClosedException("lost"),
            ),
            self.assertRaisesRegex(EvalControlError, "transport failed"),
        ):
            control._evaluate("1 + 1")

    def test_runtime_root_must_be_new_or_empty(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "keep.txt").write_text("caller-owned", encoding="utf-8")

            with self.assertRaisesRegex(RuntimeError, "new or empty"):
                CodexRuntime(
                    apps_root=root,
                    auth_file=root / "auth.json",
                    attach_cdp_url=None,
                    keep_runtime=False,
                    runtime_root=root,
                    timeout_seconds=1,
                )

            self.assertEqual(
                (root / "keep.txt").read_text(encoding="utf-8"), "caller-owned"
            )

    def test_runtime_cleanup_preserves_files_added_by_the_caller(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = CodexRuntime(
                apps_root=root,
                auth_file=root / "auth.json",
                attach_cdp_url=None,
                keep_runtime=False,
                runtime_root=root,
                timeout_seconds=1,
            )
            (root / "caller-created.txt").write_text("keep", encoding="utf-8")

            runtime.close(succeeded=True)

            self.assertEqual(
                (root / "caller-created.txt").read_text(encoding="utf-8"), "keep"
            )

    def test_failed_runtime_cleanup_removes_credentialed_browser_profile(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime = CodexRuntime(
                apps_root=root,
                auth_file=root / "auth.json",
                attach_cdp_url=None,
                keep_runtime=True,
                runtime_root=root,
                timeout_seconds=1,
            )
            user_data = root / "user-data"
            user_data.mkdir()
            (user_data / "retained-service-account-key").write_text(
                "secret", encoding="utf-8"
            )
            (root / "codex-agent.log").write_text("diagnostics", encoding="utf-8")

            runtime.close(succeeded=False)

            self.assertFalse(user_data.exists())
            self.assertEqual(
                (root / "codex-agent.log").read_text(encoding="utf-8"),
                "diagnostics",
            )

    def test_runtime_environment_uses_isolated_profile_and_home(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            codex_home = root / "codex-home"
            environment = isolated_runtime_environment(
                {
                    "HOME": "/Users/example",
                    "USERPROFILE": "/Users/example",
                    "PATH": "/usr/bin",
                },
                root,
                codex_home,
            )

            isolated_home = root / "home"
            self.assertEqual(environment["HOME"], str(isolated_home))
            self.assertEqual(environment["USERPROFILE"], str(isolated_home))
            self.assertEqual(environment["CODEX_HOME"], str(codex_home))
            self.assertEqual(environment["CODEX_APPS_WORKTREE_SETUP_OWNER"], "1")
            self.assertEqual(environment["COREPACK_ENABLE_DOWNLOAD_PROMPT"], "0")
            self.assertEqual(
                environment["COREPACK_HOME"],
                str(isolated_home / ".cache" / "node" / "corepack"),
            )
            self.assertEqual(
                environment["GIT_CONFIG_GLOBAL"], str(isolated_home / ".gitconfig")
            )
            self.assertEqual(environment["PATH"], "/usr/bin")
            self.assertTrue((isolated_home / ".config").is_dir())
            self.assertTrue((isolated_home / ".cache").is_dir())

    def test_runtime_cleanup_removes_read_only_profile_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "runtime"
            cache = root / "home" / ".cache"
            cache.mkdir(parents=True)
            read_only = cache / "artifact"
            read_only.write_text("cached", encoding="utf-8")
            read_only.chmod(0o400)
            cache.chmod(0o500)

            remove_runtime_tree(root)

            self.assertFalse(root.exists())

    def test_isolated_environment_reuses_only_the_toolchain_artifact_cache(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base_home = Path(directory) / "caller"
            dotslash = base_home / "Library" / "Caches" / "dotslash"
            dotslash.mkdir(parents=True)
            codex_apps_cache = base_home / ".cache" / "codex-apps"
            bundled_plugins = codex_apps_cache / "bundled-plugin-cache"
            bundled_plugins.mkdir(parents=True)
            runtime_root = Path(directory) / "runtime"
            codex_home = runtime_root / "codex-home"

            environment = isolated_runtime_environment(
                {"HOME": str(base_home)}, runtime_root, codex_home
            )

            self.assertEqual(environment["DOTSLASH_CACHE"], str(dotslash))
            self.assertEqual(environment["HOME"], str(runtime_root / "home"))
            self.assertEqual(
                environment["CODEX_APPS_CACHE_HOME"], str(codex_apps_cache)
            )

    def test_ported_cases_are_complete_and_secret_free(self) -> None:
        cases = load_cases(DEFAULT_CASES)

        self.assertEqual(len(cases), 116)
        self.assertEqual(
            category_counts(cases),
            {
                "baseline-open": 1,
                "baseline-read": 1,
                "baseline-write": 1,
                "direct-uri": 4,
                "kernel-selection": 4,
                "notebook-tab-selection": 3,
                "redundant-confirmation": 100,
                "runner-enumeration": 2,
            },
        )
        self.assertEqual(
            [case.case_id for case in cases[:3]],
            [
                "google-drive-first-cell",
                "open-google-drive-notebook-by-name",
                "add-markdown-cell",
            ],
        )
        source = DEFAULT_CASES.read_text(encoding="utf-8").casefold()
        self.assertNotIn("private_key", source)
        self.assertNotIn("service_account_file", source)

        embedded_link = next(
            case for case in cases if case.case_id == "uri-link-inside-notebook"
        )
        self.assertTrue(embedded_link.copy_notebook)
        self.assertEqual(len(embedded_link.setup_markdown_cells), 1)
        self.assertIn(
            "1iTN_c0h93BQS0WnAJiAT88JZHhhmnNRI",
            embedded_link.setup_markdown_cells[0],
        )
        not_open = next(
            case for case in cases if case.case_id == "show-notebook-not-open"
        )
        self.assertIn("1iTN_c0h93BQS0WnAJiAT88JZHhhmnNRI", not_open.notebook_url)
        background = next(
            case for case in cases if case.case_id == "show-notebook-background-tab"
        )
        self.assertFalse(background.expected_claimed_only_primary_tab)
        self.assertIn("1c7p47TDdZT8VS-NRmCx5lamMzp4xj65h", background.notebook_url)
        sandbox = next(
            case for case in cases if case.case_id == "choose-sandbox-kernel-001"
        )
        self.assertEqual(sandbox.expected_notebook_runner_name, "appkernel-js-sandbox")
        self.assertIn(
            "RUNME-EVAL-CHOOSE-SANDBOX-KERNEL-001",
            sandbox.expected_notebook_cell_contains or "",
        )
        self.assertEqual(
            sandbox.expected_notebook_output_contains,
            "RUNME-EVAL-CHOOSE-SANDBOX-KERNEL-001",
        )

    def test_repeated_cases_get_unique_ids_and_trial_tokens(self) -> None:
        confirmation_cases = [
            case
            for case in load_cases(DEFAULT_CASES)
            if case.category == "redundant-confirmation"
        ]

        self.assertEqual(len({case.case_id for case in confirmation_cases}), 100)
        first = confirmation_cases[0]
        last = confirmation_cases[-1]
        self.assertEqual(first.case_id, "confirmation-add-markdown-001")
        self.assertIn("RUNME-EVAL-CONFIRMATION-ADD-MARKDOWN-001", first.prompt)
        self.assertEqual(last.case_id, "confirmation-no-reconfirmation-010")
        self.assertIn("RUNME-EVAL-CONFIRMATION-NO-RECONFIRMATION-010", last.prompt)

    def test_notebook_output_text_decodes_runme_buffer_shapes(self) -> None:
        cell = {
            "outputs": [
                {
                    "items": [
                        {"data": {"0": 111, "1": 107}},
                        {"data": [10, 100, 111, 110, 101]},
                        {"data": "dG9rZW4="},
                    ]
                }
            ]
        }

        self.assertEqual(notebook_output_text(cell), "ok\n\ndone\ndG9rZW4=\ntoken")

    def test_persisted_notebook_evidence_checks_runner_and_output(self) -> None:
        case = next(
            case
            for case in load_cases(DEFAULT_CASES)
            if case.case_id == "choose-sandbox-kernel-001"
        )
        token = case.expected_notebook_cell_contains
        evaluator = object.__new__(RunmeEvals)
        evaluator.timeout_seconds = 1
        evaluator._download_drive_notebook = lambda _file_id: {
            "cells": [
                {
                    "refId": "code-1",
                    "value": f"console.log({token!r})",
                    "metadata": {
                        "runme.dev/runnerName": "appkernel-js-sandbox",
                        "runme.dev/executionState": "completed",
                        "runme.dev/exitCode": "0",
                    },
                    "outputs": [
                        {"items": [{"data": list((token or "").encode("utf-8"))}]}
                    ],
                }
            ]
        }

        evidence = evaluator._wait_for_notebook_evidence("drive-file", case)

        self.assertEqual(evidence["runnerName"], "appkernel-js-sandbox")
        self.assertTrue(evidence["outputContainsExpected"])

    def test_drive_cleanup_refreshes_once_after_unauthorized(self) -> None:
        evaluator = object.__new__(RunmeEvals)
        evaluator.drive = DriveSession(
            access_token="expired",
            expires_at_ms=int(time.time() * 1000) + 60 * 60 * 1000,
            service_account={"client_email": "test@example.com"},
        )
        refreshed = DriveSession(
            access_token="fresh",
            expires_at_ms=int(time.time() * 1000) + 60 * 60 * 1000,
            service_account=evaluator.drive.service_account,
        )
        unauthorized = urllib.error.HTTPError(
            "https://example.com", 401, "Unauthorized", {}, None
        )
        response = MagicMock()
        response.__enter__.return_value = response

        with (
            patch("run.refresh_drive_session", return_value=refreshed) as refresh,
            patch("run.urllib.request.urlopen", side_effect=[unauthorized, response]),
        ):
            evaluator._delete_drive_file("temporary-drive-id")

        refresh.assert_called_once_with(evaluator.drive.service_account)
        self.assertEqual(evaluator.drive.access_token, "fresh")

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
        self.assertEqual(
            present_evidence(
                "Would you like me to proceed?", ("would you like me to", "approve")
            ),
            ["would you like me to"],
        )
        self.assertEqual(
            present_regex_evidence(
                "await runners.get()", (r"(?<!runme)\brunners\.get\(",)
            ),
            [r"(?<!runme)\brunners\.get\("],
        )
        self.assertEqual(
            present_regex_evidence(
                "await runmeRunners.get()", (r"(?<!runme)\brunners\.get\(",)
            ),
            [],
        )

    def test_redundant_confirmation_metrics_include_rate_and_interval(self) -> None:
        cases = [
            case
            for case in load_cases(DEFAULT_CASES)
            if case.category == "redundant-confirmation"
        ]
        failures = [
            {
                "category": "redundant-confirmation",
                "failureMode": "redundant_confirmation",
            }
            for _ in range(12)
        ]

        metrics = redundant_confirmation_metrics(cases, failures)

        self.assertEqual(metrics["trials"], 100)
        self.assertEqual(metrics["redundantConfirmations"], 12)
        self.assertEqual(metrics["rate"], 0.12)
        low, high = metrics["wilson95"]
        self.assertLess(low, 0.12)
        self.assertGreater(high, 0.12)
        self.assertEqual(wilson_interval(0, 0), (0.0, 0.0))
        self.assertEqual(wilson_interval(0, 100)[0], 0.0)
        self.assertEqual(wilson_interval(100, 100)[1], 1.0)

    def test_observed_confirmation_wording_is_classified(self) -> None:
        observed = (
            "May I write that content to the Google Drive notebook now?",
            "Shall I write it now?",
            "Do you confirm I should create it there?",
            "Would you like me to upload the notebook?",
        )
        for answer in observed:
            with self.subTest(answer=answer):
                self.assertTrue(
                    present_regex_evidence(answer, REDUNDANT_CONFIRMATION_PATTERNS)
                )

        cases = [
            case
            for case in load_cases(DEFAULT_CASES)
            if case.category == "redundant-confirmation"
        ]
        metrics = redundant_confirmation_metrics(
            cases,
            [
                {
                    "category": "redundant-confirmation",
                    "failureMode": "missing_answer_evidence",
                    "answer": "May I write that content now?",
                }
            ],
        )
        self.assertEqual(metrics["redundantConfirmations"], 1)

    def test_results_checkpoint_tracks_progress_and_validates_resume(self) -> None:
        cases = load_cases(DEFAULT_CASES)[:2]
        results = [{"case": cases[0].case_id, "passed": True}]
        summary = build_summary(cases, results, [])

        self.assertFalse(summary["complete"])
        self.assertEqual(summary["completed"], 1)
        self.assertEqual(summary["remaining"], 1)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "results.json"
            path.write_text(json.dumps(summary), encoding="utf-8")
            loaded_results, loaded_failures = load_results_checkpoint(path, cases)
            self.assertEqual(loaded_results, results)
            self.assertEqual(loaded_failures, [])

            summary["failures"] = [{"case": cases[0].case_id}]
            path.write_text(json.dumps(summary), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate case ids"):
                load_results_checkpoint(path, cases)

    def test_setup_failures_are_retryable_across_checkpoint_formats(self) -> None:
        self.assertTrue(retryable_setup_failure({"failureMode": "setup_error"}))
        self.assertTrue(retryable_setup_failure({"failureMode": "transient_timeout"}))
        self.assertTrue(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "RunmeNotebookImportError",
                }
            )
        )
        self.assertTrue(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "TransportError",
                    "error": "oauth2.googleapis.com read timed out",
                }
            )
        )
        self.assertTrue(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "HTTPError",
                    "error": "HTTP Error 401: Unauthorized",
                }
            )
        )
        self.assertFalse(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "HTTPError",
                    "error": "HTTP Error 404: Not Found",
                }
            )
        )
        unauthorized = urllib.error.HTTPError(
            "https://example.invalid", 401, "Unauthorized", {}, None
        )
        self.assertEqual(failure_mode_for_exception(unauthorized), "setup_error")
        not_found = urllib.error.HTTPError(
            "https://example.invalid", 404, "Not Found", {}, None
        )
        self.assertEqual(failure_mode_for_exception(not_found), "runtime_error")
        self.assertTrue(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "RuntimeError",
                    "error": "Timed out waiting for Codex task thread-1",
                }
            )
        )
        self.assertFalse(
            retryable_setup_failure(
                {"failureMode": "runtime_error", "errorType": "RuntimeError"}
            )
        )
        self.assertTrue(
            retryable_setup_failure(
                {
                    "failureMode": "runtime_error",
                    "errorType": "CodexTaskTimeoutError",
                }
            )
        )

        confirmation_cases = [
            case
            for case in load_cases(DEFAULT_CASES)
            if case.category == "redundant-confirmation"
        ][:2]
        summary = build_summary(
            confirmation_cases,
            [{"case": confirmation_cases[0].case_id, "passed": True}],
            [
                {
                    "case": confirmation_cases[1].case_id,
                    "failureMode": "setup_error",
                }
            ],
        )
        self.assertEqual(summary["completed"], 2)
        self.assertEqual(summary["redundantConfirmation"]["trials"], 1)

    def test_tool_call_evidence_omits_outputs(self) -> None:
        evidence = tool_call_evidence(
            {
                "type": "mcpToolCall",
                "server": "node_repl",
                "tool": "js",
                "arguments": {"code": "await runmeRunners.get()"},
                "output": "large and irrelevant",
            }
        )

        self.assertEqual(
            evidence,
            {
                "type": "mcpToolCall",
                "server": "node_repl",
                "tool": "js",
                "arguments": {"code": "await runmeRunners.get()"},
            },
        )

    def test_turn_tool_evidence_includes_all_completed_mcp_calls(self) -> None:
        node_call_count, evidence = tool_evidence_from_turn_items(
            [
                {
                    "type": "mcpToolCall",
                    "server": "node_repl",
                    "tool": "js",
                    "status": "completed",
                    "arguments": {"code": "await tab.playwright.domSnapshot()"},
                    "output": "large browser output",
                },
                {
                    "type": "mcpToolCall",
                    "server": "codex_apps",
                    "tool": "google_drive_fetch",
                    "status": "completed",
                    "arguments": {
                        "url": "https://drive.google.com/file/d/target-id/view"
                    },
                    "output": "large connector output",
                },
            ]
        )

        self.assertEqual(node_call_count, 1)
        self.assertIn("target-id", evidence)
        self.assertNotIn("large browser output", evidence)
        self.assertNotIn("large connector output", evidence)

    def test_drive_session_refreshes_before_expiry_skew(self) -> None:
        session = DriveSession(
            access_token="token",
            expires_at_ms=1_000_000,
            service_account={"client_email": "eval@example.com"},
        )

        self.assertFalse(drive_session_needs_refresh(session, now_ms=699_999))
        self.assertTrue(drive_session_needs_refresh(session, now_ms=700_000))

    def test_drive_import_failure_extracts_latest_failed_intent(self) -> None:
        self.assertEqual(
            drive_import_failure_message(
                {
                    "driveLinkIntents": [
                        {"status": "pending"},
                        {
                            "status": "failed",
                            "lastErrorMessage": "DriveSnapshotChangedError: retry",
                        },
                    ]
                }
            ),
            "DriveSnapshotChangedError: retry",
        )
        self.assertIsNone(drive_import_failure_message({"driveLinkIntents": []}))

    def test_open_failure_closes_partial_browser_lease(self) -> None:
        class FakeControl:
            def __init__(self) -> None:
                self.actions: list[dict[str, object]] = []

            def dispatch(
                self, action: dict[str, object], **_kwargs: object
            ) -> dict[str, object]:
                self.actions.append(action)
                if action["type"] == "browser.open":
                    return {"leaseId": "lease-1", "browserTabId": "tab-1"}
                return {}

        control = FakeControl()
        runner = RunmeEvals(
            control=control,  # type: ignore[arg-type]
            drive=DriveSession("token", 10**15, {"client_email": "eval@example.com"}),
            timeout_seconds=1,
        )

        with (
            patch.object(
                runner,
                "_wait_for_page_origin",
                side_effect=RuntimeError("setup failed"),
            ),
            self.assertRaisesRegex(RuntimeError, "setup failed"),
        ):
            runner._open_runme_tab("thread-1", "https://example.com/notebook")

        self.assertIn(
            {
                "type": "browser.close",
                "leaseId": "lease-1",
                "clearStorage": True,
            },
            control.actions,
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
