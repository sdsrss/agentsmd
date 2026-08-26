#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');
const { parseSemver } = require('./lib/surface-arbitration');

const SUPPORTED_HEADING = '## Supported versions';
const POLICY_RE = /^Only the \*\*latest published minor of the (0|[1-9][0-9]*)[.]x line\*\* receives security fixes(?:[ .(]|$)/;

function readRegularFile(file, missingCode, unsafeCode, offenders) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      offenders.push({ code: missingCode, file: path.basename(file), detail: 'file is missing' });
      return null;
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    offenders.push({ code: unsafeCode, file: path.basename(file), detail: 'expected a regular non-symlink file' });
    return null;
  }
  return fs.readFileSync(file, 'utf8');
}

function supportedSection(lines, offenders) {
  const headings = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === SUPPORTED_HEADING) headings.push(i);
  }
  if (headings.length !== 1) {
    offenders.push({
      code: 'supported-section-count',
      file: 'SECURITY.md',
      detail: `expected exactly one '${SUPPORTED_HEADING}' heading; found ${headings.length}`,
    });
    return null;
  }
  const start = headings[0] + 1;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##[ \t]+\S/.test(lines[i])) { end = i; break; }
  }
  return { start, lines: lines.slice(start, end) };
}

function runSecurityPolicyCheck({ root = path.resolve(__dirname, '..') } = {}) {
  const offenders = [];
  const packageFile = path.join(root, 'package.json');
  const securityFile = path.join(root, 'SECURITY.md');
  const packageText = readRegularFile(packageFile, 'package-file-missing', 'package-file-unsafe', offenders);
  let packageVersion = null;
  let expectedMajor = null;
  if (packageText !== null) {
    let pkg;
    try { pkg = JSON.parse(packageText); }
    catch (error) {
      offenders.push({ code: 'package-json-invalid', file: 'package.json', detail: error.message });
    }
    if (pkg) {
      packageVersion = typeof pkg.version === 'string' ? pkg.version : null;
      const parsed = parseSemver(packageVersion);
      if (!parsed) {
        offenders.push({ code: 'package-version-invalid', file: 'package.json', detail: `invalid SemVer: ${String(packageVersion)}` });
      } else {
        expectedMajor = parsed.major;
      }
    }
  }

  const securityText = readRegularFile(securityFile, 'security-file-missing', 'security-file-unsafe', offenders);
  let declaredMajor = null;
  let policyLine = null;
  let policyLineNumber = null;
  if (securityText !== null) {
    const lines = securityText.split('\n');
    const section = supportedSection(lines, offenders);
    if (section) {
      const claims = [];
      for (let i = 0; i < section.lines.length; i += 1) {
        if (section.lines[i].includes('receives security fixes')) {
          claims.push({ text: section.lines[i].trim(), line: section.start + i + 1 });
        }
      }
      if (claims.length !== 1) {
        offenders.push({
          code: 'support-policy-shape',
          file: 'SECURITY.md',
          detail: `expected exactly one support claim in '${SUPPORTED_HEADING}'; found ${claims.length}`,
        });
      } else {
        policyLine = claims[0].text;
        policyLineNumber = claims[0].line;
        const match = policyLine.match(POLICY_RE);
        if (!match) {
          offenders.push({
            code: 'support-policy-shape',
            file: 'SECURITY.md',
            line: policyLineNumber,
            detail: 'support claim must name the latest published minor of one explicit major line',
          });
        } else {
          declaredMajor = match[1];
        }
      }
    }
  }

  if (expectedMajor !== null && declaredMajor !== null && expectedMajor !== declaredMajor) {
    offenders.push({
      code: 'support-major-mismatch',
      file: 'SECURITY.md',
      line: policyLineNumber,
      detail: `package ${packageVersion} requires ${expectedMajor}.x support text; found ${declaredMajor}.x`,
    });
  }

  return {
    ok: offenders.length === 0,
    packageVersion,
    expectedMajor,
    declaredMajor,
    policyLine,
    offenders,
  };
}

function formatReport(result) {
  const lines = [
    `security-policy — package ${result.packageVersion || '(unknown)'}; expected ${result.expectedMajor || '?'}.x; declared ${result.declaredMajor || '?'}.x`,
  ];
  if (result.ok) lines.push('ok — SECURITY.md support policy matches the package major.');
  else {
    lines.push(`${result.offenders.length} support-policy violation(s):`);
    for (const entry of result.offenders) {
      lines.push(`  ${entry.file}${entry.line ? `:${entry.line}` : ''} [${entry.code}] ${entry.detail}`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  const usage = 'Usage: agentsmd-security-policy [--json]';
  printHelpAndExit(argv, usage);
  let options;
  try { options = parseStrict(argv, { bools: ['json'] }); }
  catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    console.error(`agentsmd security-policy: ${error.message}\n${usage}`);
    return 2;
  }
  const result = runSecurityPolicyCheck();
  console.log(options.bools.has('json') ? JSON.stringify(result, null, 2) : formatReport(result));
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { POLICY_RE, SUPPORTED_HEADING, formatReport, main, runSecurityPolicyCheck };
