'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const TESTS = [];
let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  TESTS.push({ name, fn });
}

function readGithubScript(relative) {
  const source = read(relative);
  const marker = '          script: |\n';
  const index = source.indexOf(marker);
  assert(index >= 0, `missing github-script block in ${relative}`);
  return source
    .slice(index + marker.length)
    .split('\n')
    .map((line) => line.startsWith('            ') ? line.slice(12) : line)
    .join('\n');
}

async function run() {
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      PASS += 1;
      console.log(`  ok   ${name}`);
    } catch (error) {
      FAIL += 1;
      console.log(`  FAIL ${name}\n     ${error.message}`);
    }
  }
  console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
  process.exitCode = FAIL === 0 ? 0 : 1;
}

test('all four distributed recipes exist and preserve authorization/worktree boundaries', () => {
  const expected = [
    'automation/weekly-runtime-canary.md',
    'automation/weekly-governance-review.md',
    'automation/release-readiness.md',
    'automation/pr-review.md',
  ];
  for (const file of expected) assert(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
  const runtime = read(expected[0]);
  assert.match(runtime, /pinned/i);
  assert.match(runtime, /latest/i);
  assert.match(runtime, /positive/i);
  assert.match(runtime, /near-negative/i);
  assert.match(runtime, /isolated CODEX_HOME/);
  assert.match(runtime, /do not push|no push|never push/i);
  const governance = read(expected[1]);
  for (const signal of ['rules', 'sampling', 'lesson', 'sparkline', 'prompt', 'performance', 'fallback']) {
    assert.match(governance, new RegExp(signal, 'i'), signal);
  }
  assert.match(governance, /no-opportunity/i);
  assert.match(governance, /runtime\/version split/i);
  const release = read(expected[2]);
  for (const gate of ['full check', 'conformance', 'perf', 'package', 'version', 'changelog', 'secret', 'rollback', 'authorization']) {
    assert.match(release, new RegExp(gate, 'i'), gate);
  }
  assert.match(release, /report-only/i);
  const combined = expected.map(read).join('\n');
  assert.match(combined, /dedicated worktree/i);
  assert.match(combined, /pinned.*active.*permanent|pinned\/active\/permanent/is);
  assert.match(combined, /task-owned/i);
});

test('manual runtime workflow gates model calls on an optional credential and retains unverified captures', () => {
  const source = read('.github/workflows/runtime-canary.yml');
  assert.doesNotMatch(source, /^\s*schedule\s*:/m);
  assert.match(source, /^\s*workflow_dispatch\s*:/m);
  assert.match(source, /channel:\s*pinned/);
  assert.match(source, /channel:\s*latest/);
  assert.match(source, /@openai\/codex@0\.145\.0/);
  assert.match(source, /@openai\/codex@latest/);
  assert.match(source, /Detect optional runtime credential/);
  assert.match(source, /credential\.outputs\.available == 'true'/);
  assert.match(source, /credential\.outputs\.available != 'true'/);
  assert.match(source, /writeUnverifiedReport/);
  assert.match(source, /qa\/runtime-canary\.js/);
  assert.match(source, /continue-on-error:\s*true/);
  assert.match(source, /if:\s*always\(\)/);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(source, /matrix\.channel == 'pinned'/);
  assert.match(source, /steps\.credential\.outputs\.available == 'true'.*steps\.canary\.outcome == 'failure'/s);
  assert.doesNotMatch(source, /\bissues:\s*write\b|\bcontents:\s*write\b|\bgit push\b/);
});

test('weekly governance workflow emits one read-only scorecard artifact', () => {
  const source = read('.github/workflows/governance-review.yml');
  assert.match(source, /^\s*schedule\s*:/m);
  assert.match(source, /scripts\/scorecard\.js --days=30 --json/);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(source, /\bissues:\s*write\b|\bcontents:\s*write\b|\bgit push\b/);
});

test('PR review is optional, same-repository/trusted-actor constrained, read-only, and posts from a separate job', () => {
  const source = read('.github/workflows/codex-review.yml');
  assert.match(source, /^\s*pull_request\s*:/m);
  assert.doesNotMatch(source, /pull_request_target/);
  assert.match(source, /head\.repo\.full_name == github\.repository/);
  assert.match(source, /author_association/);
  assert.match(source, /openai\/codex-action@[0-9a-f]{40}/);
  assert.match(source, /sandbox:\s*read-only/);
  assert.match(source, /persist-credentials:\s*false/);
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /review_available/);
  assert.match(source, /feedback:\s*\n/);
  assert.match(source, /pull-requests:\s*write/);
  assert.match(source, /actions\/github-script@[0-9a-f]{40}/);
  assert.doesNotMatch(source, /\bcontents:\s*write\b|\bgit push\b/);
  const shellBlocks = [...source.matchAll(/run:\s*\|([\s\S]*?)(?=\n\s{6}-|\n\s{2}\w|\s*$)/g)].map((match) => match[1]).join('\n');
  assert.doesNotMatch(shellBlocks, /\$\{\{\s*github\.event\.pull_request\./);
});

test('Codex review prompt treats repository and PR text as untrusted review input', () => {
  const prompt = read('.github/codex/pr-review.md');
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /review only|do not modify/i);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /actionable/i);
});

