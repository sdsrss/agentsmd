# agentsmd Surface Protocol v2

Status: **checkpoint 2 — strict v1/v2 dual reader implemented; writer remains v1**

Baseline: `v4.24.0`, `surfaceProtocolVersion: 1`

Decision date: 2026-07-27

Test contract: [`qa/PROTOCOL_V2_TEST_MATRIX.md`](qa/PROTOCOL_V2_TEST_MATRIX.md)

## 1. Outcome

Protocol v2 will let the Codex plugin surface and the npm/standalone surface
coexist, upgrade, repair, restore, and uninstall without losing agentsmd
functionality or damaging another tenant.

The protocol is not permission to replace the complete spec with a smaller
artifact. Every release continues to ship:

- the complete core, `spec/AGENTS.md`;
- the OMX-compatible core, `spec/AGENTS-omx.md`;
- the triggered extended spec, `spec/AGENTS-extended.md`;
- all registered hooks, support files, skills, and lifecycle commands.

A profile selects the correct entry point for the current environment. It does
not remove capabilities from the bundle.

## 2. Current contract

Protocol v1 already provides:

- plugin-only and standalone-only operation;
- a fresh-install guard that avoids creating an accidental dual surface;
- explicit `--allow-dual-surface` opt-in;
- health-first, SemVer-based arbitration;
- plugin-to-standalone yield through a private, freshness-bound arbitration
  cache;
- full-core plugin loading when OMX is absent;
- OMX-compatible plugin loading only when the active global guidance contains
  the exact OMX marker;
- complete-core fallback when OMX detection or the OMX-compatible artifact
  cannot be proved;
- a separately addressable extended spec;
- manifest-hash ownership for standalone deploy, extended spec, and skills;
- marker-scoped changes to shared `hooks.json`, `config.toml`, and `AGENTS.md`;
- durable install/uninstall journaling and crash recovery;
- compatible backup/restore, repair planning, and safe uninstall;
- plugin-private and standalone-private ephemeral runtime state.

Protocol v1 has two intentional limitations:

1. A v1 standalone hook cannot yield to a newer plugin winner. Arbitration can
   select the plugin, but the result remains non-exclusive/degraded because the
   already-registered standalone hook has no reciprocal yield contract.
2. Standalone always materializes the complete core in the global managed
   `AGENTS.md` block. Only the plugin chooses the OMX-compatible core at
   SessionStart.

Protocol v2 addresses those limitations without invalidating v1 ownership,
backup, restore, repair, or uninstall data.

## 3. Non-negotiable invariants

### 3.1 Feature completeness

1. `full`, `omx-compatible`, and `extended` artifacts remain present and
   version-aligned in every plugin and standalone release bundle.
2. Without a proved active OMX contract, the selected core is `full`.
3. If OMX detection is unknown, the OMX-compatible core is missing, its version
   differs, or its integrity cannot be proved, selection falls back to `full`.
4. `omx-compatible` is valid only while the exact OMX marker is present in the
   active global guidance. A similarly named package, binary, `.omx` directory,
   prompt, or inactive file is not activation evidence.
5. The extended spec remains reachable from both profiles and is never folded
   into a lossy profile conversion.
6. All 15 hook registrations, matcher/timeout/order semantics, kill switches,
   support files, skills, telemetry, and operator commands remain available.

### 3.2 Ownership and coexistence

1. Plugin installation does not write a standalone manifest or take ownership
   of global `AGENTS.md`, `hooks.json`, or `config.toml`.
2. Standalone changes only its sentinel block, its hook commands, and
   manifest-proved artifacts. Foreign bytes remain byte-preserved.
3. Prefixes, filenames, and surface detection are never ownership evidence.
   Exact path plus recorded digest remains the minimum destructive-operation
   proof.
4. Plugin-only cleanup removes only allowlisted private plugin runtime state.
   Standalone uninstall remains a separate operation.
5. Unknown, corrupt, symlinked, or mixed-owner state fails closed before
   destructive mutation.

### 3.3 Lifecycle safety

1. The install manifest remains the last live file written by install/update.
2. Every lifecycle mutation is preceded by a backup where the current command
   contract requires one and by a durable journal before the first live write.
