#!/usr/bin/env node
'use strict';

const fs = require('fs');

const TRANSCRIPT_CAP_BYTES = 1 << 19;

const FIX_CLAIM_RE = /\b(?:fixed|resolved)\b|修复|解决了|已解决/iu;
const EVIDENCE_RE = /[0-9]+ ?\/ ?[0-9]+|[0-9]+ (?:passed|failed|tests?|ok|assertions?)|\b(?:passed|failed)\b|exit [0-9]+|exit code|[0-9]+%|[0-9]+ ?(?:→|->|=>) ?[0-9]+|\.[a-z0-9_]+:[0-9]+|\b(?:was|were|used to|previously|regression|crash|crashed|threw|throws|traceback)\b|TypeError|Exception|Error:|\b[0-9a-f]{7,40}\b|`[^`]+`/iu;
const HEDGE_RE = /\b(?:may|might|could|possibly|perhaps)\b|可能|或许|也许|大概/iu;
const BECAUSE_RE = /\bbecause\b|因为|由于/iu;
const VALUE_CLAIM_RE = /\b(?:done|completed|finished|fixed|resolved|implemented|shipped|added|improved|improves|optimized|optimised|reduced|increased|faster|slower|works|passed|passes|verified)\b|完成|修复|解决|实现|新增|优化|提升|改进|通过|验证|更快/iu;

function readPatterns(file) {
  try {
    const source = fs.readFileSync(file, 'utf8');
    return {
      readable: true,
      patterns: source.split(/\r?\n/).filter((line) => line && !line.startsWith('#')),
    };
  } catch {
    return { readable: false, patterns: [] };
  }
}

function labelPosition(message, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^[ \\t>*-]*(?:\\*\\*)?${escaped}(?:\\*\\*)?[ \\t]*:`, 'imu').exec(message);
  return match ? match.index : -1;
}

// A local numeric fingerprint, not proof that a benchmark was executed. Keep
// the timing pair adjacent to its ratio so other sentences/metrics cannot lend
// it evidence. Unknown formats remain subject to the normal vocabulary rule.
const TIMING_PAIR_END = /(?:^|[ \t(:])(\d+(?:\.\d+)?)[ \t]*(ns|us|µs|μs|ms|s|sec|min)[ \t]*(?:→|->|to)[ \t]*(\d+(?:\.\d+)?)[ \t]*(ns|us|µs|μs|ms|s|sec|min)(?:[ \t]+across[ \t]+\d+[ \t]+runs)?(?:[ \t]*[,(:][ \t]*|[ \t]+)$/iu;
const TIME_SCALE = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ms: 1e-3, s: 1, sec: 1, min: 60 };

function hasTimingBaseline(text, match) {
  const start = Math.max(0, match.index - 512);
  // A bounded slice must not manufacture a numeric start by dropping a sign
  // or leading digit. Only the real text start may satisfy the ^ alternative.
  const prefix = (start > 0 ? '\u0000' : '') + text.slice(start, match.index);
  const pair = TIMING_PAIR_END.exec(prefix);
  if (!pair) return false;
  const before = Number(pair[1]) * TIME_SCALE[pair[2].toLowerCase()];
  const after = Number(pair[3]) * TIME_SCALE[pair[4].toLowerCase()];
  const claimed = Number.parseInt(match[0], 10);
  const ratio = before / after;
  return [before, after, claimed, ratio].every(Number.isFinite)
    && after > 0 && before > after && claimed > 1
    && Math.abs(ratio - claimed) <= 1e-9 * claimed;
}

function firstBannedPattern(text, patterns) {
  for (const pattern of patterns) {
    let expression;
    try { expression = new RegExp(pattern, 'giu'); } catch { continue; }
    for (const match of text.matchAll(expression)) {
      if (pattern === '\\brobust(ly|ness)?\\b'
          && /^robust[ \t]+(?:regression|statistics|estimators?|estimation)\b/iu.test(text.slice(match.index, match.index + 96))) continue;
      if (pattern === '\\b[0-9]+x faster\\b' && hasTimingBaseline(text, match)) continue;
      return pattern;
    }
  }
  return null;
}

function reportOrder(message) {
  const positions = {
    done: labelPosition(message, 'Done'),
    notDone: labelPosition(message, 'Not done'),
    failed: labelPosition(message, 'Failed'),
    uncertain: labelPosition(message, 'Uncertain'),
  };
  const present = Object.values(positions).filter((position) => position >= 0);
  // Text does not establish L2/L3 applicability. Check relative order only;
  // missing sections cannot be classified as violations without task evidence.
  return {
    positions,
    eligible: present.length >= 2,
    violation: present.some((position, index) => index > 0 && position < present[index - 1]),
  };
}

function analyze(message, patternsFile) {
  const source = String(message || '');
  const scanText = source.replace(/```[\s\S]*?```/g, '');
  const patternSet = readPatterns(patternsFile);
  const bannedVocabulary = firstBannedPattern(scanText, patternSet.patterns);
  const order = reportOrder(source);
  const { positions } = order;
  const fixEvidenceEligible = FIX_CLAIM_RE.test(scanText);
  const honestyEligible = positions.uncertain >= 0;
  const uncertainTail = honestyEligible ? source.slice(positions.uncertain) : '';
  const vocabularyEligible = positions.done >= 0 || bannedVocabulary !== null || VALUE_CLAIM_RE.test(scanText);

  return {
    issues: {
      bannedVocabulary,
      fourSectionOrder: order.violation,
      ironLaw2: fixEvidenceEligible && !EVIDENCE_RE.test(scanText),
      uncertainHedge: honestyEligible && HEDGE_RE.test(uncertainTail) && !BECAUSE_RE.test(uncertainTail),
    },
    eligible: {
      vocabulary: vocabularyEligible,
      order: order.eligible,
      fixEvidence: fixEvidenceEligible,
      honesty: honestyEligible,
    },
    patternsReadable: patternSet.readable,
  };
}

function pullText(value, out) {
  if (value == null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) pullText(item, out);
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') out.push(value.text);
    else if (Array.isArray(value.content)) pullText(value.content, out);
  }
}

