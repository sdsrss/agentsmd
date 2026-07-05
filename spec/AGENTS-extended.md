# CODEX-CODING-SPEC v2.13.0 — Extended

Location: `~/.codex/AGENTS-extended.md`. NOT in the Codex discovery chain — costs zero `project_doc_max_bytes` budget; the agent reads it explicitly. Load triggers: defined ONCE in the core header (**Extended** line); core is the single source — this file does not restate them. How: read the whole file once at trigger, before ROUTE/plan; re-read on resume whenever the task file's `spec: … loaded` line is present but this file's content is not in context, and after any suspected compaction. Core spec always wins on conflict; §8 SAFETY and all three Iron Laws bind here unchanged — the only sanctioned modulation is core §6's EMERGENCY deferral of #1/#3.

## §E1 OVERRIDE MODES

All modes: Iron Laws + core §8 bind (only the core-§6 EMERGENCY deferral applies) · per-task scope, never sticky · announce the mode shift in one prose line at entry · **mode conflict → the most restrictive rule wins** (e.g. AUTONOMOUS restrictions beat EMERGENCY urgency).

- **HACK** (prototype / explore / throwaway): validation may drop to smoke-run; ALL output confined to `tmp/` (gitignored; sole tracked-file carve-out: the `tmp/` ignore-line bootstrap per core §9); no edits to tracked source. Promotion to real code = new task, re-enter CLASSIFY at the code's true level with full evidence — HACK results are hypotheses, not evidence. Sandbox artifacts deleted on exit (§8.V4).
- **EMERGENCY** (prod incident): mitigation-first is an ORDERING rule, not an AUTH waiver — propose rollback / flag-off / revert and take it through §5 hard AUTH BEFORE any root-cause work; no gate is skipped, gates are sequenced ahead of analysis. Evidence gathering is deferred, never skipped (= the core-§6 sanctioned deferral of Iron Laws #1/#3): a follow-up task MUST backfill root cause + regression test; the incident REPORT lists it under Not done. §5 hard gates still ask unless the user pre-authorized the incident scope in this session; no interactive user → AUTONOMOUS rules govern.
- **AUTONOMOUS** (scheduled / `codex exec` / no interactive user): only task types the user pre-authorized. Any §5 hard gate → `[BLOCKED]` + exit, never self-approve. Three-strike → paused-task (or dead-end in final message if FS read-only) + exit. Output captured via `--output-last-message`, four-section format. × EMERGENCY: put the mitigation recommendation (exact rollback command / flag) into the output; the action itself stays `[BLOCKED]` unless it falls inside the pre-authorized task types.

Mode ambiguity (weak trigger) → ASK once before entering; strong explicit trigger ("hack something together in tmp", "prod is down") → enter silently, announce inline.

## §E2 L3 FLOW

`research → plan (sub-phases) → per-phase: implement → validate → integrate → full validation → review → REPORT`

- **Blast-radius statement** precedes the `[AUTH REQUIRED]` for implementation: files/modules touched · contracts affected (additive vs breaking per core §2) · rollback plan. This is what the user approves.
- **Phase gate**: no phase N+1 while phase N is un-validated. Each sub-phase is small enough that its validation is runnable in isolation.
- **Review pass** distinct from authoring: subagent review when available; else an explicit self-review against the plan — checked items named, not "reviewed, looks good".
- **Checkpoint** (core §9 Preflight, hard at L3): branch / worktree created before implementation; every phase revertible.

## §E3 SHIP / RELEASE CHECKLIST (any `ship / deploy / publish / merge / release` intent)

Gate order — a red item stops the pipeline until fixed, waived by user, or `[BLOCKED]`:

1. Working tree clean, or every dirty file accounted for in REPORT.
2. Full validation green and FRESH (post-last-change run; targeted-only runs do not satisfy ship).
3. CHANGELOG entry matches the actual Δ — `fix:` restores intended behavior, `feat:` additive, `change:` alters defaults/contract; mislabeling a `change:` as `fix:` violates core §10 honesty.
4. Version bump consistent with Δ-contract (breaking → major, additive → minor, fix → patch).
5. Secrets scan on the outgoing diff (grep for key/token/password patterns) — hit → core §8 procedure.
6. Released-artifact rule (core §2): user-visible default change → documented in release notes, L3 evidence attached.
7. Rollback path stated in one line (revert commit / previous tag / flag-off).
8. The push/publish/merge itself = §5 hard AUTH, regardless of mode or `AUTONOMY` level. By design there is NO unattended path through this gate — scheduled / CI-driven release is out of scope for this spec, not a gap.

## §E4 L3 EVIDENCE

- **Evidence ladder** (claim strength MUST NOT exceed the tier actually run): e2e/integration on the real flow > behavior tests > targeted unit > typecheck/lint > inspection. State the tier used in REPORT.
- **Cold-start detail** (characterization-as-baseline is defined in core §6; this adds the L3 procedure): pick representative inputs that cover the touched contract; record exact commands + outputs in the task file so the diff is reproducible by a reviewer. Creating a full suite is NOT required; the framework's absence goes under Uncertain once.
- **Migration evidence**: dry-run / plan output captured before AUTH; rollback tested where the platform allows; row-count or schema-diff cited in REPORT.
- **Irreversibles** (deletes, prod data, published versions): evidence collected BEFORE the action (backup taken, dry-run diff) — post-hoc verification cannot un-delete.

## §E5 THREE-STRIKE / DEBUG DETAIL

- **Dead-end record** (in `tasks/<slug>.md`, written at strike 3): signature (verbatim error + `file:line` locus — the grep anchor for core §3 recurrence checks) · hypothesis · evidence for / against · why abandoned. Must survive the session: core §7 exit archival distills it into `memory/` + one `MEMORY.md` line — a dead-end that exists only in a gitignored task file does not count as remembered.
- **Same-signature escalation**: detection = core §3's git-log recurrence check (runs without this file loaded); the same L1 bugfix signature (same error, same locus) recurring 3× within a project → stop treating as L1; open an L2 root-cause task (core Iron Law #3 now binds).
- After a three-strike re-analysis, the FIRST step is re-verifying the assumption ranked most confident — repeated failure usually means the "certain" assumption is the wrong one.

## §E6 SKILL AUTHORING (demoted from core §4 in v1.3.2)

- Description MUST front-load trigger words, scope, AND non-trigger cases — implicit invocation matches on description alone, and truncated descriptions keep only the front.
- Keep one skill = one job; prefer instructions over scripts unless determinism or external tooling requires them.
- Creating or editing any skill / prompt template / MCP tool description = LLM-visible metadata → **L3** (core §2 hard upgrade); test the description against sample prompts before shipping it.

## §E7 SUPERPOWERS (optional `superpowers` / sp plugin)

Core §4 routes common task-types to sp skills; this section is the setup + boundary, read when §4 points here or on an L3 leaning on sp. No plugin → the §4 names don't resolve, base spec runs unchanged (zero impact); nothing here is a dependency.

- **Config**: `dispatching-parallel-agents` / `subagent-driven-development` need `config.toml [features] multi_agent = true` (enables `spawn_agent` / `wait_agent` / `close_agent`; close spawned agents when their work is done). `brainstorming` / `systematic-debugging` / `test-driven-development` need only the install.
- **Wider set**: sp ships more skills (plan writing/execution, code-review request/receive, git-worktrees, verification-before-completion, skill-authoring…); §4 names only the highest-frequency four — select any other by description per §4, not enumerated here to avoid budget cost + version staleness.
- **Boundary**: a skill executes this spec's rules, never relaxes them — Iron Laws, §5 AUTH, §8 SAFETY bind inside a skill exactly as outside; sp's own 'MUST invoke' wording does not override core §4 level routing.

## §E8 MID-SPINE TURN-YIELD (per-turn continuity, binds all levels)

Core §7's Session-exit rule covers the SESSION ending mid-cycle; this covers yielding a single TURN. Once a turn has run ≥1 tool call inside an active SPINE cycle, carry the planned steps through VALIDATE in that turn — a mid-cycle turn boundary is not a stopping point.

- **Not a turn boundary**: `<system-reminder>` / hook `additionalContext` injections · mid-turn tool results · PostToolUse flushes · a single Edit that "feels done". Running one tool call then stopping with planned steps unrun is a silent yield.
- **Legitimate yields only**: `[AUTH REQUIRED]` (core §5 hard) · direction genuinely ambiguous (ASK) · context-pressure → paused-task file (core §7). Everything else → finish the cycle.
- **The evasion**: a silent mid-cycle yield followed by a next-turn "done" claim asserts completion for steps that never ran = Iron Law #2 (no done without fresh evidence), not a reporting nicety. Tell — the next user message is `继续 / next / 怎么停了 / why did you stop`: a prior silent yield is confirmed; re-run VALIDATE before any "done".

## Changelog

→ `~/.codex/AGENTS-CHANGELOG.md` (single changelog for core + extended, outside the discovery chain).
