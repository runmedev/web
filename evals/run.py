#!/usr/bin/env python3
"""Run the Runme Web eval cases against a Codex Agent build."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from codex_driver import CodexEvalControl, EvalControlError
from google.auth.transport.requests import Request
from google.oauth2 import service_account

DEFAULT_CASES = Path(__file__).with_name("cases.json")
DEFAULT_STARTING_URL = "https://web.runme.dev/robots.txt"
DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
RUNTIME_ARTIFACT_NAMES = ("codex-agent.log", "codex-home", "user-data")


@dataclass(frozen=True)
class EvalCase:
    case_id: str
    description: str
    notebook_url: str
    prompt: str
    expected_answer_contains: tuple[str, ...]
    expected_page_contains: str | None = None
    copy_notebook: bool = False
    copy_name_prefix: str = "runme-eval"


@dataclass(frozen=True)
class DriveSession:
    access_token: str
    expires_at_ms: int
    service_account: dict[str, Any]


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
            self.runtime_root = Path(tempfile.mkdtemp(prefix="runme-codex-evals-"))
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
        state = {
            "electron-persisted-atom-state": {
                "electron:onboarding-projectless-completed": True
            }
        }
        (codex_home / ".codex-global-state.json").write_text(
            json.dumps(state), encoding="utf-8"
        )

        self.log_file = (self.runtime_root / "codex-agent.log").open(
            "w", encoding="utf-8"
        )
        environment = os.environ.copy()
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
        if self.log_file is not None:
            self.log_file.close()
        (self.runtime_root / "codex-home" / "auth.json").unlink(missing_ok=True)
        if (
            succeeded
            and not self.keep_runtime
            and not self.attach_cdp_url
            and self.owns_runtime_root
        ):
            shutil.rmtree(self.runtime_root)
        elif succeeded and not self.keep_runtime and not self.attach_cdp_url:
            for name in RUNTIME_ARTIFACT_NAMES:
                child = self.runtime_root / name
                if child.is_dir() and not child.is_symlink():
                    shutil.rmtree(child)
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
    ) -> None:
        self.control = control
        self.drive = drive
        self.timeout_seconds = timeout_seconds

    def configure_plugins(self) -> None:
        self.control.dispatch(
            {
                "type": "plugins.configure",
                "pluginName": "browser",
                "useBundledMarketplace": True,
                "install": True,
                "enabled": True,
            }
        )
        self.control.dispatch({"type": "plugins.sync_primary_runtime"})
        catalog = self.control.dispatch({"type": "plugins.list"})
        marketplace_name = plugin_marketplace(catalog, "runme")
        if marketplace_name is None:
            return
        self.control.dispatch(
            {
                "type": "plugins.configure",
                "pluginName": "runme",
                "marketplaceName": marketplace_name,
                "install": True,
                "enabled": True,
            }
        )

    def run_case(self, case: EvalCase) -> dict[str, Any]:
        copied_notebook: dict[str, str] | None = None
        browser: dict[str, Any] | None = None
        thread_id: str | None = None
        try:
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
            browser = self.control.dispatch(
                {
                    "type": "browser.open",
                    "conversationId": thread_id,
                    "startingUrl": DEFAULT_STARTING_URL,
                }
            )
            lease_id = required_string(browser, "leaseId")
            browser_tab_id = required_string(browser, "browserTabId")
            self._wait_for_page_origin(lease_id, "https://web.runme.dev")
            self._configure_runme_auth(lease_id)
            target_url = "https://web.runme.dev/?doc=" + urllib.parse.quote(
                notebook_url, safe=""
            )
            self.control.dispatch(
                {
                    "type": "browser.cdp",
                    "leaseId": lease_id,
                    "method": "Page.navigate",
                    "params": {"url": target_url},
                }
            )
            readiness = self._wait_for_runme(lease_id)
            tool_names = self._wait_for_webmcp(lease_id)

            before = self._browser_snapshot(thread_id)
            self._assert_exact_tabs(before, {browser_tab_id})
            submitted = self.control.dispatch(
                {
                    "type": "threads.send_message",
                    "threadId": thread_id,
                    "prompt": case.prompt,
                    "includeBrowserContext": True,
                }
            )
            browser_context = submitted.get("inAppBrowserContext")
            if (
                not isinstance(browser_context, dict)
                or browser_context.get("openTabCount") != 1
            ):
                raise RuntimeError("The prompt did not include the prepared Runme tab")

            completed = self._wait_for_thread(thread_id, browser_tab_id)
            after = self._browser_snapshot(
                thread_id, after_event_sequence=before["latestEventSequence"]
            )
            self._assert_exact_tabs(after, {browser_tab_id})
            unexpected = sorted(
                {
                    event.get("browserTabId")
                    for event in after["events"]
                    if event.get("browserTabId") not in {None, browser_tab_id}
                }
            )
            if unexpected:
                raise RuntimeError(
                    f"Codex opened unexpected browser tabs: {unexpected}"
                )

            page_evidence = None
            if case.expected_page_contains:
                page_evidence = self._page_contains(
                    lease_id, case.expected_page_contains
                )
                if not page_evidence:
                    raise RuntimeError(
                        f"Runme page did not contain {case.expected_page_contains!r}"
                    )
            answer = completed["answer"]
            missing = missing_answer_evidence(answer, case.expected_answer_contains)
            if missing:
                raise RuntimeError(
                    f"Answer omitted expected evidence {missing!r}: {answer!r}"
                )
            return {
                "case": case.case_id,
                "passed": True,
                "threadId": thread_id,
                "answer": answer,
                "browserTabId": browser_tab_id,
                "claimedPreparedTab": completed["claimedPreparedTab"],
                "pageEvidence": page_evidence,
                "readiness": readiness,
                "webMcpToolNames": tool_names,
                "copiedNotebook": copied_notebook,
            }
        finally:
            if browser is not None:
                try:
                    self.control.dispatch(
                        {
                            "type": "browser.close",
                            "leaseId": browser["leaseId"],
                            "clearStorage": True,
                        }
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
                        }
                    )
                except EvalControlError as error:
                    print(f"Task archival warning for {case.case_id}: {error}")

    def _configure_runme_auth(self, lease_id: str) -> None:
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

    def _wait_for_thread(self, thread_id: str, browser_tab_id: str) -> dict[str, Any]:
        deadline = time.monotonic() + self.timeout_seconds
        claimed = False
        while time.monotonic() < deadline:
            snapshot = self._browser_snapshot(thread_id)
            claimed = claimed or any(
                isinstance(tab, dict)
                and tab.get("browserTabId") == browser_tab_id
                and tab.get("isBrowserUseActive") is True
                for tab in snapshot["tabs"]
            )
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
            browser_calls = [
                item
                for item in items or []
                if isinstance(item, dict)
                and item.get("type") == "mcpToolCall"
                and item.get("server") == "node_repl"
                and item.get("tool") == "js"
                and item.get("status") == "completed"
            ]
            if not answers:
                raise RuntimeError("Codex completed without an assistant answer")
            if not browser_calls:
                raise RuntimeError("Codex completed without using the Browser plugin")
            if not claimed:
                raise RuntimeError("Codex did not claim the prepared Runme tab")
            return {"answer": answers[-1], "claimedPreparedTab": True}
        raise RuntimeError(f"Timed out waiting for Codex task {thread_id}")

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
    def _assert_exact_tabs(snapshot: dict[str, Any], expected: set[str]) -> None:
        actual = {
            tab.get("browserTabId") for tab in snapshot["tabs"] if isinstance(tab, dict)
        }
        if actual != expected:
            raise RuntimeError(
                f"Browser tabs differ from prepared leases: expected {sorted(expected)}, "
                f"found {sorted(actual)}"
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

    def _copy_notebook(self, case: EvalCase) -> dict[str, str]:
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
        return {
            "id": file_id,
            "name": str(copied.get("name") or name),
            "webViewLink": str(
                copied.get("webViewLink")
                or f"https://drive.google.com/file/d/{file_id}/view"
            ),
        }

    def _delete_drive_file(self, file_id: str) -> None:
        request = urllib.request.Request(
            "https://www.googleapis.com/drive/v3/files/"
            f"{urllib.parse.quote(file_id)}?supportsAllDrives=true",
            headers={"Authorization": f"Bearer {self.drive.access_token}"},
            method="DELETE",
        )
        try:
            with urllib.request.urlopen(request, timeout=30):
                pass
        except urllib.error.HTTPError as error:
            # A Runme save can replace the imported Drive object. If the
            # original per-trial copy is already gone, cleanup is complete.
            if error.code != 404:
                print(f"Drive cleanup warning for {file_id}: {error}")
        except (OSError, ValueError) as error:
            print(f"Drive cleanup warning for {file_id}: {error}")


def load_cases(path: Path) -> list[EvalCase]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list) or not raw:
        raise ValueError("Eval cases must be a non-empty JSON array")
    cases: list[EvalCase] = []
    seen: set[str] = set()
    for value in raw:
        if not isinstance(value, dict):
            raise TypeError("Each eval case must be an object")
        case_id = required_string(value, "id")
        if case_id in seen:
            raise ValueError(f"Duplicate eval case id: {case_id}")
        seen.add(case_id)
        expected = value.get("expected_answer_contains")
        if not isinstance(expected, list) or not all(
            isinstance(item, str) and item for item in expected
        ):
            raise ValueError(f"Case {case_id} has invalid expected answer evidence")
        cases.append(
            EvalCase(
                case_id=case_id,
                description=required_string(value, "description"),
                notebook_url=required_string(value, "notebook_url"),
                prompt=required_string(value, "prompt"),
                expected_answer_contains=tuple(expected),
                expected_page_contains=(
                    str(value["expected_page_contains"])
                    if value.get("expected_page_contains")
                    else None
                ),
                copy_notebook=value.get("copy_notebook") is True,
                copy_name_prefix=str(value.get("copy_name_prefix") or "runme-eval"),
            )
        )
    return cases


def drive_file_id(reference: str) -> str:
    marker = "/file/d/"
    if marker in reference:
        return reference.split(marker, 1)[1].split("/", 1)[0].split("?", 1)[0]
    parsed = urllib.parse.urlparse(reference)
    query = urllib.parse.parse_qs(parsed.query)
    if query.get("id"):
        return query["id"][0]
    raise ValueError(f"Unable to extract a Drive file id from {reference!r}")


def load_drive_session(path: Path) -> DriveSession:
    account = json.loads(path.read_text(encoding="utf-8"))
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


def required_string(value: dict[str, Any], key: str) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result:
        raise ValueError(f"Expected non-empty {key}: {value!r}")
    return result


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
    parser.add_argument("--codex-apps-root", type=Path)
    parser.add_argument(
        "--codex-auth-file", type=Path, default=Path.home() / ".codex/auth.json"
    )
    parser.add_argument("--service-account-file", type=Path, required=True)
    parser.add_argument("--attach-cdp-url")
    parser.add_argument("--keep-runtime", action="store_true")
    parser.add_argument("--runtime-root", type=Path)
    parser.add_argument("--timeout-seconds", type=float, default=300)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.attach_cdp_url is None and args.codex_apps_root is None:
        raise SystemExit(
            "--codex-apps-root is required unless --attach-cdp-url is used"
        )
    cases = load_cases(args.cases)
    if args.case_ids:
        selected = set(args.case_ids)
        unknown = selected - {case.case_id for case in cases}
        if unknown:
            raise SystemExit(f"Unknown eval cases: {sorted(unknown)}")
        cases = [case for case in cases if case.case_id in selected]

    runtime = CodexRuntime(
        apps_root=(args.codex_apps_root or Path.cwd()).resolve(),
        auth_file=args.codex_auth_file.expanduser().resolve(),
        attach_cdp_url=args.attach_cdp_url,
        keep_runtime=args.keep_runtime,
        runtime_root=args.runtime_root,
        timeout_seconds=args.timeout_seconds,
    )
    succeeded = False
    results: list[dict[str, Any]] = []
    try:
        control = runtime.start()
        runner = RunmeEvals(
            control=control,
            drive=load_drive_session(args.service_account_file.expanduser().resolve()),
            timeout_seconds=args.timeout_seconds,
        )
        runner.configure_plugins()
        for case in cases:
            print(f"Running {case.case_id}: {case.description}", flush=True)
            started = time.monotonic()
            result = runner.run_case(case)
            result["elapsedSeconds"] = round(time.monotonic() - started, 3)
            results.append(result)
            print(json.dumps(result, indent=2, sort_keys=True), flush=True)
        succeeded = True
        print(
            json.dumps(
                {"passed": len(results), "failed": 0, "results": results},
                indent=2,
                sort_keys=True,
            )
        )
        return 0
    finally:
        runtime.close(succeeded)


if __name__ == "__main__":
    raise SystemExit(main())
