# agentsmd Audit Optimization Plan

## Goal

Resolve the nine audit findings from 2026-07-10 without weakening the immutable
safety floor or silently changing unrelated project behavior.

## Baseline Evidence

- `npm test`: 572 passed, 0 failed.
- `node scripts/lint-argv.js`: 0 hits.
- `node scripts/safety-coverage-audit.js`: 0 reported gaps, while semantic
  counterexamples still reproduced; static keyword coverage is not sufficient.
- `node scripts/doctor.js`: 12 checks passed before fault injection.
- Reproduced failures: `git commit -a` secret bypass, quoted `git -C` bypass,
  `0600 -> 0664` config mode change, prefix-owned skill deletion, deployed-copy
  self-update deletion, partial install, unlocked telemetry loss, and Chinese
  memory prompt non-recall.

## Audit Findings 1-9

1. Replace regex-only Git command detection with a shared quote-aware parser,
   including path-qualified Git and global options.
2. Scan tracked worktree changes for `git commit -a/--all` and preserve secure
   file modes during atomic writes.
3. Make install/update/uninstall manifest-owned and transactional; reject
   modified or foreign artifacts before any mutation.
4. Narrow the ship hook contract to the known-red remote status it observes and
   add repository CI for every supported Node line plus shell static checks.
5. Serialize telemetry rotation and append across hook processes.
6. Base governance on per-rule eligible/evaluated opportunities, not unrelated
   sessions or raw zero-hit counts.
7. Reduce the always-on prompt, keep safety/auth/evidence in core, follow the
   user's language, and separate SQL data mutation from schema destruction.
8. Make repository-memory writes opt-in, add bilingual recall triggers, and add
   positive/near-negative skill-routing fixtures.
9. Synchronize manifests, architecture, READMEs, changelogs, drift gates, and
   capability wording with the contracts the repository can verify.

## Phases

### Phase 1 - Security Command and File Boundaries

- Parse Git invocations with quote-aware argv handling shared by all Git gates.
- Include `git commit -a/--all` tracked worktree changes in the secret scan.
- Preserve existing file modes during atomic install/restore writes and use
  owner-only defaults for new Codex configuration/state files.
- Acceptance: regression fixtures for quoted `-C`, `commit -a`, path-qualified
  Git, mode preservation, canonical commands, and bypass tokens.

### Phase 2 - Installation Ownership and Transactions

- Replace prefix/substr ownership with manifest-backed exact ownership markers.
- Stage a complete release tree before switching hook registrations.
- Keep the previous release usable until shared-file updates and manifest commit
  complete; roll back on injected failure.
- Make doctor validate every registered hook and required support file.
- Acceptance: foreign skill/extended files survive, self-update is non-destructive,
  each injected phase failure restores the prior usable install.

### Phase 3 - Ship Contract and CI

- Rename the hook contract to the behavior it can prove: known-red remote branch
  protection. Do not claim full/local/fresh validation from remote-run presence.
- Add repository CI for the full Node/shell suite and shell static checks.
- Acceptance: red blocks; success permits; in-progress/no-run/stale cases are
  explicitly classified and documented; CI runs `npm test` and `shellcheck`.

### Phase 4 - Telemetry Integrity and Governance

- Serialize rotation plus append across concurrent hook processes.
- Record per-rule `eligible`/`evaluated` observations and keep enforcement events
  separate from denominators.
- Compute governance signals from rule-specific eligible sessions; insufficient
  opportunity never becomes a demotion recommendation.
- Acceptance: concurrent attempted rows equal retained rows with empty stderr;
  governance fixtures distinguish no opportunity, evaluated-clean, and active.

### Phase 5 - Prompt, Memory, and Routing Semantics

- Reduce always-on core size while preserving safety/auth/evidence gates.
- Follow the user's current language and the repository document language.
- Make repository memory archival opt-in and add bilingual recall triggers.
- Split SQL data-mutation safety from destructive schema operations.
- Move unpinned `npx` advice out of the immutable unknown-script telemetry bucket.
- Shorten skill descriptions and add positive/near-negative routing fixtures.

### Phase 6 - Integration and Documentation

- Synchronize `hard-rules.json`, hook registries, architecture, READMEs,
  changelogs, skills, and version/drift checks with the implemented contracts.
- Run targeted tests after each phase, then the full suite, shell syntax/static
  checks, package dry-run, doctor sandbox, and destructive temp-fixture smoke.

## Rollback

Work is isolated on `codex/optimize-audit-findings`. Each phase keeps a focused
diff and must pass its targeted validation before the next phase begins. No push,
publish, live `$CODEX_HOME` install, or release is part of this plan.

## Completion Criteria

All reproduced failures have a pre-change counterexample and a passing regression
test; all nine findings map to code or documentation changes; no unaccounted files
remain; the final report names any contract not proven end to end.

## Implementation Status

1. Git parser and all-invocation/refspec gates: implemented; smoke 139/139.
2. `commit -a` secret coverage and secure atomic modes: implemented; install 146/146.
3. Manifest ownership plus install/uninstall CAS transactions: implemented; sandbox lifecycle and exact shim-only reinstall green.
4. Known-red ship contract and CI: implemented; Ubuntu Node 18/20/22/24, shellcheck, and macOS Node 22 jobs declared.
5. Telemetry serialization and stale-lock recovery: implemented; audit 80/80, including 96-way normal and 32-way stale-recovery fixtures.
6. Rule-specific governance denominators: implemented; no-opportunity/evaluated-clean/active fixtures green.
7. Core prompt semantics: implemented; core is 16,301 B and drift-gated at 16 KiB.
8. Opt-in memory and skill routing: implemented; 15 frontmatters parse and 27 routing proxy cases pass.
9. Manifests/docs/drift/package surfaces: synchronized; final evidence is recorded in the task report.
