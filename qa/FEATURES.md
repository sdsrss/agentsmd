# Product feature inventory and test matrix

Prepared in Round 0 from `README.md`, `README.zh-CN.md`, `bin/agentsmd.js`,
`package.json`, CI configuration, scripts, hooks, and existing tests. Coverage
markers: `BASELINE` means covered by the existing automated suite in Round 0;
`ROUND6` means freshly replayed in Round 6 through the 87-case user journey or
the 908-assertion full suite; `BLIND` means the sandbox cannot exercise the real
external runtime.

## Test personas

- Beginner — 林小雨 / Mia Lin, first-time user, skips documentation, mixes
  Chinese and English, pastes emoji and malformed flags, retries commands, and
  abandons flows halfway through.
- Expert — Alex “快点” Chen, daily CLI user, uses pipes/redirection/nested shells,
  custom paths and automation JSON, expects strict exit codes and concise errors,
  and deliberately stresses idempotency and concurrency.

## F01 — CLI discovery and dispatcher

- Normal: `node bin/agentsmd.js --help`, `--version`, and each documented command
  route to the expected script. Status: BASELINE; user replay ROUND6.
- Boundary 1: bare invocation prints help and has zero install side effects.
  Status: BASELINE; user replay ROUND6.
- Boundary 2: global help and subcommand help in common positions return exit 0.
  Status: partial BASELINE; user replay ROUND6.
- Misuse: typoed commands, extra positionals, and malformed JSON flags fail with
  an actionable message and non-zero exit. Status: partial BASELINE; ROUND6.

## F02 — Standalone installer

- Normal: install from a local source into an isolated `CODEX_HOME`, then run
  status and doctor. Status: BASELINE; user replay ROUND6.
- Boundary 1: a pinned ref/local source and an update leave no temporary source.
  Status: BASELINE; ROUND6.
- Boundary 2: a repeated install is byte-stable. Status: BASELINE; ROUND6.
- Misuse: unknown options, a non-raw GitHub URL, or missing jq/node fail before
  partial installation. Status: partial BASELINE; ROUND6.

## F03 — npm CLI/package installation

- Normal: pack and install the package into a temporary prefix; run the linked
  `agentsmd` lifecycle. Status: BASELINE; user replay ROUND6.
- Boundary 1: bare CLI and `--help` never install. Status: BASELINE; ROUND6.
- Boundary 2: default install output is concise and `--json` is parseable.
  Status: BASELINE; ROUND6.
- Misuse: bare scoped `npx`, unknown commands, unknown flags, and reordered junk
  are rejected rather than silently defaulted. Status: partial BASELINE; ROUND6.

## F04 — Codex plugin marketplace

- Normal: manifest exposes the root plugin with hooks and skills. Status:
  BASELINE for static packaging; real browser/runtime BLIND.
- Boundary 1: browser installation is documented when `codex plugin` is absent.
  Status: documentation ROUND6; runtime BLIND.
- Boundary 2: `name@marketplace` and `--marketplace` forms are documented.
  Status: ROUND6; runtime BLIND.
- Misuse: wrong names, duplicate add, and confusing plugin-only installation with
  the full standalone footprint yield clear guidance. Status: BLIND.

## F05 — Local install and multi-tenant ownership

- Normal: install into an isolated `CODEX_HOME` preserves foreign hooks/config
  and produces healthy status/doctor output. Status: BASELINE; ROUND6.
- Boundary 1: custom `status_line`, file modes, spaces, Chinese, and emoji in the
  path survive. Status: partial BASELINE; ROUND6.
- Boundary 2: repeated installation and an OMX fixture remain byte-stable.
  Status: BASELINE; ROUND6.
- Misuse: malformed shared files, foreign collisions, or changed owned artifacts
  are refused without overwriting foreign bytes. Status: BASELINE; ROUND6.

## F06 — Update and atomic rollback

- Normal: update an older isolated install to the current version. Status:
  BASELINE; user replay ROUND6.
- Boundary 1: same-version update is idempotent. Status: BASELINE; ROUND6.
- Boundary 2: a foreign tenant or concurrent writer survives. Status: BASELINE;
  concurrency replay ROUND6.
