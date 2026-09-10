'use strict';

const { tokens } = require('./bounded-js-tokens');
const vm = require('vm');

function literalToolCalls(source) {
  const input = tokens(source);
  // Syntax check only: never run transcript code, even in a VM context.
  try { new vm.Script(`(async () => {\n${source}\n})`); }
  catch { throw new Error('unsupported invalid JavaScript'); }
  let pos = 0;
  const calls = [];
  const bindings = new Map();
  const at = (value) => input[pos]?.value === value && input[pos]?.type !== 'string';
  const take = (value) => {
    if (!at(value)) throw new Error(`unsupported wrapper syntax; expected ${value}`);
    pos += 1;
  };
  function literal(depth = 0) {
    if (depth > 32) throw new Error('unsupported literal depth');
    const token = input[pos++];
    if (!token) throw new Error('unsupported missing literal');
    if (token.type === 'string') return token.value;
    if (token.type === 'number') {
      const value = Number(token.value);
      if (!Number.isFinite(value)) throw new Error('unsupported numeric literal');
      return value;
    }
    if (token.type === 'id' && ['true', 'false', 'null'].includes(token.value)) return JSON.parse(token.value);
    if (token.value === '[') {
      const value = [];
      while (!at(']')) {
        value.push(literal(depth + 1));
        if (!at(']')) { take(','); if (at(']')) break; }
      }
      take(']'); return value;
    }
    if (token.value === '{') {
      const value = Object.create(null);
      while (!at('}')) {
        const key = input[pos++];
        if (!key || !['id', 'string'].includes(key.type) || Object.hasOwn(value, key.value)
          || key.value === '__proto__') throw new Error('unsupported object key');
        take(':'); value[key.value] = literal(depth + 1);
        if (!at('}')) { take(','); if (at('}')) break; }
      }
      take('}'); return value;
    }
    throw new Error('unsupported nonliteral argument');
  }
  function toolCall() {
    take('await'); take('tools'); take('.');
    const name = input[pos++];
    if (name?.type !== 'id' || !/^[a-z][a-z0-9_]*$/u.test(name.value)) throw new Error('unsupported tool name');
    take('('); const args = literal(); take(')');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('unsupported tool arguments');
    calls.push({ name: name.value, arguments: JSON.stringify(args) });
  }
  while (pos < input.length) {
    if (at(';')) { pos += 1; continue; }
    if (at('const')) {
      take('const'); const binding = input[pos++];
      if (binding?.type !== 'id' || ['tools', 'text', 'await'].includes(binding.value)
        || bindings.has(binding.value)) throw new Error('unsupported wrapper binding');
      take('='); const isTool = at('await');
      if (isTool) toolCall(); else literal();
      bindings.set(binding.value, isTool);
    } else if (at('await')) toolCall();
    else if (at('text')) {
      take('text'); take('(');
      if (at('await')) toolCall();
      else {
        const binding = input[pos++];
        if (binding?.type !== 'id' || bindings.get(binding.value) !== true) throw new Error('unsupported output expression');
      }
      take(')');
    } else throw new Error('unsupported wrapper control flow or expression');
    // Require an explicit separator between statements, not guessed ASI.
    if (pos < input.length) take(';');
  }
  return calls;
}

module.exports = { literalToolCalls };
