# Codex-assisted release process (draft)

## Goals

- Enable maintainers to run a **manual, auditable release workflow** with Codex.
- Keep credentials minimal by relying on the permissions of the person triggering Codex.
- Make UI validation artifacts (screenshots/videos) accessible from PRs and issues.
- Use Codex to run tests, detect regressions, and iterate on fixes with human approval checkpoints.

## Trigger model

We intentionally use **manual triggers** only:

1. `@codex` mention on an issue or PR.
2. Codex UI session started by a maintainer.
3. App-based Codex trigger.

Rationale:

- No standalone Codex API key is required.
- Execution inherits the trigger user's permission model in GitHub/repo context.
- Maintainers can choose scope and timing (pre-release, release candidate, hotfix).

## Proposed release stages

### Stage 0 — Intake and context sync

Codex gathers:

- target release version,
- release branch/tag target,
- changelog source,
- known blockers,
- required CUJs.

Codex posts a short execution plan in the issue/PR thread before touching code.

### Stage 1 — Environment + dependency checks

Run setup tasks and classify outcomes:

- **Blocking checks**: must pass to proceed (e.g., install, build, required tests).
- **Non-blocking checks**: report warnings but allow continuation (e.g., optional tooling download issues when an equivalent command succeeds).

> Note on earlier confusion: `runme run configure` can fail (network/tooling fetch issue) while release validation still passes if the equivalent pnpm configuration command succeeds and all blocking checks pass. Future reports should explicitly mark this as **warning + fallback used**, not as a full pass.

### Stage 2 — Build + tests + regression detection

Codex runs the canonical build/test pipeline and records:

- exact commands,
- pass/fail/warn status per command,
- failing suites and first failing test(s),
- comparison against baseline expectations (where available).

Regression classification:

- **New regression**: test previously passing on base branch, fails on candidate.
- **Known failing**: already failing on base branch; do not block unless policy says otherwise.
- **Flaky suspect**: intermittent failure; rerun policy required.

### Stage 3 — Automated fix iteration loop

For each actionable regression:

1. Codex proposes root cause hypothesis.
2. Codex applies minimal patch.
3. Codex reruns targeted tests, then full required suite.
4. Codex posts diff summary and residual risk.

Loop stops when:

- required suites pass, or
- max iteration budget reached, or
- human asks to stop.

### Stage 4 — CUJ UI validation + artifact capture

Codex runs the app and executes CUJs (scripted/manual-assist).

Artifacts required per CUJ:

- screenshot(s),
- short video,
- machine-verifiable assertion log.

Codex should store artifacts in a **repo-accessible location**, not ephemeral `/tmp` references in final PR comments.

### Stage 5 — Release handoff

Codex prepares:

- release readiness summary,
- final changelog draft,
- remaining risks/open items,
- go/no-go recommendation.

A maintainer performs final approval and release/tag action.

## Artifact publishing design (screenshots/videos)

Problem: local `/tmp/...` artifact paths are not durable or user-accessible after session end.

### Preferred publication targets

1. **GitHub Actions artifacts** (if run in CI context)
   - durable for retention period,
   - downloadable by users with repo access,
   - easy link from PR comment.

2. **PR comment attachments** (images directly embedded; videos linked)
   - fastest reviewer UX,
   - good for key screenshots,
   - may need size limits handling for video.

3. **Issue comment links** for `@codex` issue-triggered runs
   - mirrors PR behavior when no PR exists yet.

### Permission model

- Codex inherits permissions from the triggering user/session.
- Posting to PR/issue requires write access to that thread.
- Uploading artifacts requires platform support in the execution environment (CI/App/Codex UI).
- If permissions are insufficient, Codex must:
  - explicitly report which action failed,
  - keep local artifact metadata,
  - provide instructions for a maintainer re-run with adequate permissions.

### Minimum artifact policy

For each CUJ run, publish:

- `summary.json` (machine-readable pass/fail + assertions),
- at least one screenshot,
- one short video (WebM/MP4),
- a markdown index linking all files.

## Reporting contract for Codex comments

Each run should post a structured report with:

1. **Command status table**
   - pass/fail/warn,
   - command string,
   - short failure reason,
   - fallback used (if any).

2. **Regression section**
   - detected regressions,
   - fixed regressions,
   - unresolved regressions.

3. **Artifact section**
   - durable links to screenshots/videos,
   - explicit note if links are ephemeral or unavailable.

4. **Decision section**
   - ready / not ready,
   - blocking reasons,
   - suggested next action.

## Open decisions

- Should release gating require *all* CUJs to pass, or allow a labeled exception list?
- What is the maximum Codex fix-iteration count before mandatory human review?
- Do we require baseline comparison against `main` for every release candidate?
- Where should long-term artifact retention live beyond GitHub retention windows?

## Next iteration tasks

1. Define a concrete `release-checklist.md` using this stage model.
2. Add a machine-readable schema for `summary.json` and regression report output.
3. Add CUJ runner integration that emits durable artifact bundle links.
4. Add a PR/issue comment template for Codex release updates.

## Verification: posting artifacts to GitHub from Codex container

Tested from this container against `runmedev/runme` issue `#69`.

### What was verified

1. Issue read access works without auth:
   - `GET /repos/runmedev/runme/issues/69` returned `200`.
2. Posting to issue comments without auth does **not** work:
   - `POST /repos/runmedev/runme/issues/69/comments` returned `401 Requires authentication`.

### Conclusion

- In a Codex container, posting screenshots/videos back to PRs/issues works **only if** the execution context provides GitHub credentials with write permission to issues/PRs.
- Without injected credentials, Codex can generate artifacts locally but cannot publish them to GitHub threads.

### Required permissions for successful publish

Minimum token scopes/permissions needed:

