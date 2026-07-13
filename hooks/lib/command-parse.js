#!/usr/bin/env node
"use strict";

// Parse enough POSIX shell syntax to identify an actual Git command without
// evaluating expansions. This is deliberately a lexer, not a shell executor.

const path = require("path");

const VALUE_GLOBALS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);
const REPO_VALUE_GLOBALS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
const FLAG_GLOBALS = new Set([
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--bare",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
]);
const CONTROL_PREFIXES = new Set(["if", "then", "elif", "while", "until", "do", "else", "!", "{"]);
const ENV_FLAGS = new Set(["-", "-i", "--ignore-environment", "-0", "--null", "-v", "--debug"]);
const ENV_VALUE_OPTIONS = new Set(["-u", "--unset"]);
const SUDO_FLAGS = new Set(["-A", "--askpass", "-b", "--background", "-E", "--preserve-env", "-H", "--set-home", "-K", "--remove-timestamp", "-k", "--reset-timestamp", "-n", "--non-interactive", "-S", "--stdin", "-V", "--version", "-v", "--validate"]);
const SUDO_VALUE_OPTIONS = new Set(["-C", "--close-from", "-D", "--chdir", "-g", "--group", "-h", "--host", "-p", "--prompt", "-R", "--chroot", "-r", "--role", "-t", "--type", "-T", "--command-timeout", "-u", "--user"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "http", "https", "aria2c"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish",
  "python", "python2", "python3", "node", "ruby", "perl", "php",
  "lua", "luajit", "deno", "bun", "r", "rscript", "pwsh", "powershell",
]);

function lexCommands(source) {
  const commands = [];
  let words = [];
  let word = "";
  let started = false;
  let quote = null;

  function finishWord() {
    if (started) words.push(word);
    word = "";
    started = false;
  }
  function finishCommand() {
    finishWord();
    if (words.length) commands.push(words);
    words = [];
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else word += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) word += source[++i];
      else word += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < source.length) {
      word += source[++i];
      started = true;
    } else if (/\s/.test(ch)) {
      finishWord();
      if (ch === "\n") finishCommand();
    } else if (";|&()".includes(ch)) {
      finishCommand();
      if ((ch === "|" || ch === "&") && source[i + 1] === ch) i += 1;
    } else if (ch === "#" && !started) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i += 1;
    } else {
      word += ch;
      started = true;
    }
  }
  if (quote !== null) return [];
  finishCommand();
  return commands;
}

function basename(path) {
  return path.slice(path.lastIndexOf("/") + 1);
}

// Safety checks need the same quote/wrapper awareness as Git parsing, plus the
// distinction between a literal '$HOME' and an expansion. Keep raw and cooked
// words together instead of scanning the complete command string with regexes.
function lexSafetyCommands(source) {
  const commands = [];
  let words = [];
  let word = { value: "", raw: "", expands: false };
  let started = false;
  let quote = null;
  let substitutionDepth = 0;

  function finishWord() {
    if (started) words.push(word);
    word = { value: "", raw: "", expands: false };
    started = false;
  }
  function finishCommand(opAfter = null) {
    finishWord();
    if (words.length) commands.push({ words, opAfter });
    else if (commands.length && opAfter) commands[commands.length - 1].opAfter = opAfter;
    words = [];
  }
  function append(ch, raw = ch) {
    word.value += ch;
    word.raw += raw;
    started = true;
  }
  function beginsExpansion(i) {
    return source[i] === "$" && i + 1 < source.length && /[({A-Za-z_0-9@*]/.test(source[i + 1]);
  }

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quote === "'") {
      word.raw += ch;
      if (ch === "'") quote = null;
      else word.value += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      word.raw += ch;
      if (ch === '"') quote = null;
      else if (ch === "\\" && i + 1 < source.length && '"\\$`\n'.includes(source[i + 1])) {
        word.raw += source[i + 1];
        word.value += source[++i];
      } else {
        word.value += ch;
        if (beginsExpansion(i)) word.expands = true;
        if (ch === "`") word.expands = true;
      }
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      word.raw += ch;
      quote = ch;
      started = true;
    } else if (ch === "\\" && i + 1 < source.length) {
      word.raw += ch + source[i + 1];
      word.value += source[++i];
      started = true;
    } else if ((ch === "$" || ch === "<" || ch === ">") && source[i + 1] === "(") {
      append(ch + "(");
      word.expands = word.expands || ch === "$";
      substitutionDepth += 1;
      i += 1;
    } else if (substitutionDepth > 0) {
      append(ch);
      if (ch === "(") substitutionDepth += 1;
      else if (ch === ")") substitutionDepth -= 1;
    } else if (/\s/.test(ch)) {
      finishWord();
      if (ch === "\n") finishCommand(";");
    } else if (ch === ";") {
      finishCommand(";");
    } else if (ch === "|" || ch === "&") {
      const doubled = source[i + 1] === ch;
      finishCommand(ch === "|" && !doubled ? "|" : ";");
      if (doubled) i += 1;
    } else if (ch === "(" || ch === ")") {
      finishCommand(";");
    } else if (ch === "#" && !started) {
      while (i + 1 < source.length && source[i + 1] !== "\n") i += 1;
    } else {
      append(ch);
      if (beginsExpansion(i)) word.expands = true;
      if (ch === "`") word.expands = true;
    }
  }
  if (quote !== null || substitutionDepth !== 0) return [];
  finishCommand();
  return commands;
}

