#!/usr/bin/env node
"use strict";

// Parse enough POSIX shell syntax to identify an actual Git command without
// evaluating expansions. This is deliberately a lexer, not a shell executor.

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
const DOWNLOADERS = new Set(["curl", "wget"]);
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

function rmRfState(commands) {
  let candidate = false;
  let variableTarget = false;
  for (const command of commands) {
    const { name, args } = safetyExecutable(command);
    if (name !== "rm") continue;
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
    const child = rmRfStateRecursive(lexSafetyCommands(nested), depth + 1);
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

function downloaderOutput(command) {
  const { name, args: commandArgs } = safetyExecutable(command);
  if (!DOWNLOADERS.has(name)) return "";
  const args = commandArgs.map((word) => word.value);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (name === "curl" && (arg === "-o" || arg === "--output")) return args[i + 1] || "";
    if (name === "wget" && (arg === "-O" || arg === "--output-document")) return args[i + 1] || "";
    if (name === "curl" && arg.startsWith("--output=")) return arg.slice("--output=".length);
    if (name === "wget" && arg.startsWith("--output-document=")) return arg.slice("--output-document=".length);
    const shortOption = name === "curl" ? "o" : "O";
    if (/^-[^-]/.test(arg)) {
      const optionIndex = arg.slice(1).indexOf(shortOption);
      if (optionIndex >= 0) {
        const attached = arg.slice(optionIndex + 2);
        return attached || args[i + 1] || "";
      }
    }
  }
  return "";
}

function interpreterReadsFile(command, file) {
  const { name, args } = safetyExecutable(command);
  if (!(name === "source" || name === ".") && !interpreterExecutesInput(command)) return false;
  const normalized = file.replace(/^\.\//, "");
  return args.some((word) => word.value.replace(/^\.\//, "") === normalized);
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

  // A file downloaded and then passed directly to an interpreter in the same
  // tool call is still uninspected remote execution. Plain inspection commands
  // such as `cat file` do not satisfy this predicate.
  for (let i = 0; i < commands.length; i += 1) {
    const output = downloaderOutput(commands[i]);
    if (!output) continue;
    for (let j = i + 1; j < commands.length; j += 1) {
      if (interpreterReadsFile(commands[j], output)) return true;
    }
  }
  if (depth < MAX_SAFETY_RECURSION) {
    for (const nested of nestedShellSources(commands)) {
      if (remoteExecState(lexSafetyCommands(nested), depth + 1)) return true;
    }
  }
  return false;
}

function analyzeSafety(source) {
  const commands = lexSafetyCommands(source);
  const rm = rmRfStateRecursive(commands, 0);
  return {
    rmRfCandidate: rm.candidate,
    rmRfVar: rm.variableTarget,
    remoteExec: remoteExecState(commands),
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
  return {
    executable: words[executableIndex],
    globalArgs,
    repoArgs,
    cwd,
    subcommand,
    args,
    commitAll: subcommand.toLowerCase() === "commit" && commitUsesAll(args),
    messages: subcommand.toLowerCase() === "commit" ? commitMessages(args) : [],
  };
}

function main() {
  if (process.argv[2] === "--safety") {
    process.stdout.write(JSON.stringify(analyzeSafety(process.argv[3] || "")));
    return;
  }
  const wanted = new Set((process.argv[2] || "").toLowerCase().split("|").filter(Boolean));
  const source = process.argv[3] || "";
  const matches = [];
  for (const words of lexCommands(source)) {
    const parsed = parseGit(words, wanted);
    if (parsed) matches.push(parsed);
  }
  process.stdout.write(JSON.stringify(matches));
}

main();
