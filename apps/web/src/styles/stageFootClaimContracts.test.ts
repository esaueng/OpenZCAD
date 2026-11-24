import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Floating surfaces sharing a narrow stage (design review 16 Nov 2026).
 * happy-dom computes no layout, so `test/e2e/phone-panel-conflicts.spec.ts`
 * measures the stage at 390 × 844; these pin what it rests on.
 */
const componentsDir = resolve(__dirname, 'components');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const read = (name: string) =>
  stripComments(readFileSync(join(componentsDir, name), 'utf8'));

/** The bodies of every `@media` block whose prelude is exactly `query`. */
function mediaBlock(css: string, query: string): string {
  const bodies: string[] = [];
  let at = css.indexOf(`@media ${query} {`);
  if (at < 0) throw new Error(`No @media ${query}`);
  while (at >= 0) {
    const open = css.indexOf('{', at);
    let depth = 0;
    let index = open;
    for (; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}' && --depth === 0) break;
    }
    if (index >= css.length) throw new Error(`Unclosed @media ${query}`);
    bodies.push(css.slice(open + 1, index));
    at = css.indexOf(`@media ${query} {`, index);
  }
  return bodies.join('\n');
}

describe('the stage’s foot claim', () => {
  it('is the highest of the surfaces that publish one', () => {
    expect(read('quiet-stage.css')).toMatch(
      /\.viewer-area \{\s*--stage-foot-claim:\s*max\(\s*var\(--workspace-tour-claim, 0px\),\s*var\(--motion-timeline-claim, 0px\)\s*\);/
    );
  });

  it('lifts a phone’s panel above the modeling guide (UX-001)', () => {
    const block = mediaBlock(read('quiet-stage.css'), '(max-width: 520px)');
    const lane =
      /\.viewer-area \.stage-right:has\(> \.panel-lane-float\) \{([^}]*)\}/.exec(
        block
      )?.[1];
    expect(lane).toBeDefined();
    expect(lane).toMatch(
      /--panel-lane-bottom:\s*max\(\s*calc\(var\(--lane-base\) \+ 40px\),\s*calc\(var\(--stage-foot-claim\) \+ var\(--island-gap\)\)\s*\)/
    );
    expect(lane).toMatch(/bottom:\s*var\(--panel-lane-bottom\)/);
    expect(lane).toMatch(
      /max-height:\s*min\(\s*40dvh,\s*calc\(100% - var\(--stage-top\) - var\(--panel-lane-bottom\)\)\s*\)/
    );
  });

  it('lets a command card in a phone’s panel lane shrink into the stage', () => {
    // Held at full height inside the 40dvh lane, the measurement workbench
    // ran past the lane's foot and off a 360 × 640 screen (PR review).
    const block = mediaBlock(read('quiet-stage.css'), '(max-width: 520px)');
    // The feature card a History row opens takes the same lane (#2002).
    expect(block).toMatch(
      /\.viewer-area:is\(\.has-command, \.has-inspector\)\s+\.stage-right:has\(> \.panel-lane-float\) \{\s*max-height:\s*calc\(100% - var\(--stage-top\) - var\(--panel-lane-bottom\)\);\s*\}/
    );
    expect(block).toMatch(
      /\.viewer-area\.has-command\s+\.stage-right:has\(> \.panel-lane-float\)\s+> \.command-float \{\s*flex-shrink:\s*1;\s*min-height:\s*0;\s*\}/
    );
    // The panel gives way before the card does.
    expect(block).toMatch(
      /\.viewer-area:is\(\.has-command, \.has-inspector\)\s+\.stage-right\s+> \.panel-lane-float \{\s*flex-shrink:\s*1000;\s*\}/
    );
  });

  it('shrinks a phone’s feature card into the lane it shares with a panel', () => {
    // Its max-height: 100% never resolved in the content-sized lane, and at
    // 430 × 932 the card ran over the command bar and off the screen (#2002).
    const block = mediaBlock(read('quiet-stage.css'), '(max-width: 520px)');
    expect(block).toMatch(
      /\.stage-right:has\(> \.panel-lane-float\) > \.inspector-float \{\s*flex-direction:\s*column;\s*align-items:\s*stretch;\s*\}/
    );
    // The panel it pushes down to nothing draws nothing past its float.
    expect(block).toMatch(
      /\.viewer-area\.has-inspector \.stage-right > \.panel-lane-float \{\s*overflow:\s*hidden;\s*\}/
    );
  });

  it('ends Assemble’s narrow sidebar above the timeline (UX-003)', () => {
    const block = mediaBlock(read('motion-study.css'), '(max-width: 620px)');
    expect(block).toMatch(
      /\.assembly-panel-float \{[^}]*bottom:\s*max\([^;]*var\(--stage-foot-claim, 0px\) \+ var\(--island-gap\)/
    );
  });

  it('leaves the wide stage’s sidebar where it was', () => {
    // Outside the narrow rule the timeline starts past the sidebar.
    expect(read('assembly.css')).toMatch(
      /\.assembly-panel-float \{[^}]*bottom:\s*calc\(var\(--island-gap\) \* 2 \+ var\(--readout-reserve, 0px\)\);/
    );
  });
});

describe('a measurement’s actions on touch (UX-010)', () => {
  it('take their own line under the value instead of the 108px track', () => {
    const block = mediaBlock(read('touch-targets.css'), '(pointer: coarse)');
    expect(block).toMatch(
      /\.measurement-row-main \{\s*grid-template-columns:\s*minmax\(0, 1fr\);\s*\}/
    );
    const actions = /\.measurement-row-actions \{([^}]*)\}/.exec(block)?.[1];
    expect(actions).toMatch(/position:\s*static/);
    expect(actions).toMatch(/width:\s*auto/);
    // Narrower than the four, they wrap rather than lose one.
    expect(actions).toMatch(/flex-wrap:\s*wrap/);
    expect(actions).toMatch(/max-width:\s*100%;/);
    // Nothing waits for hover on touch.
    expect(actions).toMatch(/opacity:\s*1/);
    expect(actions).toMatch(/pointer-events:\s*auto/);
  });
});