function safetyCommandStart(words) {
  return commandStart(words.map((word) => word.value));
}

function safetyExecutable(command) {
  const index = safetyCommandStart(command.words);
  if (index >= 0) {
    return {
      index,
      name: basename(command.words[index]?.value || "").toLowerCase(),
      args: command.words.slice(index + 1),
    };
  }

  // GNU env -S/--split-string turns its value into the command + argv. The
  // generic Git lexer deliberately refuses this wrapper; safety analysis only
  // needs the bounded first-command form used in pipelines.
  const values = command.words.map((word) => word.value);
  const envIndex = values.findIndex((value) => basename(value).toLowerCase() === "env");
  const envProbe = envIndex >= 0 ? [...values.slice(0, envIndex + 1), "__agentsmd_probe__"] : [];
  if (envIndex >= 0 && commandStart(envProbe) === envIndex + 1) {
    for (let i = envIndex + 1; i < values.length; i += 1) {
      let split = null;
      if (values[i] === "-S" || values[i] === "--split-string") split = values[i + 1] || "";
      else if (values[i].startsWith("--split-string=")) split = values[i].slice("--split-string=".length);
      if (split === null) continue;
      const nested = lexSafetyCommands(split)[0];
      if (!nested || !nested.words.length) return { index: -1, name: "", args: [] };
      const consumed = values[i].includes("=") ? i : i + 1;
      return {
        index: consumed,
        name: basename(nested.words[0].value).toLowerCase(),
        args: [...nested.words.slice(1), ...command.words.slice(consumed + 1)],
      };
    }
  }
  return { index: -1, name: "", args: [] };
}

function isInterpreter(name) {
  return INTERPRETERS.has(name)
    || /^(?:python|php|ruby|perl|lua|node)[0-9]+(?:\.[0-9]+)*$/.test(name);
}

function interpreterExecutesInput(command) {
  const { name, args } = safetyExecutable(command);
  const values = args.map((arg) => arg.value);
  if (SHELL_INTERPRETERS.has(name)) {
    for (const value of values) {
      if (value === "--") break;
      if (/^-[^-]*n/.test(value)) return false;
      if (!value.startsWith("-")) break;
    }
  }
  if (/^python(?:[0-9]+(?:\.[0-9]+)*)?$/.test(name)) {
    for (let i = 0; i < values.length; i += 1) {
      if ((values[i] === "-m" && values[i + 1] === "json.tool") || values[i] === "-mjson.tool") return false;
    }
  }
  return isInterpreter(name);
}

// Remove here-document bodies that are data for commands such as cat/tee. The
// ordinary lexer is line-oriented and would otherwise mistake examples inside a
// heredoc for top-level commands. Preserve bodies consumed by an interpreter (or
// piped to one): those bytes really are executable input and must stay visible.
function stripDataHereDocs(source) {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const header = lines[i];
    const match = header.match(/<<(-)?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (!match || header[match.index - 1] === "<") continue; // here-string, not heredoc
    const delimiter = match[2] || match[3] || match[4] || "";
    if (!delimiter) continue;
    const executableInput = lexSafetyCommands(header)
      .some((command) => interpreterExecutesInput(command) || ["source", ".", "eval"].includes(safetyExecutable(command).name));
    if (executableInput) continue;
    const stripTabs = Boolean(match[1]);
    for (let j = i + 1; j < lines.length; j += 1) {
      const probe = stripTabs ? lines[j].replace(/^\t+/, "") : lines[j];
      if (probe === delimiter) {
        for (let k = i + 1; k <= j; k += 1) lines[k] = "";
        i = j;
        break;
      }
    }
  }
  return lines.join("\n");
}

