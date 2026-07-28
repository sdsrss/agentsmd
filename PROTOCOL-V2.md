# agentsmd Surface Protocol v2

Status: implemented single-full-profile protocol.

## Objective

agentsmd has two delivery mechanisms—Codex plugin and manifest-backed
standalone—but one policy profile. The protocol prevents a delivery mechanism,
foreign marker, stale session pointer, or unrelated orchestration runtime from
changing the specification's authorization, evidence, safety, or reporting
contract.

The supported artifacts are:

- `spec/AGENTS.md`: the complete core profile;
- `spec/AGENTS-extended.md`: conditionally loaded L3/ship detail;
- `spec/source/layout.json`: the reproducible source layout.

`spec/AGENTS-omx.md` and runtime OMX profile selection are removed.

## Installation contract

Standalone is the full lifecycle:

1. prerequisite and ownership preflight;
2. durable backup and journal;
3. exact-path/hash-owned deploy and skills;
4. scoped hook merge;
5. transactional agentsmd sentinel merge into `$CODEX_HOME/AGENTS.md`;
6. extended-spec and status-line installation;
7. manifest commit.

Every byte outside the agentsmd `AGENTS.md` sentinels is preserved. Uninstall
removes only the owned block and manifest-proved artifacts. Repair reuses the
same transaction after a digest-bound read-only plan.

The Codex plugin is a cache-owned alternative. It injects the same complete
profile on trusted SessionStart and never writes the global `AGENTS.md`. Codex
plugins have no repository-controlled uninstall hook that can guarantee removal
of a global sentinel block, so global-file ownership remains in standalone.

A fresh standalone CLI install refuses when the exact enabled
`agentsmd@agentsmd` plugin is installed. There is no dual-surface opt-in.
Existing standalone installations remain updateable so an accidental legacy
dual surface can be repaired or removed.

## Profile contract

Public profile selection is:

```text
full
```

Omitting `--profile` and passing `--profile=full` produce the same bytes.
Removed values (`auto`, `omx-compatible`, `legacy-full`) are argv errors before
any mutation.

SessionStart always reports:

```json
{
  "profile": "full",
  "profileReason": "single-full-profile"
}
```

An explicit standalone `--profile=full` records `explicit-full`; the
materialized bytes are identical.

## Manifest schema

Schema v2 retains all schema-v1 ownership fields. New manifests add:

```json
{
  "manifestSchemaVersion": 2,
  "surfaceProtocolVersion": 2,
  "deliverySurface": "standalone",
  "profile": {
    "selectionMode": "full",
    "materialized": "full",
    "reason": "single-full-profile",
    "coreRelativePath": "spec/AGENTS.md",
    "coreSha256": "<sha256>",
    "capabilityContractVersion": 1
  },
  "bundleProfiles": {
    "full": {
      "relativePath": "spec/AGENTS.md",
      "sha256": "<sha256>"
    },
    "extended": {
      "relativePath": "spec/AGENTS-extended.md",
      "sha256": "<sha256>"
    },
    "layoutSchemaVersion": 1,
    "layoutSha256": "<sha256>"
  }
}
```

Profile metadata is health evidence, not deletion authority. Deletion remains
limited to schema-v1 `ownedArtifacts` with exact path and digest checks.

## Backward migration

The reader accepts the immediately previous dual-profile schema only when its
legacy `omx-compatible` bundle record is structurally complete. This compatibility
is one-way:

- status may report the old materialized profile as drift from desired `full`;
- `agentsmd update` writes the full core and a new single-profile manifest;
- repair does not invent missing legacy profile evidence;
- no marker or runtime state can select the removed profile;
- new packages do not ship the removed artifact.

Schema v1 remains readable and upgrades directly to the same single full
schema-v2 manifest.

## Plugin hook root contract

Each plugin hook launcher resolves:

1. official `PLUGIN_ROOT`;
2. legacy `CLAUDE_PLUGIN_ROOT`;
3. no root: clean exit 0.

Once launched, support paths derive from the script location. A missing
environment root therefore cannot expand to `/hooks/<name>.sh` and produce the
repeated code-127 Stop-hook failure class.

## Native orchestration contract

The full core includes only orchestration semantics that Codex can enforce
without an external state machine:

- solo execution by default;
- bounded independent delegation when it materially helps;
- exact child ownership, inputs, constraints, and verifiable output;
- leader-owned integration, conflict resolution, and final validation;
- dependencies serialized;
- only roles exposed by the active Codex surface;
- blockers and scope crossings escalated upward;
- no recursive child orchestration;
- no fabricated leader proof, pointer, authority, pane, or runtime state.

This deliberately excludes tmux coordination, session-pointer liveness,
documented-leader proofs, and Stop authorization. Those mechanisms require an
external runtime and are not valid prerequisites for completing or stopping a
normal Codex coding session.

## Health and arbitration

Structural health and runtime observation remain separate:

- bundle health verifies manifest, package, hooks, scripts, support files, full
  core, and extended version alignment;
- a private SessionStart receipt proves only that the handler prepared the
  selected profile;
- receipt absence is `unverified`, not fabricated activation evidence;
- dual-surface detection remains a doctor error and cleanup requirement;
- version arbitration chooses only among structurally healthy candidates.

No exact-once claim is made for a legacy dual-surface process. The supported
steady state is one delivery surface.

## Verification matrix

The executable matrix is in `qa/PROTOCOL_V2_TEST_MATRIX.md`. The required gates
cover:

- single-profile writer and strict argv;
- global sentinel merge/reversal;
- schema-v1 migration;
- previous dual-schema read-only migration compatibility;
- full/extended bundle digest and version alignment;
- plugin root official/fallback/absent cases;
- former marker cannot alter profile;
- plugin/standalone single-surface refusal;
- crash journal, ownership, repair, restore, and uninstall boundaries.
