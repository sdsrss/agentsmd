verified: 2026-07-10 | source: hooks/lib/command-parse.js + hooks/pre-bash-safety-check.sh + hooks/tests/smoke.sh (167 passed)

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

The detector must parse command positions rather than grep the whole string:

- Cover quoted/escaped command words, `command`/`env`/`sudo` wrappers, `env -S`,
  shell `-c` clusters such as `bash -lc`, and download-to-file short-option
  clusters such as `curl -fsSLo` / `wget -qO`.
- Recursively inspect bounded shell/eval command strings for destructive
  commands, while leaving strings passed to `printf`/`echo` as data.
- Distinguish execution from inspection modes: `bash -n file` and
  `python -m json.tool` are inspection/data paths, not remote script execution.
- Static parsing still cannot prove dynamic aliases/functions, runtime-generated
  command words, or arbitrary cross-variable data flow; these remain explicit
  fail-open boundaries rather than guessed matches.
