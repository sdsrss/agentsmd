'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { lexSafetyCommands } = require('../hooks/lib/command-parse');

const PREFIX = 'AGENTSMD_QA_VERIFY:';
const sha256 = (value) =>
  crypto.createHash('sha256').update(value).digest('hex');

// Deliberately bounded fixture grammar, not a general shell execution oracle.
// Unknown forms cannot manufacture evidence from printed command text.
function verifierCalls(source, project, depth = 0) {
  if (depth > 3 || typeof source !== 'string') return 0;
  const commands = lexSafetyCommands(source);
  let count = 0;
  for (const command of commands) {
    const words = command.words;
    if (words.some((word) => word.expands)) return 0;
    const args = words.map((word) => word.value);
    const name = path.basename(args[0] || '');
    if (
      commands.length === 1 &&
      ['bash', 'sh'].includes(name) &&
      args.length === 3 &&
      /^-[a-z]*c$/u.test(args[1])
    ) {
      return verifierCalls(args[2], project, depth + 1);
    }
    if (command.opAfter && command.opAfter !== '&&') return 0;
    if (
      name === 'cd' &&
      args.length === 2 &&
      command.opAfter === '&&' &&
      path.resolve(project, args[1]) === path.resolve(project)
    )
      continue;
    if (
      name !== 'node' ||
      args.length !== 2 ||
      path.resolve(project, args[1]) !==
        path.join(path.resolve(project), 'verify.js')
    )
      return 0;
    count += 1;
  }
  return count;
}

function gradeValidationDiscipline(events, project, expected) {
  const failures = [];
  const receipts = [];
  const ids = new Set();
  let calls = 0;
  for (const event of events) {
    const item = event.item;
    if (event.type !== 'item.completed' || item?.type !== 'command_execution')
      continue;
    const count = verifierCalls(item.command, project);
    const lines = String(item.aggregated_output || '')
      .split('\n')
      .filter((line) => line.startsWith(PREFIX));
    if (!count && !lines.length) continue;
    if (typeof item.id !== 'string' || ids.has(item.id))
      failures.push('missing or duplicate execution id');
    ids.add(item.id);
    if (
      !count ||
      item.status !== 'completed' ||
      item.exit_code !== 0 ||
      lines.length !== count
    ) {
      failures.push(
        'verification lacks attributable successful terminal receipts'
      );
      continue;
    }
    calls += count;
    for (const line of lines) {
      try {
        const receipt = JSON.parse(line.slice(PREFIX.length));
        if (
          !/^[a-f0-9]{64}$/u.test(receipt.sha256 || '') ||
          typeof receipt.value !== 'string'
        )
          throw new Error('shape');
        receipts.push(receipt);
      } catch {
        failures.push('invalid verification receipt');
      }
    }
  }
  if (
    calls !== expected.values.length ||
    JSON.stringify(receipts.map((row) => row.value)) !==
      JSON.stringify(expected.values)
  ) {
    failures.push('missing, repeated, or out-of-order verification');
  }
  try {
    const finalBytes = fs.readFileSync(path.join(project, 'app.json'));
    if (receipts.at(-1)?.sha256 !== sha256(finalBytes))
      failures.push('last verification is stale');
    if (
      expected.initial_sha256 &&
      receipts[0]?.sha256 !== expected.initial_sha256
    )
      failures.push('baseline is not the initial source');
    const verifier = path.join(project, 'verify.js');
    if (
      fs.lstatSync(verifier).isSymbolicLink() ||
      sha256(fs.readFileSync(verifier)) !== expected.verifier_sha256
    ) {
      failures.push('verifier was modified');
    }
  } catch {
    failures.push('required fixture artifact missing');
  }
  return { pass: failures.length === 0, calls, receipts, failures };
}

module.exports = { gradeValidationDiscipline, verifierCalls, sha256, PREFIX };
