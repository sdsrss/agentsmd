# CODEX-CODING-SPEC — Changelog

Single changelog for the pair `~/.codex/AGENTS.md` (core) + `~/.codex/AGENTS-extended.md` (extended). From v1.4.0 both files carry ONE shared version and move together. This file sits outside the Codex discovery chain and costs zero context; the agent never loads it unless explicitly asked.

## v1.4.1 (2026-07-03) — version-sync (no rule changes)

Core + extended rule text is unchanged from v1.4.0; the shared version moves to
keep it in lockstep with the codexmd plugin's v1.4.1 hook-delivery fix (Stop
advisories deferred to the next UserPromptSubmit — see the repo `CHANGELOG.md`).
`hard-rules.json` `added_version` fields stay at v1.4.0 (that is when each rule
was added).

## v1.4.0 (2026-07-02) — structural-hole + consistency release (audit-driven)

Structural fixes (rules previously voided by their own loading structure or timing):

- core §3 **Recurrence check**: L1 bugfixes now run `git log --grep` on the error signature before fixing; ≥2 prior fixes (3rd+ occurrence) → open L2 root-cause task. Closes the chicken-and-egg where §E5's cross-task detector lived in a file whose load trigger the detector itself defined, while §7 auto-write skip #3 discarded the data it needed. Git history is the signature store — no memory writes added.
- core §7 **Exit archival (HARD)**: `[BLOCKED]` / paused / three-strike exits must distill dead-ends + durable findings into `memory/` + one `MEMORY.md` index line before exiting (FS read-only → final message). Previously archival only happened at REPORT stage, which abnormal exits never reach — dead-ends could never be found by §4's `MEMORY.md` routing in later sessions.
- §E5 **Dead-end record** gains a leading `signature` field (verbatim error + `file:line`) — the grep anchor the recurrence check matches against.
- core header + §5 **Ship-family single source**: ship intent defined once in the core **Extended** line (`push` shared / merge / PR / publish / release / deploy); §5 hard's push/merge/publish/release entry now points to §E3 before execution. Extended header no longer duplicates the trigger list (dual-write drift removed; its old "(from core §2/§5)" attribution was inaccurate).
- §E1 **EMERGENCY** clarified: mitigation-first = ORDERING (rollback proposal + its AUTH precede root-cause work), never an AUTH waiver. **Mode conflict → most restrictive wins**; AUTONOMOUS × EMERGENCY defined — mitigation recommendation goes into `--output-last-message`, the action stays `[BLOCKED]` unless pre-authorized.
- core §7 **Spec anchor in task files**: L3 task files open with `spec: core+extended v1.4.0 loaded`; the existing resume re-read of the task file now mechanically re-triggers the extended load (replaces reliance on "suspected compaction" self-awareness).
- core §6 **Characterization-as-baseline** promoted from §E4 into Iron Law #1's refactor branch, so L2 refactors in test-less repos have a path besides `[PARTIAL]`. Closes the former "pending v1.4 / F3" item; the dangling F3 reference is removed. §E4 keeps only the L3 procedure detail.
- core §6 **Iron Laws intro** now names the sole sanctioned exception (EMERGENCY deferral of #1/#3, #2 never deferrable) — previously "all overrides" contradicted §E1's deferral on a literal core-wins reading, and §E1's "Iron Law #2 + §8 still bind" implied #1/#3 were off in modes.

Consistency fixes:

- **Unified versioning + external changelog**: core previously shipped without a changelog section while extended pointed at it ("see core changelog" — dangling). Both files now reference this file; §E6's "(demoted from core §4 in v1.3.2)" is resolvable below.
- core §8: `.git/info/exclude` exempted from the "edit `.git/` internals" Never (config surface, not object surgery); core §9 + §E1: adding the `tmp/` ignore line is a permitted L0 pre-step **including under HACK** — resolves the deadlock where HACK forbade tracked-source edits but guaranteeing `tmp/` ignored required one.
- core §9: git status of memory layers made explicit — `tasks/` gitignored (machine-local; insights must reach `memory/` via exit archival to count), `memory/` + `MEMORY.md` committed (the auditable layer §7 is built on).
- core §7: `MEMORY.md` eviction policy — stale + un-re-verifiable after one refresh attempt → line moves to `memory/archive_index.md`; prune least-matched lines when the index bloats.
- core header: build-specific skill-path claims ("`~/.codex/skills/` also scanned in current builds — confirm via `/skills`") moved out of the spec; stable rule instead — `/skills` is the live-set source, build-specific paths belong in `memory/reference_*.md`. Silent-truncation warning + cap-raise guidance added to Discovery.
- §E3 item 8: unattended/scheduled release declared out of scope **by design** (previously impossible-by-construction via §E3.8 × §E1-AUTONOMOUS, but unstated).

Sizing: core 21,983 → 24,118 B (73.6% of the default 32,768 B combined cap; ~8.6 KB left for project chains — raise `project_doc_max_bytes` to 65536 in `config.toml` if a project layer starves). Extended 6,160 → 7,166 B (zero-budget, load-triggered). Growth is the cost of moving structural rules into the always-loaded layer; deep compression deferred to a usage-data-driven pass.

## Pre-v1.4.0 (partial — reconstructed)

- v1.3.3 core / v1.3.1 extended: the audited versions. Core's own changelog had been trimmed for byte budget; its history is not preserved. Known entries only:
- v1.3.2 core: skill authoring demoted from core §4 to extended §E6.
- v1.3.1 extended (2026-07-02): initial skeleton — E1 override modes, E2 L3 flow, E3 ship checklist, E4 L3 evidence + cold-start, E5 three-strike detail, E6 skill authoring. Content was pre-deployment scaffolding.
