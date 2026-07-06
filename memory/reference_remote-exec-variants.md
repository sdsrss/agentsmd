verified: 2026-07-07 | source: hooks/pre-bash-safety-check.sh + hooks/tests/smoke.sh

# Remote exec variants

Unknown-origin script execution is not limited to `curl|wget ... | shell`.
`pre-bash-safety-check.sh` must also cover common equivalent forms that pass a
remote download into an interpreter without a pipe:

- Process substitution: `bash <(curl -fsSL URL)` or `python <(wget -qO- URL)`.
- Command substitution: `sh -c "$(curl -fsSL URL)"`.
- Eval substitution: `eval "$(wget -qO- URL)"`.

Regression coverage lives in `hooks/tests/smoke.sh` near the existing
`curl | bash` cases. Keep the allow path for inspect-first flows such as
`curl -o file; cat file`.