// Recognize one deliberately narrow proof shape:
//   SAFE="$(realpath -- "$VAR")" &&
//     [[ -n "$SAFE" && "$SAFE" == /tmp/* ]] && rm -rf "$SAFE"
// Canonicalization closes symlink/.. escapes before the bounded-prefix check.
// Every later check and the rm target must name that exact canonical variable.
// Replace only the guarded rm target with a literal before safety parsing;
// prefix-only or non-empty-only guards stay variable-bearing and remain blocked.
function markStrictlyValidatedRmTargets(source) {
  const guard = /(?<safe>[A-Za-z_][A-Za-z0-9_]*)=(?<outer>["'])\$\(realpath(?:\s+-e)?\s+--\s+(?<inner>["'])\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)\k<inner>\)\k<outer>\s+&&\s+\[\[\s+-n\s+(["']?)\$(?:\{\k<safe>\}|\k<safe>)\4\s+&&\s+(["']?)\$(?:\{\k<safe>\}|\k<safe>)\5\s+==\s+\/tmp\/\*\s+\]\]\s+&&\s+(?<rm>(?:(?:command|sudo)\s+)*(?:\/[^\s]+\/)?rm\b[^;\n]*)/g;
  return source.replace(guard, (...args) => {
    const groups = args.at(-1);
    const whole = args[0];
    const safe = groups.safe;
    const rmText = groups.rm;
    const expansion = new RegExp(`(["']?)\\$(?:\\{${safe}\\}|${safe})\\1`, "g");
    if (!expansion.test(rmText)) return whole;
    expansion.lastIndex = 0;
    return whole.slice(0, whole.length - rmText.length)
      + rmText.replace(expansion, "/tmp/agentsmd-validated-target");
  });
}

function prepareSafetySource(source) {
  return markStrictlyValidatedRmTargets(stripDataHereDocs(source));
}

function rmArgSets(command) {
  const { name, args } = safetyExecutable(command);
  if (name === "rm") return [{ args, indirect: false }];
  if ((name === "busybox" || name === "toybox") && basename(args[0]?.value || "").toLowerCase() === "rm") {
    return [{ args: args.slice(1), indirect: false }];
  }
  if (name === "find") {
    const sets = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i].value !== "-exec" && args[i].value !== "-execdir") continue;
      let end = i + 1;
      while (end < args.length && args[end].value !== ";" && args[end].value !== "+") end += 1;
      const nested = { words: args.slice(i + 1, end), opAfter: null };
      const executable = safetyExecutable(nested);
      if (executable.name === "rm") sets.push({ args: executable.args, indirect: false });
      i = end;
    }
    return sets;
  }
  if (name === "xargs") {
    const rmIndex = args.findIndex((arg) => basename(arg.value).toLowerCase() === "rm");
    if (rmIndex >= 0) return [{ args: args.slice(rmIndex + 1), indirect: true }];
  }
  return [];
}

function rmRfState(commands) {
  let candidate = false;
  let variableTarget = false;
  for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
    const command = commands[commandIndex];
    for (const invocation of rmArgSets(command)) {
      const { args } = invocation;
      let recursive = false;
      let force = false;
      let options = true;
      const targets = [];
      for (const arg of args) {
        const value = arg.value;
        if (options && value === "--") {
          options = false;
          continue;
        }
        if (options && value === "--recursive") recursive = true;
        else if (options && value === "--force") force = true;
        else if (options && /^-[^-]/.test(value)) {
          recursive = recursive || /[rR]/.test(value.slice(1));
          force = force || value.slice(1).includes("f");
        } else if (!options || !value.startsWith("-")) targets.push(arg);
      }
      if (!recursive || !force) continue;
      candidate = true;
      if (targets.some((target) => target.expands)) variableTarget = true;
      if (invocation.indirect) {
        for (let i = commandIndex - 1; i >= 0; i -= 1) {
          if (commands[i].words.some((word) => word.expands)) variableTarget = true;
          if (commands[i].opAfter !== "|") break;
        }
      }
    }
  }
  return { candidate, variableTarget };
}

const MAX_SAFETY_RECURSION = 3;

function shellCommandSourceIndex(name, args) {
  if (!SHELL_INTERPRETERS.has(name)) return -1;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i].value;
    if (value === "--" || !value.startsWith("-")) return -1;
    if (/^-[^-]+$/.test(value) && value.slice(1).includes("c")) {
      return i + 1 < args.length ? i + 1 : -1;
    }
  }
  return -1;
}

function interpreterCodeSource(name, args) {
  const specs = name === "python" || /^python[0-9]/.test(name)
    ? new Set(["-c"])
    : name === "ruby" || /^ruby[0-9]/.test(name)
      ? new Set(["-e"])
      : name === "node" || /^node[0-9]/.test(name)
        ? new Set(["-e", "--eval", "-p", "--print"])
        : null;
  if (!specs) return null;
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i].value;
    if (specs.has(value)) return args[i + 1] || null;
    for (const flag of specs) {
      if (flag.startsWith("--") && value.startsWith(`${flag}=`)) {
        const offset = args[i].raw.indexOf("=") + 1;
        return { ...args[i], value: value.slice(flag.length + 1), raw: args[i].raw.slice(offset) };
      }
      if (!flag.startsWith("--") && value.startsWith(flag) && value.length > flag.length) {
        const offset = args[i].raw.indexOf(flag) + flag.length;
        return { ...args[i], value: value.slice(flag.length), raw: args[i].raw.slice(offset) };
      }
    }
  }
  return null;
}

function nestedShellSources(commands) {
  const sources = [];
  for (const command of commands) {
    const { name, args } = safetyExecutable(command);
    if (name === "eval") {
      if (args.length) sources.push(args.map((arg) => arg.value).join(" "));
      continue;
    }
    if (!interpreterExecutesInput(command)) continue;
    const sourceIndex = shellCommandSourceIndex(name, args);
    if (sourceIndex >= 0) sources.push(args[sourceIndex].value);
  }
  return sources;
}

function rmRfStateRecursive(commands, depth) {
  const state = rmRfState(commands);
  if (depth >= MAX_SAFETY_RECURSION || (state.candidate && state.variableTarget)) return state;
  for (const nested of nestedShellSources(commands)) {
    const child = rmRfStateRecursive(lexSafetyCommands(prepareSafetySource(nested)), depth + 1);
    state.candidate = state.candidate || child.candidate;
    state.variableTarget = state.variableTarget || child.variableTarget;
    if (state.candidate && state.variableTarget) break;
  }
  return state;
}

