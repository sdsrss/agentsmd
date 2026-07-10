'use strict';

// Skills use a deliberately small YAML subset: one scalar key/value per line.
// Keeping the parser strict makes routing metadata dependency-free while still
// rejecting YAML ambiguities such as an unquoted `: ` inside a description.
function parseSkillFrontmatter(source, label = 'SKILL.md') {
  const lines = String(source).split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`${label}: missing opening frontmatter delimiter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error(`${label}: missing closing frontmatter delimiter`);
  const out = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[ \t]+(.+)$/);
    if (!match) throw new Error(`${label}:${i + 1}: expected scalar key: value`);
    const [, key, raw] = match;
    if (Object.hasOwn(out, key)) throw new Error(`${label}:${i + 1}: duplicate ${key}`);
    let value;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); } catch { throw new Error(`${label}:${i + 1}: invalid quoted scalar`); }
    } else {
      if (/:\s|\s#/.test(raw)) throw new Error(`${label}:${i + 1}: ambiguous plain scalar must be quoted`);
      value = raw;
    }
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}:${i + 1}: empty scalar`);
    out[key] = value;
  }
  return out;
}

module.exports = { parseSkillFrontmatter };
