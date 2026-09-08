#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseStrict, printHelpAndExit } = require('./lib/argv');
const { candidateIdentity } = require('./conformance-candidate');
const { regularBytes } = require('./lib/release-measurement');
const { MAX_PROOF_BYTES, validateDeclaration, validateReadiness, buildReadiness } = require('./lib/release-readiness');
const ROOT = path.resolve(__dirname, '..');
const USAGE = `Usage: node scripts/release-readiness.js --mode=declare --codex-version=VERSION --model=MODEL
  node scripts/release-readiness.js --mode=build --declaration=FILE --candidate=FILE --results=FILE,FILE --slo=FILE
  node scripts/release-readiness.js --mode=verify --proof=FILE
  node scripts/release-readiness.js --mode=verify --proof-env
  node scripts/release-readiness.js --mode=verify --proof-event
Outputs JSON only; never writes files, calls a model, publishes, or grants a waiver.
--proof-env reads only AGENTSMD_READINESS_JSON (maximum ${MAX_PROOF_BYTES} bytes).
--proof-event reads inputs.readiness_json from GitHub's bounded event JSON, never as script text.
Declaration/build require the clean candidate; verification permits an identical merged source tree.`;

function parseArgs(argv) {
  const parsed = parseStrict(argv, { bools: ['proof-env', 'proof-event'], values: ['mode', 'codex-version', 'model', 'declaration', 'candidate', 'results', 'slo', 'proof'] });
  const value = parsed.values;
  const allowed = {
    declare: ['mode', 'codex-version', 'model'],
    build: ['mode', 'declaration', 'candidate', 'results', 'slo'],
    verify: ['mode', ...(parsed.bools.size ? [] : ['proof'])],
  }[value.mode];
  if (!allowed || Object.keys(value).some((key) => !allowed.includes(key))
    || allowed.some((key) => !value[key] || value[key].length > 8192)
    || parsed.bools.size > 1 || (parsed.bools.size && value.mode !== 'verify')) throw new Error('invalid or incomplete mode arguments');
  if (value.mode === 'build' && value.results.split(',').length !== 2) throw new Error('build requires exactly two results paths');
  return { ...value, proofEnv: parsed.bools.has('proof-env'), proofEvent: parsed.bools.has('proof-event') };
}

function context(root = ROOT) {
  return { identity: candidateIdentity(root),
    casesBytes: regularBytes(path.join(root, 'qa/conformance/cases.json')),
    thresholdsBytes: regularBytes(path.join(root, 'qa/conformance/thresholds.json')),
    sloBytes: regularBytes(path.join(root, 'qa/perf/slo.json')) };
}

function main(argv, inspectContext = context) {
  printHelpAndExit(argv, USAGE);
  let options;
  try { options = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  try {
    // Reject missing/oversized workflow input before expensive source inspection.
    const proofText = options.mode === 'verify' ? (options.proofEvent
      ? JSON.parse(regularBytes(process.env.GITHUB_EVENT_PATH, 1024 * 1024)).inputs?.readiness_json || ''
      : options.proofEnv ? process.env.AGENTSMD_READINESS_JSON || '' : regularBytes(options.proof, MAX_PROOF_BYTES).toString('utf8')) : null;
    if (options.mode === 'verify' && (typeof proofText !== 'string' || !proofText || Buffer.byteLength(proofText) > MAX_PROOF_BYTES)) throw new Error('readiness proof missing or oversized');
    const current = inspectContext();
    let output;
    if (options.mode === 'declare') {
      output = { schema_version: 1, kind: 'agentsmd-release-declaration', declared_at: new Date().toISOString(),
        subject: current.identity, runtime: { codex_version: options['codex-version'], model: options.model, surface: 'standalone', profile: 'full' } };
      validateDeclaration(output, current.identity);
    } else if (options.mode === 'build') {
      output = buildReadiness({
        declaration: JSON.parse(regularBytes(options.declaration, MAX_PROOF_BYTES)),
        candidate: JSON.parse(regularBytes(options.candidate, MAX_PROOF_BYTES)),
        results: options.results.split(',').map((file) => regularBytes(file)),
        performance: JSON.parse(regularBytes(options.slo, 4 * 1024 * 1024)),
      }, current);
    } else {
      output = validateReadiness(JSON.parse(proofText), current);
      console.log(JSON.stringify(output));
      return output.ready ? 0 : 1;
    }
    console.log(JSON.stringify(output));
    return 0;
  } catch (error) {
    // Do not echo submitted JSON or arbitrary paths into a hosted log.
    console.error(`release-readiness: ${error instanceof SyntaxError ? 'invalid JSON input' : error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseArgs, main, context, USAGE };
