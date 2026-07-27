'use strict';

// Canonical source composer for the two shipped discovery-chain profiles.
// Fragments are concatenated as raw Buffers in the explicit layout order:
// no trimming, newline insertion, template rendering, or encoding round-trip.

const fs = require('fs');
const path = require('path');
const F = require('./lib/fs-atomic');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');

const LAYOUT = 'spec/source/layout.json';

function safeRelative(root, relative, kind) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative)) {
    throw new Error(`unsafe spec source path (${kind}): ${relative}`);
  }
  const normalized = path.normalize(relative);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, normalized);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`unsafe spec source path (${kind}): ${relative}`);
  }
  return resolved;
}

function loadLayout(root) {
  const file = safeRelative(root, LAYOUT, 'layout');
  let layout;
  try {
    layout = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${LAYOUT}: ${error.message}`);
  }
  if (!layout || layout.schemaVersion !== 1 || !layout.outputs
      || typeof layout.outputs !== 'object' || Array.isArray(layout.outputs)) {
    throw new Error(`${LAYOUT}: invalid schema`);
  }
  const entries = Object.entries(layout.outputs);
  if (entries.length === 0) throw new Error(`${LAYOUT}: outputs must not be empty`);
  for (const [output, fragments] of entries) {
    safeRelative(root, output, 'output');
    if (!output.startsWith('spec/AGENTS') || !output.endsWith('.md')) {
      throw new Error(`unsafe spec source path (output): ${output}`);
    }
    if (!Array.isArray(fragments) || fragments.length === 0) {
      throw new Error(`${LAYOUT}: ${output} fragments must be a non-empty array`);
    }
    for (const fragment of fragments) {
      safeRelative(root, fragment, 'fragment');
      if (!fragment.startsWith('spec/source/') || !fragment.endsWith('.md')) {
        throw new Error(`unsafe spec source path (fragment): ${fragment}`);
      }
    }
  }
  return entries;
}

function contentFor(root, relative, sourceContent) {
  if (sourceContent instanceof Map && sourceContent.has(relative)) {
    return Buffer.from(sourceContent.get(relative));
  }
  if (sourceContent && Object.prototype.hasOwnProperty.call(sourceContent, relative)) {
    return Buffer.from(sourceContent[relative]);
  }
  return fs.readFileSync(safeRelative(root, relative, 'fragment'));
}

function renderAll({ root = path.join(__dirname, '..'), sourceContent = null } = {}) {
  const rendered = new Map();
  for (const [output, fragments] of loadLayout(root)) {
    rendered.set(output, Buffer.concat(
      fragments.map((fragment) => contentFor(root, fragment, sourceContent))
    ));
  }
  return rendered;
}

function check({ root = path.join(__dirname, '..'), sourceContent = null } = {}) {
  const rendered = renderAll({ root, sourceContent });
  for (const [relative, expected] of rendered) {
    const file = safeRelative(root, relative, 'output');
    let actual;
    try {
      actual = fs.readFileSync(file);
    } catch (error) {
      throw new Error(`generated spec drift: ${relative} (${error.code || error.message})`);
    }
    if (!actual.equals(expected)) throw new Error(`generated spec drift: ${relative}`);
  }
  return { checked: [...rendered.keys()] };
}

function generate({
  root = path.join(__dirname, '..'),
  sourceContent = null,
  write = F.writeFileAtomic,
} = {}) {
  const rendered = renderAll({ root, sourceContent });
  const snapshots = new Map([...rendered.keys()].map((relative) => {
    const file = safeRelative(root, relative, 'output');
    return [relative, F.snapshotFile(file)];
  }));
  const written = [];
  try {
    for (const [relative, content] of rendered) {
      const file = safeRelative(root, relative, 'output');
      const before = snapshots.get(relative);
      const after = {
        present: true,
        content: Buffer.from(content),
        mode: before.present ? before.mode : 0o600,
      };
      write(file, content, { expectedSnapshot: before });
      written.push({
        relative,
        file,
        after,
      });
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of written.reverse()) {
      const current = F.snapshotFile(record.file);
      if (!F.sameSnapshot(current, record.after)) {
        rollbackErrors.push(`${record.relative}: concurrent bytes prevent rollback`);
        continue;
      }
      try {
        const before = snapshots.get(record.relative);
        if (before.present) {
          F.writeFileAtomic(record.file, before.content, {
            expectedSnapshot: current,
            mode: before.mode,
            preserveMode: false,
          });
        } else {
          F.unlinkFileIfUnchanged(record.file, current);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${record.relative}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) error.message += `; rollback incomplete: ${rollbackErrors.join('; ')}`;
    throw error;
  }
  return { generated: [...rendered.keys()] };
}

if (require.main === module) {
  const usage = 'Usage: node scripts/spec-source.js <--generate|--check>';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let action;
  try {
    const opts = parseStrict(argv, { bools: ['generate', 'check'] });
    if (argv.length !== 1 || opts.bools.size !== 1) {
      throw new ArgvError('exactly one of --generate or --check is required');
    }
    action = opts.bools.has('generate') ? 'generate' : 'check';
  } catch (error) {
    console.error(`spec source: ${error.message}\n${usage}`);
    process.exit(2);
  }
  try {
    const result = action === 'generate' ? generate() : check();
    console.log(`spec ${action}: ${(result.generated || result.checked).join(', ')}`);
  } catch (error) {
    console.error(`spec ${action} failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { LAYOUT, check, generate, loadLayout, renderAll };
