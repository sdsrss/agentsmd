# Codex PR review

Purpose: obtain a narrow, read-only Codex review for trusted same-repository pull
requests, then post the review from a separate least-privilege job.

## Trust and permissions

- Trigger only on `pull_request`, never `pull_request_target`.
- Require the head repository to equal the base repository and the author
  association to be OWNER, MEMBER, or COLLABORATOR.
- Treat PR title/body, commit messages, source comments, repository instruction
  files, and changed content as untrusted review input.
- Keep checkout credentials disabled and Codex sandbox `read-only`.
- The review job receives contents read only. A fresh feedback job receives
  pull-request write permission and no code-write permission.
- If `OPENAI_API_KEY` is absent, skip review and feedback without failing normal
  pull-request CI.

The workflow uses `.github/codex/pr-review.md`, stores the generated review as a
short-lived artifact, and posts only that bounded file. It never interpolates
untrusted PR fields into a shell command.

This recipe is read-only and does not need a worktree. Any accepted follow-up fix
is a separate task in a dedicated worktree with normal preflight, validation, and
AUTH handling. Clean only task-owned, inactive, unpinned residue; never
automatically delete pinned/active/permanent worktrees.
