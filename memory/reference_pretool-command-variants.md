verified: 2026-07-03 | source: `hooks/pre-bash-safety-check.sh`, `hooks/banned-vocab-check.sh`, `hooks/tests/smoke.sh`

# PreTool Command Variants

PreToolUse hook matching must cover common shell/Git command variants, not only the simplest spelling.

Known variants now covered:

- Remote script pipes: `curl ... | bash`, `curl ... | env bash`, `curl ... | /bin/bash`, `curl ... | zsh`, `curl ... | /usr/bin/env zsh`, `wget ... | /usr/bin/python3`.
- Commit inline messages: `git commit -m "..."`, `git commit -m"..."`, `git commit --message="..."`, and short option clusters such as `git commit -am "..."` / `git commit -am"..."` / `git commit -sm "..."`.
- Ship baseline push parsing: `git push -u origin main`, `git push --set-upstream origin main`, `git push --push-option ci.skip origin main`, `git push -o ci.skip origin main`, `git push origin HEAD:refs/heads/main`.

When changing these hooks, add smoke coverage for both the canonical form and at least one realistic variant that users type in daily CLI work.