- Misuse: injected failure rolls every owned/shared artifact back without a
  half-update. Status: BASELINE; ROUND6.

## F07 — Uninstall and compatibility shims

- Normal: uninstall removes owned entries while preserving all foreign bytes.
  Status: BASELINE; user replay ROUND6.
- Boundary 1: standalone and plugin surfaces require separate cleanup. Status:
  documentation ROUND6; plugin runtime BLIND.
- Boundary 2: cached-session no-op shims exit 0 and a later reinstall replaces
  them. Status: BASELINE; ROUND6.
- Misuse: hash mismatch, corrupt manifest, concurrent replacement, or repeated
  uninstall must not delete foreign state. Status: BASELINE; ROUND6.

## F08 — Backup and restore

- Normal: list/preview a compatible snapshot and restore only with `--confirm`.
  Status: BASELINE; user replay ROUND6.
- Boundary 1: default selection chooses the newest compatible pre-install
  snapshot. Status: BASELINE; ROUND6.
- Boundary 2: absent-at-backup files and file modes are preserved correctly.
  Status: BASELINE; ROUND6.
- Misuse: unknown options, incomplete snapshots, or incompatible install state
  fail without partial overwrite. Status: BASELINE; ROUND6.

## F09 — Legacy `codexmd` migration

- Normal: a provenance-verified legacy fixture migrates once. Status: BASELINE;
  user replay ROUND6.
- Boundary 1: partial legacy state and telemetry migrate without duplication.
  Status: BASELINE; ROUND6.
- Boundary 2: rerunning after migration is a no-op. Status: BASELINE; ROUND6.
- Misuse: modified or foreign same-named directories remain untouched and are
  reported. Status: BASELINE; ROUND6.

## F10 — Status inventory

- Normal: installed state reports hooks, manifest, tenants, status line, and
  telemetry row counts. Status: BASELINE; user replay ROUND6.
- Boundary 1: uninstalled and shim-only states report uninstalled. Status:
  BASELINE; ROUND6.
- Boundary 2: malformed telemetry rows are skipped in counts. Status: BASELINE;
  ROUND6.
- Misuse: malformed/null/array/wrong-identity manifests are not reported healthy.
  Status: BASELINE; ROUND6.

## F11 — Doctor health diagnosis

- Normal: a healthy isolated install exits 0 and identifies all checks. Status:
  BASELINE; user replay ROUND6.
- Boundary 1: single-, double-, and multiline TOML status-line strings parse.
  Status: BASELINE; ROUND6.
- Boundary 2: each missing deployed support file is named. Status: BASELINE;
  ROUND6.
- Misuse: unparseable config, stale spec, missing dependency, or missing wiring
  produces a non-healthy result rather than a crash. Status: BASELINE; ROUND6.

## F12 — Project `init`

- Normal: detect Node/Rust/Python/Go stack facts and write/update the managed
  project block while preserving user content. Status: BASELINE; ROUND6.
- Boundary 1: frontend frameworks, package-manager precedence, and mixed manifests
  are deterministic. Status: BASELINE; ROUND6.
- Boundary 2: `--local` is create-only and idempotently updates `.gitignore`.
  Status: BASELINE; ROUND6.
- Misuse: mutually exclusive modes, unknown flags, concurrent replacement, and
  existing local files must not clobber data. Status: BASELINE; ROUND6.

## F13 — Convention `analyze`

- Normal: gather an ignore-aware source map and write supplied conventions into
  the managed block. Status: BASELINE; ROUND6.
- Boundary 1: empty/ignored source sets and real Git ignore rules are handled.
  Status: BASELINE; ROUND6.
- Boundary 2: exact and over-budget inputs are accepted/refused without silent
  truncation. Status: BASELINE; ROUND6.
- Misuse: missing `--from`, duplicate/mixed modes, option-like values, and
  concurrent writes fail without damaging AGENTS.md. Status: BASELINE; ROUND6.

## F14 — Convention adoption

- Normal: real `@conv-*` citations aggregate per project and time window. Status:
  BASELINE; user replay ROUND6.
- Boundary 1: empty/no-opportunity windows report no data, not false pruning.
  Status: BASELINE; ROUND6.