3. Recovery always converges to a complete old state or a complete new state.
4. Foreign concurrent bytes cause a conflict; recovery never overwrites them.
5. New schemas are additive until the supported downgrade window closes.
6. A v2 installation can be safely uninstalled by the immediately preceding v1
   lifecycle implementation because the v1 ownership fields and artifact shape
   remain intact.

### 3.4 Honest observability

Structural health, selected profile, desired profile, arbitration exclusivity,
and observed runtime activation are separate facts. Status and doctor must not
turn one into evidence for another.

## 4. Decision

Protocol v2 uses **additive capability negotiation with materialized
standalone profiles**.

- Plugin mode keeps runtime profile selection because the plugin SessionStart
  owns the context it injects and does not mutate global guidance.
- Standalone mode materializes one core into the existing managed
  `AGENTS.md` block during an explicit install/update transaction.
- Both complete profile artifacts remain in the standalone deploy tree. A
  later profile change replaces only the managed core through the normal
  journaled update path.
- SessionStart may diagnose profile drift, but it does not rewrite global files
  and does not try to subtract a core already loaded by Codex discovery.
- Protocol negotiation adds reciprocal v2 standalone yield to a verified plugin
  winner. It does not claim exclusivity when either side lacks the required
  directional yield capability.

### 4.1 Rejected: dynamic standalone core replacement at every SessionStart

This would react automatically when OMX is installed or removed, but Codex may
already have loaded the global standalone block before the hook runs. Injecting
another core can duplicate or contradict the discovery-chain instructions, and
rewriting global `AGENTS.md` from a runtime hook would turn ordinary session
startup into a lifecycle mutation.

### 4.2 Rejected: ship only the currently selected profile

Removing the unused profile makes an OMX removal, detection failure, repair, or
offline rollback dependent on a package refetch. It also converts profile
selection into capability loss. Protocol v2 always ships all profile artifacts.

### 4.3 Rejected: treat SemVer precedence as sufficient for exact-once execution

Version selection does not prove that the losing hook understands how to yield.
Exclusivity is a negotiated directional capability, not a property of which
version number is larger.

## 5. Version fields

The install-manifest schema and the cross-surface runtime protocol describe
different things and must not share one version field.

### 5.1 Standalone manifest

The v2 standalone manifest adds these fields while retaining every v1 field:

```json
{
  "name": "agentsmd",
  "version": "4.x.y",
  "manifestSchemaVersion": 2,
  "surfaceProtocolVersion": 2,
  "deliverySurface": "standalone",
  "profile": {
    "selectionMode": "legacy-full",
    "materialized": "full",
    "reason": "v1-upgrade-preservation",
    "coreRelativePath": "spec/AGENTS.md",
    "coreSha256": "<sha256>",
    "capabilityContractVersion": 1
  },
  "bundleProfiles": {
    "full": {
      "relativePath": "spec/AGENTS.md",
      "sha256": "<sha256>"
    },
    "omx-compatible": {
      "relativePath": "spec/AGENTS-omx.md",
      "sha256": "<sha256>"
    },
    "extended": {
      "relativePath": "spec/AGENTS-extended.md",
      "sha256": "<sha256>"
    },
    "layoutSchemaVersion": 1,
    "layoutSha256": "<sha256>"
  },
  "ownedArtifacts": {
    "deploy": {
      "path": "<existing path>",
      "sha256": "<existing hash>"
    },
    "extended": {
      "path": "<existing path>",
      "sha256": "<existing hash>"
    },
    "skills": []
  },
  "deployedFiles": []
}
```

Normative rules:

- `manifestSchemaVersion` defaults to `1` when absent.
- A reader that understands v2 validates both the v1 ownership core and the v2
  profile/bundle extension.
- An unsupported future manifest schema is not silently treated as v1.
- `surfaceProtocolVersion` continues to describe yield/arbitration behavior.
- `profile.coreSha256` must equal both the selected bundle profile digest and the
  bytes materialized in the global managed block.
- `bundleProfiles` proves that fallback and extended artifacts are available;
  it does not expand uninstall ownership beyond `ownedArtifacts` and
  `deployedFiles`.
- Unknown additive fields remain tolerated so an immediately preceding reader
  can uninstall or replace a v2 manifest without misclassifying ownership.

### 5.2 Plugin manifest

The plugin manifest keeps the existing Codex plugin fields and declares:

