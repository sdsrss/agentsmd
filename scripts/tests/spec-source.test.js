'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const G = require('../spec-source');
const sha256 = (content) => crypto.createHash('sha256').update(content).digest('hex');
let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try { fn(); PASS++; console.log('  ok   ' + name); }
  catch (error) { FAIL++; console.log('  FAIL ' + name + '\n     ' + error.message); }
};

t('canonical layout renders the committed full artifact byte-for-byte', () => {
  const rendered = G.renderAll({ root: ROOT });
  assert.deepStrictEqual([...rendered.keys()], ['spec/AGENTS.md']);
  for (const [relative, content] of rendered) {
    assert.deepStrictEqual(content, fs.readFileSync(path.join(ROOT, relative)), relative);
  }
  assert.strictEqual(sha256(rendered.get('spec/AGENTS.md')), '9749a8a8351a2f651743da546db74cd28405e09ce5eea7d13cbcf546464262c2');
});

t('spec:check is read-only and reports the full output in sync', () => {
  const outputs = ['spec/AGENTS.md'];
  const before = new Map(outputs.map((relative) => [
    relative,
    {
      content: fs.readFileSync(path.join(ROOT, relative)),
      mtimeMs: fs.statSync(path.join(ROOT, relative)).mtimeMs,
    },
  ]));
  const result = G.check({ root: ROOT });
  assert.deepStrictEqual(result.checked, outputs);
  for (const relative of outputs) {
    assert.deepStrictEqual(fs.readFileSync(path.join(ROOT, relative)), before.get(relative).content);
    assert.strictEqual(fs.statSync(path.join(ROOT, relative)).mtimeMs, before.get(relative).mtimeMs);
  }
});

t('generate repairs artifact drift from canonical fragments', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-spec-source.'));
  try {
    fs.cpSync(path.join(ROOT, 'spec', 'source'), path.join(fixture, 'spec', 'source'), { recursive: true });
    for (const relative of ['spec/AGENTS.md']) {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, relative), target);
    }
    fs.appendFileSync(path.join(fixture, 'spec', 'AGENTS.md'), '\ndrift\n');
    assert.throws(() => G.check({ root: fixture }), /generated spec drift: spec\/AGENTS\.md/);
    const generated = G.generate({ root: fixture });
    assert.deepStrictEqual(generated.generated, ['spec/AGENTS.md']);
    assert.doesNotThrow(() => G.check({ root: fixture }));
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

t('generate rolls back the first artifact when the second write fails', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-spec-source-rollback.'));
  try {
    fs.cpSync(path.join(ROOT, 'spec', 'source'), path.join(fixture, 'spec', 'source'), { recursive: true });
    const layoutFile = path.join(fixture, 'spec', 'source', 'layout.json');
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    layout.outputs['spec/AGENTS-secondary.md'] = [...layout.outputs['spec/AGENTS.md']];
    fs.writeFileSync(layoutFile, `${JSON.stringify(layout, null, 2)}\n`);
    for (const relative of ['spec/AGENTS.md', 'spec/AGENTS-secondary.md']) {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `old ${relative}\n`);
    }
    const before = new Map(['spec/AGENTS.md', 'spec/AGENTS-secondary.md'].map((relative) => [
      relative,
      fs.readFileSync(path.join(fixture, relative)),
    ]));
    const atomic = require('../lib/fs-atomic').writeFileAtomic;
    let writes = 0;
    assert.throws(() => G.generate({
      root: fixture,
      write(file, content, options) {
        writes += 1;
        if (writes === 2) throw new Error('simulated generated-output write failure');
        atomic(file, content, options);
      },
    }), /simulated generated-output write failure/);
    for (const [relative, content] of before) {
      assert.deepStrictEqual(fs.readFileSync(path.join(fixture, relative)), content, relative);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

t('generate preserves a concurrent edit instead of blessing it as rollback state', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-spec-source-cas.'));
  try {
    fs.cpSync(path.join(ROOT, 'spec', 'source'), path.join(fixture, 'spec', 'source'), { recursive: true });
    const layoutFile = path.join(fixture, 'spec', 'source', 'layout.json');
    const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
    layout.outputs['spec/AGENTS-secondary.md'] = [...layout.outputs['spec/AGENTS.md']];
    fs.writeFileSync(layoutFile, `${JSON.stringify(layout, null, 2)}\n`);
    for (const relative of ['spec/AGENTS.md', 'spec/AGENTS-secondary.md']) {
      const target = path.join(fixture, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `old ${relative}\n`);
    }
    const atomic = require('../lib/fs-atomic').writeFileAtomic;
    const concurrent = '\nconcurrent-edit\n';
    let writes = 0;
    let error;
    try {
      G.generate({
        root: fixture,
        write(file, content, options) {
          writes += 1;
          if (writes === 2) throw new Error('simulated second-output failure');
          atomic(file, content, options);
          fs.appendFileSync(file, concurrent);
        },
      });
    } catch (caught) {
      error = caught;
    }
    assert(error, 'generate unexpectedly succeeded');
    assert.match(error.message, /rollback incomplete: spec\/AGENTS\.md: concurrent bytes prevent rollback/);
    assert(fs.readFileSync(path.join(fixture, 'spec/AGENTS.md'), 'utf8').endsWith(concurrent));
    assert.strictEqual(
      fs.readFileSync(path.join(fixture, 'spec/AGENTS-secondary.md'), 'utf8'),
      'old spec/AGENTS-secondary.md\n'
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

t('layout paths cannot escape the repository root', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-spec-source-path.'));
  try {
    const source = path.join(fixture, 'spec', 'source');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'layout.json'), JSON.stringify({
      schemaVersion: 1,
      outputs: { 'spec/AGENTS.md': ['../outside.md'] },
    }));
    assert.throws(() => G.renderAll({ root: fixture }), /unsafe spec source path/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

t('spec-source CLI rejects unknown actions without writing', () => {
  const script = path.join(ROOT, 'scripts', 'spec-source.js');
  const result = cp.spawnSync(process.execPath, [script, 'wat'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /Usage:/);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
