# Protocol v2 compatibility and no-regression matrix

Status: **strict dual-reader gate implemented; v2 writer not implemented**

Design: [`../PROTOCOL-V2.md`](../PROTOCOL-V2.md)

The purpose of this matrix is not merely to test a new manifest. It prevents a
profile, protocol, migration, or arbitration change from removing a capability
that works in protocol v1.

## 1. Baseline evidence

Before this design milestone, the complete `npm test` suite passed on
2026-07-27 with exit code 0. Relevant fresh results included:

- install suite: `217 passed, 0 failed`;
- lifecycle journal suite: `16 passed, 0 failed`;
- fault-injection suite: `18 passed, 0 failed`;
- repair suite: `20 passed, 0 failed`;
- backup/restore suite: `21 passed, 0 failed`;
- plugin-surface suite: `56 passed, 0 failed`;
- runtime-state suite: `10 passed, 0 failed`;
- canonical spec-source suite: `7 passed, 0 failed`;
- shell hook smoke suite: `382 passed, 0 failed`;
- live guard: the real `/home/sds/.codex` remained unchanged across all nine
  protected surfaces.

These are the pre-change comparison results. Protocol-v2 work must reproduce
the full suite after every runtime checkpoint.

The initial characterization file,
`scripts/tests/protocol-v2.test.js`, now locks PV2-M01, PV2-M08, PV2-L10,
PV2-L11, complete profile-bundle presence, and the protocol-v1 directional-yield
baseline before any v2 writer behavior is introduced.

The dual-reader checkpoint additionally covers a valid metadata-only v2 full
profile, a valid materialized OMX-compatible profile, strict missing-profile
and future-schema rejection, declared fallback-artifact hash verification, and
the additive status fields. The production writer still emits schema 1 and
protocol 1.

## 2. Preservation gates

| Capability | Protocol-v1 evidence | Protocol-v2 requirement |
|---|---|---|
| Fresh npm install with active plugin | `scripts/tests/install.test.js`: fresh standalone install skips with zero mutation | Same zero-mutation default |
| Explicit dual surface | `scripts/tests/install.test.js`: explicit standalone override | Explicit opt-in remains available |
| Plugin-only operation | `scripts/tests/plugin-surface.test.js`: complete plugin bundle and doctor health | No standalone manifest/global ownership required |
| Standalone-only operation | `scripts/tests/install.test.js`: install/status/doctor lifecycle | Full functionality without OMX or plugin |
| Full profile without OMX | `hooks/tests/smoke.sh`: every SessionStart source selects full | `full` selected and complete |
| OMX-compatible profile | `hooks/tests/smoke.sh`: exact active OMX marker selects compatibility core | OMX orchestration plus agentsmd gates, with no duplicated full orchestration |
| Safe profile fallback | `hooks/tests/smoke.sh`: missing OMX profile falls back to complete core | Unknown/missing/corrupt/wrong-version OMX profile selects `full` |
| Extended spec | plugin and standalone health checks require `AGENTS-extended.md` | Reachable and version-aligned under every profile |
| Hook registry | `scripts/tests/hook-registry.test.js`: 15 registry entries | Same entries, order, matcher, timeout, scripts, and kill switches |
| Multi-tenant shared files | install/uninstall CAS and byte-round-trip tests | Foreign hooks/config/guidance remain byte-preserved |
| Ownership | manifest hash, collision, symlink, and modified-artifact tests | v2 extensions never broaden deletion authority |
| Crash recovery | lifecycle-journal and fault-injection matrices | Complete v1 or complete v2; no mixed manifest/profile state |
| Backup/restore | compatible snapshot and install→update→uninstall→restore tests | Legacy and v2 snapshots remain state-compatible and non-reactivating |
| Repair | plan/digest/ownership tests | Valid v1/v2 plan; no automatic adoption |
| Plugin cleanup | plugin-only allowlist/symlink/unknown-state tests | Removes private allowlist only |
| Runtime isolation | `scripts/tests/runtime-state.test.js` | Plugin and standalone writers remain physically isolated |
| Status honesty | structural health vs activation receipt tests | Schema/profile/arbitration/activation remain separate |
| Distribution | npm pack lifecycle and plugin manifest tests | Every profile and support artifact ships |

## 3. Manifest schema cases

