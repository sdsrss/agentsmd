'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-summary-status-'));
const previous = {
  CODEX_HOME: process.env.CODEX_HOME,
  PLUGIN_DATA: process.env.PLUGIN_DATA,
  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
};
process.env.CODEX_HOME = sandbox;
process.env.PLUGIN_DATA = path.join(sandbox, 'plugin-data');
delete process.env.CLAUDE_PLUGIN_DATA;
const { status } = require('../status');

try {
  const state = path.join(sandbox, '.agentsmd-state');
  const pluginRuntime = path.join(process.env.PLUGIN_DATA, 'runtime');
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(pluginRuntime, { recursive: true });
  fs.writeFileSync(path.join(pluginRuntime, 'session-summary-plugin.json'), JSON.stringify({ sid: 'plugin', denies: 1, bypasses: 0, top_section: '§8', top_count: 1 }));
  const old = new Date('2026-01-01T00:00:00Z');
  const fresh = new Date('2026-01-02T00:00:00Z');
  fs.utimesSync(path.join(pluginRuntime, 'session-summary-plugin.json'), old, old);

  let result = status().sessionSummaries;
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.latest.sid, 'plugin');
  console.log('  ok   status reads plugin-private session summaries');

  fs.writeFileSync(path.join(state, 'session-summary-legacy.json'), JSON.stringify({ sid: 'legacy', denies: 2, bypasses: 1, top_section: '§10', top_count: 3 }));
  fs.utimesSync(path.join(state, 'session-summary-legacy.json'), fresh, fresh);
  result = status().sessionSummaries;
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.latest.sid, 'legacy');
  assert.strictEqual(result.latest.denies, 2);
  assert.strictEqual(result.latest.bypasses, 1);
  assert.strictEqual(result.latest.topSection, '§10');
  console.log('  ok   status merges legacy shared and plugin-private summaries by mtime');

  const standaloneRuntime = path.join(state, 'runtime');
  fs.mkdirSync(standaloneRuntime, { recursive: true });
  fs.writeFileSync(path.join(standaloneRuntime, 'session-summary-standalone.json'), JSON.stringify({ sid: 'standalone', denies: 0, bypasses: 2, top_section: 'standalone', top_count: 2 }));
  const standaloneTime = new Date('2026-01-02T12:00:00Z');
  fs.utimesSync(path.join(standaloneRuntime, 'session-summary-standalone.json'), standaloneTime, standaloneTime);
  result = status().sessionSummaries;
  assert.strictEqual(result.count, 3);
  assert.strictEqual(result.latest.sid, 'standalone');
  console.log('  ok   status reads standalone-private session summaries');

  const duplicateName = 'session-summary-duplicate.json';
  fs.writeFileSync(path.join(state, duplicateName), JSON.stringify({ sid: 'legacy-duplicate', denies: 9, bypasses: 9, top_section: 'legacy', top_count: 9 }));
  fs.writeFileSync(path.join(pluginRuntime, duplicateName), JSON.stringify({ sid: 'plugin-duplicate', denies: 3, bypasses: 0, top_section: 'plugin', top_count: 3 }));
  const pluginDuplicateTime = new Date('2026-01-03T00:00:00Z');
  const legacyDuplicateTime = new Date('2026-01-04T00:00:00Z');
  fs.utimesSync(path.join(pluginRuntime, duplicateName), pluginDuplicateTime, pluginDuplicateTime);
  fs.utimesSync(path.join(state, duplicateName), legacyDuplicateTime, legacyDuplicateTime);
  result = status().sessionSummaries;
  assert.strictEqual(result.count, 4, 'same logical summary must be counted once');
  assert.strictEqual(result.latest.sid, 'plugin-duplicate', 'plugin-private copy wins a migration duplicate');
  console.log('  ok   status deduplicates migration copies with plugin-private precedence');

  console.log('\nRESULT: 4 passed, 0 failed');
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
}