```json
{
  "name": "agentsmd",
  "version": "4.x.y",
  "surfaceProtocolVersion": 2,
  "profileContractVersion": 1,
  "profiles": {
    "full": "spec/AGENTS.md",
    "omx-compatible": "spec/AGENTS-omx.md",
    "extended": "spec/AGENTS-extended.md"
  }
}
```

Plugin structural health requires all declared artifacts, matching release
versions, matching generator outputs, and the existing hook registry contract.

### 5.3 Arbitration cache

The cache schema becomes v2 only when reciprocal yield is implemented. It adds:

- the selected and losing surface identities;
- both surface versions and protocol versions;
- the direction of the negotiated yield;
- plugin root identity when the plugin participates;
- standalone manifest freshness key;
- creation time and bounded expiry;
- the capability result that justified `exclusive: true`.

A hook yields only when it is the named loser, its physical surface identity
matches the cache, the cache is fresh, and the named direction is supported.
Malformed, stale, mismatched-root, or unsupported caches do not suppress
enforcement.

## 6. Profile selection

### 6.1 Plugin

The existing runtime rule remains:

| Evidence | Selected profile |
|---|---|
| Exact active OMX marker + valid aligned OMX artifact | `omx-compatible` |
| Marker absent | `full` |
| Detection unknown | `full` |
| OMX artifact missing, corrupt, or wrong version | `full` |

The activation receipt records the selected profile and reason. It proves only
that SessionStart prepared that response.

### 6.2 Standalone

Standalone selection is transaction-bound:

| `selectionMode` | Behavior |
|---|---|
| `legacy-full` | Preserve the v1 materialized full core across the initial schema migration |
| `auto` | Select `omx-compatible` only with the exact active OMX marker; otherwise `full` |
| `full` | Explicitly materialize the complete core |
| `omx-compatible` | Accepted only when the exact active OMX marker is currently proved |

An OMX state change after installation creates profile drift:

- `status` reports configured and desired profiles;
- `doctor` reports an actionable, non-destructive update command;
- SessionStart continues using the already materialized standalone profile;
- no hook mutates global files automatically.

The initial v2 writer uses `legacy-full` for v1 upgrades. Automatic standalone
profile adaptation is enabled only in a later rollout step after profile parity
and real Codex E2E gates pass.

## 7. Mixed-version arbitration

Health is evaluated before version or protocol negotiation.

| Winner | Loser | Exclusive condition |
|---|---|---|
| standalone | plugin | plugin is healthy and supports plugin-to-standalone yield (`protocol >= 1`) |
| plugin | standalone | standalone is healthy and supports standalone-to-plugin yield (`protocol >= 2`) |
| either | absent loser | exclusive |
| either | unhealthy/legacy/unknown loser | non-exclusive and degraded |
| none | any | no healthy surface; degraded fallback only |

Additional rules:

- Same healthy SemVer precedence keeps the existing deterministic standalone
  winner.
- Build metadata does not affect precedence.
- A newer v2 plugin can win over a healthy v1 standalone, but it cannot claim
  exact-once execution because the v1 standalone cannot yield.
- A v1 plugin can yield to a v2 standalone because that direction already
  exists in protocol v1.
- No surface rewrites or unregisters the other surface as part of arbitration.
- A non-exclusive result remains visible in status, doctor, and SessionStart.

## 8. Lifecycle transitions

### 8.1 v1 to v2 update

1. Read the v1 manifest as schema 1.
2. Validate all existing exact-path ownership and hashes.
3. Create the normal pre-install backup.
4. Stage the complete release, including every profile.
5. Build a v2 manifest with `selectionMode: legacy-full` and
   `materialized: full`.
6. Persist the existing compatible journal shape.
7. Swap owned trees and write shared files with compare-and-swap checks.
8. Write the v2 manifest last.
9. On any failure, restore the byte-identical v1 state or retain conflict
   evidence without overwriting foreign bytes.

The schema migration itself does not change the user's active profile.

### 8.2 v2 update and profile change

A profile change is a normal update transaction. It snapshots the current
managed block, stages the complete bundle, records the selected core digest,
and writes the manifest last. A crash cannot leave a v2 manifest claiming one
profile while `AGENTS.md` contains another.

### 8.3 Downgrade

During the supported downgrade window:

- v2 keeps all v1 manifest ownership fields and deployed artifact shapes;
- the prior v1 installer can validate and replace the install;
- the prior v1 uninstaller can remove manifest-owned artifacts;
- unknown additive v2 fields do not change ownership;
- downgrade materializes the v1 complete core, providing a safe functional
  fallback even though v2 profile metadata is discarded.

No new journal step kind is introduced until every supported downgrade reader
can fail closed on it. The first v2 implementation adds metadata only to the
existing journal shape.

### 8.4 Backup and restore

Backup schema evolution is additive:

- new snapshots record `backupSchemaVersion`, current manifest schema/protocol,
  current materialized profile, and current manifest digest;
- snapshot contents remain the authority for the shared-footprint state;
- legacy snapshots without new metadata remain classified from their actual
  bytes;
- default and explicit restore keep the existing install-state compatibility
  guard;
- restore never converts profiles and never recreates shared agentsmd entries
  without a compatible owned runtime and manifest;
- `install → update → uninstall → restore` must remain uninstalled.

### 8.5 Repair

Repair remains plan-first and digest-bound:

- v2 can plan against valid v1 and v2 manifests;
- missing owned artifacts are repairable only from a release artifact matching
  the manifest release identity;
- modified or unexpected owned content is not automatically adopted;
- invalid, future, or ownership-unprovable manifests do not permit apply;
- profile drift alone recommends an update/profile transaction, not repair;
- confirmed repair preserves the manifest's materialized profile unless the
  user explicitly requested an allowed profile change.

### 8.6 Uninstall

Standalone uninstall continues to depend on the v1 ownership core. It removes
only exact manifest-owned artifacts and agentsmd's shared entries. Profile and
bundle metadata are diagnostic, not additional deletion authority.

Plugin-only cleanup remains independent and removes only allowlisted private
runtime records. Uninstalling one surface never silently uninstalls the other.

## 9. Status and doctor contract

Status adds machine-readable fields without changing existing fields:

```json
{
  "manifestSchemaVersion": 2,
  "surfaceProtocolVersion": 2,
  "configuredProfile": "full",
  "desiredProfile": "omx-compatible",
  "profileSelectionMode": "legacy-full",
  "profileState": "drift",
  "bundleProfilesComplete": true
}
```

Doctor reports separate checks for:

1. install-manifest schema and ownership validity;
2. complete profile bundle integrity;
3. materialized core identity;
4. desired-vs-configured profile;
5. structural plugin health;
6. cross-surface arbitration exclusivity;
7. observed plugin runtime activation;
8. pending lifecycle transaction and recovery direction.

Profile drift is not reported as lost enforcement. It is an actionable
configuration mismatch. Missing/corrupt materialized bytes or missing fallback
artifacts are health failures.

## 10. Rollout

Protocol v2 is delivered in independently reversible checkpoints:

1. **Characterization gate** — retain the current v1 writer; add schema,
   profile-equivalence, mixed-version, and lifecycle fixtures.
2. **Dual reader** — read and report v1/v2 manifests while still writing v1.
3. **Metadata-only v2 writer** — write v2 with `legacy-full`; no profile behavior
   change and no new journal step kind.
4. **Reciprocal arbitration** — add v2 standalone-to-plugin yield with hostile
   cache tests; keep mixed v1 results non-exclusive.
5. **Explicit profile transaction** — add `full`/proved `omx-compatible`
   materialization through install/update, still defaulting upgraded users to
   `legacy-full`.
6. **Automatic profile default** — enable `auto` only after isolated real Codex
   plugin/standalone E2E proves no duplicated guidance, no missing extended
   behavior, and correct OMX install/remove transitions.

Each checkpoint must pass the full existing suite plus the protocol-v2 matrix.
Failure rolls back the checkpoint; later stages do not weaken an earlier gate.

## 11. Implementation stop condition

Protocol-v2 implementation is not complete until:

- all existing tests remain green;
- every preservation row in the protocol-v2 matrix is green;
- v1-to-v2, v2-to-v1, crash recovery, repair, restore, and uninstall fixtures
  prove complete old-or-new state;
- no profile artifact or hook capability is absent from either release bundle;
- dual-surface exact-once is claimed only for a proved yield direction;
- live-guard proves tests did not modify the real `CODEX_HOME`;
- real marketplace E2E gaps are stated rather than inferred from fixtures.