| ID | Fixture | Expected result |
|---|---|---|
| PV2-M01 | Valid v1 manifest with no schema field | Read as schema 1; current behavior unchanged |
| PV2-M02 | Valid v2 manifest with all v1 ownership fields | Healthy when v2 extensions and live bytes match |
| PV2-M03 | v2 manifest missing a v1 ownership field | Invalid; no repair/uninstall mutation |
| PV2-M04 | v2 manifest missing a declared profile artifact | Bundle health fails |
| PV2-M05 | v2 materialized profile hash differs from managed block | Standalone health fails |
| PV2-M06 | v2 profile hash differs from deployed bundle profile | Standalone health fails |
| PV2-M07 | Unsupported future `manifestSchemaVersion` | Explicit unsupported-schema diagnosis; fail closed |
| PV2-M08 | Unknown additive field on schema 2 | Preserved/tolerated; ownership unchanged |
| PV2-M09 | Symlinked manifest or profile artifact | Rejected as structural/ownership evidence |
| PV2-M10 | Duplicate/unsafe profile path or inventory path | Rejected before mutation |

## 4. Profile cases

| ID | Surface | OMX evidence | Bundle state | Expected profile/result |
|---|---|---|---|---|
| PV2-P01 | plugin | absent | complete | `full` |
| PV2-P02 | plugin | exact active marker | complete | `omx-compatible` |
| PV2-P03 | plugin | unknown/unreadable | complete | `full` fallback |
| PV2-P04 | plugin | exact marker | OMX core missing | `full` fallback; plugin bundle unhealthy is visible |
| PV2-P05 | plugin | exact marker | OMX core wrong version | `full` fallback; version mismatch visible |
| PV2-P06 | standalone `auto` | absent | complete | materialize `full` |
| PV2-P07 | standalone `auto` | exact active marker | complete | materialize `omx-compatible` |
| PV2-P08 | standalone explicit `full` | exact marker | complete | materialize `full` |
| PV2-P09 | standalone explicit OMX | marker absent | complete | refuse before mutation |
| PV2-P10 | standalone `legacy-full` upgrade | exact marker | complete | preserve `full`; report desired profile separately |
| PV2-P11 | either | any | extended missing/corrupt | health failure; never claim complete capability |
| PV2-P12 | either | any | all profiles complete | extended path remains resolvable |
| PV2-P13 | active `AGENTS.override.md` masks OMX marker | marker only in inactive file | `full` |
| PV2-P14 | OMX-like package/binary/`.omx` directory only | no active marker | `full` |

## 5. Arbitration cases

`S` means standalone; `P` means plugin. Every detected candidate is inspected
for health before this matrix is applied.

| ID | S protocol/version | P protocol/version | Health | Expected winner | Exclusive |
|---|---|---|---|---|---|
| PV2-A01 | absent | v1 | P healthy | P | yes |
| PV2-A02 | v1 | absent | S healthy | S | yes |
| PV2-A03 | v1/4.2.0 | v1/4.2.0 | both healthy | S | yes, existing P→S yield |
| PV2-A04 | v1/4.1.0 | v2/4.2.0 | both healthy | P | no; v1 S cannot yield |
| PV2-A05 | v2/4.1.0 | v1/4.2.0 | both healthy | P | yes only if v2 S accepts verified P winner |
| PV2-A06 | v2/4.2.0 | v1/4.1.0 | both healthy | S | yes, existing P→S yield |
| PV2-A07 | v2/4.1.0 | v2/4.2.0 | both healthy | P | yes, reciprocal v2 yield |
| PV2-A08 | v2/4.2.0 | v2/4.2.0 | both healthy | S | yes |
| PV2-A09 | any | newer unhealthy P | S healthy | S | depends only on safe loser yield; reason names unhealthy P |
| PV2-A10 | newer unhealthy S | any | P healthy | P | no if damaged S cannot prove yield |
| PV2-A11 | unhealthy | unhealthy | neither healthy | none | no; degraded fallback |
| PV2-A12 | prerelease vs stable | both healthy | SemVer precedence | deterministic | capability-dependent |
| PV2-A13 | build metadata only differs | both healthy | equal precedence | S | capability-dependent |

Hostile-cache cases:

| ID | Cache condition | Required result |
|---|---|---|
| PV2-C01 | Fresh v2 cache, exact physical loser and roots | Named loser yields |
| PV2-C02 | Missing cache | Neither detected hook suppresses itself from assumption |
| PV2-C03 | Malformed schema | No yield |
| PV2-C04 | Expired cache | No yield |
| PV2-C05 | Standalone manifest freshness changed | No yield; re-inspect |
| PV2-C06 | Plugin root identity differs | No yield |
| PV2-C07 | Cache names the current hook as winner | Hook continues |
| PV2-C08 | Unsupported protocol/direction | Non-exclusive; no yield |
| PV2-C09 | Concurrent cache replacement | Compare identity/freshness; never suppress from mixed bytes |

## 6. Lifecycle and migration cases

