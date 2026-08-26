#!/usr/bin/env node
'use strict';

// Observation-first inventory for ignored local QA evidence. This command can
// write one generated index, but it never deletes or rewrites capture payloads.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');
const F = require('./lib/fs-atomic');
const { platformCanonicalPath } = require('./lib/paths');

const ROOT = path.resolve(__dirname, '..');
const CAPTURE_ROOT = path.join(ROOT, 'docs', 'qa-captures');
const CONTROL_NAMES = Object.freeze(new Set(['index.json', 'RETENTION.md']));
const METADATA_NAMES = Object.freeze(new Set(['result.json', 'results.json', 'progress.json']));
const REVIEW_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMITS = Object.freeze({
  maxUnits: 512,
  maxEntries: 10000,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxMetadataBytes: 1024 * 1024,
  maxMetadataFilesPerUnit: 64,
  maxDepth: 12,
  maxPathChars: 4096,
  maxOutputBytes: 4 * 1024 * 1024,
});
const USAGE = [
  'Usage: node scripts/capture-inventory.js [--json] [--write]',
  '',
  'Inventory bounded local evidence below docs/qa-captures.',
  '--write atomically refreshes only docs/qa-captures/index.json.',
  'The command never deletes or rewrites capture payloads.',
].join('\n');

function sortStrings(values) {
  return values.sort();
}

function parseArgs(argv) {
  const parsed = parseStrict(argv, { bools: ['json', 'write'], values: [] });
  return { json: parsed.bools.has('json'), write: parsed.bools.has('write') };
}

function modeString(mode) {
  return (mode & 0o777).toString(8).padStart(4, '0');
}

function isWideMode(stat) {
  return (stat.mode & 0o077) !== 0;
}

function normalizeLimits(overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`capture limit ${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function repoRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function strictTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  let normalized = value;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/u.exec(value);
  if (compact) {
    normalized = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}.${compact[7] || '000'}Z`;
  } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.]\d{3})?Z$/u.test(value)) {
    return null;
  }
  const time = Date.parse(normalized);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  const exact = date.toISOString();
  if (compact) return exact;
  if (value.includes('.')) return exact === value ? exact : null;
  return exact === value.replace(/Z$/u, '.000Z') ? exact : null;
}

function timestampFromPath(relative) {
  const match = /(\d{8}T\d{6}(?:\d{3})?Z)(?:$|\/)/u.exec(relative);
  return match ? strictTimestamp(match[1]) : null;
}

function classifyUnitPath(relative) {
  if (/^release-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?(?:-|$)/u.test(relative)) {
    return 'release-evidence';
  }
  if (/^phase-[0-9A-Za-z][0-9A-Za-z.-]*(?:-|$)/u.test(relative)) return 'phase-evidence';
  if (/^core-ab\/core-ab-\d{8}T\d{9}Z$/u.test(relative)) return 'core-ab-experiment';
  if (/^conformance-\d{8}T\d{6}Z$/u.test(relative)) return 'conformance-experiment';
  if (/^runtime-canary-(?:pinned|latest)-\d{8}T\d{6}Z$/u.test(relative)) return 'runtime-canary';
  if (/^event-journal-runtime-(?:[0-9A-Za-z-]+-)?\d{8}T\d{6}Z$/u.test(relative)) return 'event-journal-canary';
  return 'unknown';
}

function retentionFor(classification, capturedAt, now) {
  const permanentHold = new Set(['release-evidence', 'phase-evidence', 'unknown']);
  if (permanentHold.has(classification)) {
    return {
      policy: 'hold',
      review_after_days: null,
      review_due: false,
      deletion_eligible: false,
      reason: 'release, phase, or unknown evidence requires a reviewed archive/replacement binding; age grants no deletion authority',
    };
  }
  let reviewDue = false;
  if (capturedAt) {
    const captured = Date.parse(capturedAt);
    reviewDue = Number.isFinite(captured) && captured <= now.getTime()
      && Math.floor((now.getTime() - captured) / DAY_MS) >= REVIEW_AFTER_DAYS;
  }
  return {
    policy: 'review',
    review_after_days: REVIEW_AFTER_DAYS,
    review_due: reviewDue,
    deletion_eligible: false,
    reason: '90 days triggers human review only; deletion still requires exact ownership, archive digest, and replacement evidence',
  };
}

