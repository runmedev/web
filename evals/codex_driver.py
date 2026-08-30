"""Small CDP client for Codex desktop eval-control actions.

This module intentionally depends only on the public Chrome DevTools transport
and the JSON action boundary exposed by a Codex Agent/Dev build.
"""

from __future__ import annotations

import json
import time
import urllib.request
from dataclasses import dataclass
from typing import Any

import websocket

_DISPATCHER_SOURCE = r"""
async (action, timeoutMs) => {
  const bridge = window.electronBridge;
  if (!bridge || typeof bridge.sendMessageFromView !== "function") {
    throw new Error("Codex eval-control bridge is unavailable");
  }
  const requestId = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  let transfer = null;

  function receive(message) {
    if (message?.marker !== "codex-host-chunked-message-v1") return message;
    if (message.kind === "start") {
      const root = [];
      transfer = {
        id: message.transferId,
        nextSequence: 0,
        root,
        frames: [{ value: root }],
        string: null,
        parts: 0,
      };
    }
    const state = transfer;
    if (!state || state.id !== message.transferId) return null;
    if (message.sequence !== state.nextSequence++) {
      throw new Error("Invalid chunk sequence");
    }
    if (++state.parts > 4096) throw new Error("Chunk limit exceeded");

    function frame() {
      const value = state.frames[state.frames.length - 1];
      if (!value) throw new Error("Invalid chunk frame");
      return value;
    }
    function save(value) {
      const current = frame();
      if (Array.isArray(current.value)) current.value.push(value);
      else {
        if (current.key === undefined) throw new Error("Missing chunk key");
        current.value[current.key] = value;
        delete current.key;
      }
    }
    function key(value) {
      const current = frame();
      if (Array.isArray(current.value) || current.key !== undefined) {
        throw new Error("Invalid chunk key");
      }
      current.key = value;
    }

    for (const token of message.tokens || []) {
      switch (token.type) {
        case "array-start":
        case "object-start": {
          const value = token.type === "array-start" ? [] : {};
          save(value);
          state.frames.push({ value });
          break;
        }
        case "container-end":
          if (state.frames.length <= 1) throw new Error("Invalid chunk end");
          state.frames.pop();
          break;
        case "key":
          key(token.value);
          break;
        case "value":
          save(token.value);
          break;
        case "string-start":
          state.string = { target: token.target, parts: [] };
          break;
        case "string-chunk":
          if (!state.string) throw new Error("Invalid string chunk");
          state.string.parts.push(token.value);
          break;
        case "string-end": {
          if (!state.string) throw new Error("Invalid string end");
          const completed = state.string;
          state.string = null;
          const value = completed.parts.join("");
          if (completed.target === "key") key(value);
          else save(value);
          break;
        }
        default:
          throw new Error(`Unknown chunk token: ${token.type}`);
      }
    }
    if (typeof bridge.acknowledgeChunkedMessage === "function") {
      bridge.acknowledgeChunkedMessage(message.transferId, message.sequence);
    }
    if (message.kind !== "end") return null;
    if (state.frames.length !== 1 || state.root.length !== 1 || state.string) {
      throw new Error("Incomplete chunked response");
    }
    transfer = null;
    return state.root[0];
  }

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for Codex eval-control response"));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    }
    function onMessage(event) {
      if (event.source != null && event.source !== window) return;
      try {
        const message = receive(event.data);
        if (
          message?.type !== "debug-run-eval-control-response" ||
          message.requestId !== requestId
        ) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    }
    window.addEventListener("message", onMessage);
    Promise.resolve(
      bridge.sendMessageFromView({
        type: "debug-run-eval-control-request",
        action,
        requestId,
      }),
    ).catch((error) => {
      cleanup();
      reject(error);
    });
  });
}
"""


class EvalControlError(RuntimeError):
    pass


@dataclass(frozen=True)
class PageTarget:
    title: str
    url: str
    websocket_url: str


class CodexEvalControl:
    def __init__(self, cdp_url: str, timeout_seconds: float = 60) -> None:
        self.cdp_url = cdp_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def dispatch(
        self, action: dict[str, Any], *, timeout_seconds: float | None = None
    ) -> dict[str, Any]:
        timeout = timeout_seconds or self.timeout_seconds
        expression = (
            f"({_DISPATCHER_SOURCE})"
            f"({json.dumps(action, separators=(',', ':'))},"
            f"{int(timeout * 1000)})"
        )
        evaluated = self._evaluate(expression, timeout_seconds=timeout)
        if not isinstance(evaluated, dict):
            raise EvalControlError(f"Invalid eval-control response: {evaluated!r}")
        if evaluated.get("ok") is not True:
            raise EvalControlError(str(evaluated.get("errorMessage") or evaluated))
        result = evaluated.get("result")
        if result is None:
            return {}
        if not isinstance(result, dict):
            raise EvalControlError(f"Invalid eval-control result: {result!r}")
        return result

    def wait_until_ready(self) -> PageTarget:
        deadline = time.monotonic() + self.timeout_seconds
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                return self._app_target()
            except (
                EvalControlError,
                OSError,
                ValueError,
                json.JSONDecodeError,
            ) as error:
                last_error = error
                time.sleep(0.25)
        raise EvalControlError(f"Codex CDP target was not ready: {last_error}")

    def _evaluate(
        self, expression: str, timeout_seconds: float | None = None
    ) -> Any:
        try:
            return self._evaluate_transport(expression, timeout_seconds)
        except (OSError, ValueError, websocket.WebSocketException) as error:
            raise EvalControlError(f"Codex CDP transport failed: {error}") from error

    def _evaluate_transport(
        self, expression: str, timeout_seconds: float | None = None
    ) -> Any:
        timeout = timeout_seconds or self.timeout_seconds
        target = self._app_target()
        request = {
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": True,
                "returnByValue": True,
                "timeout": int(timeout * 1000),
            },
        }
        socket = websocket.create_connection(
            target.websocket_url,
            timeout=timeout + 5,
            suppress_origin=True,
        )
        try:
            socket.send(json.dumps(request))
            while True:
                message = json.loads(socket.recv())
                if message.get("id") != 1:
                    continue
                if "error" in message:
                    raise EvalControlError(f"CDP error: {message['error']}")
                evaluation = message.get("result", {})
                if evaluation.get("exceptionDetails"):
                    details = evaluation["exceptionDetails"]
                    raise EvalControlError(
                        str(
                            details.get("exception", {}).get("description")
                            or details.get("text")
                            or details
                        )
                    )
                remote = evaluation.get("result", {})
                return remote.get("value")
        finally:
            socket.close()

    def _app_target(self) -> PageTarget:
        with urllib.request.urlopen(f"{self.cdp_url}/json/list", timeout=5) as response:
            targets = json.load(response)
        candidates: list[tuple[int, PageTarget]] = []
        for target in targets:
            if target.get("type") != "page" or not target.get("webSocketDebuggerUrl"):
                continue
            url = str(target.get("url") or "")
            title = str(target.get("title") or "")
            is_app = url.startswith("app://-/") or (
                title in {"Codex", "ChatGPT"}
                and url.startswith(("http://127.0.0.1:", "http://localhost:"))
            )
            if not is_app:
                continue
            rank = 0 if "initialRoute=" not in url else 1
            candidates.append(
                (
                    rank,
                    PageTarget(
                        title=title,
                        url=url,
                        websocket_url=str(target["webSocketDebuggerUrl"]),
                    ),
                )
            )
        if not candidates:
            raise EvalControlError("No Codex desktop page target was found")
        candidates.sort(key=lambda item: item[0])
        return candidates[0][1]
