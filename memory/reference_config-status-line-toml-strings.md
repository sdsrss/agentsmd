verified: 2026-07-03 | source: scripts/lib/config-toml.js fixtures with single-quoted, multiline, and commented tui.status_line

# Config Status Line TOML Strings

`tui.status_line` is TOML. Users may write arrays using double-quoted basic strings, single-quoted literal strings, multiline formatting, and comments outside strings.

The lightweight parser in `scripts/lib/config-toml.js` must preserve and parse both:

- `status_line = ["model"]`
- `status_line = ['model']`
- `status_line = [\n  "model",\n]`
- `status_line = [\n  "model", # comment\n  "branch#name",\n]`

This matters because `scripts/doctor.js` treats present-but-unparseable `tui.status_line` as a failed health check. A valid single-quoted custom footer must report as `custom`, not `unparseable`.

Regression coverage lives in `scripts/tests/install.test.js`: `doctor accepts a single-quoted custom tui.status_line`, `doctor accepts a multiline custom tui.status_line`, `doctor accepts comments inside a multiline custom tui.status_line`, `config: existing single-quoted user status_line is preserved`, `config: existing multiline user status_line is preserved`, and `config: existing commented multiline user status_line is preserved`.
