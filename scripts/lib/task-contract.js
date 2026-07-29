'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TASK_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-contract.schema.json'), 'utf8'));
const EVIDENCE_SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'task-evidence.schema.json'), 'utf8'));

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
];

function typeMatches(value, expected) {
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expected === 'integer') return Number.isInteger(value);
  return typeof value === expected;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported schema reference: ${ref}`);
  return ref.slice(2).split('/').reduce((value, part) => value[part.replace(/~1/g, '/').replace(/~0/g, '~')], root);
}

function validateSchema(value, schema, root, at = '$') {
  if (schema.$ref) return validateSchema(value, resolveRef(root, schema.$ref), root, at);
  const errors = [];

  if (schema.allOf) {
    for (const child of schema.allOf) errors.push(...validateSchema(value, child, root, at));
  }
  if (schema.anyOf) {
    const matches = schema.anyOf.filter((child) => validateSchema(value, child, root, at).length === 0).length;
    if (matches === 0) errors.push(`${at}: must match at least one allowed shape`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((child) => validateSchema(value, child, root, at).length === 0).length;
    if (matches !== 1) errors.push(`${at}: must match exactly one allowed shape`);
  }
  if (schema.if && validateSchema(value, schema.if, root, at).length === 0 && schema.then) {
    errors.push(...validateSchema(value, schema.then, root, at));
  } else if (schema.if && schema.else) {
    errors.push(...validateSchema(value, schema.else, root, at));
  }

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }

  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${at}: must be ${schema.type}`);
    return errors;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: length must be at least ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: maxLength ${schema.maxLength} exceeded`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) {
      errors.push(`${at}: does not match the required pattern`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: must contain at most ${schema.maxItems} item(s)`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((item) => JSON.stringify(item));
      if (new Set(serialized).size !== serialized.length) errors.push(`${at}: items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateSchema(item, schema.items, root, `${at}[${index}]`)));
    }
    if (schema.contains) {
      const matches = value.filter((item) => validateSchema(item, schema.contains, root, at).length === 0).length;
      const minimum = schema.minContains === undefined ? 1 : schema.minContains;
      if (matches < minimum) errors.push(`${at}: must contain at least ${minimum} matching item(s)`);
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      errors.push(`${at}: must contain at least ${schema.minProperties} field(s)`);
    }
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) errors.push(`${at}.${required}: is required`);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties || {}));
      for (const key of keys) {
        if (!allowed.has(key)) errors.push(`${at}.${key}: unknown field`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(value[key], child, root, `${at}.${key}`));
      }
    }
  }

  return errors;
}

function sensitivePaths(value, at = '$', out = []) {
  if (typeof value === 'string') {
    if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) out.push(at);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => sensitivePaths(item, `${at}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) sensitivePaths(child, `${at}.${key}`, out);
  }
  return out;
}

function finish(errors, value) {
  for (const at of sensitivePaths(value)) errors.push(`${at}: secret-shaped value is forbidden`);
  const unique = [...new Set(errors)];
  return { valid: unique.length === 0, errors: unique };
}

function validateTaskContract(value) {
  const errors = validateSchema(value, TASK_SCHEMA, TASK_SCHEMA);
  if (value && Array.isArray(value.allowed_mutations) && Array.isArray(value.forbidden_mutations)) {
    const forbidden = new Set(value.forbidden_mutations);
    for (const scope of value.allowed_mutations) {
      if (forbidden.has(scope)) errors.push(`$.allowed_mutations: scope ${JSON.stringify(scope)} is also forbidden`);
    }
  }
  return finish(errors, value);
}

function validateTaskEvidence(value) {
  const errors = validateSchema(value, EVIDENCE_SCHEMA, EVIDENCE_SCHEMA);
  if (value && value.status === 'partial') {
    const remaining = ['not_done', 'failed', 'uncertain']
      .some((key) => Array.isArray(value[key]) && value[key].length > 0);
    if (!remaining) errors.push('$: partial evidence must name at least one not_done, failed, or uncertain item');
  }
  return finish(errors, value);
}

function renderList(label, items) {
  const lines = [`${label}:`];
  if (!items.length) lines.push('- none');
  else lines.push(...items.map((item) => `- ${item}`));
  return lines;
}

function renderEvidence(value) {
  const validation = validateTaskEvidence(value);
  if (!validation.valid) throw new Error(`invalid task evidence:\n${validation.errors.join('\n')}`);
  const lines = [
    ...renderList('Done', value.done),
    ...renderList('Not done', value.not_done),
    ...renderList('Failed', value.failed),
    ...renderList('Uncertain', value.uncertain),
  ];
  if (value.status === 'partial') {
    lines.push(`[PARTIAL: ${[...value.not_done, ...value.failed, ...value.uncertain].join('; ')}]`);
  }
  for (const operation of value.auth_required) {
    lines.push(`[AUTH REQUIRED op:${operation} scope:task contract risk:external action]`);
  }
  if (value.status === 'blocked') {
    lines.push(`[BLOCKED: ${value.not_done.join('; ')} | unblock: ${value.resume_command}]`);
  }
  if (value.resume_command !== null) lines.push(`Resume: ${value.resume_command}`);
  if (value.cleanup.length) lines.push('Cleanup:', ...value.cleanup.map((item) => `- ${item}`));
  return lines.join('\n');
}

module.exports = {
  renderEvidence,
  validateSchema,
  validateTaskContract,
  validateTaskEvidence,
};
