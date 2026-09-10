'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

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

test('Release fails closed on missing readiness before asset creation and registry publication', () => {
  const source = read('.github/workflows/release.yml');
  assert.match(source, /readiness_json:\s*\n\s+description:/);
  assert.match(source, /readiness:\s*\n\s+runs-on: ubuntu-latest/);
  assert.match(source, /readiness:[\s\S]*?permissions:\s*\n\s+contents: read/);
  assert.match(source, /node scripts\/release-readiness\.js --mode=verify --proof-event/);
  assert.match(source, /release-assets:\s*\n\s+needs: \[ci, readiness\]/);
  assert.match(source, /npm-publish:\s*\n\s+needs: release-assets/);
  assert.doesNotMatch(source, /\$\{\{\s*(?:inputs|github\.event\.inputs)\.readiness_json\s*\}\}/);
  const readinessJob = source.slice(source.indexOf('  readiness:'), source.indexOf('  release-assets:'));
  assert.doesNotMatch(readinessJob, /continue-on-error|if:\s*always|OPENAI_API_KEY|NPM_TOKEN|contents: write/);
});


// These source checks protect GitHub's documented default success-only needs
// semantics. They do not emulate the hosted scheduler or prove hosted latency.
function workflowJob(source, name) {
  const match = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, 'm'));
  assert(match, `missing workflow job ${name}`);
  return match[1];
}

function releaseShell(name) {
  const source = read('.github/workflows/release.yml');
  const start = source.indexOf(`      - name: ${name}\n`);
  assert(start >= 0, `missing release step ${name}`);
  const step = source.slice(start).split(/\n      - /)[0];
  const body = (step + '\n').match(/        run: \|\n((?:          [^\n]*\n|\n)*)/);
  assert(body, `missing shell for ${name}`);
  return body[1].replace(/^          /gm, '');
}

test('asset stage reuses strict CI/readiness gates and has no duplicate suite', () => {
  const release = read('.github/workflows/release.yml');
  const ci = read('.github/workflows/ci.yml');
  assert.match(workflowJob(release, 'ci'), /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(ci, /^  workflow_call:/m);
  for (const source of [release, ci]) {
    // Any conditional, softened failure, or redirected checkout needs review.
    assert.doesNotMatch(source, /^\s*(?:if|continue-on-error|repository):/m);
    const checkouts = [...source.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=      - |\n  [a-z]|$(?![\s\S]))/g)];
    assert.strictEqual(checkouts.length, 4);
    for (const [, checkout] of checkouts) {
      assert.match(checkout, /^        with:\n          ref: \$\{\{ github\.sha \}\}/m);
    }
  }
  assert.match(workflowJob(release, 'release-assets'), /^    needs: \[ci, readiness\]$/m);
  assert.match(workflowJob(release, 'npm-publish'), /^    needs: release-assets$/m);
  assert.match(workflowJob(release, 'plugin-marketplace-smoke'), /^    needs: npm-publish$/m);
  assert.doesNotMatch(workflowJob(release, 'release-assets'), /npm (?:test|run (?:check|test[:\w-]*))/);
  assert.match(workflowJob(ci, 'test'), /node-version: \[18, 20, 22, 24\]/);
  for (const job of ['test', 'macos-hooks']) {
    assert.match(workflowJob(ci, job), /- run: npm test\n/);
    assert.match(workflowJob(ci, job), /- run: npm run test:phase4\n/);
  }
  assert.match(workflowJob(ci, 'macos-hooks'), /runs-on: macos-latest/);
  assert.match(workflowJob(ci, 'shellcheck'), /run: shellcheck/);
  assert.match(workflowJob(ci, 'user-journey'), /run: bash qa\/user-journey\.sh/);
});

test('publication retains full prepublish checks, byte/signature/provenance and marketplace checks', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts.prepublishOnly, 'npm run check');
  assert.match(pkg.scripts.check, /npm test/);
  const source = read('.github/workflows/release.yml');
  const publish = workflowJob(source, 'npm-publish');
  assert.match(publish, /npm publish --provenance --access public/);
  assert.doesNotMatch(releaseShell('Publish with provenance (idempotent)'), /--ignore-scripts|NPM_CONFIG_IGNORE_SCRIPTS/i);
  for (const marker of ['REGISTRY_SHA', 'RELEASE_SHA', 'npm audit signatures',
    'resolvedDependencies', '.digest.gitCommit == $commit', '.digest.sha512 == $sha512']) {
    assert(publish.includes(marker), `missing ${marker}`);
  }
  assert.match(workflowJob(source, 'plugin-marketplace-smoke'), /bash qa\/plugin-marketplace-e2e\.sh/);
});

