/**
 * Guards the contract between the web app's markup and its stylesheets: every
 * element that carries a class must carry at least one class some stylesheet
 * actually defines.
 *
 * Four defects shipped at once, each one a component naming a class no
 * stylesheet defines. The hole tool's face list asked for `body-picker` and
 * `body-pick-row` where inspector.css defines `pick-list` and `pick-row`; its
 * Style and Depth labels asked for `form-field` instead of `field`;
 * ExportDialog's three loaders asked for `spinner` instead of topbar.css's
 * `spin`; and the lazy viewport fallback asked for `viewer` instead of
 * `viewer-shell`. Each one rendered as a bare browser default -- the unstyled
 * face list flowed two inline-block buttons per line, uncapped and unelided --
 * and neither the type checker nor a unit test can see it.
 *
 * The check is per element, not per class: markup legitimately carries a
 * semantic hook no rule targets next to the class that does the styling, so
 * only an element where *nothing* is defined is a finding.
 *
 * "Defined" is compound-aware. `.selected` appears in these stylesheets only as
 * `.pick-row.selected`, `.feature-row.selected` and friends, so it styles
 * nothing on its own; counting it as a definition would have let the
 * `body-pick-row${active ? ' selected' : ''}` half of the FacePicker defect
 * through. A class anchors an element only when some rule targets it either
 * alone or alongside classes the element also carries.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Directories scanned for both stylesheets and markup. The web app is the only
 * React surface and owns every stylesheet; `packages/viewport` builds its HUD
 * DOM imperatively but is styled from here, so it is scanned too.
 */
export const SCANNED_ROOTS = ['apps/web/src', 'packages/viewport/src'];

/** A class literal: lowercase words joined by single hyphens. */
const CLASS_TOKEN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Elements that carry no defined class on purpose, because their styling comes
 * from a parent, a child, or a wrapper component. Keyed by file and exact class
 * list, so an unrelated element in the same file still fails and an entry that
 * stops matching is reported as stale rather than quietly rotting.
 */
export const UNSTYLED_ALLOWANCES = [
  {
    file: 'apps/web/src/components/Inspector.tsx',
    classes: ['sketch-attachment'],
    reason:
      'Bare wrapper. Its kv-grid and muted children carry every rule that lays this block out.'
  },
  {
    file: 'apps/web/src/components/ProjectSharingDialog.tsx',
    classes: ['sharing-invite'],
    reason:
      'Spaced positionally by `.sharing-body > * + *` in modals.css; the name is an aria-label anchor.'
  },
  {
    file: 'apps/web/src/components/ProjectSharingDialog.tsx',
    classes: ['sharing-section'],
    reason:
      'Spaced positionally by `.sharing-body > * + *` in modals.css; three sections share the name.'
  },
  {
    file: 'apps/web/src/components/SettingsPage.tsx',
    classes: ['settings-turnstile-shell'],
    reason:
      'Bare wrapper around the sized .settings-turnstile widget slot and its status line.'
  },
  {
    file: 'apps/web/src/components/SettingsPage.tsx',
    classes: ['settings-challenge-state'],
    reason:
      'Inherits the surrounding settings type scale; the name plus its state suffix is a status hook.'
  },
  {
    file: 'apps/web/src/components/Sidebar.tsx',
    classes: ['revisions'],
    reason:
      'Passed to SidebarSection, which composes `sidebar-section ${className}` (Sidebar.tsx:96).'
  },
  {
    file: 'apps/web/src/components/Sidebar.tsx',
    classes: ['grow'],
    reason:
      'Same SidebarSection composition: .sidebar-section.grow is satisfied by the base class the component adds.'
  },
  {
    file: 'apps/web/src/components/assistant/AssistantPanel.tsx',
    classes: ['assistant-turn-who'],
    reason:
      'Inherits font, size and colour from .assistant-turn-meta on its parent header.'
  }
];

// ── Stylesheets ────────────────────────────────────────────────────────────

