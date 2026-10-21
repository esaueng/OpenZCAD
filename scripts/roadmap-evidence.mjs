/**
 * Roadmap evidence fragments: each PR records its delivery evidence in its own
 * file under `docs/roadmap-evidence/` instead of editing ROADMAP.md, and a
 * later fold PR appends every fragment to its row in one commit.
 *
 * ROADMAP.md is the single ledger and its rows are single-line table cells, so
 * two PRs that append evidence to the same row -- or to adjacent rows -- always
 * conflict. With twenty open PRs each touching the ledger, every merge made the
 * rest un-mergeable. Fragments are separate files, so they never conflict.
 *
 * A fragment is Markdown with a small front matter block:
 *
 *   ---
 *   row: H02
 *   state: In review
 *   ---
 *   Evidence text, appended to the row's evidence cell.
 *
 * `row` names the ledger row by its anchor id (`h02`) or its displayed ID
 * (`H02`, `PERF-N04`, `8.1`); it must match exactly one table row. `state` is
 * optional and replaces the row's status cell outright, so two fragments that
 * set the state of one row are refused rather than ordered by file name.
 */

import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

export const ROADMAP_PATH = 'ROADMAP.md';
export const FRAGMENT_DIR = 'docs/roadmap-evidence';

/** Fragment files: `<row>--<slug>.md`, lowercase, so the row is visible in a listing. */
export const FRAGMENT_NAME = /^[a-z0-9][a-z0-9.-]*--[a-z0-9][a-z0-9-]*\.md$/;

const FRONT_MATTER_KEYS = new Set(['row', 'state']);
const EMPTY_CELLS = new Set(['', '—', '-']);

/**
 * Parses one fragment. Throws with the file name on any malformed input, since
 * a fragment the fold cannot place would otherwise be deleted with its evidence.
 */
export function parseFragment(name, source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(source);
  if (!match) {
    throw new Error(`${name}: missing front matter (--- row: <ID> ---)`);
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const field = /^([a-z]+):\s*(.*?)\s*$/.exec(line);
    if (!field || !FRONT_MATTER_KEYS.has(field[1])) {
      throw new Error(`${name}: unknown front matter line "${line}"`);
    }
    if (field[1] in fields) {
      throw new Error(`${name}: duplicate front matter key "${field[1]}"`);
    }
    fields[field[1]] = field[2];
  }
  if (!fields.row) {
    throw new Error(`${name}: front matter needs a row`);
  }
  if ('state' in fields && !fields.state) {
    throw new Error(`${name}: state is empty`);
  }
  const evidence = match[2].replace(/\s+/g, ' ').trim();
  if (!evidence) {
    throw new Error(`${name}: no evidence text`);
  }
  return { name, row: fields.row, state: fields.state, evidence };
}

/**
 * Splits a table row into cells. A pipe inside a code span or escaped as `\|`
 * is cell content, not a separator.
 */
export function splitRow(line) {
  const cells = [];
  let cell = '';
  let inCode = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cell += '\\|';
      i += 1;
    } else if (ch === '`') {
      inCode = !inCode;
      cell += ch;
    } else if (ch === '|' && !inCode) {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  // Drop the empty strings outside the leading and trailing pipes.
  return cells.slice(1, -1).map((c) => c.trim());
}

export function joinRow(cells) {
  return `| ${cells.join(' | ')} |`;
}

const isTableRow = (line) =>
  line.startsWith('|') && line.trimEnd().endsWith('|');
const isDelimiter = (line) => /^\|(\s*:?-+:?\s*\|)+\s*$/.test(line);

/** Header cells of the table that contains `lines[index]`, or null outside a table body. */
function headerFor(lines, index) {
  let i = index;
  while (i > 0 && isTableRow(lines[i - 1]) && !isDelimiter(lines[i - 1]))
    i -= 1;
  if (i < 2 || !isDelimiter(lines[i - 1]) || !isTableRow(lines[i - 2]))
    return null;
  return splitRow(lines[i - 2]);
}

function lastIndex(cells, test) {
  for (let i = cells.length - 1; i >= 0; i -= 1) if (test(cells[i])) return i;
  return -1;
}

/**
 * The cell that receives evidence: the last column named for evidence, else an
 * outcome column, else the state column. A slash-separated header such as
 * "Priority / phase / evidence" holds structured codes, not prose, so it never
 * receives appended text.
 */
export function evidenceColumn(header) {
  const evidence = lastIndex(
    header,
    (h) => /evidence/i.test(h) && !h.includes('/')
  );
  if (evidence >= 0) return evidence;
  const outcome = lastIndex(header, (h) => /^outcome\b/i.test(h));
  if (outcome >= 0) return outcome;
  return stateColumn(header);
}

