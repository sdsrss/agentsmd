verified: 2026-07-03 | source: `openai-docs` Codex manual helper + `~/.codex/backups/omx-uninstall-2026-07-02T21-04-24-091Z/config.toml`

# Codex Status Line Ownership

The useful footer formerly restored from oh-my-codex is Codex's built-in `[tui] status_line`, not an OMX runtime process.

OMX's useful preset was:

```toml
status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]
```

agentsmd installer policy:

- Fill `[tui] status_line` with that preset only when no user status line exists.
- Preserve existing `[tui] status_line` and top-level dotted `tui.status_line` byte-for-byte.
- If top-level dotted `tui.*` keys exist and no status line exists, add `tui.status_line = [...]` instead of appending a duplicate `[tui]` table.
- Uninstall leaves the status-line setting in place because it is a user-visible Codex TUI preference.
