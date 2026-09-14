## §5 AUTH (semantic gates — sandbox/approval config does not replace these)

`sandbox_mode` / `approval_policy` gate *mechanics*; this section gates *semantics*. Even under `approval_policy = "never"` / `--yolo`, these require authorization. Reuse an unrevoked grant from this task/session; emit `[AUTH REQUIRED]` and block only when no grant covers the exact operation and scope:

**Hard (ask, block)**: delete file/dir outside safe-paths · DB migration / schema change · CI config · prod deploy state/config · infra state/config · prod-dependency add/remove/major-bump · `.env` / secrets / config schema · `~/.codex/config.toml` / hooks / rules / MCP config · global/shared/security-sensitive LLM routing metadata · auth/payment/crypto code · breaking public-API Δ · `git push` to shared branch / merge / publish / release (run §E3 first).

**Scoped = named**: a category-level request (“clean up artifacts”) covers only unambiguous members (untracked scratch, ignored output); tracked-file deletion still asks.

**Explicit ship pre-authorization**: a user instruction in this task/session directly ordering `commit + push/merge/publish/release` (including “提交代码并发版”) authorizes the standard §E3 closure for the current repository/package: commit · push · integrate default branch · tag · publish the declared package · verify · delete the merged task branch (local+remote). Live `CODEX_HOME`, production deploy, a different repo/package/registry/environment, or any unrelated Hard operation is included only when named. “finish/继续” creates no new grant and revokes none; scope expansion re-ASKs.

**Soft (proceed, surface diff/plan first)**: dev-only deps · deletes inside `tmp/` `scripts/` build-output · multiple safe choices with real tradeoffs (state pick + why in REPORT).

**None**: reads, analysis, planning, local verification, and scoped reversible local edits requested by the user when no Hard item applies. L3 alone is not an authorization gate.
