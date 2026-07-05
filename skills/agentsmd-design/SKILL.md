---
name: agentsmd-design
description: Extract a frontend project's design tokens — CSS `:root` custom properties + Tailwind v4 `@theme` — into a facts-only DESIGN.md (sentinel-managed block) plus a one-line pointer in AGENTS.md. Use when the user wants Codex to know a project's design tokens (colors / spacing / typography / radii / shadows), asks to capture or document the design system, or is scaffolding project docs for a React/Vue/Svelte/Angular/Solid app. Deterministic (no AI), command-only, consent-gated — previews by default, writes only with --write. NOT for AI-distilled coding conventions (that is agentsmd-analyze); a no-op on a non-frontend project; does not parse a Tailwind v3 config-object theme (points you at tailwind.config.js instead).
---

# agentsmd-design

Turns a frontend project's design tokens into a **facts-only `DESIGN.md`** the agent can read when doing UI work — colors, spacing, typography, radii, shadows — extracted deterministically from the project's own CSS. Keeps `AGENTS.md` lean (a one-line pointer, not the tokens).

```bash
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/design.js"           # preview — writes nothing
node "${CODEX_HOME:-$HOME/.codex}/agentsmd/scripts/design.js" --write   # commit DESIGN.md + the AGENTS.md pointer
```

- **Deterministic, not AI**: tokens are facts, so this parses them directly (unlike `agentsmd-analyze`, which distills conventions with an AI step). Sources: `:root { --x: … }` custom properties and Tailwind v4 `@theme { --x: … }`.
- **Consent-gated**: default **previews** the exact managed block + writes nothing; `--write` commits. The block is sentinel-delimited (`<!-- agentsmd:design … -->`) so a re-run refreshes it in place and preserves anything you wrote outside it.
- **Budget-guarded**: refuses (never truncates) if the token block would exceed its size cap.
- **Honest edges**: a non-frontend project is a no-op; if no `:root`/`@theme` tokens are found the DESIGN.md says so — and for a Tailwind v3 project (theme in `tailwind.config.js`), it points you there (config-object parsing is a documented future extension).

Runs against the **current project directory** (like `init` / `analyze`), not `$CODEX_HOME`. From the repo instead of an install: `node scripts/design.js`. For AI-distilled coding conventions (naming, imports, error handling), use `agentsmd-analyze` instead.