| ID | Transition/fault | Required result |
|---|---|---|
| PV2-L01 | Clean v1 → metadata-only v2 | Same materialized full bytes; valid v2 manifest written last |
| PV2-L02 | v1 → v2 crash after journal | Fresh process chooses executable rollback/forward; no lockout |
| PV2-L03 | v1 → v2 crash after tree swap | Complete v1 or v2, never mixed profile/manifest |
| PV2-L04 | v1 → v2 crash during shared writes | Foreign-safe rollback; manifest remains authoritative last write |
| PV2-L05 | v2 same-version update | Byte-stable when desired profile unchanged |
| PV2-L06 | v2 full → proved OMX profile | Journaled managed-block/profile digest change |
| PV2-L07 | v2 OMX → full after OMX removal | Complete full fallback, extended preserved |
| PV2-L08 | Concurrent foreign shared-file edit | Abort; foreign bytes preserved |
| PV2-L09 | Concurrent owned-tree edit | Abort; ownership evidence retained |
| PV2-L10 | v2 → immediately previous v1 update | v1 complete core restored; safe loss of v2 metadata only |
| PV2-L11 | Previous v1 uninstall over valid v2 manifest | Only v1-owned artifacts/shared entries removed |
| PV2-L12 | Future schema passed to older v2 command | Explicit refusal before mutation |
| PV2-L13 | Install/update with active plugin and no standalone footprint | Same zero-mutation guard |
| PV2-L14 | Explicit dual install | Both surfaces present; arbitration honesty preserved |

## 7. Backup, restore, repair, and uninstall cases

| ID | Operation | Required result |
|---|---|---|
| PV2-R01 | List legacy snapshot | Readable and classified from actual bytes |
| PV2-R02 | Restore compatible legacy snapshot | Existing shared-state guard preserved |
| PV2-R03 | Restore v2 snapshot with matching install state | Exact shared bytes/modes restored |
| PV2-R04 | Restore snapshot with mismatched manifest/profile state | Refuse; no partial overwrite |
| PV2-R05 | install → profile update → uninstall → default restore | Remains uninstalled |
| PV2-R06 | Backup creation fails midway | Partial snapshot removed |
| PV2-R07 | Restore second write fails | First write rolls back with CAS |
| PV2-R08 | Repair valid v1 manifest under v2 code | Existing repair classification preserved |
| PV2-R09 | Repair valid v2 missing owned artifact | Restore from exact matching release only |
| PV2-R10 | Repair v2 modified artifact | Report modified; do not adopt automatically |
| PV2-R11 | Repair profile drift only | Recommend explicit update/profile transaction |
| PV2-R12 | Standalone uninstall valid v2 | Profile metadata adds no deletion authority |
| PV2-R13 | Plugin-only cleanup beside v2 standalone | Standalone manifest, runtime, and shared bytes preserved |
| PV2-R14 | Standalone uninstall beside plugin | Plugin bundle/private state remains outside standalone ownership |
| PV2-R15 | Corrupt/foreign/symlinked state | Fail closed with zero destructive mutation |

## 8. Status and doctor cases

| ID | State | Required reporting |
|---|---|---|
| PV2-D01 | Healthy v1 standalone | Schema 1/protocol 1, no false profile failure |
| PV2-D02 | Healthy v2 standalone | Schema/protocol/configured/desired/profile state shown |
| PV2-D03 | `legacy-full` with active OMX | Healthy enforcement plus visible profile drift |
| PV2-D04 | Missing selected core | Health failure, exact artifact named |
| PV2-D05 | Missing unselected fallback core | Bundle completeness failure |
| PV2-D06 | Healthy plugin, no activation receipt | Structurally healthy; runtime unverified |
| PV2-D07 | Valid activation receipt | Observed selected profile only; no all-hooks claim |
| PV2-D08 | Mixed v1/v2 non-exclusive arbitration | Winner and degraded/non-exclusive reason shown |
| PV2-D09 | Pending recoverable lifecycle journal | Exact recovery direction and command |
| PV2-D10 | Foreign-conflict journal | Not auto-recoverable; evidence preserved |

## 9. Release gates

Every implementation checkpoint runs, in order:

1. the smallest new protocol-v2 test file;
2. existing install, plugin-surface, runtime-state, lifecycle-journal, repair,
   backup, distribution, spec-source, and hook smoke tests;
3. complete `npm test`;
4. `npm run lint:shell`;
5. package-content inspection proving all profiles/support files ship;
6. isolated plugin-only, standalone-only, and dual-surface user journeys;
7. live-guard verification that the real `CODEX_HOME` is unchanged.

Before automatic standalone profile selection becomes the default, additionally
require:

- a real Codex plugin marketplace/cache lifecycle run;
- active OMX and absent OMX sessions across startup/resume/clear/compact;
- OMX install-after-agentsmd and OMX remove-after-agentsmd transitions;
- proof that the selected context has one intended core, one extended path, and
  no missing hook capability;
- an explicit report of host/version combinations that were not exercised.