function extractParenBodies(raw, prefix) {
  const bodies = [];
  for (let i = 0; i < raw.length - 1; i += 1) {
    if (!raw.startsWith(prefix, i)) continue;
    let depth = 1;
    let quote = null;
    const start = i + prefix.length;
    let j = start;
    for (; j < raw.length; j += 1) {
      const ch = raw[j];
      if (quote) {
        if (ch === quote && raw[j - 1] !== "\\") quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth += 1;
      else if (ch === ")" && --depth === 0) break;
    }
    if (depth === 0) {
      bodies.push(raw.slice(start, j));
      i = j;
    }
  }
  return bodies;
}

function extractBacktickBodies(raw) {
  const bodies = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] !== "`" || raw[i - 1] === "\\") continue;
    let body = "";
    let j = i + 1;
    for (; j < raw.length; j += 1) {
      if (raw[j] === "`" && raw[j - 1] !== "\\") break;
      body += raw[j];
    }
    if (j < raw.length) {
      bodies.push(body);
      i = j;
    }
  }
  return bodies;
}

function hasDownloader(source) {
  return lexSafetyCommands(source).some((command) => DOWNLOADERS.has(safetyExecutable(command).name));
}

function expandedSubstitutionHasDownloader(word) {
  if (!word || !word.expands) return false;
  return extractParenBodies(word.raw, "$(").some(hasDownloader)
    || extractBacktickBodies(word.raw).some(hasDownloader);
}

function hereStringHasDownloader(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].value === "<<<") {
      if (expandedSubstitutionHasDownloader(args[i + 1])) return true;
      i += 1;
      continue;
    }
    if (args[i].value.startsWith("<<<") && args[i].value.length > 3) {
      const rawOffset = args[i].raw.indexOf("<<<") + 3;
      const source = {
        ...args[i],
        value: args[i].value.slice(3),
        raw: args[i].raw.slice(rawOffset),
      };
      if (expandedSubstitutionHasDownloader(source)) return true;
    }
  }
  return false;
}

function downloaderOutput(command) {
  const { name, args: commandArgs } = safetyExecutable(command);
  if (!DOWNLOADERS.has(name)) return "";
  const args = commandArgs.map((word) => word.value);
  let explicitOutput = null;
  let outputDir = "";
  let curlRemoteName = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (name === "curl" && (arg === "-o" || arg === "--output")) explicitOutput = args[i + 1] || "";
    else if (name === "wget" && (arg === "-O" || arg === "--output-document")) explicitOutput = args[i + 1] || "";
    else if ((name === "fetch" || name === "http" || name === "https") && (arg === "-o" || arg === "--output")) explicitOutput = args[i + 1] || "";
    else if (name === "aria2c" && (arg === "-o" || arg === "--out")) explicitOutput = args[i + 1] || "";
    else if (name === "aria2c" && (arg === "-d" || arg === "--dir")) outputDir = args[i + 1] || "";
    else if (name === "curl" && arg.startsWith("--output=")) explicitOutput = arg.slice("--output=".length);
    else if (name === "wget" && arg.startsWith("--output-document=")) explicitOutput = arg.slice("--output-document=".length);
    else if ((name === "fetch" || name === "http" || name === "https") && arg.startsWith("--output=")) explicitOutput = arg.slice("--output=".length);
    else if (name === "aria2c" && arg.startsWith("--out=")) explicitOutput = arg.slice("--out=".length);
    else if (name === "aria2c" && arg.startsWith("--dir=")) outputDir = arg.slice("--dir=".length);
    if (name === "curl" && (arg === "-O" || arg === "--remote-name")) curlRemoteName = true;
    if (name === "aria2c" && /^-d.+/.test(arg)) outputDir = arg.slice(2);
    const shortOption = name === "wget" ? "O" : "o";
    if (/^-[^-]/.test(arg)) {
      if (name === "curl" && arg.slice(1).includes("O")) curlRemoteName = true;
      const optionIndex = arg.slice(1).indexOf(shortOption);
      if (optionIndex >= 0) {
        const attached = arg.slice(optionIndex + 2);
        explicitOutput = attached || args[i + 1] || "";
      }
    }
  }
  if (explicitOutput !== null && explicitOutput !== "-") {
    if (name === "aria2c" && outputDir && !explicitOutput.startsWith("/")) {
      return `${outputDir.replace(/\/$/, "")}/${explicitOutput}`;
    }
    return explicitOutput;
  }

  // curl writes the response body to stdout unless an output/remote-name option
  // redirects it. wget does so only with an explicit stdout output document.
  const stdoutIsPayload = name === "curl"
    ? !curlRemoteName && (explicitOutput === null || explicitOutput === "-")
    : explicitOutput === "-";
  if (!stdoutIsPayload) return "";
  for (let i = 0; i < args.length; i += 1) {
    const redirect = args[i].match(/^(?:1)?(?:>>|>\||>)(.*)$/);
    if (!redirect) continue;
    const target = redirect[1] || args[i + 1] || "";
    if (target && !target.startsWith("&")) return target;
  }
  return "";
}

