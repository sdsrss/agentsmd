'use strict';

const fs = require('fs');
const { literalToolCalls } = require('./native-wrapper-grammar');

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

function nestedToolCalls(source) {
  try { return literalToolCalls(source); }
  catch (error) { throw new Error(`native wrapper unmeasurable: ${error.message}`); }
}

function extractNativeTools(raw) {
  const items = parseJsonLines(raw);
  const outputs = new Map();
  for (const item of items) {
    if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      if (!item.call_id || outputs.has(item.call_id)) throw new Error('native output pairing unmeasurable');
      outputs.set(item.call_id || '', item);
    }
  }

  const captured = [];
  const seenCalls = new Set();
  for (const call of items) {
    if (call.type === 'function_call' || call.type === 'custom_tool_call') {
      if (!call.call_id || seenCalls.has(call.call_id)) throw new Error('native call identity unmeasurable');
      seenCalls.add(call.call_id);
    }
    if (call.type === 'function_call') {
      const result = outputs.get(call.call_id || '');
      captured.push({
        name: call.name || '',
        arguments: call.arguments || '',
        call_id: call.call_id || '',
        paired: Boolean(result),
        output: flattenOutput(result && result.output),
        output_attribution: 'direct',
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
        output_attribution: 'direct',
      });
      continue;
    }
    if (typeof call.input !== 'string') throw new Error('native wrapper source unmeasurable');
    const nestedCalls = nestedToolCalls(call.input);
    const outputAttribution = nestedCalls.length === 1 ? 'wrapper-exact' : 'wrapper-shared';
    for (const nested of nestedCalls) {
      captured.push({
        name: nested.name,
        arguments: nested.arguments,
        call_id: call.call_id || '',
        paired: Boolean(result),
        output: flattenOutput(result && result.output),
        output_attribution: outputAttribution,
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
