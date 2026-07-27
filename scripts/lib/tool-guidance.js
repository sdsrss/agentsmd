'use strict';

const fs = require('fs');

function parseOsRelease(source) {
  const values = {};
  for (const line of String(source || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value.toLowerCase();
  }
  return values;
}

function readOsRelease() {
  try { return fs.readFileSync('/etc/os-release', 'utf8'); }
  catch { return ''; }
}

function platformFamily(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform !== 'linux') return 'unknown';

  const release = parseOsRelease(
    Object.prototype.hasOwnProperty.call(options, 'osRelease')
      ? options.osRelease
      : readOsRelease()
  );
  const identity = `${release.ID || ''} ${release.ID_LIKE || ''}`;
  if (/\b(ubuntu|debian|linuxmint|pop)\b/.test(identity)) return 'apt';
  if (/\b(fedora|rhel|centos|rocky|almalinux)\b/.test(identity)) return 'dnf';
  if (/\b(arch|manjaro)\b/.test(identity)) return 'pacman';
  if (/\b(alpine)\b/.test(identity)) return 'apk';
  return 'unknown';
}

function manualInstallCommand(tool, options = {}) {
  const family = options.family || platformFamily(options);
  const packages = {
    jq: 'jq',
    node: 'nodejs',
    shellcheck: 'shellcheck',
    git: 'git',
    gh: 'gh',
  };
  const labels = {
    jq: 'jq',
    node: 'Node.js 18 or newer',
    shellcheck: 'ShellCheck',
    git: 'Git',
    gh: 'GitHub CLI',
  };
  const packageName = packages[tool] || tool;

  if (family === 'macos') return `brew install ${tool === 'node' ? 'node' : packageName}`;
  if (family === 'apt') return `sudo apt-get update && sudo apt-get install -y ${packageName}`;
  if (family === 'dnf') return `sudo dnf install -y ${packageName}`;
  if (family === 'pacman') return `sudo pacman -S --needed ${packageName}`;
  if (family === 'apk') return `sudo apk add ${packageName}`;
  return `install ${labels[tool] || tool} with your OS package manager and ensure it is on PATH`;
}

module.exports = { manualInstallCommand, parseOsRelease, platformFamily };
