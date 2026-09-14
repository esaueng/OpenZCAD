import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The chain that stops an exact section describing geometry the viewport is
 * not drawing.
 *
 * Three mechanisms have broken that in turn — a preview document, an
 * unapplied parameter edit, and the Move gizmo posing a body's mesh straight
 * into the scene — and the first two were fixed by declaring themselves to
 * the section. The third could not be: posing a mesh is three lines against
 * an `Object3D` inside a pointer handler, and a fourth mechanism is under no
 * obligation to announce itself either.
 *
 * So the section no longer asks the mechanisms. The viewer samples the body
 * objects in the frame it is about to draw and reports which of them are not
 * where the document built them; the workspace folds that into the one value
 * the section derives from. Every link of that is behaviour no unit test can
 * see without a GPU, and every link is one edit away from being dropped —
 * which is what this file is for. These are source assertions on purpose:
 * `test/css-class-coverage.test.ts` guards the styling contract the same way,
 * for the same reason.
 */

function source(path: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${path}`, import.meta.url)),
    'utf8'
  );
}

const VIEWER = 'apps/web/src/components/ModelViewer.tsx';
const SHELL = 'apps/web/src/components/ViewerShell.tsx';
const WORKSPACE = 'apps/web/src/App.tsx';
const SECTION = 'apps/web/src/lib/sectionOutline.ts';

describe('the viewer reports what it drew, in the frame it drew it', () => {
  it('samples the body objects before the frame is rendered', () => {
    const viewer = source(VIEWER);
    const sampled = viewer.indexOf('drawnBodyReport.sample(');
    const drawn = viewer.indexOf('renderer.render(');

    // Before the draw, in the same function as the draw. Anything that poses
    // a body has to have done it by then, or the frame would not show the
    // pose — that ordering is the whole guarantee, so it is asserted rather
    // than left to a reviewer to notice it has been moved.
    expect(sampled).toBeGreaterThan(-1);
    expect(drawn).toBeGreaterThan(-1);
    expect(sampled).toBeLessThan(drawn);
    expect(viewer).toContain(
      'onBodiesDrawnElsewhereRef.current?.(drawnElsewhere)'
    );
  });

  it('forgets the scene it is torn down with', () => {
    // Otherwise a disposed viewer's last pose outlives it and every later
    // section is refused until the page is reloaded.
    expect(source(VIEWER)).toContain(
      'onBodiesDrawnElsewhereRef.current?.(drawnBodyReport.reset())'
    );
  });

  it('is carried from the viewer to the workspace and back into the view', () => {
    expect(source(SHELL)).toContain(
      'onBodiesDrawnElsewhere={onBodiesDrawnElsewhere}'
    );
    const workspace = source(WORKSPACE);
    expect(workspace).toContain(
      'onBodiesDrawnElsewhere={setBodiesDrawnElsewhere}'
    );
    // Into the one value the section derives its source from...
    expect(workspace).toContain('drawnElsewhere: bodiesDrawnElsewhere');
    // ...and into what takes a drawn section down when that value changes.
    expect(workspace).toContain('viewportGeometry.drawnElsewhere');
  });
});

describe('the section reads every field of what is on screen', () => {
  it('keeps the compile-time check that says so', () => {
    // `SectionReadsEveryViewportField` resolves to `false` — and this file
    // stops compiling — when a field is added to ViewportGeometry without
    // being classified. It is load-bearing and deletable in one keystroke,
    // so its absence fails here rather than silently reopening the hole.
    const section = source(SECTION);
    expect(section).toContain(
      'export const sectionReadsEveryViewportField: SectionReadsEveryViewportField'
    );
    expect(section).toMatch(
      /Exclude<keyof ViewportGeometry, SectionReadViewportField> extends never/
    );
  });

  it('derives the source from the whole value, not from named cases', () => {
    // A refusal written per mechanism ("...unless it is the Move tool") is
    // how instance four gets written. The rule reads the value's fields.
    expect(source(SECTION)).toContain(
      'const { document, bodies, standIns, drawnElsewhere } = view;'
    );
  });
});
