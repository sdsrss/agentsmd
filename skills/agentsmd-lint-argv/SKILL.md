---
name: agentsmd-lint-argv
description: Detect silent-fallback argv parsing in agentsmd bin/ and scripts/. Use when adding or reviewing a CLI flag/parser. Not for runtime hook command parsing or general linting; static read-only gate.
---

# agentsmd-lint-argv

Use the selected `SKILL.md` absolute path from the live skills list; never infer it from the process cwd. Define and call the adjacent launcher in the same shell. The launcher preserves selected bundle → manifest-owned standalone → versioned CLI identity checks and exports plugin context only for a verified selected bundle.

```bash
SKILL_MD="<selected SKILL.md absolute path from the live skills list>"
agentsmd_skill_run() {
  node "$(dirname "$SKILL_MD")/scripts/agentsmd-run.js" "$SKILL_MD" "$@"
}
```

The bug class: a CLI that reads a flag with `args.includes('--x')` or `args[args.indexOf('--x')+1]` silently ignores a mis-shaped flag (`--days 30` instead of `--days=30`) or a bare value flag that swallows the next token — the failure is invisible, the wrong default wins. This gate locks it out:

```bash
agentsmd_skill_run
agentsmd_skill_run --json
```

- **Antipattern scan** — `.includes('--` / `.find(a=>a.startsWith('--'))` / `.indexOf('--` on a code line. Suppress a deliberate one with an inline `// argv-lint:allow`.
- **Main-block scan** — a `require.main === module` block that never calls a real parser (`parseStrict` / `parseArgs` / `parseDaysArg` / `parseNoArgs` / `printHelpAndExit`) → a new CLI can't silently skip arg validation. No-arg CLIs (`install` / `uninstall`) are allowlisted.
- `0 hits` + exit 0 = clean; a hit → exit 1 naming `file:line [pattern]`. **Fix**: parse through `scripts/lib/argv.js` (`parseStrict` demands `--key=value`, rejects unknown flags loudly; `parsePositiveInt` rejects the `Number()`/`parseInt` coercion footguns).

Wired into `npm test` as a regression gate — a CLI that reintroduces the antipattern fails CI. From the repo instead of an install: `node scripts/lint-argv.js`.
