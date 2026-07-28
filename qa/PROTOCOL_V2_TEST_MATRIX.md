# Surface Protocol v2 test matrix

Status: single full profile implemented.

This matrix names the executable evidence for the current protocol. Historical
dual-profile behavior is not an acceptance target; only one-way migration
reading remains.

| ID | Contract | Evidence | Expected result |
|---|---|---|---|
| PV2-P01 | Default profile | `scripts/tests/protocol-v2.test.js` | schema v2, `full`, global sentinel present |
| PV2-P02 | Explicit full | protocol-v2 + distribution tests | same bytes, reason `explicit-full` |
| PV2-P03 | Removed profile argv | protocol-v2 + distribution tests | reject before mutation |
| PV2-P04 | Foreign/old marker | protocol-v2 + hook smoke | marker preserved; full profile unchanged |
| PV2-P05 | Plugin SessionStart | hook smoke + plugin-surface tests | full profile on startup/resume/clear/compact |
| PV2-P06 | Activation receipt | hook smoke + plugin-surface tests | private receipt, `full`, `single-full-profile` |
| PV2-H01 | Official plugin root | plugin-surface tests | launcher reaches `PLUGIN_ROOT` script |
| PV2-H02 | Legacy plugin root | plugin-surface tests | launcher reaches `CLAUDE_PLUGIN_ROOT` script |
| PV2-H03 | Missing plugin root | plugin-surface tests | exit 0, no `/hooks/...` execution |
| PV2-M01 | New manifest | protocol-v2 tests | full + extended + layout digests only |
| PV2-M02 | Schema v1 reader/update | protocol-v2 tests | readable; update migrates to single full |
| PV2-M03 | Previous dual schema | protocol-v2 tests + surface-arbitration validation | valid materialized OMX profile updates to full; malformed legacy record is rejected |
| PV2-M04 | Missing/mismatched digest | protocol-v2 + plugin-surface tests | health fails closed |
| PV2-M05 | Future schema | protocol-v2 tests | unsupported schema rejected |
| PV2-L01 | Direct global install | install tests | full spec merged between sentinels |
| PV2-L02 | Preserve foreign bytes | install tests | block-external guidance/hooks byte-preserved |
| PV2-L03 | Reversible uninstall | install tests | managed block/artifacts removed; foreign bytes remain |
| PV2-L04 | Crash recovery | lifecycle-journal + fault-injection tests | roll forward/back to coherent state |
| PV2-L05 | Repair | repair tests | only manifest-owned missing artifacts restored |
| PV2-L06 | One delivery surface | install + distribution tests | enabled plugin causes zero-mutation refusal |
| PV2-L07 | Existing standalone update | install tests | update remains available for cleanup/migration |
| PV2-O01 | Native orchestration | drift + spec-source tests | leadership invariants present in generated full core |
| PV2-D01 | Status honesty | plugin-surface + protocol-v2 tests | structure, receipt, profile, and arbitration stay separate |
| PV2-R01 | Release artifact | distribution + version-sync tests | no removed profile artifact ships |

Before release, run:

```bash
npm run spec:check
npm test
npm run lint:shell
```

The marketplace E2E remains a separate environment-dependent gate:

```bash
npm run test:plugin-marketplace
```