function validateRoot(root) {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  const canonical = platformCanonicalPath(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== canonical) {
    throw new Error('capture root must be a canonical non-symlink directory');
  }
  return { resolved, stat };
}

function discoverUnits(root, limits) {
  const entries = sortStrings(fs.readdirSync(root));
  if (entries.length > limits.maxUnits) throw new Error(`capture unit limit exceeds ${limits.maxUnits}`);
  const units = [];
  for (const name of entries) {
    if (CONTROL_NAMES.has(name)) continue;
    const absolute = path.join(root, name);
    const stat = fs.lstatSync(absolute);
    if (name === 'core-ab' && stat.isDirectory() && !stat.isSymbolicLink()) {
      const children = sortStrings(fs.readdirSync(absolute));
      for (const child of children) {
        if (CONTROL_NAMES.has(child)) continue;
        units.push({ absolute: path.join(absolute, child), relative: `core-ab/${child}` });
      }
    } else {
      units.push({ absolute, relative: name });
    }
  }
  if (units.length > limits.maxUnits) throw new Error(`capture unit limit exceeds ${limits.maxUnits}`);
  return units;
}

function metadataTimestamp(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return { status: 'invalid', timestamp: null }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid', timestamp: null };
  }
  const candidates = [
    value.captured_at,
    value.started_at,
    value.meta && value.meta.stamp,
  ].filter((entry) => entry !== undefined && entry !== null);
  if (candidates.length === 0) return { status: 'absent', timestamp: null };
  for (const candidate of candidates) {
    const parsed = strictTimestamp(candidate);
    if (parsed) return { status: 'valid', timestamp: parsed };
  }
  return { status: 'invalid', timestamp: null };
}

function readStableFile(file, before, relative) {
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  const unchanged = after.isFile()
    && !after.isSymbolicLink()
    && after.dev === before.dev
    && after.ino === before.ino
    && after.size === before.size
    && after.mtimeMs === before.mtimeMs
    && (after.mode & 0o777) === (before.mode & 0o777)
    && bytes.length === before.size;
  if (!unchanged) throw new Error(`${relative}: changed during capture inventory`);
  return bytes;
}

