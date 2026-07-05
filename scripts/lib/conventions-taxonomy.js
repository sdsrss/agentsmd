'use strict';
// conventions-taxonomy.js — fixed convention-dimension taxonomy, the single
// source of truth for the stable `@conv-<slug>` anchors analyze.js stamps onto
// a project's distilled AGENTS.md conventions. The crux this file exists to
// solve (design doc §3): analyze's distillation is AI-authored and its wording
// changes on every re-run, so an anchor derived from convention TEXT would
// never accumulate citations. Anchors instead come from this fixed dimension
// list — content under a heading may change every run, but the heading (and
// therefore its anchor) doesn't. Consumers: analyze.js `--write` (stamps),
// the agentsmd-analyze skill (buckets AI output under these headings), and
// hooks/convention-cite-scan.sh (reads anchors back off disk directly, NOT
// from this file — a hook is L1 and must never import scripts/lib).

const DIMENSIONS = [
  { slug: 'declarations',   heading: 'Declaration style',         aliases: ['declaration style', 'declarations'] },
  { slug: 'naming',         heading: 'Naming',                    aliases: ['naming', 'naming conventions'] },
  { slug: 'imports',        heading: 'Import order',              aliases: ['import order', 'imports', 'import conventions'] },
  { slug: 'error-handling', heading: 'Error handling',            aliases: ['error handling'] },
  { slug: 'api',            heading: 'Request/API encapsulation', aliases: ['request/api encapsulation', 'api', 'api encapsulation', 'requests'] },
  { slug: 'state',          heading: 'State management',          aliases: ['state management', 'state'] },
  { slug: 'comments',       heading: 'Comment style',              aliases: ['comment style', 'comments'] },
  { slug: 'git',            heading: 'Git conventions',            aliases: ['git conventions', 'git'] },
];

// One-line notice analyze.js prepends to every written conventions block —
// deterministic, not AI-authored, so it can never drift or go missing on a
// re-run the way AI-authored prose could.
const CONVENTIONS_CITE_NOTICE = 'When you apply one of the conventions below, cite its `@conv-<dim>` anchor in your output — that citation is this project\'s only adoption signal (see `agentsmd analyze --adoption`); uncited dimensions decay toward a prune candidate.';

// Normalize a heading's TITLE TEXT for alias lookup: strip ATX `#` marks and
// inline markdown emphasis/code marks, collapse whitespace, lowercase.
function normalizeHeading(s) {
  return String(s)
    .replace(/^#{1,6}\s+/, '')
    .replace(/[`*_]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Look up the stable slug for a heading's title text (caller strips any
// pre-existing `(@conv-<slug>)` suffix first). null when unrecognized.
function anchorFor(headingText) {
  const norm = normalizeHeading(headingText);
  const dim = DIMENSIONS.find((d) => d.aliases.includes(norm));
  return dim ? dim.slug : null;
}

// Stamp a stable `(@conv-<slug>)` suffix onto every recognized canonical
// dimension heading (a markdown ATX heading, `#` through `######`) in `text`.
// Unrecognized headings are left byte-for-byte untouched. Idempotent: an
// already-stamped heading has its slug RE-DERIVED from the title text, not
// doubled — so re-running on unchanged input is byte-stable, and a stale
// anchor (were a slug ever renamed) self-heals rather than accumulating.
function stampConventionAnchors(text) {
  return String(text).split('\n').map((line) => {
    const m = line.match(/^(#{1,6}\s+)(.*)$/);
    if (!m) return line;
    const [, prefix, rest] = m;
    const already = rest.match(/\s*\(@conv-[a-z-]+\)\s*$/);
    const title = already ? rest.slice(0, already.index) : rest;
    const slug = anchorFor(title);
    return slug ? `${prefix}${title} (@conv-${slug})` : line;
  }).join('\n');
}

module.exports = { DIMENSIONS, CONVENTIONS_CITE_NOTICE, normalizeHeading, anchorFor, stampConventionAnchors };