function transcriptLastAssistantMessage(file) {
  if (typeof file !== 'string' || !file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = size > TRANSCRIPT_CAP_BYTES ? size - TRANSCRIPT_CAP_BYTES : 0;
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const messages = [];
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record && record.payload != null ? record.payload : record;
      const role = payload && (payload.role || payload.author);
      const isMessage = record.type === 'message'
        || record.type === 'response_item'
        || (payload && payload.type === 'message');
      if (role !== 'assistant' || !isMessage) continue;
      const parts = [];
      pullText(payload.content != null ? payload.content : payload.text, parts);
      const message = parts.join('\n').trim();
      if (message) messages.push(message);
    }
    return messages.at(-1) || '';
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* fail open */ }
    }
  }
}

function analyzeEvent(event, patternsFile) {
  const source = event && typeof event === 'object' ? event : {};
  const direct = typeof source.last_assistant_message === 'string'
    ? source.last_assistant_message
    : '';
  const message = direct || transcriptLastAssistantMessage(source.transcript_path);
  const messageSource = direct ? 'event' : (message ? 'transcript' : 'none');
  return {
    sessionId: typeof source.session_id === 'string' ? source.session_id : '',
    messageSource,
    messageFound: Boolean(message),
    ...analyze(message, patternsFile),
  };
}

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function formatTsv(result) {
  return [
    result.issues.bannedVocabulary || '-',
    result.issues.fourSectionOrder,
    result.issues.ironLaw2,
    result.issues.uncertainHedge,
    result.eligible.vocabulary,
    result.eligible.order,
    result.eligible.fixEvidence,
    result.eligible.honesty,
    result.patternsReadable,
  ].join('\t');
}

function formatEventTsv(result) {
  return [
    result.sessionId || '-',
    result.messageSource,
    result.messageFound,
    formatTsv(result),
  ].join('\t');
}

if (require.main === module) {
  const flags = new Set(process.argv.slice(3));
  let result;
  if (flags.has('--commits')) {
    try {
      const invocations = JSON.parse(readStdin());
      const patternSet = readPatterns(process.argv[2] || '');
      if (!Array.isArray(invocations) || !patternSet.readable) throw new Error('unreadable commit input');
      let hit = null;
      for (const invocation of invocations) {
        if (!Array.isArray(invocation.messages) || !invocation.messages.every((message) => typeof message === 'string')) {
          throw new Error('invalid commit messages');
        }
        // Each -m starts a paragraph. Preserve those newlines and never merge
        // different commits; unlike Stop, commit fences are not stripped.
        hit = firstBannedPattern(invocation.messages.join('\n'), patternSet.patterns);
        if (hit) break;
      }
      process.stdout.write(hit || '-');
    } catch { process.exit(1); }
  } else if (flags.has('--event')) {
    let event;
    try { event = JSON.parse(readStdin()); } catch { process.exit(1); }
    result = analyzeEvent(event, process.argv[2] || '');
    process.stdout.write(flags.has('--tsv') ? formatEventTsv(result) : JSON.stringify(result));
  } else {
    result = analyze(readStdin(), process.argv[2] || '');
    process.stdout.write(flags.has('--tsv') ? formatTsv(result) : JSON.stringify(result));
  }
}

module.exports = {
  analyze,
  analyzeEvent,
  formatEventTsv,
  formatTsv,
  labelPosition,
  firstBannedPattern,
  reportOrder,
  readPatterns,
  transcriptLastAssistantMessage,
};
