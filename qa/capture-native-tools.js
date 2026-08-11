'use strict';

const fs = require('fs');

function parseJsonLines(raw) {
  const items = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      throw new Error(`invalid transcript JSON at line ${index + 1}: ${error.message}`);
    }
    if (event && event.type === 'response_item' && event.payload) items.push(event.payload);
  }
  return items;
}

function flattenOutput(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((block) => {
      if (block && typeof block.text === 'string') return block.text;
      return JSON.stringify(block);
    }).join('\n');
  }
  return output == null ? '' : JSON.stringify(output);
}

function skipQuoted(source, start, quote) {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      i++;
      continue;
    }
    if (source[i] === quote) return i + 1;
  }
  return source.length;
}

function skipLineComment(source, start) {
  const end = source.indexOf('\n', start + 2);
  return end === -1 ? source.length : end + 1;
}

function skipBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);
  return end === -1 ? source.length : end + 2;
}

function readCallArguments(source, openParen) {
  let depth = 1;
  for (let i = openParen + 1; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' || char === "'" || char === '`') {
      i = skipQuoted(source, i, char) - 1;
      continue;
    }
    if (char === '/' && next === '/') {
      i = skipLineComment(source, i) - 1;
      continue;
    }
    if (char === '/' && next === '*') {
      i = skipBlockComment(source, i) - 1;
      continue;
    }
    if (char === '(') depth++;
    if (char === ')' && --depth === 0) {
      return { arguments: source.slice(openParen + 1, i).trim(), end: i + 1 };
    }
  }
  return null;
}

function quoteBareObjectKeys(argumentsText) {
  return argumentsText.replace(/(^|[{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*:)/g, '$1"$2"$3');
}

function nestedToolCalls(source) {
  const calls = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' || char === "'" || char === '`') {
      i = skipQuoted(source, i, char);
      continue;
    }
    if (char === '/' && next === '/') {
      i = skipLineComment(source, i);
      continue;
    }
    if (char === '/' && next === '*') {
      i = skipBlockComment(source, i);
      continue;
    }
    const previous = source[i - 1] || '';
    if (source.startsWith('tools.', i) && !/[A-Za-z0-9_$]/.test(previous)) {
      let cursor = i + 'tools.'.length;
      const nameStart = cursor;
      while (/[a-z0-9_]/.test(source[cursor] || '')) cursor++;
      const name = source.slice(nameStart, cursor);
      while (/\s/.test(source[cursor] || '')) cursor++;
      if (/^[a-z][a-z0-9_]*$/.test(name) && source[cursor] === '(') {
        const parsed = readCallArguments(source, cursor);
        if (parsed) {
          calls.push({ name, arguments: quoteBareObjectKeys(parsed.arguments) });
          i = parsed.end;
          continue;
        }
      }
    }
    i++;
  }
  return calls;
}

function extractNativeTools(raw) {
  const items = parseJsonLines(raw);
  const outputs = new Map();
  for (const item of items) {
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      outputs.set(item.call_id || '', item);
    }
  }

  const captured = [];
  for (const call of items) {
    if (call.type === 'function_call') {
      const result = outputs.get(call.call_id || '');
      captured.push({
        name: call.name || '',
        arguments: call.arguments || '',
        call_id: call.call_id || '',
        paired: Boolean(result),
        output: flattenOutput(result && result.output),
      });
      continue;
    }
    if (call.type !== 'custom_tool_call') continue;
    const result = outputs.get(call.call_id || '');
    if (call.name !== 'exec') {
      captured.push({
        name: call.name || '',
        arguments: call.input || call.arguments || '',
        call_id: call.call_id || '',
        paired: Boolean(result),
        output: flattenOutput(result && result.output),
      });
      continue;
    }
    for (const nested of nestedToolCalls(typeof call.input === 'string' ? call.input : '')) {
      captured.push({
        name: nested.name,
        arguments: nested.arguments,
        call_id: call.call_id || '',
        paired: Boolean(result),
        output: flattenOutput(result && result.output),
      });
    }
  }
  return captured;
}

function main(argv) {
  if (argv.length !== 1) {
    console.error('Usage: node qa/capture-native-tools.js <rollout.jsonl>');
    return 2;
  }
  const stat = fs.lstatSync(argv[0]);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('transcript must be a regular file');
  const captured = extractNativeTools(fs.readFileSync(argv[0], 'utf8'));
  for (const item of captured) process.stdout.write(`${JSON.stringify(item)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`capture-native-tools: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { extractNativeTools, nestedToolCalls };
