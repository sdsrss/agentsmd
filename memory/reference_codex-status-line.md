verified: 2026-07-28 | source: `scripts/lib/config-toml.js` + `scripts/tests/install.test.js`

# Codex Status Line Ownership

The useful footer is Codex's built-in `[tui] status_line`, not a plugin runtime process.

The agentsmd preset is:

```toml
status_line = ["model-with-reasoning", "git-branch", "context-remaining", "total-input-tokens", "total-output-tokens", "five-hour-limit", "weekly-limit"]
```

agentsmd installer policy:

- Fill `[tui] status_line` with that preset only when no user status line exists.
- Preserve existing `[tui] status_line` and top-level dotted `tui.status_line` byte-for-byte.
- If top-level dotted `tui.*` keys exist and no status line exists, add `tui.status_line = [...]` instead of appending a duplicate `[tui]` table.
- Uninstall removes the preset only when the install manifest records that
  agentsmd added it and the current value is still the exact agentsmd preset.
  A pre-existing or subsequently customized status line is preserved byte-for-byte.