- Issues: write (for issue comments)
- Pull requests: write (for PR comments/reviews)
- Actions artifacts (if used): permissions to upload artifacts in workflow context

### Operational recommendation

Before CUJ runs, add a preflight "publishability check":

1. Verify GitHub auth is present.
2. Verify target thread write access using a dry-run comment API check.
3. If check fails, mark artifact publication as blocked and avoid claiming public links.

## Secret and token strategy for Codex environments

Short answer: **yes**, you can attach a secret to the Codex execution environment and use a narrow GitHub token for issue/PR posting.

### Can Codex generate and attach the secret itself?

- Codex can only do this if it already has privileged GitHub credentials that allow managing secrets.
- Without such bootstrap credentials, a human maintainer must create the secret and attach it to the environment.
- Therefore, treat secret creation as a platform/admin step, not a default runtime step.

### Recommended token type

1. **Best for automation at scale**: GitHub App installation token
   - short-lived,
   - repository-scoped by installation,
   - granular permissions.
2. **Practical fallback**: Fine-grained PAT
   - restrict to a single repository,
   - grant only required repo permissions,
   - enforce expiration and rotation.

### Minimum permissions for the artifact-posting use case

- Issues: **Read and write** (post issue comments)
- Pull requests: **Read and write** (post PR comments / status updates)
- Contents: **Read-only** (optional, only if Codex must read repo files via API)

### Implementation blueprint

1. Create token (GitHub App installation token preferred, or fine-grained PAT).
2. Store token as a secret in the Codex/Codespaces environment (for example `GITHUB_TOKEN_CUJ_BOT`).
3. Limit secret exposure to the specific repository and environment where release runs happen.
4. At run start, export token to process env and run preflight checks:
   - `GET` target issue/PR,
   - `POST` a dry-run marker comment (or equivalent permission probe),
   - delete probe comment if policy requires a clean thread.
5. If preflight fails, continue local validation but mark publication as blocked.

### Security guardrails

- Never print token values in logs.
- Use short token TTLs and rotate regularly.
- Prefer one-purpose tokens (artifact publishing only).
- If a token is suspected leaked, revoke immediately and re-run with a new secret.

## Verification notes: `GITHUB_TOKEN` and posting artifacts to PRs

Expected behavior when a token is attached to the Codex environment:

- If `GITHUB_TOKEN` is present and has `issues:write` / `pull_requests:write`, Codex can post comments to PR or issue threads through the GitHub REST API.
- The REST API does not provide a simple generic binary "upload attachment" endpoint for issue/PR comments; practical patterns are:
  1. publish artifacts to a durable location first (Actions artifacts, object storage, or committed files),
  2. post links/embedded image markdown in the PR comment.

Observed in this container during verification:

- `GITHUB_TOKEN` was not present in process environment, so authenticated post-to-PR verification could not be completed from this shell.
- This means the preflight should fail fast and mark "artifact publication blocked" rather than claiming upload success.

### Recommended preflight checks (must pass before claiming publication)

1. Verify token presence (`GITHUB_TOKEN` or equivalent secret env).
2. Verify target PR/issue identifier is known (`PR_NUMBER`/`ISSUE_NUMBER`).
3. Verify write access with an authenticated API probe (`POST` comment endpoint).
4. Only after (1)-(3), publish artifact links in a final comment.

## Codex-task verification procedure (repository-linked runtime)

When maintainers state that the repository-linked Codex task includes `GITHUB_TOKEN`, verify artifact posting in that runtime (not a generic shell) with the following sequence.

### Step-by-step verification script

```bash
# 1) Confirm token exists (do not print value)
python - <<'PY'
import os
print('GITHUB_TOKEN_PRESENT=', bool(os.getenv('GITHUB_TOKEN')))
PY

# 2) Check target thread is reachable
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/runmedev/runme/issues/69 | jq -r '.number, .state'

# 3) Post probe comment
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/runmedev/runme/issues/69/comments \
  -d '{"body":"Codex artifact publish probe (safe to delete)."}' | jq -r '.id, .html_url'
```

### Expected outcome

- If token and permissions are correct, step (3) returns a comment id/url (`201 Created`).
- If token is missing/invalid, step (3) returns `401`.
- If token exists but lacks permission, step (3) returns `403`.

### PR artifact posting pattern

For PRs, post a markdown comment that references durable artifact URLs, e.g.:

```markdown
### CUJ artifacts
- Screenshot: https://.../artifact.png
- Video: https://.../artifact.webm
```

This confirms that the Codex task can publish links back to the PR thread with the attached token scope.

## GitHub CLI (`gh`) standard for issue/PR publication

Use `gh` as the default publishing interface (instead of raw `curl`) for release-thread updates.

### Required commands

```bash
# Auth + reachability preflight
gh auth status -h github.com
gh issue view <ISSUE_NUMBER> --repo <OWNER>/<REPO>

# Publish comment with artifact links
gh issue comment <ISSUE_NUMBER> --repo <OWNER>/<REPO> --body-file artifacts-comment.md
# or for pull requests
gh pr comment <PR_NUMBER> --repo <OWNER>/<REPO> --body-file artifacts-comment.md
```

### Artifact handling with `gh`

- `gh issue comment` / `gh pr comment` publish markdown text.
- For binaries (PNG/WEBM), first publish them to a durable location (Actions artifact, committed file URL, or gist/release URL), then post links in comment markdown.
- Never publish local container paths like `/tmp/...` as final artifact references.

### Verification result in this shell

- `gh` was installed and used for probing.
- `gh auth status` reported not logged in and no token available.
- `gh issue comment 69 --repo runmedev/runme ...` failed due missing authentication.

This validates the preflight contract: if auth is absent, do not claim artifact publication success.
