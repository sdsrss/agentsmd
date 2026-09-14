'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const M = require('./engineering-baseline.cjs');

const source = `const arrow = (a) => {\n${'// } function misleading() {\n'.repeat(51)}return a;\n};\nfunction outer(){ return function inner(){}; }`;
const parsed = M.analyzeJs(source, 'scripts/example.js');
assert.strictEqual(parsed.functions.length, 3);
assert.strictEqual(parsed.functions.filter((f) => f.lines > 50).length, 1);
assert.strictEqual(parsed.functions[0].name, 'arrow');
assert.throws(() => M.analyzeJs('function {', 'bad.js'));
const imports = M.analyzeJs(
  'require("./b"); require(target); module.exports = { api };',
  'a.js'
);
assert.deepStrictEqual(imports.imports, [{ request: './b', line: 1 }]);
assert.strictEqual(imports.dynamic.length, 1);
const graph = M.dependencyGraph({
  'a.js': imports,
  'b.js': { imports: [{ request: './a', line: 1 }] },
}).graph;
assert.deepStrictEqual(M.cycles(graph), [['a.js', 'b.js']]);
assert.deepStrictEqual(M.cycles({ a: ['b'], b: ['c'], c: [] }), []);
assert.deepStrictEqual(M.cycles({ self: ['self'] }), [['self']]);
const block = Array.from({ length: 10 }, (_, i) => `statement_${i};`).join(
  '\n'
);
const dup = M.duplication({
  a: block,
  b: `\n ${block.split('\n').join('\n ')}\n`,
  c: 'unique;',
});
assert.strictEqual(
  dup.duplicated_lines,
  20,
  'overlapping windows must not double count'
);
assert.strictEqual(dup.total_nonblank_lines, 21);
assert.strictEqual(dup.percent, 95.24);
assert.strictEqual(
  M.duplication({ a: 'x\ny', b: 'x\ny' }).duplicated_lines,
  0,
  'short boilerplate is below threshold'
);
assert.strictEqual(M.lines('x\n'), 1);
assert.strictEqual(M.lines(''), 0);
assert.strictEqual(
  M.canonical('skills/example/scripts/agentsmd-run.js'),
  false
);
assert.strictEqual(M.canonical('scripts/tests/fixtures/demo.js'), false);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-metrics-test-'));
try {
  cp.execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored/\n');
  fs.mkdirSync(path.join(root, 'ignored'));
  fs.writeFileSync(path.join(root, 'ignored', 'omit.js'), 'private');
  fs.writeFileSync(path.join(root, 'source.js'), 'module.exports = {};\n');
  fs.symlinkSync('source.js', path.join(root, 'linked.js'));
  const entries = M.inventory(root);
  assert.deepStrictEqual(
    entries.map((e) => e.file),
    ['.gitignore', 'source.js']
  );
  assert.strictEqual(entries[1].lines, 1);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'tracked.js'), 'original');
  cp.execFileSync('git', ['add', 'nested/tracked.js'], { cwd: root });
  fs.renameSync(
    path.join(root, 'nested'),
    path.join(root, 'ignored', 'original')
  );
  fs.symlinkSync(
    path.join(root, 'ignored', 'original'),
    path.join(root, 'nested'),
    'dir'
  );
  assert.ok(
    !M.inventory(root).some((e) => e.file === 'nested/tracked.js'),
    'a tracked file through an ancestor symlink is excluded'
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(
  'baseline tools: AST boundaries, graph cycles, duplication denominator and Git scope passed'
);
