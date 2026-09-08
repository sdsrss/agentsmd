'use strict';

// A bounded lexical subset, not a JavaScript parser or evaluator. Consumers must
// explicitly accept their grammar; templates/regex/executable expressions are
// never interpreted as literal tool arguments.
function tokens(source) {
  if (typeof source !== 'string' || source.length > 256 * 1024) throw new Error('unsupported source size');
  const result = [];
  for (let i = 0; i < source.length;) {
    if (/\s/u.test(source[i])) { i += 1; continue; }
    if (source.startsWith('//', i)) {
      const offset = source.slice(i + 2).search(/[\r\n\u2028\u2029]/u);
      i = offset < 0 ? source.length : i + 3 + offset; continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unsupported unterminated comment');
      i = end + 2; continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'") {
      let value = ''; let closed = false;
      for (i += 1; i < source.length; i += 1) {
        const char = source[i];
        if (char === quote) { i += 1; closed = true; break; }
        if (char === '\n' || char === '\r') throw new Error('unsupported multiline string');
        if (char !== '\\') { value += char; continue; }
        const escaped = source[++i];
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" };
        if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else if (escaped === 'u' && /^[0-9a-f]{4}$/iu.test(source.slice(i + 1, i + 5))) {
          value += String.fromCharCode(parseInt(source.slice(i + 1, i + 5), 16)); i += 4;
        } else throw new Error('unsupported string escape');
      }
      if (!closed) throw new Error('unsupported unterminated string');
      result.push({ type: 'string', value }); continue;
    }
    if (quote === '`') throw new Error('unsupported template literal');
    const id = source.slice(i).match(/^[A-Za-z_$][A-Za-z0-9_$]*/u);
    if (id) { result.push({ type: 'id', value: id[0] }); i += id[0].length; continue; }
    const number = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u);
    if (number) { result.push({ type: 'number', value: number[0] }); i += number[0].length; continue; }
    result.push({ type: 'punct', value: source[i++] });
  }
  return result;
}

module.exports = { tokens };
