'use strict';
// argv.test.js — the shared strict argv parser (scripts/lib/argv.js). Proves the
// bug class it exists to kill: a value flag demands --key=value (a bare --key
// never silently swallows the next token), unknown flags/args throw loudly
// instead of being ignored, and parsePositiveInt rejects the Number()/parseInt
// coercion footguns ('1e2' / '0x1e' / '1.5' / '0' / ''). printHelpAndExit exits
// 0 after printing usage (verified in a child process, since it exits).

const assert = require('assert');
const cp = require('child_process');
const path = require('path');
const { ArgvError, parsePositiveInt, parseStrict } = require('../lib/argv');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

// ── parsePositiveInt ──────────────────────────────────────────────────────────
t('parsePositiveInt accepts clean positive ints (trimmed, .0, numeric)', () => {
  assert.strictEqual(parsePositiveInt('30'), 30);
  assert.strictEqual(parsePositiveInt('30.0'), 30);
  assert.strictEqual(parsePositiveInt(' 30 '), 30);
  assert.strictEqual(parsePositiveInt(7), 7);
  assert.strictEqual(parsePositiveInt('1'), 1);
});
t('parsePositiveInt rejects coercion footguns + non-positive + junk → null', () => {
  for (const bad of ['1.5', '0x1e', '1e2', '0', '-5', 'abc', '', null, undefined]) {
    assert.strictEqual(parsePositiveInt(bad), null, 'should reject ' + JSON.stringify(bad));
  }
});

// ── parseStrict ───────────────────────────────────────────────────────────────
t('parseStrict: --key=value populates values', () => {
  const r = parseStrict(['--days=30'], { values: ['days'] });
  assert.strictEqual(r.values.days, '30');
});
t('parseStrict: bare bool flag populates bools', () => {
  const r = parseStrict(['--verbose'], { bools: ['verbose'] });
  assert.ok(r.bools.has('verbose'));
});
t('parseStrict: bare value flag throws (no silent next-token swallow)', () => {
  assert.throws(() => parseStrict(['--days'], { values: ['days'] }), /requires '=value'/);
});
t('parseStrict: valued bool flag throws', () => {
  assert.throws(() => parseStrict(['--verbose=1'], { bools: ['verbose'] }), /does not take a value/);
});
t('parseStrict: unknown flag / valued-unknown / positional all throw', () => {
  assert.throws(() => parseStrict(['--bogus'], {}), /Unknown flag/);
  assert.throws(() => parseStrict(['--bogus=1'], {}), /Unknown flag/);
  assert.throws(() => parseStrict(['positional'], {}), /Unknown argument/);
});
t('parseStrict: repeated value flag → last wins; empty argv → empty', () => {
  const r = parseStrict(['--days=1', '--days=2'], { values: ['days'] });
  assert.strictEqual(r.values.days, '2');
  const e = parseStrict([], { bools: ['v'], values: ['days'] });
  assert.strictEqual(e.bools.size, 0);
  assert.deepStrictEqual(e.values, {});
});
t('ArgvError is a named Error subclass (callers exit 2 on it)', () => {
  try { parseStrict(['x'], {}); assert.fail('should throw'); }
  catch (e) { assert.ok(e instanceof ArgvError); assert.strictEqual(e.name, 'ArgvError'); }
});

// ── printHelpAndExit (exits the process → verify in a child) ───────────────────
const argvJs = path.join(__dirname, '..', 'lib', 'argv.js');
const runChild = (code) => cp.execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' });
t('printHelpAndExit prints usage to stdout and exits 0 on --help', () => {
  const out = runChild(`const {printHelpAndExit}=require(${JSON.stringify(argvJs)});printHelpAndExit(['--help'],'USAGE-LINE');console.log('NOTREACHED');`);
  assert.ok(out.includes('USAGE-LINE'), 'usage printed');
  assert.ok(!out.includes('NOTREACHED'), 'exited before continuing');
});
t('printHelpAndExit is a no-op without a help flag', () => {
  const out = runChild(`const {printHelpAndExit}=require(${JSON.stringify(argvJs)});printHelpAndExit(['--days=1'],'USAGE');console.log('REACHED');`);
  assert.ok(out.includes('REACHED'));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