test('Release retains tag-push compatibility and accepts an explicit tag-ref dispatch', () => {
  const source = read('.github/workflows/release.yml');
  assert.match(source, /^  push:\s*$/m);
  assert.match(source, /^\s+tags:\s*\n\s+- 'v\*'/m);
  assert.match(source, /^  workflow_dispatch:\s*$/m);
  assert.match(source, /Assert tag matches package version/);
  assert.match(source, /test "\$TAG" = "v\$VER"/);
});

test('merged version PR automation creates a verified annotated tag and dispatches Release once', () => {
  const relative = '.github/workflows/release-tag.yml';
  assert(fs.existsSync(path.join(ROOT, relative)), `missing ${relative}`);
  const source = read(relative);

  assert.match(source, /^  pull_request_target:\s*$/m);
  assert.match(source, /^\s+types:\s*\[closed\]\s*$/m);
  assert.match(source, /^\s+branches:\s*\[main\]\s*$/m);
  assert.match(source, /github\.event\.pull_request\.merged == true/);
  assert.match(source, /permissions:\s*\n\s+contents:\s*write\s*\n\s+actions:\s*write/);
  assert.doesNotMatch(source, /\bpull-requests:\s*write\b|\bpackages:\s*write\b|\bid-token:\s*write\b/);
  assert.match(source, /actions\/github-script@[0-9a-f]{40}/);
  assert.doesNotMatch(source, /actions\/checkout@|\bnpm (?:ci|install|test)\b|\bgit (?:checkout|pull|switch)\b/);

  assert.match(source, /path:\s*'package\.json'/);
  assert.match(source, /github\.rest\.pulls\.listFiles/);
  assert.match(source, /file\.filename === 'package\.json'/);
  assert.match(source, /pr\.base\.sha/);
  assert.match(source, /pr\.merge_commit_sha/);
  assert.match(source, /stable SemVer/);
  assert.match(source, /BigInt/);
  assert.match(source, /base\.version === merged\.version/);
  assert.match(source, /merged\.tuple.*base\.tuple/s);

  assert.match(source, /github\.rest\.git\.createTag/);
  assert.match(source, /github\.rest\.git\.createRef/);
  assert.match(source, /ref:\s*`refs\/tags\/\$\{tag\}`/);
  assert.match(source, /github\.rest\.git\.getRef/);
  assert.match(source, /github\.rest\.git\.getTag/);
  assert.match(source, /existingRef\.object\.type !== 'tag'/);
  assert.match(source, /tagObject\.object\.sha !== mergeSha/);
  assert.match(source, /tagObject\.message !== message/);

  assert.match(source, /github\.rest\.actions\.listWorkflowRuns/);
  assert.match(source, /workflow_id:\s*'release\.yml'/);
  assert.match(source, /run\.head_branch === tag/);
  assert.match(source, /github\.rest\.actions\.createWorkflowDispatch/);
  assert.match(source, /ref:\s*tag/);
  assert.match(source, /concurrency:\s*\n\s+group:/);
  assert.match(source, /cancel-in-progress:\s*false/);
});

