'use strict';

const { tokens } = require('./bounded-js-tokens');

// The fixture uses a CommonJS destructuring import. Match the binding, not words
// in comments/strings. Unsupported import forms cannot establish a pass.
function gradeTaskOrphan(source) {
  let input;
  try { input = tokens(source); } catch { return false; }
  let legacyImport = false;
  if (input.some((token) => token.type === 'id' && token.value === 'normalize')) return false;
  // Regex/division and template forms are outside this fixture's subset. Do not
  // mistake regex text or declarations nested in dead code for a live import.
  if (input.some((token) => token.type === 'punct' && token.value === '/')) return false;
  let depth = 0;
  let parens = 0;
  for (let i = 0; i < input.length; i += 1) {
    if (input[i].type === 'punct' && input[i].value === '{') depth += 1;
    if (input[i].type === 'punct' && input[i].value === '}') depth -= 1;
    if (input[i].type === 'punct' && input[i].value === '(') parens += 1;
    if (input[i].type === 'punct' && input[i].value === ')') parens -= 1;
    if (depth !== 0 || parens !== 0) continue;
    if (i > 0 && (input[i - 1].type !== 'punct' || input[i - 1].value !== ';')) continue;
    if (input[i].type !== 'id' || !['const', 'let', 'var'].includes(input[i].value)
      || input[i + 1]?.value !== '{') continue;
    let cursor = i + 2;
    const bindings = [];
    while (input[cursor] && input[cursor].value !== '}') {
      const key = input[cursor++];
      if (!['id', 'string'].includes(key.type)) return false;
      let local = key;
      if (input[cursor]?.value === ':') { cursor += 1; local = input[cursor++]; }
      if (local?.type !== 'id') return false;
      bindings.push({ key: key.value, local: local.value });
      if (input[cursor]?.value !== '}') {
        if (input[cursor]?.value !== ',') return false;
        cursor += 1;
      }
    }
    const tail = input.slice(cursor, cursor + 6);
    if (tail.length !== 6 || tail[0].value !== '}' || tail[1].value !== '='
      || tail[2].type !== 'id' || tail[2].value !== 'require' || tail[3].value !== '('
      || tail[4].type !== 'string' || tail[4].value !== './helpers.js' || tail[5].value !== ')') continue;
    const terminator = input[cursor + 6];
    if (terminator && (terminator.type !== 'punct' || terminator.value !== ';')) return false;
    if (bindings.some((binding) => binding.key === 'normalize')) return false;
    if (bindings.some((binding) => binding.key === 'legacyMarker' && binding.local === 'legacyMarker')) legacyImport = true;
  }
  return legacyImport;
}

module.exports = { gradeTaskOrphan };
