---
name: gh-issue-artifact-posting
description: Post CUJ/test summaries to GitHub PRs/issues with gh, and link durable artifacts (do not assume direct binary attachment upload in comments).
---

# GH issue/PR artifact posting

Use this skill when publishing test/CUJ results back to GitHub via `gh`.

## Key constraint

`gh issue comment` and `gh pr comment` publish markdown text only. Do **not** assume
these commands can directly upload binary attachments (PNG/WEBM) into the comment.

## Preconditions

1. `gh` is installed.
2. Auth token is available (`GH_TOKEN` or `GITHUB_TOKEN`).
3. Target repo and issue/PR number are known.
4. Artifacts are already stored in a durable location (e.g. GHA artifacts, Pages,
   release assets, or another approved store).

## Workflow

1. Auth preflight

```bash
gh auth status -h github.com
gh issue view <number> --repo <owner>/<repo>
# or
gh pr view <number> --repo <owner>/<repo>
```

2. Build markdown summary containing:

- pass/fail summary,
- key assertion notes,
- links to artifact locations (not local filesystem paths).

3. Post summary

```bash
gh issue comment <number> --repo <owner>/<repo> --body-file summary.md
# or
gh pr comment <number> --repo <owner>/<repo> --body-file summary.md
```

## Troubleshooting

- `Resource not accessible by personal access token (addComment)`:
  token lacks repo write scope for issues/PRs.
- Comment succeeds but no artifact previews:
  links are not public/durable, or target host blocks rendering.
- Artifacts only local (`/tmp`, workspace path):
  upload/store them first, then re-comment with links.
