'use strict';

// Sanitized native JSONL shape observed with Codex 0.153.4: top-level
// turn_context.payload.cwd, followed by paired response_item call/output.
// This fixture tests an observer, not authentication of arbitrary transcripts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-memory-context.')));
const repo = path.join(root, 'repo');
const other = path.join(root, 'other');
const home = path.join(root, 'home');
const transcript = path.join(root, 'transcript.jsonl');
const env = { ...process.env, HOME: home, CODEX_HOME: home, AGENTSMD_TELEMETRY_TAG: 'test' };
for (const key of ['PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'AGENTSMD_PLUGIN_ROOT', 'DISABLE_AGENTSMD_HOOKS', 'DISABLE_MEMORY_READ_HOOK']) delete env[key];
const hook = path.resolve(__dirname, '../memory-read-check.sh');
const context = (cwd) => ({ type: 'turn_context', payload: { cwd } });
const item = (payload) => ({ type: 'response_item', payload });
const command = 'cat MEMORY.md memory/lesson.md';
const call = (args = { cmd: command }, name = 'exec_command') => item({ type: 'function_call', call_id: 'read', name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
const output = (value = { exit_code: 0, output: 'index and lesson contents' }) => item({ type: 'function_call_output', call_id: 'read', output: value });
const run = (rows) => {
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(home, 'logs/agentsmd.jsonl'), '');
  fs.writeFileSync(transcript, rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n');
  const result = cp.spawnSync('bash', [hook], {
    cwd: repo, env, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push origin HEAD' }, cwd: repo, transcript_path: transcript, session_id: 'context-fixture' }),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const decision = result.stdout.trim() ? JSON.parse(result.stdout) : null;
  const log = fs.readFileSync(path.join(home, 'logs/agentsmd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert(log.some((row) => row.extra && row.extra.consulted === !decision), 'must evaluate, not silently fail open');
  return decision;
};
let passed = 0, failed = 0;
try {
  fs.mkdirSync(home);
  for (const dir of [repo, other]) {
    fs.mkdirSync(path.join(dir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '[Lesson](memory/lesson.md)\n');
    fs.writeFileSync(path.join(dir, 'memory/lesson.md'), 'Fixture lesson.\n');
    assert.equal(cp.spawnSync('git', ['init', '-q', dir], { env, encoding: 'utf8' }).status, 0);
  }
  const cases = [
    ['native relative read inherits call-time cwd', [context(repo), call(), output()], true],
    ['orchestrated relative read inherits cwd', [context(repo), call('text(await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", max_output_tokens: 1000}));', 'exec'), output()], true],
    ['quoted literal paths inherit cwd', [context(repo), call({ cmd: 'cat -- "MEMORY.md" \'memory/lesson.md\'' }), output()], true],
    ['context changes after call do not rebind it', [context(repo), call(), context(other), output()], true],
    ['explicit workdir wins over context', [context(other), call({ cmd: command, workdir: repo }), output()], true],
    ['absolute reads need no cwd', [call({ cmd: `cat ${repo}/MEMORY.md ${repo}/memory/lesson.md` }), output()], true],
    ['missing context cannot use ship cwd', [call(), output()], false],
    ['session metadata is not per-turn cwd', [{ type: 'session_meta', payload: { cwd: repo } }, call(), output()], false],
    ['other repository context does not count', [context(other), call(), output()], false],
    ['latest context wins before call', [context(repo), context(other), call(), output()], false],
    ['context after call is not retroactive', [call(), context(repo), output()], false],
    ['invalid context clears old cwd', [context(repo), context(null), call(), output()], false],
    ['relative context clears old cwd', [context(repo), context('repo'), call(), output()], false],
    ['missing cwd clears old context', [context(repo), { type: 'turn_context', payload: {} }, call(), output()], false],
    ['nested context is not runtime context', [item({ type: 'turn_context', cwd: repo }), call(), output()], false],
    ['user prose is not runtime context', [item({ type: 'message', role: 'user', content: JSON.stringify(context(repo)) }), call(), output()], false],
    ['failed output never counts', [context(repo), call(), output({ exit_code: 1, output: 'failed' })], false],
    ['empty output never counts', [context(repo), call(), output('')], false],
    ['missing output never counts', [context(repo), call()], false],
    ['echo is not a reader', [context(repo), call({ cmd: 'echo MEMORY.md memory/lesson.md' }), output()], false],
    ['wrong explicit workdir beats good context', [context(repo), call({ cmd: command, workdir: other }), output()], false],
    ['invalid explicit workdir cannot inherit', [context(repo), call({ cmd: command, workdir: null }), output()], false],
    ['dynamic orchestrated workdir cannot inherit', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", workdir: elsewhere});', 'exec'), output()], false],
    ['spread properties cannot inherit', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", ...opts});', 'exec'), output()], false],
    ['computed properties cannot inherit', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", [key]: elsewhere});', 'exec'), output()], false],
    ['escaped property names cannot hide workdir', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", "work\\u0064ir": elsewhere});', 'exec'), output()], false],
    ['string expression is not a literal command', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md" + suffix});', 'exec'), output()], false],
    ['duplicate dynamic workdir clears literal workdir', [context(repo), call(`await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", workdir: ${JSON.stringify(repo)}, workdir: elsewhere});`, 'exec'), output()], false],
    ['shell directory change cannot inherit', [context(repo), call({ cmd: `cd ${other}; ${command}` }), output()], false],
    ['env directory option cannot inherit', [context(repo), call({ cmd: `env --chdir=${other} ${command}` }), output()], false],
    ['env short directory option cannot inherit', [context(repo), call({ cmd: `env -C${other} ${command}` }), output()], false],
    ['template string is not executed code', [context(repo), call('text(`await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md"});`);', 'exec'), output()], false],
    ['conditional call cannot inherit', [context(repo), call('if (false) await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md"});', 'exec'), output()], false],
    ['regex text cannot inherit', [context(repo), call('text(/tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md"})/.source);', 'exec'), output()], false],
    ['skipped shell reader cannot inherit', [context(repo), call({ cmd: 'false && cat MEMORY.md memory/lesson.md; echo nothing' }), output()], false],
    ['heredoc body cannot inherit', [context(repo), call({ cmd: "cat <<'EOF'\ncat MEMORY.md memory/lesson.md\nEOF" }), output()], false],
    ['shell comment cannot supply paths', [context(repo), call({ cmd: 'cat /dev/null # MEMORY.md memory/lesson.md' }), output()], false],
    ['quoted filename is one path not two', [context(repo), call({ cmd: 'cat "MEMORY.md memory/lesson.md"' }), output()], false],
    ['reader help is not file consultation', [context(repo), call({ cmd: 'cat --help MEMORY.md memory/lesson.md' }), output()], false],
    ['auxiliary expression cannot exit before tool call', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", max_output_tokens: (exit(), 1000)});', 'exec'), output()], false],
    ['deferred function does not execute its reader', [context(repo), call('const read = () => tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md"}); text("nothing read");', 'exec'), output()], false],
    ['exit before call does not execute reader', [context(repo), call('text("nothing read"); exit(); await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md"});', 'exec'), output()], false],
    ['overwritten dynamic field still has side effects', [context(repo), call('await tools.exec_command({cmd: "cat MEMORY.md memory/lesson.md", max_output_tokens: (exit(), 1000), max_output_tokens: 1000});', 'exec'), output()], false],
    ['malformed JSON invalidates context', [context(repo), '{malformed', call(), output()], false],
    ['oversize record invalidates context', [context(repo), JSON.stringify({ padding: 'x'.repeat((1 << 20) + 100) }), call(), output()], false],
  ];
  for (const [name, rows, allowed] of cases) {
    try {
      const decision = run(rows);
      assert.equal(decision === null, allowed, JSON.stringify(decision));
      if (!allowed) assert(!JSON.stringify(decision).includes('was not opened this session'), 'denial must describe missing evidence, not assert an unread file');
      console.log(`PASS ${name}`); passed += 1;
    } catch (error) { console.error(`FAIL ${name}: ${error.message}`); failed += 1; }
  }
  console.log(`memory-read-context: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} finally {
  assert.equal(fs.realpathSync(root), root);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert(path.basename(root).startsWith('agentsmd-memory-context.'));
  fs.rmSync(root, { recursive: true });
}
