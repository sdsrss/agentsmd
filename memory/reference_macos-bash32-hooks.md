verified: 2026-07-11 | source: GitHub Actions runs 29112132342, 29112488894, 29112723752 and `hooks/tests/smoke.sh`

# macOS Bash 3.2 Hook Portability

Stock macOS Bash 3.2 behaves differently from newer Bash when `set -u` meets an
empty array expansion. A loop over `"${items[@]}"` can abort before the first
append. Guard the loop with a safe length check, or keep command-argument arrays
non-empty by seeding required arguments such as `-C "$cwd"`.

macOS also exposes temporary paths through equivalent `/var/...` and
`/private/var/...` spellings. Git may return the canonical `/private/var` root
while a transcript retains `/var`. Target-bound evidence comparisons must accept
that specific alias without weakening repository binding.

The macOS Hook smoke job is the release gate for both behaviors; Linux-only
success does not cover them.
