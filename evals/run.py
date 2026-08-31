#!/usr/bin/env python3
"""Run the Runme Web eval cases against a Codex Agent build."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from codex_driver import CodexEvalControl, EvalControlError
from google.auth.transport.requests import Request
from google.oauth2 import service_account

DEFAULT_CASES = Path(__file__).with_name("cases.json")
DEFAULT_RUNME_ORIGIN = "https://web.runme.dev"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
DRIVE_REFRESH_SKEW_MS = 5 * 60 * 1000
RUNTIME_ARTIFACT_NAMES = ("codex-agent.log", "codex-home", "home", "user-data")
REDUNDANT_CONFIRMATION_PATTERNS = (
    r"(?i)\b(?:may|shall|should) i (?:write|create|update|upload|save|proceed|apply|make)\b",
    r"(?i)\bdo you (?:confirm|approve|authorize|want me to)\b",
    r"(?i)\b(?:can|could|would) you (?:confirm|approve|authorize)\b",
    r"(?i)\bwould you like me to\b",
    r"(?i)\b(?:need|require)(?:s)? (?:your|an?) (?:confirmation|approval)\b",
)


def write_initial_codex_settings(codex_home: Path) -> None:
    """Seed deterministic settings required by the isolated eval profile."""
    state = {
        "electron-persisted-atom-state": {
            "electron:onboarding-projectless-completed": True
        }
    }
    (codex_home / ".codex-global-state.json").write_text(
        json.dumps(state), encoding="utf-8"
    )
    # Browser-client fails closed when this preference cannot be read. Make
    # the eval's WebMCP dependency explicit instead of relying on a fresh
    # profile's default while Codex is still initializing its config.
    browser_config = codex_home / "browser" / "config.toml"
    browser_config.parent.mkdir(parents=True, exist_ok=True)
    browser_config.write_text("webmcp_enabled = true\n", encoding="utf-8")


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    description: str
    notebook_url: str
    prompt: str
    expected_answer_contains: tuple[str, ...]
    expected_page_contains: str | None = None
    expected_answer_not_contains: tuple[str, ...] = ()
    expected_tool_contains: tuple[str, ...] = ()
    expected_tool_not_contains: tuple[str, ...] = ()
    expected_tool_not_regex: tuple[str, ...] = ()
    expected_notebook_cell_contains: str | None = None
    expected_notebook_cell_not_contains: tuple[str, ...] = ()
    expected_notebook_runner_name: str | None = None
    expected_notebook_output_contains: str | None = None
    distractor_urls: tuple[str, ...] = ()
    setup_markdown_cells: tuple[str, ...] = ()
    expected_claimed_primary_tab: bool = False
    expected_claimed_only_primary_tab: bool = False
    category: str = "uncategorized"
    confirmation_policy_trigger: str | None = None
    forbidden_answer_failure_mode: str = "forbidden_answer"
    copy_notebook: bool = False
    copy_name_prefix: str = "runme-eval"


@dataclass(frozen=True)
class DriveSession:
    access_token: str
    expires_at_ms: int
    service_account: dict[str, Any]


class EvalAssertionError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        failure_mode: str,
        evidence: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.failure_mode = failure_mode
        self.evidence = evidence or {}


class RunmeNotebookImportError(RuntimeError):
    failure_mode = "setup_error"


class CodexTaskTimeoutError(RuntimeError):
    failure_mode = "transient_timeout"


class CodexRuntime:
    def __init__(
        self,
        *,
        apps_root: Path,
        auth_file: Path,
        attach_cdp_url: str | None,
        keep_runtime: bool,
        runtime_root: Path | None,
        timeout_seconds: float,
    ) -> None:
        self.apps_root = apps_root.resolve()
        self.auth_file = auth_file
        self.attach_cdp_url = attach_cdp_url
        self.keep_runtime = keep_runtime
        self.owns_runtime_root = runtime_root is None
        if runtime_root is None:
            # macOS returns /var/... here even though /var is a symlink to
            # /private/var. The trusted Node REPL config bridge rejects TOML
            # paths that traverse symlinks, which otherwise makes Browser's
            # WebMCP preference read fail closed. Canonicalize the generated
            # root before deriving CODEX_HOME and browser config paths.
            self.runtime_root = Path(
                tempfile.mkdtemp(prefix="runme-codex-evals-")
            ).resolve()
        else:
            self.runtime_root = runtime_root.resolve()
            if self.runtime_root.exists():
                if not self.runtime_root.is_dir():
                    raise RuntimeError(
                        f"Runtime root is not a directory: {self.runtime_root}"
                    )
                if any(self.runtime_root.iterdir()):
                    raise RuntimeError(
                        f"--runtime-root must be a new or empty directory: {self.runtime_root}"
                    )
            else:
                self.runtime_root.mkdir(parents=True)
        self.metadata_path = self._default_metadata_path()
        self.timeout_seconds = timeout_seconds
        self.process: subprocess.Popen[str] | None = None
        self.log_file: Any = None

    def start(self) -> CodexEvalControl:
        if self.attach_cdp_url:
            control = CodexEvalControl(self.attach_cdp_url, self.timeout_seconds)
            control.wait_until_ready()
            return control

        if not self.auth_file.is_file():
            raise RuntimeError(f"Codex auth file does not exist: {self.auth_file}")
        if not (self.apps_root / "package.json").is_file():
            raise RuntimeError(f"Codex Apps root is invalid: {self.apps_root}")

        codex_home = self.runtime_root / "codex-home"
        user_data = self.runtime_root / "user-data"
        sqlite_home = codex_home / "sqlite"
        for directory in (codex_home, user_data, sqlite_home):
            directory.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(self.auth_file, codex_home / "auth.json")
        write_initial_codex_settings(codex_home)

        self.log_file = (self.runtime_root / "codex-agent.log").open(
            "w", encoding="utf-8"
        )
        environment = isolated_runtime_environment(
            os.environ, self.runtime_root, codex_home
        )
        environment.pop("BUILDKITE", None)
        environment.pop("CI", None)
        environment.pop("CODEX_ELECTRON_METADATA_PATH", None)
        environment.update(
            {
                "CODEX_ELECTRON_DESKTOP_FEATURE_OVERRIDES": json.dumps(
                    {
                        "ambientSuggestions": False,
                        "browserPane": True,
                        "computerUse": False,
                        "computerUseNodeRepl": False,
                        "control": False,
                        "externalBrowserUse": False,
                        "externalBrowserUseAllowed": False,
                        "inAppBrowserUse": True,
                        "inAppBrowserUseAllowed": True,
                        "multiWindow": False,
                        "webMcp": True,
                    }
                ),
                "CODEX_ELECTRON_USER_DATA_PATH": str(user_data),
                "CODEX_ENABLE_DEV_BUNDLED_PLUGINS": "1",
                "CODEX_SQLITE_HOME": str(sqlite_home),
                "DISABLE_SFW": "1",
            }
        )
        command = [
            *resolve_command("pnpm"),
            "run",
            "app",
            "--flavor",
            "agent",
            "--codex-home",
            str(codex_home),
            "--disable-quit-confirmation",
            "--isolated-tmpdir",
            "--playwright",
            "--title",
            "Runme Web evals",
            "--user-data-path",
            str(user_data),
        ]
        if metadata_tracks_live_app(self.metadata_path):
            raise RuntimeError(
                "A Codex dev app is already running in this worktree; stop it "
                f"before running evals ({self.metadata_path})"
            )
        self.process = subprocess.Popen(
            command,
            cwd=self.apps_root,
            env=environment,
            stdout=self.log_file,
            stderr=subprocess.STDOUT,
            start_new_session=os.name != "nt",
            text=True,
        )

        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError(
                    f"Codex Agent exited during startup; see {self.runtime_root / 'codex-agent.log'}"
                )
            try:
                metadata = json.loads(self.metadata_path.read_text(encoding="utf-8"))
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(0.25)
                continue
            cdp_url = metadata.get("cdpHttpUrl")
            if metadata.get("status") == "ready" and isinstance(cdp_url, str):
                control = CodexEvalControl(cdp_url, self.timeout_seconds)
                control.wait_until_ready()
                return control
            time.sleep(0.25)
        raise RuntimeError(
            f"Timed out starting Codex Agent; see {self.runtime_root / 'codex-agent.log'}"
        )

    def close(self, succeeded: bool) -> None:
        try:
            if self.process is not None and self.process.poll() is None:
                if os.name == "nt":
                    subprocess.run(
                        ["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                        check=False,
                        capture_output=True,
                        text=True,
                    )
                else:
                    os.killpg(self.process.pid, signal.SIGTERM)
                try:
                    self.process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    if os.name != "nt":
                        os.killpg(self.process.pid, signal.SIGKILL)
                    self.process.wait(timeout=10)
        finally:
            if self.log_file is not None:
                self.log_file.close()
            (self.runtime_root / "codex-home" / "auth.json").unlink(missing_ok=True)
            if not self.attach_cdp_url:
                user_data = self.runtime_root / "user-data"
                if user_data.is_dir() and not user_data.is_symlink():
                    remove_runtime_tree(user_data)
                elif user_data.exists() or user_data.is_symlink():
                    user_data.unlink()
        if (
            succeeded
            and not self.keep_runtime
            and not self.attach_cdp_url
            and self.owns_runtime_root
        ):
            remove_runtime_tree(self.runtime_root)
        elif succeeded and not self.keep_runtime and not self.attach_cdp_url:
            for name in RUNTIME_ARTIFACT_NAMES:
                child = self.runtime_root / name
                if child.is_dir() and not child.is_symlink():
                    remove_runtime_tree(child)
                elif child.exists() or child.is_symlink():
                    child.unlink()
        elif not self.attach_cdp_url:
            print(f"Runtime artifacts: {self.runtime_root}")

    def _default_metadata_path(self) -> Path:
        worktree_hash = hashlib.sha1(
            str(self.apps_root).encode("utf-8"), usedforsecurity=False
        ).hexdigest()[:12]
        return (
            Path(tempfile.gettempdir())
            / "codex-electron-dev"
            / f"{self.apps_root.name}-{worktree_hash}.json"
        )


class RunmeEvals:
    def __init__(
        self,
        *,
        control: CodexEvalControl,
        drive: DriveSession,
        timeout_seconds: float,
        runme_origin: str = DEFAULT_RUNME_ORIGIN,
    ) -> None:
        self.control = control
        self.drive = drive
        self.timeout_seconds = timeout_seconds
        self.runme_origin = parse_runme_origin(runme_origin)

    def configure_plugins(self) -> None:
        self._configure_dispatch(
            {
                "type": "plugins.configure",
                "pluginName": "browser",
                "useBundledMarketplace": True,
                "install": True,
                "enabled": True,
            }
        )
        self._configure_dispatch({"type": "plugins.sync_primary_runtime"})
        catalog = self._configure_dispatch({"type": "plugins.list"})
        marketplace_name = plugin_marketplace(catalog, "runme")
        if marketplace_name is None:
            return
        self._configure_dispatch(
            {
                "type": "plugins.configure",
                "pluginName": "runme",
                "marketplaceName": marketplace_name,
                "install": True,
                "enabled": True,
            }
        )

    def _configure_dispatch(self, action: dict[str, Any]) -> dict[str, Any]:
        attempts = 3
        timeout_seconds = min(self.timeout_seconds, 60)
        last_error: EvalControlError | None = None
        for attempt in range(1, attempts + 1):
            try:
                return self.control.dispatch(action, timeout_seconds=timeout_seconds)
            except EvalControlError as error:
                last_error = error
                if attempt == attempts:
                    break
                print(
                    "Retrying eval-control plugin setup "
                    f"({attempt}/{attempts - 1}) after: {error}",
                    flush=True,
                )
                time.sleep(2)
        raise RunmeNotebookImportError(
            f"Eval-control plugin setup failed after {attempts} attempts: {last_error}"
        )

    def run_case(self, case: EvalCase) -> dict[str, Any]:
        copied_notebook: dict[str, str] | None = None
        browsers: list[dict[str, Any]] = []
        thread_id: str | None = None
        failure_evidence: dict[str, Any] = {}
        try:
            self._refresh_drive_session()
            if case.copy_notebook:
                copied_notebook = self._copy_notebook(case)
            notebook_url = (
                copied_notebook["webViewLink"] if copied_notebook else case.notebook_url
            )

            created = self.control.dispatch(
                {
                    "type": "threads.create_empty",
                    "title": case.description,
                }
            )
            thread_id = required_string(created, "threadId")
            primary, readiness, tool_names = self._open_runme_tab(
                thread_id, notebook_url
            )
            browsers.append(primary)
            for distractor_url in case.distractor_urls:
                distractor = self.control.dispatch(
                    {
                        "type": "browser.open",
                        "conversationId": thread_id,
                        "startingUrl": distractor_url,
                    }
                )
                distractor_lease = required_string(distractor, "leaseId")
                expected_origin = urllib.parse.urlparse(distractor_url)
                self._wait_for_page_origin(
                    distractor_lease,
                    f"{expected_origin.scheme}://{expected_origin.netloc}",
                )
                browsers.append(distractor)

            before = self._browser_snapshot(thread_id)
            browser_tab_ids = {
                required_string(browser, "browserTabId") for browser in browsers
            }
            browser_tab_ids_by_guest = prepared_tab_ids_by_guest(browsers)
            browser_tab_ids_by_page_key = prepared_tab_ids_by_page_key(browsers)
            primary_tab_id = required_string(primary, "browserTabId")
            primary_lease_id = required_string(primary, "leaseId")
            self._assert_exact_tabs(
                before,
                browser_tab_ids,
                browser_tab_ids_by_guest,
                browser_tab_ids_by_page_key,
            )
            submitted = self.control.dispatch(
                {
                    "type": "threads.send_message",
                    "threadId": thread_id,
                    "prompt": rewrite_runme_urls(case.prompt, self.runme_origin),
                    "includeBrowserContext": True,
                }
            )
            browser_context = submitted.get("inAppBrowserContext")
            if not isinstance(browser_context, dict) or browser_context.get(
                "openTabCount"
            ) != len(browsers):
                raise RuntimeError(
                    "The prompt did not include every prepared browser tab"
                )

            completed = self._wait_for_thread(
                thread_id,
                browser_tab_ids,
                browser_tab_ids_by_guest,
                browser_tab_ids_by_page_key,
            )
            after = self._browser_snapshot(
                thread_id, after_event_sequence=before["latestEventSequence"]
            )
            browser_tab_ids_by_alias = completed["browserTabIdsByAlias"]
            self._assert_exact_tabs(
                after,
                browser_tab_ids,
                browser_tab_ids_by_guest,
                browser_tab_ids_by_page_key,
                browser_tab_ids_by_alias,
            )
            unexpected = unexpected_browser_event_tab_ids(
                after["events"],
                browser_tab_ids,
                browser_tab_ids_by_guest,
                browser_tab_ids_by_page_key,
                browser_tab_ids_by_alias,
            )
            if unexpected:
                raise RuntimeError(
                    f"Codex opened unexpected browser tabs: {unexpected}"
                )

            answer = completed["answer"]
            failure_evidence = {
                "threadId": thread_id,
                "answer": answer,
                "claimedTabIds": sorted(completed["claimedTabIds"]),
                "nodeReplCallCount": completed["nodeReplCallCount"],
                "toolEvidencePreview": completed["toolEvidence"][:4000],
            }
            redundant_confirmation = (
                present_regex_evidence(answer, REDUNDANT_CONFIRMATION_PATTERNS)
                if case.category == "redundant-confirmation"
                else []
            )
            if redundant_confirmation:
                raise EvalAssertionError(
                    "Answer requested redundant confirmation matching "
                    f"{redundant_confirmation!r}: {answer!r}",
                    failure_mode="redundant_confirmation",
                )
            forbidden = present_evidence(answer, case.expected_answer_not_contains)
            if forbidden:
                raise EvalAssertionError(
                    f"Answer contained forbidden evidence {forbidden!r}: {answer!r}",
                    failure_mode=case.forbidden_answer_failure_mode,
                )
            missing = missing_answer_evidence(answer, case.expected_answer_contains)
            if missing:
                raise EvalAssertionError(
                    f"Answer omitted expected evidence {missing!r}: {answer!r}",
                    failure_mode="missing_answer_evidence",
                )
            tool_evidence = completed["toolEvidence"]
            missing_tool = missing_answer_evidence(
                tool_evidence, case.expected_tool_contains
            )
            if missing_tool:
                raise EvalAssertionError(
                    f"Browser tool trace omitted expected evidence {missing_tool!r}",
                    failure_mode="missing_tool_evidence",
                )
            forbidden_tool = present_evidence(
                tool_evidence, case.expected_tool_not_contains
            )
            if forbidden_tool:
                raise EvalAssertionError(
                    "Browser tool trace contained forbidden evidence "
                    f"{forbidden_tool!r}",
                    failure_mode="forbidden_tool_evidence",
                )
            forbidden_tool_regex = present_regex_evidence(
                tool_evidence, case.expected_tool_not_regex
            )
            if forbidden_tool_regex:
                raise EvalAssertionError(
                    "Browser tool trace matched forbidden patterns "
                    f"{forbidden_tool_regex!r}",
                    failure_mode="forbidden_tool_evidence",
                )
            if (
                case.expected_claimed_primary_tab
                and primary_tab_id not in completed["claimedTabIds"]
            ):
                raise EvalAssertionError(
                    "Codex did not claim the prepared primary Runme tab",
                    failure_mode="wrong_tab",
                )
            if case.expected_claimed_only_primary_tab and completed[
                "claimedTabIds"
            ] != {primary_tab_id}:
                raise EvalAssertionError(
                    "Codex claimed tabs other than the prepared primary Runme tab: "
                    f"{sorted(completed['claimedTabIds'])}",
                    failure_mode="wrong_tab",
                )

            page_evidence = None
            if case.expected_page_contains:
                page_evidence = self._wait_for_page_evidence(
                    primary_lease_id, case.expected_page_contains
                )
                if not page_evidence:
                    page_state = self._page_evidence_state(primary_lease_id)
                    raise EvalAssertionError(
                        "Runme page did not contain "
                        f"{case.expected_page_contains!r}: {page_state!r}",
                        failure_mode="missing_page_evidence",
                    )
            notebook_evidence = None
            if copied_notebook is not None and (
                case.expected_notebook_cell_contains
                or case.expected_notebook_cell_not_contains
            ):
                notebook_evidence = self._wait_for_notebook_evidence(
                    copied_notebook["id"], case
                )
            return {
                "case": case.case_id,
                "category": case.category,
                "confirmationPolicyTrigger": case.confirmation_policy_trigger,
                "passed": True,
                "threadId": thread_id,
                "answer": answer,
                "browserTabId": primary_tab_id,
                "browserTabIds": sorted(browser_tab_ids),
                "claimedTabIds": sorted(completed["claimedTabIds"]),
                "pageEvidence": page_evidence,
                "notebookEvidence": notebook_evidence,
                "readiness": readiness,
                "webMcpToolNames": tool_names,
                "nodeReplCallCount": completed["nodeReplCallCount"],
                "copiedNotebook": copied_notebook,
            }
        except EvalAssertionError as error:
            error.evidence.update(failure_evidence)
            raise
        finally:
            for browser in reversed(browsers):
                try:
                    self.control.dispatch(
                        {
                            "type": "browser.close",
                            "leaseId": browser["leaseId"],
                            "clearStorage": True,
                        },
                        timeout_seconds=min(15, self.timeout_seconds),
                    )
                except EvalControlError as error:
                    print(f"Browser cleanup warning for {case.case_id}: {error}")
            if copied_notebook is not None:
                self._delete_drive_file(copied_notebook["id"])
            if thread_id is not None:
                try:
                    self.control.dispatch(
                        {
                            "type": "threads.set_archived",
                            "threadId": thread_id,
                            "archived": True,
                        },
                        timeout_seconds=min(15, self.timeout_seconds),
                    )
                except EvalControlError as error:
                    print(f"Task archival warning for {case.case_id}: {error}")

    def _open_runme_tab(
        self, thread_id: str, notebook_url: str
    ) -> tuple[dict[str, Any], dict[str, Any], list[str]]:
        browser = self.control.dispatch(
            {
                "type": "browser.open",
                "conversationId": thread_id,
                "startingUrl": f"{self.runme_origin}/robots.txt",
            }
        )
        lease_id = required_string(browser, "leaseId")
        try:
            self._wait_for_page_origin(lease_id, self.runme_origin)
            self._configure_runme_auth(lease_id)
            target_url = f"{self.runme_origin}/?doc=" + urllib.parse.quote(
                notebook_url, safe=""
            )
            readiness: dict[str, Any] | None = None
            for attempt in range(3):
                retry_url = target_url
                if attempt:
                    retry_url += f"&evalImportRetry={attempt}"
                self.control.dispatch(
                    {
                        "type": "browser.cdp",
                        "leaseId": lease_id,
                        "method": "Page.navigate",
                        "params": {"url": retry_url},
                    }
                )
                try:
                    readiness = self._wait_for_runme(lease_id)
                    break
                except RunmeNotebookImportError:
                    if attempt == 2:
                        raise
                    time.sleep(1 + attempt)
            if readiness is None:
                raise RuntimeError("Runme notebook did not become ready")
            return browser, readiness, self._wait_for_webmcp(lease_id)
        except BaseException:
            try:
                self.control.dispatch(
                    {
                        "type": "browser.close",
                        "leaseId": lease_id,
                        "clearStorage": True,
                    },
                    timeout_seconds=min(15, self.timeout_seconds),
                )
            except EvalControlError as close_error:
                print(f"Browser cleanup warning after open failure: {close_error}")
            raise

    def _configure_runme_auth(self, lease_id: str) -> None:
        self._refresh_drive_session()
        account = self.drive.service_account
        oauth_config = {
            "oauthClientId": "",
            "oauthAuthFlow": "service_account",
            "oauthAuthUxMode": "new_tab",
            "oauthServiceAccount": {
                "clientEmail": account["client_email"],
                "privateKey": account["private_key"],
                "privateKeyId": account.get("private_key_id"),
                "tokenUri": account.get(
                    "token_uri", "https://oauth2.googleapis.com/token"
                ),
                "subject": account.get("subject"),
                "scopes": [DRIVE_SCOPE],
            },
        }
        token = {
            "token": self.drive.access_token,
            "expiresAt": self.drive.expires_at_ms,
            "credentialExpiresAt": self.drive.expires_at_ms,
            "authFlow": "service_account",
            "effectivePrincipal": account["client_email"],
        }
        expression = """(() => {
          localStorage.setItem("googleClientConfig", CONFIG);
          localStorage.setItem("runme/app-config/prefer-local", "true");
          localStorage.setItem("runme/google-auth/token", TOKEN);
          return { configured: true };
        })()""".replace("CONFIG", json.dumps(json.dumps(oauth_config))).replace(
            "TOKEN", json.dumps(json.dumps(token))
        )
        value = self._evaluate_browser(lease_id, expression)
        if value != {"configured": True}:
            raise RuntimeError(f"Runme auth setup returned unexpected value: {value!r}")

    def _wait_for_page_origin(self, lease_id: str, expected_origin: str) -> None:
        deadline = time.monotonic() + min(self.timeout_seconds, 30)
        while time.monotonic() < deadline:
            try:
                state = self._evaluate_browser(
                    lease_id,
                    "({ origin: location.origin, readyState: document.readyState })",
                )
                if (
                    isinstance(state, dict)
                    and state.get("origin") == expected_origin
                    and state.get("readyState") != "loading"
                ):
                    return
            except EvalControlError:
                pass
            time.sleep(0.25)
        raise RuntimeError(f"Runme origin {expected_origin} did not become ready")

    def _wait_for_runme(self, lease_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        last: Any = None
        while time.monotonic() < deadline:
            try:
                last = self._evaluate_browser(
                    lease_id,
                    """(() => {
                      const currentDoc = sessionStorage.getItem("runme/currentDoc") || "";
                      const mounted = Boolean(document.querySelector("#documents [data-document-id]"));
                      const cellVisible = Boolean(document.querySelector(
                        "#documents [data-document-id] [data-testid='code-action'], " +
                        "#documents [data-document-id] [data-testid='markdown-action']"
                      ));
                      const buttons = [...document.querySelectorAll("button")];
                      const clickOnce = (label, marker) => {
                        const button = buttons.find(
                          (candidate) => (candidate.textContent || "").trim().toLowerCase() === label
                        );
                        if (button && window[marker] !== true) {
                          window[marker] = true;
                          button.click();
                          return true;
                        }
                        return false;
                      };
                      const loginClicked = clickOnce("login to drive", "__runmeEvalLoginClicked");
                      const trustClicked = clickOnce(
                        "trust this document and open",
                        "__runmeEvalTrustClicked"
                      );
                      let driveLinkIntents = [];
                      try {
                        driveLinkIntents = JSON.parse(
                          sessionStorage.getItem("runme/drive-link-intents") || "[]"
                        );
                      } catch {
                        driveLinkIntents = [{ status: "invalid_session_storage" }];
                      }
                      return {
                        ready: currentDoc.startsWith("local://file/") && mounted && cellVisible,
                        currentDoc,
                        mounted,
                        cellVisible,
                        href: location.href,
                        loginClicked,
                        trustClicked,
                        driveLinkIntents,
                      };
                    })()""",
                )
                if isinstance(last, dict) and last.get("ready") is True:
                    return last
                import_failure = drive_import_failure_message(last)
                if import_failure:
                    raise RunmeNotebookImportError(import_failure)
            except EvalControlError:
                pass
            time.sleep(0.75)
        raise RuntimeError(f"Runme notebook did not become ready: {last!r}")

    def _wait_for_webmcp(self, lease_id: str) -> list[str]:
        deadline = time.monotonic() + self.timeout_seconds
        while time.monotonic() < deadline:
            result = self.control.dispatch(
                {"type": "browser.webmcp_tools", "leaseId": lease_id}
            )
            names = result.get("toolNames")
            if isinstance(names, list) and "ExecuteCode" in names:
                return [str(name) for name in names]
            time.sleep(0.5)
        raise RuntimeError("Runme WebMCP ExecuteCode did not become available")

    def _wait_for_thread(
        self,
        thread_id: str,
        browser_tab_ids: set[str],
        browser_tab_ids_by_guest: dict[int, str],
        browser_tab_ids_by_page_key: dict[str, str],
    ) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        claimed_tab_ids: set[str] = set()
        active_tab_records: list[dict[str, Any]] = []
        while time.monotonic() < deadline:
            snapshot = self._browser_snapshot(thread_id)
            for tab in snapshot["tabs"]:
                if (
                    not isinstance(tab, dict)
                    or tab.get("isBrowserUseActive") is not True
                ):
                    continue
                active_tab_records.append(dict(tab))
                tab_id = canonical_browser_tab_id(
                    tab, browser_tab_ids_by_guest, browser_tab_ids_by_page_key
                )
                if tab_id in browser_tab_ids:
                    claimed_tab_ids.add(tab_id)
            result = self.control.dispatch(
                {
                    "type": "threads.read",
                    "threadId": thread_id,
                    "hostId": "local",
                    "limit": 1,
                    "includeOutputs": True,
                    "maxOutputChars": 20_000,
                }
            )
            thread = result.get("thread")
            status = thread.get("status") if isinstance(thread, dict) else None
            status_type = status.get("type") if isinstance(status, dict) else None
            if status_type == "systemError":
                raise RuntimeError(f"Codex task failed: {result!r}")
            if status_type != "idle":
                time.sleep(0.5)
                continue
            turns = result.get("turns")
            latest = turns[0] if isinstance(turns, list) and turns else None
            if not isinstance(latest, dict) or latest.get("status") == "inProgress":
                time.sleep(0.5)
                continue
            if latest.get("status") != "completed":
                raise RuntimeError(f"Codex turn failed: {latest!r}")
            items = latest.get("items")
            answers = [
                item["text"]
                for item in items or []
                if isinstance(item, dict)
                and item.get("type") == "agentMessage"
                and isinstance(item.get("text"), str)
            ]
            node_repl_call_count, tool_evidence = tool_evidence_from_turn_items(
                items or []
            )
            browser_tab_ids_by_alias = browser_tab_aliases_from_turn_items(
                items or [], browser_tab_ids
            )
            for tab in active_tab_records:
                tab_id = canonical_browser_tab_id(
                    tab,
                    browser_tab_ids_by_guest,
                    browser_tab_ids_by_page_key,
                    browser_tab_ids_by_alias,
                )
                if tab_id in browser_tab_ids:
                    claimed_tab_ids.add(tab_id)
            if not answers:
                raise RuntimeError("Codex completed without an assistant answer")
            if not node_repl_call_count:
                raise RuntimeError("Codex completed without using the Browser plugin")
            if not claimed_tab_ids:
                raise RuntimeError("Codex did not claim the prepared Runme tab")
            return {
                "answer": answers[-1],
                "claimedTabIds": claimed_tab_ids,
                "nodeReplCallCount": node_repl_call_count,
                "toolEvidence": tool_evidence,
                "browserTabIdsByAlias": browser_tab_ids_by_alias,
            }
        raise CodexTaskTimeoutError(f"Timed out waiting for Codex task {thread_id}")

    def _browser_snapshot(
        self, thread_id: str, after_event_sequence: int | None = None
    ) -> dict[str, Any]:
        action: dict[str, Any] = {
            "type": "browser.snapshot",
            "conversationId": thread_id,
        }
        if after_event_sequence is not None:
            action["afterEventSequence"] = after_event_sequence
        result = self.control.dispatch(action)
        if not isinstance(result.get("latestEventSequence"), int):
            raise TypeError(f"Invalid browser snapshot: {result!r}")
        if not isinstance(result.get("events"), list) or not isinstance(
            result.get("tabs"), list
        ):
            raise TypeError(f"Invalid browser snapshot: {result!r}")
        return result

    @staticmethod
    def _assert_exact_tabs(
        snapshot: dict[str, Any],
        expected: set[str],
        expected_by_guest: dict[int, str] | None = None,
        expected_by_page_key: dict[str, str] | None = None,
        expected_by_alias: dict[str, str] | None = None,
    ) -> None:
        actual: set[str] = set()
        invalid_tabs: list[dict[str, Any]] = []
        for tab in snapshot["tabs"]:
            if not isinstance(tab, dict):
                continue
            tab_id = canonical_browser_tab_id(
                tab,
                expected_by_guest or {},
                expected_by_page_key or {},
                expected_by_alias or {},
            )
            if tab_id is None:
                invalid_tabs.append(tab)
            else:
                actual.add(tab_id)
        if invalid_tabs:
            raise EvalAssertionError(
                "Browser snapshot contained tabs without stable identities: "
                f"{invalid_tabs!r}",
                failure_mode="unexpected_tab",
            )
        if actual != expected:
            raise EvalAssertionError(
                f"Browser tabs differ from prepared leases: expected {sorted(expected)}, "
                f"found {sorted(actual)}",
                failure_mode="unexpected_tab",
            )

    def _evaluate_browser(self, lease_id: str, expression: str) -> Any:
        response = self.control.dispatch(
            {
                "type": "browser.evaluate",
                "leaseId": lease_id,
                "expression": expression,
            }
        )
        cdp_result = response.get("result")
        if not isinstance(cdp_result, dict):
            raise EvalControlError(f"Invalid browser.evaluate result: {response!r}")
        if cdp_result.get("exceptionDetails"):
            raise EvalControlError(str(cdp_result["exceptionDetails"]))
        remote = cdp_result.get("result")
        if not isinstance(remote, dict):
            raise EvalControlError(f"Missing Runtime.evaluate value: {response!r}")
        return remote.get("value")

    def _page_contains(self, lease_id: str, expected: str) -> bool:
        value = self._evaluate_browser(
            lease_id,
            f"document.body.innerText.includes({json.dumps(expected)})",
        )
        return value is True

    def _wait_for_page_evidence(self, lease_id: str, expected: str) -> bool:
        """Wait for React to render a notebook selected through the runtime API."""
        deadline = time.monotonic() + min(self.timeout_seconds, 30)
        while time.monotonic() < deadline:
            if self._page_contains(lease_id, expected):
                return True
            time.sleep(0.5)
        return self._page_contains(lease_id, expected)

    def _page_evidence_state(self, lease_id: str) -> Any:
        return self._evaluate_browser(
            lease_id,
            """(() => ({
              currentDoc: sessionStorage.getItem("runme/currentDoc"),
              documentIds: [...document.querySelectorAll("[data-document-id]")]
                .map((element) => element.getAttribute("data-document-id")),
              visibleText: (document.body.innerText || "").slice(0, 1_000),
              href: location.href,
            }))()""",
        )

    def _wait_for_notebook_evidence(
        self, file_id: str, case: EvalCase
    ) -> dict[str, Any]:
        expected_value = case.expected_notebook_cell_contains
        forbidden_values = case.expected_notebook_cell_not_contains
        if not expected_value and not forbidden_values:
            raise ValueError("Notebook evidence requires expected or forbidden content")
        deadline = time.monotonic() + min(self.timeout_seconds, 60)
        last_failure_mode = "missing_notebook_evidence"
        last_message = (
            f"No persisted cell contained {expected_value!r}"
            if expected_value
            else "Persisted notebook still contained forbidden content"
        )
        while time.monotonic() < deadline:
            try:
                notebook = self._download_drive_notebook(file_id)
                cells = notebook.get("cells")
                if not isinstance(cells, list):
                    raise TypeError("Drive notebook does not contain a cells array")
                matches = (
                    [
                        cell
                        for cell in cells
                        if isinstance(cell, dict)
                        and expected_value in str(cell.get("value") or "")
                    ]
                    if expected_value
                    else []
                )
                if expected_value and not matches:
                    last_failure_mode = "missing_notebook_evidence"
                    last_message = f"No persisted cell contained {expected_value!r}"
                    time.sleep(1)
                    continue
                present_forbidden = [
                    value
                    for value in forbidden_values
                    if any(
                        isinstance(cell, dict) and value in str(cell.get("value") or "")
                        for cell in cells
                    )
                ]
                if present_forbidden:
                    last_failure_mode = "unexpected_notebook_evidence"
                    last_message = (
                        "Persisted notebook still contained forbidden values "
                        f"{present_forbidden!r}"
                    )
                    time.sleep(1)
                    continue
                cell = matches[-1] if matches else {}
                metadata = cell.get("metadata")
                if not isinstance(metadata, dict):
                    metadata = {}
                actual_runner = metadata.get("runme.dev/runnerName")
                if (
                    case.expected_notebook_runner_name
                    and actual_runner != case.expected_notebook_runner_name
                ):
                    last_failure_mode = "wrong_runner"
                    last_message = (
                        "Persisted cell used runner "
                        f"{actual_runner!r}, expected "
                        f"{case.expected_notebook_runner_name!r}"
                    )
                    time.sleep(1)
                    continue
                output_text = notebook_output_text(cell)
                if (
                    case.expected_notebook_output_contains
                    and case.expected_notebook_output_contains not in output_text
                ):
                    last_failure_mode = "missing_notebook_output"
                    last_message = (
                        "Persisted cell output omitted "
                        f"{case.expected_notebook_output_contains!r}"
                    )
                    time.sleep(1)
                    continue
                if case.expected_notebook_output_contains and (
                    metadata.get("runme.dev/executionState") != "completed"
                    or str(metadata.get("runme.dev/exitCode")) != "0"
                ):
                    last_failure_mode = "notebook_execution_failed"
                    last_message = (
                        "Persisted cell did not have completed execution with exit code 0: "
                        f"{metadata!r}"
                    )
                    time.sleep(1)
                    continue
                return {
                    "refId": cell.get("refId"),
                    "runnerName": actual_runner,
                    "executionState": metadata.get("runme.dev/executionState"),
                    "exitCode": metadata.get("runme.dev/exitCode"),
                    "outputContainsExpected": (
                        case.expected_notebook_output_contains in output_text
                        if case.expected_notebook_output_contains
                        else None
                    ),
                    "forbiddenValuesAbsent": not present_forbidden,
                }
            except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
                last_failure_mode = "missing_notebook_evidence"
                last_message = f"Could not read the persisted Drive notebook: {error}"
                time.sleep(1)
        raise EvalAssertionError(last_message, failure_mode=last_failure_mode)

    def _download_drive_notebook(self, file_id: str) -> dict[str, Any]:
        self._refresh_drive_session()
        request = urllib.request.Request(
            "https://www.googleapis.com/drive/v3/files/"
            f"{urllib.parse.quote(file_id)}?alt=media&supportsAllDrives=true",
            headers={"Authorization": f"Bearer {self.drive.access_token}"},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            notebook = json.load(response)
        if not isinstance(notebook, dict):
            raise TypeError("Drive notebook content must be a JSON object")
        return notebook

    def _copy_notebook(self, case: EvalCase) -> dict[str, str]:
        self._refresh_drive_session()
        source_id = drive_file_id(case.notebook_url)
        name = (
            f"{case.copy_name_prefix}-{time.strftime('%Y%m%d')}-"
            f"{uuid.uuid4().hex[:8]}.json"
        )
        request = urllib.request.Request(
            "https://www.googleapis.com/drive/v3/files/"
            f"{urllib.parse.quote(source_id)}/copy?supportsAllDrives=true&"
            "fields=id,name,webViewLink",
            data=json.dumps({"name": name}).encode(),
            headers={
                "Authorization": f"Bearer {self.drive.access_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            copied = json.load(response)
        file_id = required_string(copied, "id")
        if case.setup_markdown_cells:
            self._append_fixture_markdown_cells(file_id, case.setup_markdown_cells)
        return {
            "id": file_id,
            "name": str(copied.get("name") or name),
            "webViewLink": str(
                copied.get("webViewLink")
                or f"https://drive.google.com/file/d/{file_id}/view"
            ),
        }

    def _append_fixture_markdown_cells(
        self, file_id: str, values: tuple[str, ...]
    ) -> None:
        self._refresh_drive_session()
        download = urllib.request.Request(
            "https://www.googleapis.com/drive/v3/files/"
            f"{urllib.parse.quote(file_id)}?alt=media&supportsAllDrives=true",
            headers={"Authorization": f"Bearer {self.drive.access_token}"},
        )
        with urllib.request.urlopen(download, timeout=30) as response:
            notebook = json.load(response)
        cells = notebook.get("cells")
        if not isinstance(cells, list):
            raise TypeError("Copied Runme fixture does not contain a cells array")
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for value in values:
            cells.append(
                {
                    "kind": "CELL_KIND_MARKUP",
                    "value": value,
                    "languageId": "markdown",
                    "metadata": {
                        "runme.dev/createdAt": now,
                        "runme.dev/updatedAt": now,
                    },
                    "refId": f"markup_{uuid.uuid4().hex}",
                    "role": "CELL_ROLE_USER",
                }
            )
        upload = urllib.request.Request(
            "https://www.googleapis.com/upload/drive/v3/files/"
            f"{urllib.parse.quote(file_id)}?uploadType=media&supportsAllDrives=true",
            data=json.dumps(notebook).encode(),
            headers={
                "Authorization": f"Bearer {self.drive.access_token}",
                "Content-Type": "application/json",
            },
            method="PATCH",
        )
        with urllib.request.urlopen(upload, timeout=30):
            pass

    def _delete_drive_file(self, file_id: str) -> None:
        def delete_once() -> None:
            request = urllib.request.Request(
                "https://www.googleapis.com/drive/v3/files/"
                f"{urllib.parse.quote(file_id)}?supportsAllDrives=true",
                headers={"Authorization": f"Bearer {self.drive.access_token}"},
                method="DELETE",
            )
            with urllib.request.urlopen(request, timeout=30):
                pass

        self._refresh_drive_session()
        try:
            delete_once()
        except urllib.error.HTTPError as error:
            # A Runme save can replace the imported Drive object. If the
            # original per-trial copy is already gone, cleanup is complete.
            if error.code == 401:
                try:
                    self.drive = refresh_drive_session(self.drive.service_account)
                    delete_once()
                except urllib.error.HTTPError as retry_error:
                    if retry_error.code != 404:
                        print(f"Drive cleanup warning for {file_id}: {retry_error}")
                except (OSError, ValueError) as retry_error:
                    print(f"Drive cleanup warning for {file_id}: {retry_error}")
            elif error.code != 404:
                print(f"Drive cleanup warning for {file_id}: {error}")
        except (OSError, ValueError) as error:
            print(f"Drive cleanup warning for {file_id}: {error}")

    def _refresh_drive_session(self) -> None:
        if drive_session_needs_refresh(self.drive):
            self.drive = refresh_drive_session(self.drive.service_account)


def load_cases(path: Path) -> list[EvalCase]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("Eval cases must be a non-empty JSON array")
    cases: list[EvalCase] = []
    seen: set[str] = set()
    for value in raw:
        if not isinstance(value, dict):
            raise TypeError("Each eval case must be an object")
        base_case_id = required_string(value, "id")
        repeat = value.get("repeat", 1)
        if not isinstance(repeat, int) or repeat < 1:
            raise ValueError(f"Case {base_case_id} has invalid repeat count")
        for trial in range(1, repeat + 1):
            case_id = base_case_id if repeat == 1 else f"{base_case_id}-{trial:03d}"
            if case_id in seen:
                raise ValueError(f"Duplicate eval case id: {case_id}")
            seen.add(case_id)
            trial_token = "RUNME-EVAL-" + re.sub(r"[^A-Za-z0-9-]", "-", case_id).upper()

            def render(
                text: str,
                trial_number: str = str(trial),
                token: str = trial_token,
            ) -> str:
                return text.replace("{trial}", trial_number).replace(
                    "{trial_token}", token
                )

            expected = string_list(value, "expected_answer_contains", base_case_id)
            cases.append(
                EvalCase(
                    case_id=case_id,
                    description=render(required_string(value, "description")),
                    notebook_url=render(required_string(value, "notebook_url")),
                    prompt=render(required_string(value, "prompt")),
                    expected_answer_contains=tuple(render(item) for item in expected),
                    expected_page_contains=(
                        render(str(value["expected_page_contains"]))
                        if value.get("expected_page_contains")
                        else None
                    ),
                    expected_answer_not_contains=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "expected_answer_not_contains",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_tool_contains=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "expected_tool_contains",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_tool_not_contains=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "expected_tool_not_contains",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_tool_not_regex=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "expected_tool_not_regex",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_notebook_cell_contains=(
                        render(str(value["expected_notebook_cell_contains"]))
                        if value.get("expected_notebook_cell_contains")
                        else None
                    ),
                    expected_notebook_cell_not_contains=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "expected_notebook_cell_not_contains",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_notebook_runner_name=(
                        render(str(value["expected_notebook_runner_name"]))
                        if value.get("expected_notebook_runner_name")
                        else None
                    ),
                    expected_notebook_output_contains=(
                        render(str(value["expected_notebook_output_contains"]))
                        if value.get("expected_notebook_output_contains")
                        else None
                    ),
                    distractor_urls=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "distractor_urls",
                            base_case_id,
                            required=False,
                        )
                    ),
                    setup_markdown_cells=tuple(
                        render(item)
                        for item in string_list(
                            value,
                            "setup_markdown_cells",
                            base_case_id,
                            required=False,
                        )
                    ),
                    expected_claimed_primary_tab=(
                        value.get("expected_claimed_primary_tab") is True
                    ),
                    expected_claimed_only_primary_tab=(
                        value.get("expected_claimed_only_primary_tab") is True
                    ),
                    category=str(value.get("category") or "uncategorized"),
                    confirmation_policy_trigger=(
                        render(str(value["confirmation_policy_trigger"]))
                        if value.get("confirmation_policy_trigger")
                        else None
                    ),
                    forbidden_answer_failure_mode=str(
                        value.get("forbidden_answer_failure_mode") or "forbidden_answer"
                    ),
                    copy_notebook=value.get("copy_notebook") is True,
                    copy_name_prefix=render(
                        str(value.get("copy_name_prefix") or "runme-eval")
                    ),
                )
            )
    return cases


def string_list(
    value: dict[str, Any],
    key: str,
    case_id: str,
    *,
    required: bool = True,
) -> list[str]:
    result = value.get(key)
    if result is None and not required:
        return []
    if not isinstance(result, list) or not all(
        isinstance(item, str) and item for item in result
    ):
        raise ValueError(f"Case {case_id} has invalid {key}")
    return result


def drive_file_id(reference: str) -> str:
    marker = "/file/d/"
    if marker in reference:
        return reference.split(marker, 1)[1].split("/", 1)[0].split("?", 1)[0]
    parsed = urllib.parse.urlparse(reference)
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("id"):
        return query["id"][0]
    raise ValueError(f"Unable to extract a Drive file id from {reference!r}")


def notebook_output_text(cell: dict[str, Any]) -> str:
    chunks: list[str] = []
    outputs = cell.get("outputs")
    if not isinstance(outputs, list):
        return ""
    for output in outputs:
        if not isinstance(output, dict):
            continue
        items = output.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            data = item.get("data")
            raw: bytes | None = None
            if isinstance(data, str):
                chunks.append(data)
                try:
                    raw = base64.b64decode(data, validate=True)
                except ValueError:
                    raw = None
            elif isinstance(data, list) and all(
                isinstance(value, int) and 0 <= value <= 255 for value in data
            ):
                raw = bytes(data)
            elif (
                isinstance(data, dict)
                and data
                and all(
                    str(key).isdigit() and isinstance(value, int) and 0 <= value <= 255
                    for key, value in data.items()
                )
            ):
                raw = bytes(
                    value
                    for _, value in sorted(data.items(), key=lambda pair: int(pair[0]))
                )
            if raw is not None:
                chunks.append(raw.decode("utf-8", errors="replace"))
    return "\n".join(chunks)


def refresh_drive_session(account: dict[str, Any]) -> DriveSession:
    credentials = service_account.Credentials.from_service_account_info(
        account, scopes=[DRIVE_SCOPE]
    )
    credentials.refresh(Request())
    if not credentials.token or credentials.expiry is None:
        raise RuntimeError("Google service-account authentication returned no token")
    return DriveSession(
        access_token=credentials.token,
        expires_at_ms=int(credentials.expiry.timestamp() * 1000),
        service_account=account,
    )


def load_drive_session(path: Path) -> DriveSession:
    account = json.loads(path.read_text(encoding="utf-8"))
    return refresh_drive_session(account)


def drive_session_needs_refresh(
    session: DriveSession, *, now_ms: int | None = None
) -> bool:
    if now_ms is None:
        now_ms = int(time.time() * 1000)
    return session.expires_at_ms <= now_ms + DRIVE_REFRESH_SKEW_MS


def drive_import_failure_message(state: Any) -> str | None:
    if not isinstance(state, dict):
        return None
    intents = state.get("driveLinkIntents")
    if not isinstance(intents, list):
        return None
    for intent in reversed(intents):
        if not isinstance(intent, dict) or intent.get("status") != "failed":
            continue
        message = intent.get("lastErrorMessage")
        if isinstance(message, str) and message:
            return message
        return "Runme Drive import failed without an error message"
    return None


def required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"Expected non-empty {key}: {value!r}")
    return result


def parse_runme_origin(value: str) -> str:
    """Validate and normalize the HTTP(S) origin hosting Runme Web."""
    if any(character.isspace() for character in value):
        raise argparse.ArgumentTypeError("Runme origin must not contain whitespace")
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme not in {"http", "https"} or parsed.hostname is None:
        raise argparse.ArgumentTypeError(
            "Runme origin must be an absolute HTTP(S) origin"
        )
    if parsed.username is not None or parsed.password is not None:
        raise argparse.ArgumentTypeError("Runme origin must not contain credentials")
    if parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise argparse.ArgumentTypeError(
            "Runme origin must not contain a path, query, or fragment"
        )
    try:
        _ = parsed.port
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"Invalid Runme origin: {error}") from error
    return f"{parsed.scheme}://{parsed.netloc}"


def rewrite_runme_urls(text: str, runme_origin: str) -> str:
    """Point production Runme links in an eval prompt at the selected origin."""
    return text.replace(DEFAULT_RUNME_ORIGIN, runme_origin)


def prepared_tab_ids_by_guest(browsers: list[dict[str, Any]]) -> dict[int, str]:
    """Map stable guest page identities to their prepared eval tab IDs."""
    result: dict[int, str] = {}
    for browser in browsers:
        guest_id = browser.get("guestWebContentsId")
        if not isinstance(guest_id, int) or isinstance(guest_id, bool):
            continue
        browser_tab_id = required_string(browser, "browserTabId")
        prior = result.get(guest_id)
        if prior is not None and prior != browser_tab_id:
            raise RuntimeError(
                "Prepared browser leases unexpectedly share guest page identity "
                f"{guest_id}: {prior!r} and {browser_tab_id!r}"
            )
        result[guest_id] = browser_tab_id
    return result


def prepared_tab_ids_by_page_key(browsers: list[dict[str, Any]]) -> dict[str, str]:
    """Map stable Browser page keys to their prepared eval tab IDs."""
    result: dict[str, str] = {}
    for browser in browsers:
        page_key = browser.get("pageKey")
        if not isinstance(page_key, str) or not page_key:
            continue
        browser_tab_id = required_string(browser, "browserTabId")
        prior = result.get(page_key)
        if prior is not None and prior != browser_tab_id:
            raise RuntimeError(
                "Prepared browser leases unexpectedly share page key "
                f"{page_key!r}: {prior!r} and {browser_tab_id!r}"
            )
        result[page_key] = browser_tab_id
    return result


def canonical_browser_tab_id(
    record: dict[str, Any],
    expected_by_guest: dict[int, str],
    expected_by_page_key: dict[str, str] | None = None,
    expected_by_alias: dict[str, str] | None = None,
) -> str | None:
    """Resolve a snapshot/event tab alias to its prepared logical tab ID."""
    guest_id = record.get("guestWebContentsId")
    if isinstance(guest_id, int) and not isinstance(guest_id, bool):
        prepared_id = expected_by_guest.get(guest_id)
        if prepared_id is not None:
            return prepared_id
    page_key = record.get("pageKey")
    if isinstance(page_key, str):
        prepared_id = (expected_by_page_key or {}).get(page_key)
        if prepared_id is not None:
            return prepared_id
    browser_tab_id = record.get("browserTabId")
    if isinstance(browser_tab_id, str):
        prepared_id = (expected_by_alias or {}).get(browser_tab_id)
        if prepared_id is not None:
            return prepared_id
    return (
        browser_tab_id if isinstance(browser_tab_id, str) and browser_tab_id else None
    )


def unexpected_browser_event_tab_ids(
    events: list[Any],
    expected: set[str],
    expected_by_guest: dict[int, str],
    expected_by_page_key: dict[str, str] | None = None,
    expected_by_alias: dict[str, str] | None = None,
) -> list[str]:
    """Return event tab IDs that do not resolve to prepared logical tabs."""
    unexpected: set[str] = set()
    for event in events:
        if not isinstance(event, dict):
            continue
        browser_tab_id = canonical_browser_tab_id(
            event,
            expected_by_guest,
            expected_by_page_key,
            expected_by_alias,
        )
        if browser_tab_id is not None and browser_tab_id not in expected:
            unexpected.add(browser_tab_id)
    return sorted(unexpected)


def isolated_runtime_environment(
    base: os._Environ[str] | dict[str, str], runtime_root: Path, codex_home: Path
) -> dict[str, str]:
    profile_home = runtime_root / "home"
    xdg_config = profile_home / ".config"
    xdg_cache = profile_home / ".cache"
    xdg_data = profile_home / ".local" / "share"
    xdg_state = profile_home / ".local" / "state"
    npm_cache = profile_home / ".npm"
    corepack_home = xdg_cache / "node" / "corepack"
    for directory in (
        profile_home,
        xdg_config,
        xdg_cache,
        xdg_data,
        xdg_state,
        npm_cache,
        corepack_home,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    environment = dict(base)
    # DotSlash and the bundled-plugin loader store immutable toolchain artifacts
    # under the user's cache. Reuse only those artifact caches so a fresh profile
    # does not need caller credentials merely to boot the dev app. This is not
    # Codex/browser profile state; all mutable application homes remain isolated.
    inherited_dotslash_cache = environment.get("DOTSLASH_CACHE")
    if not inherited_dotslash_cache and environment.get("HOME"):
        candidate = Path(environment["HOME"]) / "Library" / "Caches" / "dotslash"
        if candidate.is_dir():
            inherited_dotslash_cache = str(candidate)
    caller_cache_home = Path(
        environment.get("XDG_CACHE_HOME")
        or (Path(environment["HOME"]) / ".cache" if environment.get("HOME") else "")
    )
    caller_codex_apps_cache = caller_cache_home / "codex-apps"
    environment.update(
        {
            "CODEX_HOME": str(codex_home),
            "CODEX_APPS_WORKTREE_SETUP_OWNER": "1",
            "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0",
            "COREPACK_HOME": str(corepack_home),
            "GIT_CONFIG_GLOBAL": str(profile_home / ".gitconfig"),
            "HISTFILE": str(profile_home / ".shell_history"),
            "HOME": str(profile_home),
            "NPM_CONFIG_CACHE": str(npm_cache),
            "USERPROFILE": str(profile_home),
            "XDG_CACHE_HOME": str(xdg_cache),
            "XDG_CONFIG_HOME": str(xdg_config),
            "XDG_DATA_HOME": str(xdg_data),
            "XDG_STATE_HOME": str(xdg_state),
        }
    )
    if inherited_dotslash_cache:
        environment["DOTSLASH_CACHE"] = inherited_dotslash_cache
    if caller_codex_apps_cache.is_dir():
        environment["CODEX_APPS_CACHE_HOME"] = str(caller_codex_apps_cache)
    return environment


def remove_runtime_tree(path: Path) -> None:
    if path.is_symlink():
        path.unlink()
        return
    os.chmod(path, stat.S_IRWXU)
    for directory, child_directories, files in os.walk(path):
        os.chmod(directory, stat.S_IRWXU)
        for name in child_directories:
            child = Path(directory, name)
            if not child.is_symlink():
                os.chmod(child, stat.S_IRWXU)
        for name in files:
            child = Path(directory, name)
            if not child.is_symlink():
                os.chmod(child, stat.S_IRUSR | stat.S_IWUSR)
    shutil.rmtree(path)


def resolve_command(name: str) -> list[str]:
    environment_name = "npm_execpath" if name == "pnpm" else "npm_node_execpath"
    environment_path = os.environ.get(environment_name)
    if environment_path:
        executable = Path(environment_path).resolve()
        if executable.is_file():
            if name == "pnpm" and executable.suffix in {".cjs", ".js"}:
                node_path = os.environ.get("npm_node_execpath")
                if node_path:
                    return [str(Path(node_path).resolve()), str(executable)]
            return [str(executable)]

    resolved = shutil.which(name)
    if resolved is None:
        raise RuntimeError(f"Unable to resolve required executable: {name}")
    executable = Path(resolved).resolve()
    if os.name == "nt" and executable.suffix.lower() in {".bat", ".cmd"}:
        command_shell = os.environ.get("COMSPEC")
        if not command_shell:
            raise RuntimeError("COMSPEC is required to launch Windows command shims")
        return [str(Path(command_shell).resolve()), "/d", "/s", "/c", str(executable)]
    return [str(executable)]


def metadata_tracks_live_app(metadata_path: Path) -> bool:
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    if metadata.get("status") == "exited":
        return False
    pids = [
        metadata.get(key)
        for key in ("parentPid", "webviewPid", "electronPid")
        if isinstance(metadata.get(key), int)
    ]
    if not pids:
        return False
    for pid in pids:
        try:
            os.kill(pid, 0)
        except OSError:
            return False
    return True


def missing_answer_evidence(answer: str, expected: tuple[str, ...]) -> list[str]:
    normalized = answer.casefold()
    return [text for text in expected if text.casefold() not in normalized]


def present_evidence(answer: str, forbidden: tuple[str, ...]) -> list[str]:
    normalized = answer.casefold()
    return [text for text in forbidden if text.casefold() in normalized]


def present_regex_evidence(answer: str, forbidden: tuple[str, ...]) -> list[str]:
    return [pattern for pattern in forbidden if re.search(pattern, answer)]


def tool_call_evidence(item: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item[key]
        for key in (
            "type",
            "server",
            "tool",
            "name",
            "title",
            "arguments",
            "input",
        )
        if key in item
    }


def tool_evidence_from_turn_items(items: list[Any]) -> tuple[int, str]:
    completed_mcp_calls = [
        item
        for item in items
        if isinstance(item, dict)
        and item.get("type") == "mcpToolCall"
        and item.get("status") == "completed"
    ]
    node_repl_call_count = sum(
        item.get("server") == "node_repl" and item.get("tool") == "js"
        for item in completed_mcp_calls
    )
    command_calls = [
        item
        for item in items
        if isinstance(item, dict)
        and item.get("type") == "commandExecution"
        and isinstance(item.get("command"), str)
    ]
    evidence = [
        {
            "type": item.get("type"),
            "command": item.get("command"),
        }
        for item in command_calls
    ] + [tool_call_evidence(item) for item in completed_mcp_calls]
    return node_repl_call_count, json.dumps(evidence, sort_keys=True, default=str)


def browser_tab_aliases_from_turn_items(
    items: list[Any], expected_browser_tab_ids: set[str]
) -> dict[str, str]:
    """Extract unambiguous Browser tab ID to provider-tab ID mappings."""
    candidates: dict[str, set[str]] = {}

    def record(alias: Any, provider: Any) -> None:
        if (
            isinstance(alias, str)
            and alias
            and isinstance(provider, str)
            and provider in expected_browser_tab_ids
        ):
            candidates.setdefault(alias, set()).add(provider)

    def inspect(value: Any) -> None:
        if isinstance(value, dict):
            record(value.get("id"), value.get("providerTabId"))
            for child in value.values():
                inspect(child)
            return
        if isinstance(value, list):
            for child in value:
                inspect(child)
            return
        if not isinstance(value, str):
            return
        for block in re.findall(r"\{[^{}]{0,2000}\}", value, flags=re.DOTALL):
            alias_match = re.search(r"""["']?id["']?\s*:\s*["']([^"']+)["']""", block)
            provider_match = re.search(
                r"""["']?providerTabId["']?\s*:\s*["']([^"']+)["']""",
                block,
            )
            if alias_match is not None and provider_match is not None:
                record(alias_match.group(1), provider_match.group(1))

    for item in items:
        if (
            not isinstance(item, dict)
            or item.get("type") != "mcpToolCall"
            or item.get("status") != "completed"
            or item.get("server") != "node_repl"
            or item.get("tool") != "js"
        ):
            continue
        inspect(item.get("output"))

    return {
        alias: next(iter(providers))
        for alias, providers in candidates.items()
        if len(providers) == 1
    }


def category_counts(cases: list[EvalCase]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for case in cases:
        counts[case.category] = counts.get(case.category, 0) + 1
    return dict(sorted(counts.items()))


def failure_mode_counts(failures: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for failure in failures:
        mode = str(failure["failureMode"])
        counts[mode] = counts.get(mode, 0) + 1
    return dict(sorted(counts.items()))


def wilson_interval(successes: int, trials: int) -> tuple[float, float]:
    if trials == 0:
        return (0.0, 0.0)
    z = 1.959963984540054
    rate = successes / trials
    denominator = 1 + z * z / trials
    center = (rate + z * z / (2 * trials)) / denominator
    margin = (
        z
        * math.sqrt(rate * (1 - rate) / trials + z * z / (4 * trials * trials))
        / denominator
    )
    low = 0.0 if successes == 0 else max(0.0, center - margin)
    high = 1.0 if successes == trials else min(1.0, center + margin)
    return (low, high)


def redundant_confirmation_metrics(
    cases: list[EvalCase], failures: list[dict[str, Any]]
) -> dict[str, Any]:
    trials = sum(case.category == "redundant-confirmation" for case in cases)
    failure_count = sum(
        failure.get("category") == "redundant-confirmation"
        and (
            failure.get("failureMode") == "redundant_confirmation"
            or bool(
                present_regex_evidence(
                    str(failure.get("answer") or ""),
                    REDUNDANT_CONFIRMATION_PATTERNS,
                )
            )
        )
        for failure in failures
    )
    low, high = wilson_interval(failure_count, trials)
    triggers = sorted(
        {
            case.confirmation_policy_trigger or "generic"
            for case in cases
            if case.category == "redundant-confirmation"
        }
    )
    by_trigger: dict[str, Any] = {}
    for trigger in triggers:
        trigger_trials = sum(
            case.category == "redundant-confirmation"
            and (case.confirmation_policy_trigger or "generic") == trigger
            for case in cases
        )
        trigger_failures = sum(
            failure.get("category") == "redundant-confirmation"
            and (failure.get("confirmationPolicyTrigger") or "generic") == trigger
            and (
                failure.get("failureMode") == "redundant_confirmation"
                or bool(
                    present_regex_evidence(
                        str(failure.get("answer") or ""),
                        REDUNDANT_CONFIRMATION_PATTERNS,
                    )
                )
            )
            for failure in failures
        )
        trigger_low, trigger_high = wilson_interval(trigger_failures, trigger_trials)
        by_trigger[trigger] = {
            "trials": trigger_trials,
            "redundantConfirmations": trigger_failures,
            "rate": trigger_failures / trigger_trials if trigger_trials else 0.0,
            "wilson95": [trigger_low, trigger_high],
        }
    return {
        "trials": trials,
        "redundantConfirmations": failure_count,
        "rate": failure_count / trials if trials else 0.0,
        "wilson95": [low, high],
        "byTrigger": by_trigger,
    }


def build_summary(
    cases: list[EvalCase],
    results: list[dict[str, Any]],
    failures: list[dict[str, Any]],
) -> dict[str, Any]:
    completed_ids = {
        str(record["case"])
        for record in [*results, *failures]
        if isinstance(record.get("case"), str)
    }
    retryable_setup_ids = {
        str(failure["case"])
        for failure in failures
        if isinstance(failure.get("case"), str) and retryable_setup_failure(failure)
    }
    observed_cases = [
        case
        for case in cases
        if case.case_id in completed_ids and case.case_id not in retryable_setup_ids
    ]
    return {
        "complete": len(completed_ids) == len(cases),
        "completed": len(completed_ids),
        "remaining": len(cases) - len(completed_ids),
        "passed": len(results),
        "failed": len(failures),
        "total": len(cases),
        "categoryCounts": category_counts(cases),
        "failureModeCounts": failure_mode_counts(failures),
        "redundantConfirmation": redundant_confirmation_metrics(
            observed_cases, failures
        ),
        "results": results,
        "failures": failures,
    }


def write_results_checkpoint(path: Path, summary: dict[str, Any]) -> None:
    destination = path.expanduser().resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    os.replace(temporary, destination)


def load_results_checkpoint(
    path: Path, cases: list[EvalCase]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    checkpoint = json.loads(path.expanduser().resolve().read_text(encoding="utf-8"))
    results = checkpoint.get("results")
    failures = checkpoint.get("failures")
    if not isinstance(results, list) or not isinstance(failures, list):
        raise TypeError("Results checkpoint must contain results and failures arrays")
    records = [*results, *failures]
    case_ids = [record.get("case") for record in records if isinstance(record, dict)]
    if len(case_ids) != len(records) or not all(
        isinstance(case_id, str) for case_id in case_ids
    ):
        raise ValueError("Every checkpoint record must contain a string case id")
    if len(set(case_ids)) != len(case_ids):
        raise ValueError("Results checkpoint contains duplicate case ids")
    expected_ids = {case.case_id for case in cases}
    unknown = set(case_ids) - expected_ids
    if unknown:
        raise ValueError(
            f"Results checkpoint contains unknown cases: {sorted(unknown)}"
        )
    return results, failures


def retryable_setup_failure(record: dict[str, Any]) -> bool:
    error_type = str(record.get("errorType") or "")
    error_message = str(record.get("error") or "")
    return (
        record.get("failureMode")
        in {
            "setup_error",
            "transient_timeout",
        }
        or error_type
        in {
            "RunmeNotebookImportError",
            "CodexTaskTimeoutError",
            "TransportError",
        }
        or error_message.startswith("Timed out waiting for Codex task ")
        or (
            error_type == "HTTPError"
            and any(
                marker in error_message
                for marker in (
                    "HTTP Error 401:",
                    "HTTP Error 408:",
                    "HTTP Error 429:",
                    "HTTP Error 500:",
                    "HTTP Error 502:",
                    "HTTP Error 503:",
                    "HTTP Error 504:",
                )
            )
        )
    )


def failure_mode_for_exception(error: Exception) -> str:
    explicit_mode = getattr(error, "failure_mode", None)
    if isinstance(explicit_mode, str):
        return explicit_mode
    if retryable_setup_failure(
        {
            "errorType": type(error).__name__,
            "error": str(error),
        }
    ):
        return "setup_error"
    return "runtime_error"


def plugin_marketplace(catalog: dict[str, Any], plugin_name: str) -> str | None:
    marketplaces = catalog.get("marketplaces")
    if not isinstance(marketplaces, list):
        raise TypeError(f"Invalid Codex plugin catalog: {catalog!r}")
    for marketplace in marketplaces:
        if not isinstance(marketplace, dict) or not isinstance(
            marketplace.get("name"), str
        ):
            continue
        plugins = marketplace.get("plugins")
        if isinstance(plugins, list) and any(
            isinstance(plugin, dict) and plugin.get("name") == plugin_name
            for plugin in plugins
        ):
            return marketplace["name"]
    return None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--case", action="append", dest="case_ids")
    parser.add_argument("--category", action="append", dest="categories")
    parser.add_argument(
        "--confirmation-policy-trigger",
        action="append",
        dest="confirmation_policy_triggers",
        help=(
            "Select redundant-confirmation cases by their white-box Browser "
            "policy trigger; repeat for multiple triggers"
        ),
    )
    parser.add_argument("--list-cases", action="store_true")
    parser.add_argument("--codex-apps-root", type=Path)
    parser.add_argument(
        "--codex-auth-file", type=Path, default=Path.home() / ".codex/auth.json"
    )
    parser.add_argument(
        "--runme-origin",
        type=parse_runme_origin,
        default=DEFAULT_RUNME_ORIGIN,
        help="HTTP(S) origin hosting Runme Web (default: %(default)s)",
    )
    parser.add_argument("--service-account-file", type=Path)
    parser.add_argument("--attach-cdp-url")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument("--keep-runtime", action="store_true")
    parser.add_argument("--results-file", type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--setup-retries", type=int, default=2)
    parser.add_argument("--timeout-seconds", type=float, default=300)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    cases = load_cases(args.cases)
    if args.case_ids:
        selected = set(args.case_ids)
        matched = {
            selector
            for selector in selected
            if any(
                case.case_id == selector or case.case_id.startswith(f"{selector}-")
                for case in cases
            )
        }
        unknown = selected - matched
        if unknown:
            raise SystemExit(f"Unknown eval cases: {sorted(unknown)}")
        cases = [
            case
            for case in cases
            if any(
                case.case_id == selector or case.case_id.startswith(f"{selector}-")
                for selector in selected
            )
        ]
    if args.categories:
        selected_categories = set(args.categories)
        unknown_categories = selected_categories - {case.category for case in cases}
        if unknown_categories:
            raise SystemExit(f"Unknown eval categories: {sorted(unknown_categories)}")
        cases = [case for case in cases if case.category in selected_categories]
    if args.confirmation_policy_triggers:
        selected_triggers = set(args.confirmation_policy_triggers)
        available_triggers = {
            case.confirmation_policy_trigger
            for case in cases
            if case.confirmation_policy_trigger is not None
        }
        unknown_triggers = selected_triggers - available_triggers
        if unknown_triggers:
            raise SystemExit(
                "Unknown confirmation policy triggers: "
                f"{sorted(unknown_triggers)}; available: "
                f"{sorted(available_triggers)}"
            )
        cases = [
            case
            for case in cases
            if case.confirmation_policy_trigger in selected_triggers
        ]
    if args.list_cases:
        print(
            json.dumps(
                {
                    "count": len(cases),
                    "categories": category_counts(cases),
                    "cases": [
                        {
                            "id": case.case_id,
                            "category": case.category,
                            "confirmationPolicyTrigger": (
                                case.confirmation_policy_trigger
                            ),
                            "description": case.description,
                        }
                        for case in cases
                    ],
                },
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    if args.attach_cdp_url is None and args.codex_apps_root is None:
        raise SystemExit(
            "--codex-apps-root is required unless --attach-cdp-url is used"
        )
    if args.service_account_file is None:
        raise SystemExit("--service-account-file is required to run eval cases")

    if args.resume and args.results_file is None:
        raise SystemExit("--resume requires --results-file")
    if args.setup_retries < 0:
        raise SystemExit("--setup-retries must be nonnegative")
    results: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    if args.resume and args.results_file.expanduser().resolve().is_file():
        results, failures = load_results_checkpoint(args.results_file, cases)
        retried_failures = [
            failure for failure in failures if retryable_setup_failure(failure)
        ]
        if retried_failures:
            print(
                "Retrying setup failures from checkpoint: "
                + ", ".join(str(failure["case"]) for failure in retried_failures),
                flush=True,
            )
            failures = [
                failure for failure in failures if not retryable_setup_failure(failure)
            ]
    completed_case_ids = {str(record["case"]) for record in [*results, *failures]}
    pending_cases = [case for case in cases if case.case_id not in completed_case_ids]
    initial_summary = build_summary(cases, results, failures)
    if args.results_file is not None:
        write_results_checkpoint(args.results_file, initial_summary)
    if not pending_cases:
        print(json.dumps(initial_summary, indent=2, sort_keys=True))
        return 0 if not failures else 1

    runtime = CodexRuntime(
        apps_root=(args.codex_apps_root or Path.cwd()).resolve(),
        auth_file=args.codex_auth_file.expanduser().resolve(),
        attach_cdp_url=args.attach_cdp_url,
        keep_runtime=args.keep_runtime,
        runtime_root=args.runtime_root,
        timeout_seconds=args.timeout_seconds,
    )
    succeeded = False
    try:
        control = runtime.start()
        runner = RunmeEvals(
            control=control,
            drive=load_drive_session(args.service_account_file.expanduser().resolve()),
            timeout_seconds=args.timeout_seconds,
            runme_origin=args.runme_origin,
        )
        runner.configure_plugins()
        for case in pending_cases:
            print(f"Running {case.case_id}: {case.description}", flush=True)
            started = time.monotonic()
            setup_attempt = 0
            while True:
                try:
                    result = runner.run_case(case)
                    break
                except Exception as error:
                    failure_mode = failure_mode_for_exception(error)
                    if (
                        failure_mode in {"setup_error", "transient_timeout"}
                        and setup_attempt < args.setup_retries
                    ):
                        setup_attempt += 1
                        print(
                            f"Retrying {case.case_id} after transient error "
                            f"({setup_attempt}/{args.setup_retries}): {error}",
                            flush=True,
                        )
                        continue
                    failure = {
                        "case": case.case_id,
                        "category": case.category,
                        "confirmationPolicyTrigger": (case.confirmation_policy_trigger),
                        "passed": False,
                        "elapsedSeconds": round(time.monotonic() - started, 3),
                        "errorType": type(error).__name__,
                        "error": str(error),
                        "failureMode": failure_mode,
                        "setupAttempts": setup_attempt + 1,
                    }
                    failure.update(getattr(error, "evidence", {}))
                    failures.append(failure)
                    print(json.dumps(failure, indent=2, sort_keys=True), flush=True)
                    if args.results_file is not None:
                        write_results_checkpoint(
                            args.results_file, build_summary(cases, results, failures)
                        )
                    if args.fail_fast:
                        raise
                    result = None
                    break
            if result is None:
                continue
            result["elapsedSeconds"] = round(time.monotonic() - started, 3)
            result["setupAttempts"] = setup_attempt + 1
            results.append(result)
            print(json.dumps(result, indent=2, sort_keys=True), flush=True)
            if args.results_file is not None:
                write_results_checkpoint(
                    args.results_file, build_summary(cases, results, failures)
                )
        summary = build_summary(cases, results, failures)
        if args.results_file is not None:
            write_results_checkpoint(args.results_file, summary)
        succeeded = not failures
        print(json.dumps(summary, indent=2, sort_keys=True))
        return 0 if succeeded else 1
    finally:
        runtime.close(succeeded)


if __name__ == "__main__":
    raise SystemExit(main())