/** Blanks comments and string literals so neither can look like a selector. */
function stripCssNoise(css) {
  let out = '';
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
      out += ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      i = j;
      out += '""';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Splits on a separator that sits outside every paren and bracket. */
function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Every selector in a stylesheet. A prelude is the text before a `{` since the
 * last `{`, `}` or `;`, which puts declarations out of reach without needing a
 * rule grammar. At-rule preludes are dropped but their bodies are still walked,
 * so rules inside `@media` count.
 */
export function ruleSelectors(css) {
  const selectors = [];
  let prelude = '';
  for (const ch of stripCssNoise(css)) {
    if (ch === '{') {
      const text = prelude.trim();
      if (text && !text.startsWith('@'))
        selectors.push(...splitTopLevel(text, ','));
      prelude = '';
    } else if (ch === '}' || ch === ';') {
      prelude = '';
    } else {
      prelude += ch;
    }
  }
  return selectors;
}

/** Splits a selector into compounds at its combinators. */
function compoundSelectors(selector) {
  const compounds = [];
  let current = '';
  let depth = 0;
  for (const ch of selector) {
    if (ch === '(' || ch === '[') depth += 1;
    else if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (current) compounds.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) compounds.push(current);
  return compounds;
}

/** Index of the `)` or `]` closing the delimiter at `open`. */
function closingIndex(text, open) {
  const close = text[open] === '(' ? ')' : ']';
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === text[open]) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function classNames(text) {
  return [...text.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((match) => match[1]);
}

/**
 * The class groups a compound targets. Each group is a set of classes an
 * element must carry together for the rule to reach it. Attribute selectors and
 * pseudo-classes drop out -- an element still has the class whether or not
 * `:hover` is deciding to paint -- except that `:not()` and `:has()` arguments
 * are discarded, since those classes are absent from the element or sit on a
 * descendant, while `:is()` and `:where()` branches each become their own group.
 */
export function compoundClassGroups(compound) {
  const alternatives = [];
  let rest = '';
  for (let i = 0; i < compound.length; i += 1) {
    if (compound[i] === '[') {
      i = closingIndex(compound, i);
      continue;
    }
    if (compound[i] === ':') {
      const functional = /^::?([\w-]+)\(/.exec(compound.slice(i));
      if (functional) {
        const open = i + functional[0].length - 1;
        const close = closingIndex(compound, open);
        const name = functional[1].toLowerCase();
        if (name === 'is' || name === 'where')
          for (const branch of splitTopLevel(
            compound.slice(open + 1, close),
            ','
          ))
            alternatives.push(classNames(branch));
        i = close;
        continue;
      }
      const plain = /^::?[\w-]+/.exec(compound.slice(i));
      if (plain) {
        i += plain[0].length - 1;
        continue;
      }
    }
    rest += compound[i];
  }

  const base = classNames(rest);
  if (!alternatives.length) return base.length ? [base] : [];
  return alternatives.map((branch) => [...new Set([...base, ...branch])]);
}

/**
 * Maps every class a stylesheet defines to the co-required class lists it is
 * defined alongside; an empty list means the class styles an element on its
 * own. Merges into `into` so a whole directory folds into one map.
 */
export function styleAnchors(css, into = new Map()) {
  for (const selector of ruleSelectors(css)) {
    for (const compound of compoundSelectors(selector)) {
      for (const group of compoundClassGroups(compound)) {
        for (const name of group) {
          const required = group.filter((other) => other !== name);
          const known = into.get(name);
          if (known) known.push(required);
          else into.set(name, [required]);
        }
      }
    }
  }
  return into;
}

/**
 * Why none of `classes` styles the element: either the name is unknown to every
 * stylesheet (the usual typo) or it only exists in a compound whose other
 * classes are missing here.
 */
export function explainUnstyled(classes, anchors) {
  return classes
    .map((name) => {
      const required = anchors.get(name);
      if (!required) return `.${name} is defined nowhere`;
      const compounds = [
        ...new Set(
          required.map((group) => group.map((other) => `.${other}`).join(''))
        )
      ];
      return `.${name} is only defined alongside ${compounds.join(' or ')}`;
    })
    .join('; ');
}

/** Whether some stylesheet rule can reach an element carrying `classes`. */
export function isAnchored(classes, anchors) {
  const present = new Set(classes);
  return classes.some((name) =>
    (anchors.get(name) ?? []).some((required) =>
      required.every((other) => present.has(other))
    )
  );
}

// ── Markup ─────────────────────────────────────────────────────────────────

/** Index of the quote closing the one at `open`. */
function closingQuote(source, open) {
  for (let i = open + 1; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source[i] === source[open]) return i;
  }
  return source.length;
}

/** Index of the `}` closing the brace at `open`, skipping nested literals. */
function closingBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '"' || ch === "'") i = closingQuote(source, i);
    else if (ch === '`') i = templateLiteral(source, i).end;
    else if (ch === '/' && source[i + 1] === '/') {
      const line = source.indexOf('\n', i);
      i = line < 0 ? source.length : line;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 1;
    } else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/**
 * The literal text of the template starting at `open`, one segment per span
 * between interpolations. Interpolations are read for their own literals, so
 * the ternary in `pick-row${on ? ' selected' : ''}` contributes `selected` --
 * that class really does land on the element.
 */
function templateLiteral(source, open) {
  const segments = [];
  let literal = '';
  let i = open + 1;
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '`') break;
    if (ch === '$' && source[i + 1] === '{') {
      const close = closingBrace(source, i + 1);
      segments.push(literal, ...literalSegments(source.slice(i + 2, close)));
      literal = '';
      i = close;
      continue;
    }
    literal += ch;
  }
  segments.push(literal);
  return { segments, end: i };
}

/** Every string and template literal inside a JavaScript expression. */
export function literalSegments(expression) {
  const segments = [];
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === '"' || ch === "'") {
      const close = closingQuote(expression, i);
      segments.push(expression.slice(i + 1, close));
      i = close;
    } else if (ch === '`') {
      const template = templateLiteral(expression, i);
      segments.push(...template.segments);
      i = template.end;
    } else if (ch === '/' && expression[i + 1] === '/') {
      const line = expression.indexOf('\n', i);
      i = line < 0 ? expression.length : line;
    } else if (ch === '/' && expression[i + 1] === '*') {
      const end = expression.indexOf('*/', i + 2);
      i = end < 0 ? expression.length : end + 1;
    }
  }
  return segments;
}

