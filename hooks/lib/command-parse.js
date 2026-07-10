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
