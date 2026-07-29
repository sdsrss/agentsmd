'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  renderEvidence,
  validateTaskContract,
  validateTaskEvidence,
} = require('../lib/task-contract');

const ROOT = path.resolve(__dirname, '..', '..');
const casesRaw = fs.readFileSync(path.join(ROOT, 'qa', 'task-contract-cases.json'), 'utf8');
const cases = JSON.parse(casesRaw);
const taskSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-contract.schema.json'), 'utf8'));
const evidenceSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-evidence.schema.json'), 'utf8'));

function expandFragments(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{SECRET:([\w-]+)\}\}/g, (_match, name) => {
      const fragments = cases.fragments?.[name];
      assert(Array.isArray(fragments) && fragments.length >= 2, `missing split fragment: ${name}`);
      return fragments.join('');
    });
  }
  if (Array.isArray(value)) return value.map(expandFragments);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandFragments(entry)]));
  }
  return value;
}

let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

test('schemas identify draft 2020-12, reject unknown fields, and bound every text/array field', () => {
  for (const [name, schema] of Object.entries({ taskSchema, evidenceSchema })) {
    assert.strictEqual(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.strictEqual(schema.additionalProperties, false, `${name}: root unknown fields`);
    const raw = JSON.stringify(schema);
    assert(!raw.includes('tool_output'), `${name}: raw tool output field is forbidden`);
    assert(!raw.includes('"secret"'), `${name}: secret field is forbidden`);
  }
});

test('secret-shaped fixtures stay split on disk and resolve only in memory', () => {
  assert.strictEqual(casesRaw.match(/gh[pousr]_[A-Za-z0-9]{36,}/), null);
  for (const match of casesRaw.matchAll(/\{\{SECRET:([\w-]+)\}\}/g)) {
    const fragments = cases.fragments?.[match[1]];
    assert(Array.isArray(fragments) && fragments.length >= 2, `missing split fragment: ${match[1]}`);
  }
});

for (const fixture of cases.valid_tasks) {
  test(`valid task: ${fixture.name}`, () => {
    const result = validateTaskContract(expandFragments(fixture.value));
    assert.deepStrictEqual(result.errors, [], result.errors.join('\n'));
    assert.strictEqual(result.valid, true);
  });
}

for (const fixture of cases.invalid_tasks) {
  test(`invalid task: ${fixture.name}`, () => {
    const result = validateTaskContract(expandFragments(fixture.value));
    assert.strictEqual(result.valid, false, 'fixture unexpectedly validated');
    assert(result.errors.length > 0);
  });
}

for (const fixture of cases.valid_evidence) {
  test(`valid evidence: ${fixture.name}`, () => {
    const result = validateTaskEvidence(fixture.value);
    assert.deepStrictEqual(result.errors, [], result.errors.join('\n'));
    assert.strictEqual(result.valid, true);
  });
}

for (const fixture of cases.invalid_evidence) {
  test(`invalid evidence: ${fixture.name}`, () => {
    const result = validateTaskEvidence(fixture.value);
    assert.strictEqual(result.valid, false, 'fixture unexpectedly validated');
    assert(result.errors.length > 0);
  });
}

test('interactive rendering is schema-derived and preserves report order', () => {
  const evidence = cases.valid_evidence.find((entry) => entry.name === 'fresh code evidence').value;
  const rendered = renderEvidence(evidence);
  const labels = ['Done:', 'Not done:', 'Failed:', 'Uncertain:'];
  let cursor = -1;
  for (const label of labels) {
    const index = rendered.indexOf(label);
    assert(index > cursor, `${label} is out of order`);
    cursor = index;
  }
  assert(rendered.includes('- Validation routing implemented.'));
});

test('blocked/auth evidence never renders a completed item and keeps a copyable resume command', () => {
  const evidence = cases.valid_evidence.find((entry) => entry.name === 'blocked authorization boundary').value;
  const rendered = renderEvidence(evidence);
  assert.match(rendered, /\[AUTH REQUIRED op:deploy production scope:task contract risk:external action\]/);
  assert.match(rendered, /\[BLOCKED:/);
  assert(rendered.includes(`Resume: ${evidence.resume_command}`));
  assert.match(rendered, /Done:\n- none/);
  assert(!rendered.includes('Deployment completed.'));
});

test('oversized structured evidence is rejected instead of becoming unbounded output', () => {
  const base = structuredClone(cases.valid_evidence[0].value);
  base.checks[0].observed = 'x'.repeat(4097);
  const result = validateTaskEvidence(base);
  assert.strictEqual(result.valid, false);
  assert(result.errors.some((error) => /maxLength|4096|too long/.test(error)), result.errors.join('\n'));
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