/** The class expression after a `className=`, and the index it ends on. */
function classExpression(source, start) {
  const ch = source[start];
  if (ch === '"' || ch === "'" || ch === '`') {
    const close =
      ch === '`'
        ? templateLiteral(source, start).end
        : closingQuote(source, start);
    return { text: source.slice(start, close + 1), end: close };
  }
  if (ch === '{') {
    const close = closingBrace(source, start);
    return { text: source.slice(start + 1, close), end: close };
  }
  // A bare identifier (`element.className = className`) names classes we
  // cannot see from here; judging it would only invent findings.
  return null;
}

/**
 * Every place a class list is written, whether as a JSX attribute or an
 * imperative `element.className =`. A site whose classes are entirely computed
 * holds no literal and is skipped: there is nothing to check.
 */
export function classSites(source) {
  const sites = [];
  const attribute = /(?<![$\w])class(?:Name)?\s*=\s*/g;
  let match;
  while ((match = attribute.exec(source))) {
    const start = match.index + match[0].length;
    const expression = classExpression(source, start);
    if (!expression) continue;
    attribute.lastIndex = expression.end + 1;

    const classes = [
      ...new Set(
        literalSegments(expression.text)
          .join(' ')
          .split(/\s+/)
          .filter((token) => CLASS_TOKEN.test(token))
      )
    ].sort();
    if (!classes.length) continue;
    sites.push({
      line: source.slice(0, match.index).split('\n').length,
      classes
    });
  }
  return sites;
}

// ── Audit ──────────────────────────────────────────────────────────────────

function filesUnder(repoRoot, matches) {
  const found = [];
  for (const root of SCANNED_ROOTS) {
    let names;
    try {
      names = readdirSync(path.resolve(repoRoot, root), { recursive: true });
    } catch {
      continue;
    }
    for (const name of names) {
      const file = `${root}/${name.split(path.sep).join('/')}`;
      if (matches(file)) found.push(file);
    }
  }
  return found.sort();
}

const isStylesheet = (file) => file.endsWith('.css');

// Test fixtures name classes that are deliberately fake, and never ship.
const isMarkup = (file) =>
  /\.tsx?$/.test(file) &&
  !/\.test\.tsx?$/.test(file) &&
  !file.includes('/test/');

const allowanceKey = (file, classes) =>
  `${file} ${[...classes].sort().join(' ')}`;

/**
 * Reports every element whose classes no stylesheet defines, alongside the
 * counts that prove the scan actually read something.
 */
export function auditClassCoverage(repoRoot = REPO_ROOT) {
  const stylesheets = filesUnder(repoRoot, isStylesheet);
  const anchors = new Map();
  for (const file of stylesheets)
    styleAnchors(readFileSync(path.resolve(repoRoot, file), 'utf8'), anchors);

  const markup = filesUnder(repoRoot, isMarkup);
  const unstyled = [];
  for (const file of markup) {
    const source = readFileSync(path.resolve(repoRoot, file), 'utf8');
    for (const site of classSites(source)) {
      if (isAnchored(site.classes, anchors)) continue;
      unstyled.push({
        file,
        line: site.line,
        classes: site.classes,
        detail: explainUnstyled(site.classes, anchors)
      });
    }
  }

  const allowed = new Set(
    UNSTYLED_ALLOWANCES.map((entry) => allowanceKey(entry.file, entry.classes))
  );
  const used = new Set();
  const findings = unstyled.filter((finding) => {
    const key = allowanceKey(finding.file, finding.classes);
    if (!allowed.has(key)) return true;
    used.add(key);
    return false;
  });

  return {
    findings,
    staleAllowances: UNSTYLED_ALLOWANCES.filter(
      (entry) => !used.has(allowanceKey(entry.file, entry.classes))
    ),
    stylesheetCount: stylesheets.length,
    markupCount: markup.length,
    definedClassCount: anchors.size
  };
}

/** The failure report shared by the CLI and the test. */
export function describeAudit(audit) {
  const lines = [];
  for (const finding of audit.findings)
    lines.push(
      `${finding.file}:${finding.line}  ${finding.classes.join(' ')}  -- ${finding.detail}`
    );
  for (const entry of audit.staleAllowances)
    lines.push(
      `${entry.file}  ${entry.classes.join(' ')}  -- allowance matches no element any more; delete it from UNSTYLED_ALLOWANCES`
    );
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('check-css-classes.mjs')) {
  const audit = auditClassCoverage();
  if (audit.findings.length || audit.staleAllowances.length) {
    console.error(describeAudit(audit));
    console.error(
      '\nEach line is an element that renders with browser defaults. Fix the class name, add the missing rule, or record it in UNSTYLED_ALLOWANCES in scripts/check-css-classes.mjs with the reason it is styled from elsewhere.'
    );
    process.exit(1);
  }
  console.log(
    `Every classed element is styled: ${audit.markupCount} files checked against ${audit.definedClassCount} classes from ${audit.stylesheetCount} stylesheets.`
  );
}