test('release tag script enforces no-op, monotonic version, tag identity, and single dispatch paths', async () => {
  const source = readGithubScript('.github/workflows/release-tag.yml');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('github', 'context', 'core', source);
  const mergeSha = 'a'.repeat(40);
  const baseSha = '1'.repeat(40);
  const context = {
    repo: { owner: 'sdsrss', repo: 'agentsmd' },
    payload: {
      pull_request: {
        number: 42,
        merged: true,
        base: { ref: 'main', sha: baseSha },
        merge_commit_sha: mergeSha,
      },
    },
  };

  function packageFile(version) {
    return {
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from(JSON.stringify({ version })).toString('base64'),
      },
    };
  }

  function harness({
    baseVersion = '5.1.1',
    mergedVersion = '5.2.0',
    changedFiles = [{ filename: 'package.json' }],
    existingRef = null,
    existingTag = null,
    priorRuns = [],
  } = {}) {
    const calls = {
      createTag: [],
      createRef: [],
      dispatch: [],
      notices: [],
    };
    let ref = existingRef;
    const github = {
      paginate: async () => changedFiles,
      rest: {
        pulls: {
          listFiles: async () => {
            throw new Error('listFiles must be called through github.paginate');
          },
        },
        repos: {
          getContent: async ({ ref: requestedRef }) =>
            packageFile(requestedRef === baseSha ? baseVersion : mergedVersion),
        },
        git: {
          getRef: async () => {
            if (!ref) throw Object.assign(new Error('not found'), { status: 404 });
            return { data: ref };
          },
          getTag: async () => ({ data: existingTag || {
            tag: `v${mergedVersion}`,
            message: `agentsmd v${mergedVersion}`,
            object: { type: 'commit', sha: mergeSha },
          } }),
          createTag: async (input) => {
            calls.createTag.push(input);
            return { data: { sha: 'b'.repeat(40) } };
          },
          createRef: async (input) => {
            calls.createRef.push(input);
            ref = { object: { type: 'tag', sha: input.sha } };
            return { data: ref };
          },
        },
        actions: {
          listWorkflowRuns: async () => ({ data: { workflow_runs: priorRuns } }),
          createWorkflowDispatch: async (input) => {
            calls.dispatch.push(input);
          },
        },
      },
    };
    const core = {
      notice: (message) => calls.notices.push(message),
    };
    return { github, core, calls };
  }

  {
    const { github, core, calls } = harness({ changedFiles: [] });
    await execute(github, context, core);
    assert.strictEqual(calls.createTag.length, 0);
    assert.strictEqual(calls.createRef.length, 0);
    assert.strictEqual(calls.dispatch.length, 0);
    assert(calls.notices.some((message) => /did not change package\.json/.test(message)));
  }

  {
    const { github, core, calls } = harness({ mergedVersion: '5.1.1' });
    await execute(github, context, core);
    assert.strictEqual(calls.createTag.length, 0);
    assert.strictEqual(calls.createRef.length, 0);
    assert.strictEqual(calls.dispatch.length, 0);
    assert(calls.notices.some((message) => /version unchanged/.test(message)));
  }

  {
    const { github, core, calls } = harness();
    await execute(github, context, core);
    assert.strictEqual(calls.createTag.length, 1);
    assert.deepStrictEqual(
      {
        tag: calls.createTag[0].tag,
        message: calls.createTag[0].message,
        object: calls.createTag[0].object,
        type: calls.createTag[0].type,
      },
      {
        tag: 'v5.2.0',
        message: 'agentsmd v5.2.0',
        object: mergeSha,
        type: 'commit',
      },
    );
    assert.strictEqual(calls.createRef.length, 1);
    assert.strictEqual(calls.createRef[0].ref, 'refs/tags/v5.2.0');
    assert.strictEqual(calls.dispatch.length, 1);
    assert.strictEqual(calls.dispatch[0].workflow_id, 'release.yml');
    assert.strictEqual(calls.dispatch[0].ref, 'v5.2.0');
  }

  for (const mergedVersion of ['5.0.9', '5.2.0-rc.1', '5.2.0+build.1']) {
    const { github, core, calls } = harness({ mergedVersion });
    await assert.rejects(() => execute(github, context, core));
    assert.strictEqual(calls.createTag.length, 0);
    assert.strictEqual(calls.createRef.length, 0);
    assert.strictEqual(calls.dispatch.length, 0);
  }

  {
    const { github, core, calls } = harness({
      existingRef: { object: { type: 'commit', sha: mergeSha } },
    });
    await assert.rejects(
      () => execute(github, context, core),
      /exists but is not an annotated tag/,
    );
    assert.strictEqual(calls.createTag.length, 0);
    assert.strictEqual(calls.dispatch.length, 0);
  }

  {
    const { github, core, calls } = harness({
      existingRef: { object: { type: 'tag', sha: 'b'.repeat(40) } },
      priorRuns: [{
        id: 123,
        head_branch: 'v5.2.0',
        head_sha: mergeSha,
      }],
    });
    await execute(github, context, core);
    assert.strictEqual(calls.createTag.length, 0);
    assert.strictEqual(calls.createRef.length, 0);
    assert.strictEqual(calls.dispatch.length, 0);
    assert(calls.notices.some((message) => /already has run 123/.test(message)));
  }
});

run();
