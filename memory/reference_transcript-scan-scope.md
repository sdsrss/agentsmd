verified: 2026-07-03 | source: `hooks/transcript-structure-scan.sh`, `hooks/tests/smoke.sh`

# Transcript Scan Scope

`transcript-structure-scan.sh` scans assistant report prose for banned vocabulary, but strips triple-backtick fenced code blocks first.

Reason: code examples and captured command output can contain banned words as string literals or fixture text. Those are not assistant value claims and should not queue §10 advisories.

Section-order detection still runs on the original text, because report markers can appear outside code blocks and the order rule is about the report layout.