function inventoryUnit(captureRoot, descriptor, state, options) {
  const { limits, now } = options;
  const hash = crypto.createHash('sha256');
  const unit = {
    path: descriptor.relative,
    classification: classifyUnitPath(descriptor.relative),
    captured_at: null,
    age_days: null,
    metadata_status: 'absent',
    files: 0,
    directories: 0,
    total_bytes: 0,
    symlinks: 0,
    special_files: 0,
    wide_mode_entries: 0,
    max_depth: 0,
    integrity_complete: true,
    sha256: null,
    retention: null,
  };
  const timestamps = [];
  let invalidMetadata = 0;
  let metadataFiles = 0;
  const pending = [{ absolute: descriptor.absolute, relative: '.', depth: 0 }];

  while (pending.length) {
    const current = pending.pop();
    state.entries += 1;
    if (state.entries > limits.maxEntries) throw new Error(`capture entry limit exceeds ${limits.maxEntries}`);
    const fromRoot = repoRelative(captureRoot, current.absolute);
    if (!fromRoot || fromRoot.length > limits.maxPathChars) {
      throw new Error(`capture path exceeds ${limits.maxPathChars} characters`);
    }
    if (current.depth > limits.maxDepth) throw new Error(`${fromRoot}: depth exceeds ${limits.maxDepth}`);
    unit.max_depth = Math.max(unit.max_depth, current.depth);
    const stat = fs.lstatSync(current.absolute);
    if (isWideMode(stat)) unit.wide_mode_entries += 1;

    if (stat.isSymbolicLink()) {
      unit.symlinks += 1;
      unit.integrity_complete = false;
      hash.update(`L\0${current.relative}\0`);
      continue;
    }
    if (stat.isDirectory()) {
      unit.directories += 1;
      hash.update(`D\0${current.relative}\0`);
      const children = sortStrings(fs.readdirSync(current.absolute));
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        pending.push({
          absolute: path.join(current.absolute, child),
          relative: current.relative === '.' ? child : `${current.relative}/${child}`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (!stat.isFile()) {
      unit.special_files += 1;
      unit.integrity_complete = false;
      hash.update(`S\0${current.relative}\0`);
      continue;
    }

    if (stat.size > limits.maxFileBytes) throw new Error(`${fromRoot}: file exceeds ${limits.maxFileBytes} bytes`);
    state.totalBytes += stat.size;
    if (state.totalBytes > limits.maxTotalBytes) throw new Error(`capture byte limit exceeds ${limits.maxTotalBytes}`);
    unit.files += 1;
    unit.total_bytes += stat.size;
    const bytes = readStableFile(current.absolute, stat, fromRoot);
    hash.update(`F\0${current.relative}\0${stat.size}\0`);
    hash.update(bytes);
    hash.update('\0');

    if (METADATA_NAMES.has(path.basename(current.absolute))) {
      metadataFiles += 1;
      if (metadataFiles > limits.maxMetadataFilesPerUnit) {
        throw new Error(`${descriptor.relative}: metadata file limit exceeds ${limits.maxMetadataFilesPerUnit}`);
      }
      if (stat.size > limits.maxMetadataBytes) {
        invalidMetadata += 1;
      } else {
        const metadata = metadataTimestamp(bytes);
        if (metadata.timestamp) timestamps.push(metadata.timestamp);
        else if (metadata.status === 'invalid') invalidMetadata += 1;
      }
    }
  }

  const pathTimestamp = timestampFromPath(descriptor.relative);
  if (timestamps.length > 0) {
    timestamps.sort((left, right) => Date.parse(left) - Date.parse(right));
    unit.captured_at = timestamps[timestamps.length - 1];
    unit.metadata_status = invalidMetadata > 0 ? 'partial' : 'valid';
  } else if (pathTimestamp) {
    unit.captured_at = pathTimestamp;
    unit.metadata_status = invalidMetadata > 0 ? 'partial' : 'path-derived';
  } else if (invalidMetadata > 0) {
    unit.metadata_status = 'invalid';
  }
  if (unit.captured_at) {
    const capturedMs = Date.parse(unit.captured_at);
    if (capturedMs > now.getTime()) {
      unit.metadata_status = 'future';
    } else {
      unit.age_days = Math.floor((now.getTime() - capturedMs) / DAY_MS);
    }
  }
  unit.sha256 = hash.digest('hex');
  unit.retention = retentionFor(unit.classification, unit.captured_at, now);
  return unit;
}

function inventoryCaptures(root = CAPTURE_ROOT, options = {}) {
  const { resolved, stat: rootStat } = validateRoot(root);
  const limits = normalizeLimits(options.limits);
  const nowInput = options.now === undefined ? Date.now() : options.now;
  const now = nowInput instanceof Date ? new Date(nowInput.getTime()) : new Date(nowInput);
  if (!Number.isFinite(now.getTime())) throw new Error('inventory now must be a valid date');
  const state = { entries: 0, totalBytes: 0 };
  const descriptors = discoverUnits(resolved, limits);
  const units = descriptors.map((descriptor) => inventoryUnit(resolved, descriptor, state, { limits, now }));
  const classes = {};
  for (const unit of units) classes[unit.classification] = (classes[unit.classification] || 0) + 1;
  const summary = {
    units: units.length,
    files: units.reduce((sum, unit) => sum + unit.files, 0),
    directories: units.reduce((sum, unit) => sum + unit.directories, 0),
    total_bytes: units.reduce((sum, unit) => sum + unit.total_bytes, 0),
    symlinks: units.reduce((sum, unit) => sum + unit.symlinks, 0),
    special_files: units.reduce((sum, unit) => sum + unit.special_files, 0),
    wide_mode_entries: units.reduce((sum, unit) => sum + unit.wide_mode_entries, 0),
    review_due: units.filter((unit) => unit.retention.review_due).length,
    deletion_eligible: units.filter((unit) => unit.retention.deletion_eligible).length,
    classes,
  };
  const rootWide = isWideMode(rootStat);
  const warnings = [];
  if (rootWide || summary.wide_mode_entries > 0) {
    warnings.push('capture permission bits allow group/other access; storage privacy is degraded or not enforceable on this filesystem');
  }
  if (summary.symlinks > 0) warnings.push('symlink entries were not followed; affected unit hashes are incomplete');
  if (summary.special_files > 0) warnings.push('special files were not read; affected unit hashes are incomplete');
  if (units.some((unit) => ['invalid', 'partial', 'future'].includes(unit.metadata_status))) {
    warnings.push('one or more units have invalid, partial, or future metadata; age cannot grant cleanup eligibility');
  }
  const report = {
    schema_version: 1,
    generated_at: now.toISOString(),
    root: 'docs/qa-captures',
    ok: summary.symlinks === 0 && summary.special_files === 0,
    summary,
    privacy: {
      state: rootWide || summary.wide_mode_entries > 0 ? 'degraded' : 'restricted-by-mode',
      root_mode: modeString(rootStat.mode),
      root_wide_mode: rootWide,
      wide_mode_entries: summary.wide_mode_entries,
      boundary: 'permission bits are observed, not repaired; filesystem and mount policy remain external evidence',
    },
    units,
    warnings,
    limits: {
      max_units: limits.maxUnits,
      max_entries: limits.maxEntries,
      max_total_bytes: limits.maxTotalBytes,
      max_file_bytes: limits.maxFileBytes,
      max_metadata_bytes: limits.maxMetadataBytes,
      max_metadata_files_per_unit: limits.maxMetadataFilesPerUnit,
      max_depth: limits.maxDepth,
      max_path_chars: limits.maxPathChars,
      max_output_bytes: limits.maxOutputBytes,
    },
    measurement_boundary: 'local ignored capture inventory only; no payload deletion, archive verification, model call, or release proof is performed',
  };
  const outputBytes = Buffer.byteLength(`${JSON.stringify(report)}\n`);
  if (outputBytes > limits.maxOutputBytes) throw new Error(`capture index output exceeds ${limits.maxOutputBytes} bytes`);
  return report;
}

function writeIndex(root = CAPTURE_ROOT, options = {}) {
  const nowInput = options.now === undefined ? new Date() : options.now;
  const stableOptions = { ...options, now: nowInput };
  const report = inventoryCaptures(root, stableOptions);
  const confirmation = inventoryCaptures(root, stableOptions);
  if (JSON.stringify(confirmation) !== JSON.stringify(report)) {
    throw new Error('capture tree changed during index generation');
  }
  const destination = path.join(path.resolve(root), 'index.json');
  F.assertNotSymbolicLink(destination);
  const before = F.snapshotFile(destination);
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const limits = normalizeLimits(options.limits);
  if (Buffer.byteLength(content) > limits.maxOutputBytes) {
    throw new Error(`capture index output exceeds ${limits.maxOutputBytes} bytes`);
  }
  F.writeFileAtomic(destination, content, { mode: 0o600, preserveMode: false, expectedSnapshot: before });
  return report;
}

function renderHuman(report, wrote = false) {
  return [
    `QA capture inventory: ${report.ok ? 'COMPLETE' : 'INCOMPLETE'}`,
    `units: ${report.summary.units}`,
    `files: ${report.summary.files}`,
    `bytes: ${report.summary.total_bytes}`,
    `review due: ${report.summary.review_due}`,
    `deletion eligible: ${report.summary.deletion_eligible}`,
    `privacy: ${report.privacy.state} (root mode ${report.privacy.root_mode})`,
    `warnings: ${report.warnings.length}`,
    `index: ${wrote ? 'docs/qa-captures/index.json refreshed' : 'not written (use --write)'}`,
    `boundary: ${report.measurement_boundary}`,
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  printHelpAndExit(argv, USAGE);
  let options;
  try { options = parseArgs(argv); }
  catch (error) {
    if (!(error instanceof ArgvError)) throw error;
    console.error(`agentsmd capture inventory: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
  try {
    const report = options.write ? writeIndex(CAPTURE_ROOT) : inventoryCaptures(CAPTURE_ROOT);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderHuman(report, options.write));
    return report.ok ? 0 : 1;
  } catch (error) {
    console.error(`agentsmd capture inventory failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());

module.exports = {
  CAPTURE_ROOT,
  CONTROL_NAMES,
  DEFAULT_LIMITS,
  REVIEW_AFTER_DAYS,
  USAGE,
  classifyUnitPath,
  inventoryCaptures,
  main,
  parseArgs,
  renderHuman,
  retentionFor,
  strictTimestamp,
  writeIndex,
};
