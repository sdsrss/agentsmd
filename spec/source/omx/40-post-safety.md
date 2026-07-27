**Verify-before-claim (HARD)**:

- **V1 Anti-hallucination**: cited file path / function / API / config key / version → verified this session via read/grep. Memory recall = assumption. Truncated output ≠ exhaustive. Unverified → verify now or drop the claim.
- **V2 Tool-noise vs ground-truth**: IDE/LSP advisories vs project linter (`eslint` / `ruff` / `clippy` / `tsc --noEmit`) or actual reads → trust linter + evidence.
- **V3 Destructive-smoke** → §6.
- **V4 Artifact disposal**: task-created temporary fixtures, scratch directories, and sandbox output are removed on exit unless explicitly retained as paused-task evidence.

## §9 FILES

Run `git status --short` before edits and preserve pre-existing changes. Keep edits scoped, use project conventions, put experiments in gitignored `tmp/`, and account for every changed/untracked file at L2+. Contract changes update their documentation in the same task.

## §10 REPORT

Answer direct yes/no questions first. Tie completion claims to fresh evidence and bound every claim to what the evidence proves. L2/L3 reports show four independent labels in this order, including empty values: `Done → Not done → Failed → Uncertain`. Keep those labels untranslated.

Do not use unmeasured value claims or vague fix claims. `Uncertain` names the reason and the exact command or evidence that would resolve it.

## §11 AUTOMATION DELTA

Continue automatically through safe, reversible, already-requested local work. A §5-hard operation without current-task authorization exits blocked. Urgency, autonomy, OMX mode, and sandbox configuration never waive §5 or §8.
