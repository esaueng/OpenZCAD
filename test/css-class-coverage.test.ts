import { describe, expect, it } from 'vitest';
import {
  auditClassCoverage,
  classSites,
  describeAudit,
  isAnchored,
  literalSegments,
  styleAnchors,
  UNSTYLED_ALLOWANCES
} from '../scripts/check-css-classes.mjs';

/**
 * A miniature of the real stylesheets: the classes the four shipped defects
 * meant to reach, plus the shapes the extractor has to survive.
 */
const STYLESHEET = `
/* .commented-out is not a definition. */
.viewer-shell {
  position: relative;
}

.pick-list {
  overflow-y: auto;
}

.pick-row {
  display: flex;
}

.pick-row.selected {
  border-color: red;
}

.row:not(.hidden) {
  opacity: 1;
}

.field > span {
  color: gray;
}

.badge::after {
  content: '.content-string';
}

.sidebar-section.grow {
  flex: 1;
}

@media (max-width: 620px) {
  .spin {
    animation: spin 1s linear infinite;
  }
}
`;

const anchors = styleAnchors(STYLESHEET);

describe('css class coverage', () => {
  it('styles every element the web app renders with a class', () => {
    const audit = auditClassCoverage();

    // Compared as text so a failure prints the offending elements, not a diff
    // of object literals.
    expect(describeAudit(audit)).toBe('');
  });

  it('scans the files it claims to', () => {
    const audit = auditClassCoverage();

    // A guard that silently reads nothing passes forever. These are floors,
    // not counts: the app had 24 stylesheets and 645 classes when this landed.
    expect(audit.stylesheetCount).toBeGreaterThan(15);
    expect(audit.markupCount).toBeGreaterThan(100);
    expect(audit.definedClassCount).toBeGreaterThan(400);
  });

  it('explains every allowance', () => {
    for (const allowance of UNSTYLED_ALLOWANCES) {
      expect(allowance.classes.length).toBeGreaterThan(0);
      expect(allowance.reason.length).toBeGreaterThan(20);
    }
  });
});

describe('the classes a stylesheet defines', () => {
  it('reads a plain rule, a media query, and a pseudo-element', () => {
    expect(isAnchored(['viewer-shell'], anchors)).toBe(true);
    expect(isAnchored(['spin'], anchors)).toBe(true);
    expect(isAnchored(['badge'], anchors)).toBe(true);
  });

  it('reads a class that is only ever a selector subject', () => {
    // `.field > span` styles the span, but `.field` is still defined.
    expect(isAnchored(['field'], anchors)).toBe(true);
  });

  it('ignores comments and declaration strings', () => {
    expect(isAnchored(['commented-out'], anchors)).toBe(false);
    expect(isAnchored(['content-string'], anchors)).toBe(false);
  });

  it('does not treat a compound-only class as styling on its own', () => {
    // `.selected` exists only as `.pick-row.selected`, so it styles nothing by
    // itself. Without this, the `body-pick-row selected` half of the FacePicker
    // defect would have looked styled.
    expect(isAnchored(['selected'], anchors)).toBe(false);
    expect(isAnchored(['body-pick-row', 'selected'], anchors)).toBe(false);
    expect(isAnchored(['pick-row', 'selected'], anchors)).toBe(true);
  });

  it('does not count a class the selector requires to be absent', () => {
    expect(isAnchored(['hidden'], anchors)).toBe(false);
    expect(isAnchored(['row'], anchors)).toBe(true);
  });
});

describe('the classes markup asks for', () => {
  it('reads a quoted attribute, either spelling', () => {
    expect(classSites('<div className="viewer-shell" />')).toEqual([
      { line: 1, classes: ['viewer-shell'] }
    ]);
    expect(classSites('<div class="pick-list muted" />')).toEqual([
      { line: 1, classes: ['muted', 'pick-list'] }
    ]);
  });

  it('reads the literal halves of a template and a conditional', () => {
    expect(
      classSites("<button className={`pick-row${on ? ' selected' : ''}`} />")
    ).toEqual([{ line: 1, classes: ['pick-row', 'selected'] }]);
    expect(
      classSites("<div className={open ? 'expanded' : 'collapsed'} />")
    ).toEqual([{ line: 1, classes: ['collapsed', 'expanded'] }]);
  });

  it('reads an imperative assignment', () => {
    expect(classSites("element.className = 'callout-value';")).toEqual([
      { line: 1, classes: ['callout-value'] }
    ]);
  });

  it('skips a class list it cannot see', () => {
    // Nothing to check, and guessing would only invent findings.
    expect(classSites('<div className={classes} />')).toEqual([]);
    expect(classSites('element.className = className;')).toEqual([]);
    expect(classSites('<div className={`${base}`} />')).toEqual([]);
  });

  it('reports the line the attribute sits on', () => {
    const source = [
      'const a = 1;',
      '',
      '<div',
      '  className="pick-list"',
      '/>'
    ];
    expect(classSites(source.join('\n'))).toEqual([
      { line: 4, classes: ['pick-list'] }
    ]);
  });

  it('does not mistake an identifier ending in class for an attribute', () => {
    expect(classSites("const rowClassName = 'not-a-site';")).toEqual([]);
  });

  it('keeps a nested interpolation from swallowing the rest of the file', () => {
    const source =
      "<div className={`a ${x ? `${y}` : ''}`} />\n<div className='pick-list' />";
    expect(classSites(source).at(-1)).toEqual({
      line: 2,
      classes: ['pick-list']
    });
  });

  it('reads only the literals out of an expression', () => {
    expect(literalSegments("cx('a', flag && 'b', other)")).toEqual(['a', 'b']);
  });
});

describe('the four defects this guard exists for', () => {
  const broken = [
    ['<div className="viewer" />', 'lazy viewport fallback'],
    ['<LoaderCircle className="spinner" />', 'export dialog loader'],
    ['<div className="body-picker" />', 'face picker list'],
    [
      "<button className={`body-pick-row${on ? ' selected' : ''}`} />",
      'face picker row'
    ],
    ['<label className="form-field" />', 'hole style label']
  ] as const;

  const fixed = [
    '<div className="viewer-shell" />',
    '<LoaderCircle className="spin" />',
    '<div className="pick-list" />',
    "<button className={`pick-row${on ? ' selected' : ''}`} />",
    '<label className="field" />'
  ];

  it.each(broken)('flags %s (%s)', (markup) => {
    const [site] = classSites(markup);
    expect(site).toBeDefined();
    expect(isAnchored(site!.classes, anchors)).toBe(false);
  });

  it.each(fixed)('passes %s', (markup) => {
    const [site] = classSites(markup);
    expect(site).toBeDefined();
    expect(isAnchored(site!.classes, anchors)).toBe(true);
  });
});
