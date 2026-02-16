---
name: gh-issue-artifact-posting
description: Use GitHub CLI to post issue/PR comments and publish artifact links (image/video) with auth preflight checks.
---

# GH issue artifact posting

Use this skill when asked to post Codex outputs back to GitHub issues/PRs using `gh`.

## Preconditions

1. `gh` is installed.
2. Auth is available via `GH_TOKEN` or `GITHUB_TOKEN` with at least:
   - issues:write
   - pull_requests:write (for PR comments)
3. You know the target repo and issue/PR number.

## Workflow

1. **Auth preflight**

```bash
gh auth status -h github.com
gh issue view <number> --repo <owner>/<repo>
```

If auth fails, stop and report publication is blocked.

2. **Create comment body**

Write a markdown file (e.g. `artifacts-comment.md`) containing summary and artifact links.

3. **Publish artifacts and link them**

Preferred options:

- GitHub Actions artifact URL (if run originated in CI)
- Versioned repo file links (committed PNG/WEBM)
- Gist link (last resort)

4. **Post comment using gh**

```bash
gh issue comment <number> --repo <owner>/<repo> --body-file artifacts-comment.md
```

For PRs:

```bash
gh pr comment <number> --repo <owner>/<repo> --body-file artifacts-comment.md
```

## Notes

- Do not claim success unless `gh issue/pr comment` returns success.
- Avoid pasting raw local paths (e.g. `/tmp/...`) in final comments.
- Never print token values in logs.
