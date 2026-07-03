verified: 2026-07-03 | source: scripts/doctor.js fixture with broken tui.status_line

# Doctor Config Parseability

`scripts/doctor.js` is a user-facing health check. For detected config values, existence is not enough: if a parser reports the value as present but unparseable, doctor must fail that check.

Current example: `CT.getTuiStatusLine()` returns `exists: true, items: null` for malformed `tui.status_line` arrays such as `status_line = [broken`. Doctor reports this as `unparseable` and sets `ok: false`.

Parseable custom `tui.status_line` arrays still pass because user-defined footers are supported.
