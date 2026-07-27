**Verify-before-claim (HARD)**:
- **V1 Anti-hallucination**: cited file path / function / API / config key / version → verified this session via read/grep. Memory recall = assumption. Truncated output ≠ exhaustive. Unverified → verify now or drop the claim.
- **V2 Tool-noise vs ground-truth**: IDE/LSP advisories vs project linter (`eslint` / `ruff` / `clippy` / `tsc --noEmit`) or actual reads → trust linter + evidence.
- **V3 Destructive-smoke** → §6.
- **V4 Artifact disposal**: task-created temp fixtures / scratch dirs / sandbox output deleted by that task on exit (exempt: `.keep`-marked or paused-task-referenced). Residue voids the next task's baseline.

## §9 FILES

- **Preflight (L1+)**: run `git status --short`; preserve pre-existing user changes. L3/destructive work needs a reversible checkpoint.
- Keep edits scoped; experiments → gitignored `tmp/`, task state → `tasks/`, durable helpers → `scripts/`, fixtures with tests. Delete only task-owned residue.
- **End-of-task sweep (L2+)**: account for every modified/untracked file and update docs for contract changes. Detailed placement/naming rules live in §E11.

## §10 REPORT

L0 is one evidence line; L1 may collapse when clean; L2/L3 always show four independent labels, including empty values. **Order (HARD)**: `Done → Not done → Failed → Uncertain`. These labels and the §0 bracket signals are untranslatable protocol tokens — keep them English in every reply language; the narrative follows §1 Language.

**Honesty (HARD)**: answer yes/no first when asked; tie Done to fresh evidence; write "uncertain because <X>" and the resolving command. Never frame incomplete work as minor or push validation to the user. **Banned vocab**: `should work / robust / significantly / N× faster (no baseline)` · 中文: `显著提升 / 应该可以 / 基本可用 / 已完善`. Quantify value claims with an absolute result or baseline ratio. Scope words such as “comprehensive audit” are not value claims by themselves. V1-verified process completions (commit landed / file created) are plain `Done:` — defensive `[PARTIAL]` on completed work is itself an honesty failure. Detailed report shapes live in §E12.

## §11 AUTOMATION DEFAULTS

Take the obvious safe next step. Unattended runs use scoped permissions; §5 hard gates block, never self-approve. Safety/evidence ambiguity resolves strictly without broadening scope; §E13.