- Boundary 2: multiple projects, days filters, and zero-cite anchors remain
  correctly scoped. Status: BASELINE; ROUND6.
- Misuse: invented anchors, invalid days/projects, and duplicate options do not
  forge citations or silently default. Status: BASELINE; ROUND6.

## F15 — Design token extraction

- Normal: preview and write CSS `:root`/Tailwind v4 `@theme` facts into DESIGN.md
  plus an AGENTS.md pointer. Status: BASELINE; ROUND6.
- Boundary 1: duplicate tokens, comments, strings, URLs, and special values parse
  without phantom/truncated tokens. Status: BASELINE; ROUND6.
- Boundary 2: non-frontend and Tailwind v3 inputs give an honest no-op/note.
  Status: BASELINE; ROUND6.
- Misuse: unknown flags, over-budget output, concurrent writes, and existing user
  content never cause silent truncation or clobbering. Status: BASELINE; ROUND6.

## F16 — Governance audit and rules

- Normal: aggregate known JSONL events by section/project and produce rule review
  signals. Status: BASELINE; user replay ROUND6.
- Boundary 1: exact cutoff/future timestamps, rotation, empty logs, and malformed
  rows are distinguished. Status: BASELINE; ROUND6.
- Boundary 2: no-opportunity/unevaluated rules never become false demotion
  candidates. Status: BASELINE; ROUND6.
- Misuse: negative, huge, duplicate, or nonnumeric days and unknown flags fail
  instead of silently using defaults. Status: BASELINE; ROUND6.

## F17 — Sampling, memory bypass, and sparkline reports

- Normal: scan isolated transcript/telemetry fixtures for §10 violations, memory
  cite-recall, and multi-window activity trends. Status: BASELINE; ROUND6.
- Boundary 1: missing directories, empty logs, unreadable transcripts, future
  timestamps, and test-tag exclusion remain explicit. Status: BASELINE; ROUND6.
- Boundary 2: went-silent, true zero, tiny nonzero, and unmeasurable results remain
  distinct. Status: BASELINE; ROUND6.
- Misuse: unsafe limits/windows/bucket sizes and unknown flags exit non-zero.
  Status: BASELINE; ROUND6.

## F18 — Safety coverage, argv lint, version cascade, and performance tools

- Normal: run each diagnostic against the real repository and parse text/JSON
  output. Status: BASELINE; user replay ROUND6.
- Boundary 1: hook filters, event filters, markdown/JSON modes, and current-major
  allowlists are exact. Status: BASELINE; ROUND6.
- Boundary 2: empty/all-zero inputs and odd/even performance medians are correct.
  Status: BASELINE; ROUND6.
- Misuse: nonexistent filters, unsafe run counts, stale tokens, and parser
  antipattern fixtures return an actionable non-zero result. Status: BASELINE;
  ROUND6.

## F19 — Native hook enforcement and advisory lifecycle

- Normal: all 15 registry hooks emit the expected block/advisory/context/log
  shape on canonical fixtures. Status: BASELINE; user replay ROUND6.
- Boundary 1: session isolation, queue lifecycle, fail-open telemetry, kill
  switches, and jq-less JSON escaping behave explicitly. Status: BASELINE;
  ROUND6.
- Boundary 2: nested shells, path-qualified tools, command chains, redirection,
  pipes, multilingual text, and commit variants are parsed. Status: BASELINE;
  expert replay ROUND6.
- Misuse: recursive-delete variables, unknown remote scripts, secrets, red shared
  pushes, false memory evidence, and invalid report shapes cannot bypass the
  declared gate through common command variants. Status: BASELINE; ROUND6.

## Known sandbox blind spots

- Real Codex plugin browser/cache behavior across Codex versions cannot be tested
  without mutating a live Codex installation; only static manifest/drift and
  isolated package behavior are in scope.
- Real GitHub/npm publishing, shared-branch CI, production configuration, and
  third-party accounts are prohibited. Their local parsers use fixtures/mocks.
- Cross-platform CI behavior on Node 18/20/24 and macOS is represented by local
  fixtures but cannot be freshly executed on this Linux/Node 22 host.