function comparablePath(value, cwd) {
  if (!cwd) return value.replace(/^\.\//, "");
  return path.resolve(cwd, value);
}

function interpreterReadsFile(command, file, cwd = "") {
  const { name, args } = safetyExecutable(command);
  if (!(name === "source" || name === ".") && !interpreterExecutesInput(command)) return false;
  const normalized = comparablePath(file, cwd);
  return args.some((word) => comparablePath(word.value, cwd) === normalized);
}

function commandExecutesFile(command, file, cwd = "") {
  const { index } = safetyExecutable(command);
  if (index < 0) return false;
  const executable = command.words[index]?.value || "";
  if (!executable.includes("/")) {
    // A bare name is normally ambiguous, but an explicit command-local PATH
    // component of `.` (or an empty component) deterministically searches the
    // current directory. Correlate that bounded form with the downloaded file.
    const currentDirOnPath = command.words.slice(0, index).some((word) => {
      if (!word.value.startsWith("PATH=")) return false;
      return word.value.slice("PATH=".length).split(":").some((part) => part === "" || part === ".");
    });
    return currentDirOnPath && comparablePath(executable, cwd) === comparablePath(file, cwd);
  }
  return comparablePath(executable, cwd) === comparablePath(file, cwd);
}

function transferPaths(command, tainted, cwd = "") {
  const { name, args } = safetyExecutable(command);
  if (!["cp", "mv", "ln", "install"].includes(name)) return [];
  const positional = [];
  let options = true;
  for (const arg of args) {
    if (options && arg.value === "--") { options = false; continue; }
    if (options && arg.value.startsWith("-")) continue;
    positional.push(arg.value);
  }
  if (positional.length < 2) return [];
  const source = comparablePath(positional[positional.length - 2], cwd);
  const destination = comparablePath(positional[positional.length - 1], cwd);
  return tainted.has(source) ? [destination] : [];
}

function taintState(commands, initialPaths = [], cwd = "", includeDownloads = false) {
  const tainted = new Set(initialPaths.map((file) => comparablePath(file, cwd)));
  const initial = new Set(tainted);
  let executed = false;
  for (const command of commands) {
    if (includeDownloads) {
      const output = downloaderOutput(command);
      if (output) tainted.add(comparablePath(output, cwd));
    }
    for (const destination of transferPaths(command, tainted, cwd)) tainted.add(destination);
    if ([...tainted].some((file) => interpreterReadsFile(command, file, cwd) || commandExecutesFile(command, file, cwd))) {
      executed = true;
    }
  }
  return { executed, derived: [...tainted].filter((file) => !initial.has(file)) };
}

function remoteExecState(commands, depth = 0) {
  // A downloader anywhere upstream in one pipeline feeds a later interpreter.
  for (let i = 0; i < commands.length; i += 1) {
    if (!DOWNLOADERS.has(safetyExecutable(commands[i]).name)) continue;
    for (let j = i + 1; j < commands.length && commands[j - 1].opAfter === "|"; j += 1) {
      if (interpreterExecutesInput(commands[j])) return true;
    }
  }

  // Process/command substitution executes a nested downloader in an interpreter,
  // source, dot, or eval command without a visible top-level pipeline.
  for (const command of commands) {
    const { name, args } = safetyExecutable(command);
    const executesInput = interpreterExecutesInput(command);
    const processConsumer = executesInput || name === "source" || name === ".";
    const interpreterCommand = executesInput && shellCommandSourceIndex(name, args) >= 0;
    if (executesInput && hereStringHasDownloader(args)) return true;
    const codeSource = interpreterCodeSource(name, args);
    if (codeSource && expandedSubstitutionHasDownloader(codeSource)) return true;
    for (const arg of args) {
      if (processConsumer && extractParenBodies(arg.raw, "<(").some(hasDownloader)) return true;
      // eval reparses its complete argument, so any nested download can become
      // code. For `sh -c`, block when the downloaded text itself is the command;
      // do not flag data-only uses such as `sh -c 'echo "$(curl URL)"'`.
      const trimmedRaw = arg.raw.trim().replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
      const parenBodies = extractParenBodies(trimmedRaw, "$(");
      const backtickBodies = extractBacktickBodies(trimmedRaw);
      if (name === "eval" && (parenBodies.some(hasDownloader) || backtickBodies.some(hasDownloader))) return true;
      if (interpreterCommand && parenBodies.some((body) => trimmedRaw === `$(${body})` && hasDownloader(body))) return true;
      if (interpreterCommand && backtickBodies.some((body) => trimmedRaw === `\`${body}\`` && hasDownloader(body))) return true;
    }
  }

  // Track downloaded files through common file-preserving transformations. This
  // catches download → cp/mv/ln/install → interpreter without treating inspection
  // commands such as cat or bash -n as execution.
  if (taintState(commands, [], "", true).executed) return true;
  if (depth < MAX_SAFETY_RECURSION) {
    for (const nested of nestedShellSources(commands)) {
      if (remoteExecState(lexSafetyCommands(nested), depth + 1)) return true;
    }
  }
  return false;
}

function sourceExecutesFile(source, file, cwd = "", depth = 0) {
  const commands = lexSafetyCommands(prepareSafetySource(source));
  if (taintState(commands, [file], cwd).executed) return true;
  if (depth >= MAX_SAFETY_RECURSION) return false;
  return nestedShellSources(commands).some((nested) => sourceExecutesFile(nested, file, cwd, depth + 1));
}

function sourcePropagatesFile(source, file, cwd = "") {
  const commands = lexSafetyCommands(prepareSafetySource(source));
  return taintState(commands, [file], cwd).derived;
}

function collectDownloads(source, depth = 0) {
  const commands = lexSafetyCommands(source);
  const downloads = commands.map(downloaderOutput).filter(Boolean);
  if (depth >= MAX_SAFETY_RECURSION) return downloads;
  for (const nested of nestedShellSources(commands)) downloads.push(...collectDownloads(nested, depth + 1));
  return downloads;
}

function analyzeSafety(source) {
  source = prepareSafetySource(source);
  const commands = lexSafetyCommands(source);
  const rm = rmRfStateRecursive(commands, 0);
  return {
    rmRfCandidate: rm.candidate,
    rmRfVar: rm.variableTarget,
    remoteExec: remoteExecState(commands),
    downloads: collectDownloads(source),
  };
}

function commandStart(words) {
  let i = 0;
  while (CONTROL_PREFIXES.has(words[i])) i += 1;
  if (words[i] === "time") {
    i += 1;
    while (words[i] === "-p" || words[i] === "--") i += 1;
  }
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;

  for (;;) {
    const wrapper = basename(words[i] || "").toLowerCase();
    if (wrapper === "command" || wrapper === "exec" || wrapper === "nohup") {
      i += 1;
      while (words[i] === "-p" || words[i] === "--") i += 1;
      continue;
    }
    if (wrapper === "env") {
      i += 1;
      for (;;) {
        const arg = words[i] || "";
        if (arg === "--") {
          i += 1;
          break;
        }
        if (ENV_FLAGS.has(arg) || /^--(?:ignore-environment|null|debug)=/.test(arg)) {
          i += 1;
          continue;
        }
        if (ENV_VALUE_OPTIONS.has(arg)) {
          if (i + 1 >= words.length) return -1;
          i += 2;
          continue;
        }
        if (/^--unset=/.test(arg) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i += 1;
          continue;
        }
        // env -C/-S change how the following command is interpreted. Refuse to
        // guess; callers deliberately fail open on unsupported wrapper syntax.
        if (arg.startsWith("-")) return -1;
        break;
      }
      continue;
    }
    if (wrapper === "sudo") {
      i += 1;
      for (;;) {
        const arg = words[i] || "";
        if (arg === "--") {
          i += 1;
          break;
        }
        if (SUDO_FLAGS.has(arg) || /^--preserve-env=/.test(arg)) {
          i += 1;
          continue;
        }
        if (SUDO_VALUE_OPTIONS.has(arg)) {
          if (i + 1 >= words.length) return -1;
          i += 2;
          continue;
        }
        if (/^--(?:close-from|chdir|group|host|prompt|chroot|role|type|command-timeout|user)=/.test(arg)) {
          i += 1;
          continue;
        }
        if (arg.startsWith("-")) return -1;
        break;
      }
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
      continue;
    }
    break;
  }
  return i;
}

function commitMessages(args) {
  const messages = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg === "-m" || arg === "--message") {
      if (i + 1 < args.length) messages.push(args[++i]);
      continue;
    }
    if (arg.startsWith("--message=")) {
      messages.push(arg.slice("--message=".length));
      continue;
    }
    if (/^-[^-]/.test(arg)) {
      const messageIndex = arg.slice(1).indexOf("m");
      if (messageIndex >= 0) {
        const attached = arg.slice(messageIndex + 2);
        if (attached) messages.push(attached);
        else if (i + 1 < args.length) messages.push(args[++i]);
      }
    }
  }
  return messages;
}

