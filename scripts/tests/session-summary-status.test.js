'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-summary-status-'));
process.env.CODEX_HOME = sandbox;
const { status } = require('../status');

try {
  const state = path.join(sandbox, '.agentsmd-state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'session-summary-old.json'), JSON.stringify({ sid: 'old', denies: 1, bypasses: 0, top_section: '§8', top_count: 1 }));
  fs.writeFileSync(path.join(state, 'session-summary-new.json'), JSON.stringify({ sid: 'new', denies: 2, bypasses: 1, top_section: '§10', top_count: 3 }));
  const old = new Date('2026-01-01T00:00:00Z');
  const fresh = new Date('2026-01-02T00:00:00Z');
  fs.utimesSync(path.join(state, 'session-summary-old.json'), old, old);
  fs.utimesSync(path.join(state, 'session-summary-new.json'), fresh, fresh);
  const result = status().sessionSummaries;
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.latest.sid, 'new');
  assert.strictEqual(result.latest.denies, 2);
  assert.strictEqual(result.latest.bypasses, 1);
  assert.strictEqual(result.latest.topSection, '§10');
  console.log('  ok   status exposes stored session summaries without injecting them into a new session');
  console.log('\nRESULT: 1 passed, 0 failed');
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