export function stateColumn(header) {
  return header.findIndex((h) => /^(status|state)\b/i.test(h));
}

const ANCHOR = /<a id="([^"]+)"><\/a>/;

/** Ledger row line indices for a fragment's `row`, by anchor id or displayed ID. */
export function findRows(lines, row) {
  const wanted = row.trim();
  const hits = [];
  lines.forEach((line, index) => {
    if (!isTableRow(line) || isDelimiter(line)) return;
    const first = splitRow(line)[0] ?? '';
    const anchor = ANCHOR.exec(first);
    const shown = first.replace(ANCHOR, '').trim();
    if (
      (anchor && anchor[1] === wanted.toLowerCase()) ||
      shown === wanted ||
      shown.split(/\s+/)[0] === wanted
    ) {
      if (headerFor(lines, index)) hits.push(index);
    }
  });
  return hits;
}

const escapeCell = (text) => text.replace(/(?<!\\)\|/g, '\\|');

/**
 * Applies fragments to the ledger text. Fragments are applied in file-name
 * order. Returns the new text; throws, changing nothing, when any fragment
 * cannot be placed.
 */
export function foldEvidence(markdown, fragments) {
  const lines = markdown.split('\n');
  const errors = [];
  const stateSetters = new Map();
  const placed = [];
  for (const fragment of [...fragments].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const hits = findRows(lines, fragment.row);
    if (hits.length !== 1) {
      errors.push(
        `${fragment.name}: row "${fragment.row}" matches ${hits.length} ledger rows, expected 1`
      );
      continue;
    }
    const index = hits[0];
    const header = headerFor(lines, index);
    const target = evidenceColumn(header);
    const state = stateColumn(header);
    if (target < 0) {
      errors.push(
        `${fragment.name}: row "${fragment.row}" has no evidence column`
      );
      continue;
    }
    if (fragment.state !== undefined) {
      if (state < 0) {
        errors.push(
          `${fragment.name}: row "${fragment.row}" has no state column`
        );
        continue;
      }
      const prior = stateSetters.get(index);
      if (prior) {
        errors.push(
          `${fragment.name}: ${prior} already sets the state of row "${fragment.row}"`
        );
        continue;
      }
      stateSetters.set(index, fragment.name);
    }
    placed.push({ fragment, index, target, state });
  }
  if (errors.length) throw new Error(errors.join('\n'));
  // States first, then every body: where a table has no evidence column the
  // state cell also receives evidence, and a state applied after an earlier
  // fragment's body would overwrite that body.
  const rowCells = new Map();
  for (const { fragment, index, state } of placed) {
    if (!rowCells.has(index)) rowCells.set(index, splitRow(lines[index]));
    if (fragment.state !== undefined) {
      rowCells.get(index)[state] = escapeCell(fragment.state);
    }
  }
  for (const { fragment, index, target } of placed) {
    const cells = rowCells.get(index);
    const text = escapeCell(fragment.evidence);
    cells[target] = EMPTY_CELLS.has(cells[target])
      ? text
      : `${cells[target]} ${text}`;
  }
  for (const [index, cells] of rowCells) lines[index] = joinRow(cells);
  return lines.join('\n');
}

export function readFragments(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, FRAGMENT_DIR);
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const errors = [];
  const fragments = [];
  for (const name of names
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort()) {
    if (!FRAGMENT_NAME.test(name)) {
      errors.push(`${name}: name must be <row>--<slug>.md, lowercase`);
      continue;
    }
    try {
      fragments.push(
        parseFragment(name, readFileSync(path.join(dir, name), 'utf8'))
      );
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return fragments;
}

/** Validates every fragment against the ledger without writing anything. */
export function checkRepo(repoRoot = REPO_ROOT) {
  const fragments = readFragments(repoRoot);
  foldEvidence(
    readFileSync(path.join(repoRoot, ROADMAP_PATH), 'utf8'),
    fragments
  );
  return fragments;
}

/** Folds every fragment into the ledger and deletes the folded files. */
export function foldRepo(repoRoot = REPO_ROOT) {
  const fragments = readFragments(repoRoot);
  const roadmap = path.join(repoRoot, ROADMAP_PATH);
  writeFileSync(
    roadmap,
    foldEvidence(readFileSync(roadmap, 'utf8'), fragments)
  );
  for (const { name } of fragments)
    rmSync(path.join(repoRoot, FRAGMENT_DIR, name));
  return fragments;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const fold = process.argv.includes('--fold');
  try {
    const fragments = fold ? foldRepo() : checkRepo();
    console.log(
      `${fold ? 'Folded' : 'Checked'} ${fragments.length} roadmap evidence fragment(s).`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