function commitUsesAll(args) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "--all") return true;
    if (!/^-[^-]/.test(arg)) continue;
    for (const option of arg.slice(1)) {
      if (option === "a") return true;
      // These short options consume the remainder of this token (or the next
      // token) as a value, so letters in that value are not more options.
      if ("mFCcS".includes(option)) break;
    }
  }
  return false;
}

const COMMIT_LONG_VALUE_OPTIONS = new Set([
  "--author",
  "--cleanup",
  "--date",
  "--file",
  "--fixup",
  "--message",
  "--reedit-message",
  "--reuse-message",
  "--squash",
  "--template",
  "--trailer",
]);
const COMMIT_LONG_FLAGS = new Set([
  "--ahead-behind",
  "--allow-empty",
  "--allow-empty-message",
  "--amend",
  "--branch",
  "--dry-run",
  "--edit",
  "--long",
  "--no-ahead-behind",
  "--no-edit",
  "--no-post-rewrite",
  "--no-status",
  "--no-verify",
  "--null",
  "--porcelain",
  "--quiet",
  "--reset-author",
  "--short",
  "--signoff",
  "--status",
  "--verbose",
]);

// Model the content set selected by `git commit` without executing it. Unknown
// syntax is returned explicitly so enforcement hooks can record an eligible,
// unevaluated opportunity instead of scanning the wrong set and reporting green.
function commitContent(args) {
  const pathspecs = [];
  const unsupported = [];
  let all = false;
  let include = false;
  let only = false;
  let pathspecFromFile = null;
  let pathspecFileNul = false;
  let afterDashDash = false;

  function takeValue(index, option) {
    if (index + 1 >= args.length) {
      unsupported.push(`${option}:missing-value`);
      return index;
    }
    return index + 1;
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (afterDashDash) {
      pathspecs.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDashDash = true;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") {
      pathspecs.push(arg);
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--no-all") {
      all = false;
      continue;
    }
    if (arg === "--include") {
      include = true;
      continue;
    }
    if (arg === "--no-include") {
      include = false;
      continue;
    }
    if (arg === "--only") {
      only = true;
      continue;
    }
    if (arg === "--no-only") {
      only = false;
      continue;
    }
    if (arg === "--interactive" || arg === "--patch") {
      unsupported.push(arg);
      continue;
    }
    if (arg === "--no-interactive" || arg === "--no-patch") continue;
    if (arg === "--pathspec-file-nul") {
      pathspecFileNul = true;
      continue;
    }
    if (arg === "--no-pathspec-file-nul") {
      pathspecFileNul = false;
      continue;
    }
    if (arg === "--pathspec-from-file") {
      i = takeValue(i, arg);
      if (i < args.length) pathspecFromFile = args[i];
      continue;
    }
    if (arg.startsWith("--pathspec-from-file=")) {
      pathspecFromFile = arg.slice("--pathspec-from-file=".length);
      if (!pathspecFromFile) unsupported.push("--pathspec-from-file:missing-value");
      continue;
    }
    if (COMMIT_LONG_VALUE_OPTIONS.has(arg)) {
      i = takeValue(i, arg);
      continue;
    }
    if ([...COMMIT_LONG_VALUE_OPTIONS].some((option) => arg.startsWith(`${option}=`))
      || /^(?:--gpg-sign|--untracked-files)=/.test(arg)
      || arg === "--gpg-sign"
      || arg === "--no-gpg-sign"
      || arg === "--untracked-files"
      || (arg.startsWith("--no-") && COMMIT_LONG_FLAGS.has(`--${arg.slice(5)}`))
      || COMMIT_LONG_FLAGS.has(arg)) {
      continue;
    }
    if (arg.startsWith("--")) {
      unsupported.push(arg);
      continue;
    }

    // Parse clustered short flags. Value-taking options consume the remainder
    // of their token, so `-madd` is one message option and never `-m -a -d -d`.
    const cluster = arg.slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      const option = cluster[j];
      if (option === "a") all = true;
      else if (option === "i") include = true;
      else if (option === "o") only = true;
      else if (option === "p") unsupported.push("-p");
      else if ("mFCct".includes(option)) {
        if (j + 1 === cluster.length) i = takeValue(i, `-${option}`);
        break;
      } else if (option === "S" || option === "u") {
        // Both accept an optional attached value; neither consumes the next
        // token, which may be a pathspec.
        break;
      } else if (!"qvsne".includes(option)) {
        unsupported.push(`-${option}`);
      }
    }
  }

  if (pathspecFileNul && pathspecFromFile === null) unsupported.push("--pathspec-file-nul:without-file");
  if (pathspecFromFile === "-") unsupported.push("--pathspec-from-file=-");
  if (pathspecs.some((pathspec) => /[\r\n]/.test(pathspec))
    || (pathspecFromFile !== null && /[\r\n]/.test(pathspecFromFile))) {
    unsupported.push("newline-in-pathspec-argument");
  }
  if (pathspecFromFile !== null && pathspecs.length) unsupported.push("mixed-pathspec-sources");
  if (include && only) unsupported.push("include-and-only");
  if (all && (include || only || pathspecs.length || pathspecFromFile !== null)) unsupported.push("all-with-pathspec-mode");

  let mode = "staged";
  if (unsupported.length) mode = "unsupported";
  else if (all) mode = "all";
  else if (include) mode = "include";
  else if (only || pathspecs.length || pathspecFromFile !== null) mode = "only";
  if ((mode === "include" || mode === "only") && pathspecs.length === 0 && pathspecFromFile === null) {
    unsupported.push(`${mode}:missing-pathspec`);
    mode = "unsupported";
  }

  return { mode, pathspecs, pathspecFromFile, pathspecFileNul, unsupported };
}

