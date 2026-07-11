'use strict';

// Conservatively extract calls made by the JavaScript passed to functions.exec.
// Markers inside strings, templates, and comments are data, not executed calls.

function readQuoted(source, start) {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let i = start + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch !== '\\') { value += ch; continue; }
    i += 1;
    if (i >= source.length) return null;
    const esc = source[i];
    const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
    if (Object.prototype.hasOwnProperty.call(simple, esc)) value += simple[esc];
    else if (esc === 'x' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) {
      value += String.fromCharCode(parseInt(source.slice(i + 1, i + 3), 16)); i += 2;
    } else if (esc === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(i + 1, i + 5))) {
      value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4;
    } else if (esc !== '\n' && esc !== '\r') value += esc;
  }
  return null;
}

function skipTrivia(source, at) {
  let i = at;
  for (;;) {
    while (/\s/.test(source[i] || '')) i += 1;
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue;
    }
    return i;
  }
}

function readBalancedCall(source, open) {
  let depth = 1;
  for (let i = open + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'") { const q = readQuoted(source, i); if (!q) return null; i = q.end - 1; continue; }
    if (ch === '`') {
      // Dynamic templates are deliberately unsupported: accepting them would
      // guess at executed bytes. Skip the complete literal conservatively.
      for (i += 1; i < source.length; i += 1) {
        if (source[i] === '\\') { i += 1; continue; }
        if (source[i] === '`') break;
      }
      continue;
    }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); if (end < 0) return null; i = end + 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { body: source.slice(open + 1, i), end: i + 1 };
  }
  return null;
}

function commandFromObject(body) {
  let i = skipTrivia(body, 0);
  if (body[i] !== '{') return null;
  i += 1;
  let depth = 1;
  while (i < body.length && depth > 0) {
    i = skipTrivia(body, i);
    const ch = body[i];
    if (ch === '}' && depth === 1) return null;
    if (ch === '{' || ch === '[' || ch === '(') { depth += 1; i += 1; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth -= 1; i += 1; continue; }
    if (depth !== 1) { i += 1; continue; }
    let key = null;
    if (ch === '"' || ch === "'") {
      const q = readQuoted(body, i); if (!q) return null; key = q.value; i = q.end;
    } else {
      const match = body.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/);
      if (!match) { i += 1; continue; }
      key = match[0]; i += key.length;
    }
    i = skipTrivia(body, i);
    if (body[i] !== ':') { i += 1; continue; }
    i = skipTrivia(body, i + 1);
    if (key === 'cmd' || key === 'command') {
      const value = readQuoted(body, i);
      return value ? value.value : null;
    }
    // Skip this field to its top-level comma; quoted data cannot create keys.
    while (i < body.length) {
      if (body[i] === '"' || body[i] === "'") { const q = readQuoted(body, i); if (!q) return null; i = q.end; continue; }
      if (body.startsWith('//', i) || body.startsWith('/*', i)) { i = skipTrivia(body, i); continue; }
      if (body[i] === '{' || body[i] === '[' || body[i] === '(') depth += 1;
      else if (body[i] === '}' || body[i] === ']' || body[i] === ')') depth -= 1;
      else if (body[i] === ',' && depth === 1) { i += 1; break; }
      i += 1;
    }
  }
  return null;
}

function extractOrchestratorActions(source) {
  if (typeof source !== 'string') return [];
  const actions = [];
  const markers = [
    ['tools.apply_patch', 'apply_patch'],
    ['tools.exec_command', 'exec_command'],
  ];
  for (let i = 0; i < source.length;) {
    if (source[i] === '"' || source[i] === "'") { const q = readQuoted(source, i); i = q ? q.end : source.length; continue; }
    if (source[i] === '`') {
      for (i += 1; i < source.length; i += 1) { if (source[i] === '\\') i += 1; else if (source[i] === '`') { i += 1; break; } }
      continue;
    }
    if (source.startsWith('//', i) || source.startsWith('/*', i)) { i = skipTrivia(source, i); continue; }
    const found = markers.find(([marker]) => source.startsWith(marker, i));
    if (!found) { i += 1; continue; }
    const [marker, name] = found;
    let open = skipTrivia(source, i + marker.length);
    if (source[open] !== '(') { i += marker.length; continue; }
    const call = readBalancedCall(source, open);
    if (!call) break;
    actions.push(name === 'apply_patch'
      ? { name }
      : { name, command: commandFromObject(call.body) });
    i = call.end;
  }
  return actions;
}

module.exports = { extractOrchestratorActions };
