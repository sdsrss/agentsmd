#!/usr/bin/env node
'use strict';

const { ArgvError, parsePositiveInt, parseStrict } = require('./lib/argv');
const { packRegistryArtifact } = require('./lib/registry-pack-retry');

function usage() {
  return 'Usage: node scripts/release-registry-pack.js --package=<name@version> --destination=<dir> --attempts=<n> --delay-ms=<n>';
}

async function main(argv) {
  try {
    const parsed = parseStrict(argv, {
      values: ['package', 'destination', 'attempts', 'delay-ms'],
    });
    const packageSpec = parsed.values.package;
    const destination = parsed.values.destination;
    const attempts = parsePositiveInt(parsed.values.attempts);
    const delayMs = parsePositiveInt(parsed.values['delay-ms']);
    if (!packageSpec) throw new ArgvError('--package is required');
    if (!destination) throw new ArgvError('--destination is required');
    if (attempts === null) throw new ArgvError('--attempts must be a positive integer');
    if (delayMs === null) throw new ArgvError('--delay-ms must be a positive integer');
    await packRegistryArtifact({ packageSpec, destination, attempts, delayMs });
  } catch (error) {
    process.stderr.write(`agentsmd: ${error.message}\n`);
    if (error instanceof ArgvError) {
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status;
  });
}

module.exports = { main, usage };