function parseGit(words, wanted) {
  const executableIndex = commandStart(words);
  if (executableIndex < 0) return null;
  if (basename(words[executableIndex] || "").toLowerCase() !== "git") return null;

  const cwd = [];
  const globalArgs = [];
  const repoArgs = [];
  let i = executableIndex + 1;
  for (; i < words.length; i += 1) {
    const arg = words[i];
    if (arg === "--") {
      i += 1;
      break;
    }
    if (VALUE_GLOBALS.has(arg)) {
      if (i + 1 >= words.length) return null;
      globalArgs.push(arg, words[i + 1]);
      if (arg === "-C") cwd.push(words[i + 1]);
      if (REPO_VALUE_GLOBALS.has(arg)) repoArgs.push(arg, words[i + 1]);
      i += 1;
      continue;
    }
    const eq = arg.match(/^(--(?:git-dir|work-tree|namespace|exec-path|config-env))=(.*)$/);
    if (eq) {
      globalArgs.push(arg);
      if (eq[1] !== "--exec-path" && eq[1] !== "--config-env") repoArgs.push(arg);
      continue;
    }
    if (arg.startsWith("-C") && arg.length > 2) {
      globalArgs.push(arg);
      cwd.push(arg.slice(2));
      repoArgs.push("-C", arg.slice(2));
      continue;
    }
    if (arg.startsWith("-c") && arg.length > 2) {
      globalArgs.push(arg);
      continue;
    }
    if (FLAG_GLOBALS.has(arg)) {
      globalArgs.push(arg);
      continue;
    }
    break;
  }

  const subcommand = words[i] || "";
  if (!wanted.has(subcommand.toLowerCase())) return null;
  const args = words.slice(i + 1);
  const isCommit = subcommand.toLowerCase() === "commit";
  return {
    executable: words[executableIndex],
    globalArgs,
    repoArgs,
    cwd,
    subcommand,
    args,
    commitAll: isCommit && commitUsesAll(args),
    commitContent: isCommit ? commitContent(args) : null,
    messages: isCommit ? commitMessages(args) : [],
  };
}