test('actual asset shell creates once, verifies reruns, and rejects broken existing assets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-release-shell-'));
  try {
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    fs.mkdirSync(bin); fs.mkdirSync(home);
    // macOS ships shasum; release runners ship sha256sum. Keep the real hash
    // verification available in both phase4 matrix platforms.
    const hashTool = spawnSync('sha256sum', ['--version'], { encoding: 'utf8' });
    if (hashTool.error && hashTool.error.code === 'ENOENT') {
      fs.writeFileSync(path.join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
    }
    // A local service double; all hashing and workflow control flow are real.
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/bash
set -euo pipefail
case "$1 $2" in
  'release view') test "$SCENARIO" != new ;;
  'release download')
    test "$SCENARIO" != download-failed || exit 1
    while [ "$1" != --dir ]; do shift; done
    destination="$2"
    cp "$ASSET" "$ASSET.sha256" "$destination/"
    if [ "$SCENARIO" = corrupt ]; then
      echo corrupted > "$destination/$ASSET"
    elif [ "$SCENARIO" = mismatch ]; then
      echo different > "$destination/$ASSET"
      (cd "$destination"; sha256sum "$ASSET" > "$ASSET.sha256")
    elif [ "$SCENARIO" = missing-checksum ]; then
      rm "$destination/$ASSET.sha256"
    fi
    ;;
  'release create') echo create >> "$CALL_LOG" ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const asset = 'agentsmd-1.2.3.tgz';
    fs.writeFileSync(path.join(root, asset), 'fixture archive bytes\n');
    const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(root, asset))).digest('hex');
    fs.writeFileSync(path.join(root, `${asset}.sha256`), `${sha}  ${asset}\n`);
    const log = path.join(root, 'calls');
    const env = { ...process.env, HOME: home, CODEX_HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, RUNNER_TEMP: root,
      ASSET: asset, CALL_LOG: log, GITHUB_REF_NAME: 'v1.2.3' };
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.NODE_AUTH_TOKEN;
    const execute = (script, extra = {}) => spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', script], {
      cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000,
    });
    const version = releaseShell('Assert tag matches package version');
    assert.strictEqual(execute(version).status, 0);
    assert.notStrictEqual(execute(version, { GITHUB_REF_NAME: 'v9.9.9' }).status, 0);
    const script = releaseShell('Create or verify release assets');
    for (const scenario of ['new', 'same', 'same', 'corrupt', 'mismatch', 'download-failed', 'missing-checksum']) {
      const result = execute(script, { SCENARIO: scenario });
      assert(!result.error, String(result.error));
      assert.strictEqual(result.status === 0, ['new', 'same'].includes(scenario), `${scenario}: ${result.stderr}`);
      assert.strictEqual(fs.readFileSync(log, 'utf8'), 'create\n', `${scenario}: unexpected mutation`);
      assert.strictEqual(fs.readFileSync(path.join(root, asset), 'utf8'), 'fixture archive bytes\n');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('merged version PR automation creates a verified annotated tag without proof-free publication dispatch', () => {
  const relative = '.github/workflows/release-tag.yml';
  assert(fs.existsSync(path.join(ROOT, relative)), `missing ${relative}`);
  const source = read(relative);

  assert.match(source, /^  pull_request_target:\s*$/m);
  assert.match(source, /^\s+types:\s*\[closed\]\s*$/m);
  assert.match(source, /^\s+branches:\s*\[main\]\s*$/m);
  assert.match(source, /github\.event\.pull_request\.merged == true/);
  assert.match(source, /permissions:\s*\n\s+contents:\s*write/);
  assert.doesNotMatch(source, /actions:\s*write/);
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

  assert.doesNotMatch(source, /github\.rest\.actions\.(listWorkflowRuns|createWorkflowDispatch)/);
  assert.match(source, /readiness_json/);
  assert.match(source, /concurrency:\s*\n\s+group:/);
  assert.match(source, /cancel-in-progress:\s*false/);
});

test('release tag script enforces no-op, monotonic version and tag identity without dispatching', async () => {
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
    assert.strictEqual(calls.dispatch.length, 0);
    assert(calls.notices.some((message) => /readiness_json/.test(message)));
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
    assert(calls.notices.some((message) => /readiness_json/.test(message)));
  }
});

run();