function collectGitMatches(source, wanted, depth = 0) {
  source = stripDataHereDocs(source);
  const matches = [];
  for (const words of lexCommands(source)) {
    const parsed = parseGit(words, wanted);
    if (parsed) matches.push(parsed);
  }
  if (depth >= MAX_SAFETY_RECURSION) return matches;
  for (const nested of nestedShellSources(lexSafetyCommands(source))) {
    matches.push(...collectGitMatches(nested, wanted, depth + 1));
  }
  return matches;
}

// Publish verbs that carry ship intent, keyed by the tool that owns them. `gh`
// is two-level: only the release subcommands that create or mutate a published
// release gate; the read-only ones (list/view/download) never do.
const PUBLISH_TOOLS = new Set(["npm", "pnpm", "yarn", "cargo"]);
const GH_RELEASE_GATED = new Set(["create", "upload", "edit", "delete", "delete-asset"]);

// Leading positional (non-option) argument words, up to `limit`. Option-looking
// tokens are skipped so the subcommand is still found after a global flag
// (e.g. `npm --loglevel=silly publish`). The shapes gated below place their
// subcommand first, so this never mistakes an option's value for a subcommand.
function leadingPositionals(args, limit) {
  const out = [];
  for (const arg of args) {
    if (arg.startsWith("-") && arg !== "-") continue;
    out.push(arg);
    if (out.length >= limit) break;
  }
  return out;
}

// Classify one lexed command as a non-git publish invocation, or null. The
// executable must sit in an actual command position — commandStart skips env
// assignments and command/exec/nohup/env/sudo wrappers — so a publisher word
// inside a quoted argument, or passed as data to rg/grep/echo, is never matched.
function parsePublisher(words) {
  const executableIndex = commandStart(words);
  if (executableIndex < 0) return null;
  const name = basename(words[executableIndex] || "").toLowerCase();
  const args = words.slice(executableIndex + 1);
  if (PUBLISH_TOOLS.has(name)) {
    const [sub] = leadingPositionals(args, 1);
    if (sub && sub.toLowerCase() === "publish") return { publisher: name, subcommand: "publish" };
    return null;
  }
  if (name === "gh") {
    const [group, action] = leadingPositionals(args, 2);
    if (group && group.toLowerCase() === "release" && action && GH_RELEASE_GATED.has(action.toLowerCase())) {
      return { publisher: "gh", subcommand: `release ${action.toLowerCase()}` };
    }
  }
  return null;
}

function collectPublisherMatches(source, depth = 0) {
  source = stripDataHereDocs(source);
  const matches = [];
  for (const words of lexCommands(source)) {
    const parsed = parsePublisher(words);
    if (parsed) matches.push(parsed);
  }
  if (depth >= MAX_SAFETY_RECURSION) return matches;
  for (const nested of nestedShellSources(lexSafetyCommands(source))) {
    matches.push(...collectPublisherMatches(nested, depth + 1));
  }
  return matches;
}

function main() {
  if (process.argv[2] === "--executes-file") {
    process.stdout.write(JSON.stringify(sourceExecutesFile(process.argv[3] || "", process.argv[4] || "", process.argv[5] || "")));
    return;
  }
  if (process.argv[2] === "--safety") {
    process.stdout.write(JSON.stringify(analyzeSafety(process.argv[3] || "")));
    return;
  }
  if (process.argv[2] === "--propagates-file") {
    process.stdout.write(JSON.stringify(sourcePropagatesFile(process.argv[3] || "", process.argv[4] || "", process.argv[5] || "")));
    return;
  }
  if (process.argv[2] === "--publishers") {
    process.stdout.write(JSON.stringify(collectPublisherMatches(process.argv[3] || "")));
    return;
  }
  const wanted = new Set((process.argv[2] || "").toLowerCase().split("|").filter(Boolean));
  const source = process.argv[3] || "";
  const matches = collectGitMatches(source, wanted);
  process.stdout.write(JSON.stringify(matches));
}

main();
