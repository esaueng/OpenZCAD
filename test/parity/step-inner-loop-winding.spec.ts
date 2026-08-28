import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { screenStepInnerLoops } from './step-inner-loop-winding';

/**
 * Which corpus fixtures carry a mis-wound inner loop, pinned.
 *
 * `a-export-bored-plate.step` is non-conformant: both its caps run their bore
 * CCW about the face's outward normal, where ISO 10303-42 wants CW. remus
 * imports it, `validate_solid` passes it, and the NEXT boolean fails — so
 * drilling into it reports "The hole cut did not produce a valid solid" and
 * blames the drill. Tracked as esaueng/remus#115; the file is a recorded
 * artifact of the kernel's own older exporter, which stamped itself `brepkit`.
 *
 * This suite exists so the inventory cannot grow silently. A new fixture with
 * the same defect is a latent failure for any test that later drills into it,
 * and nothing else in the corpus would notice: the shape imports clean, with
 * the right volume and the right face count.
 *
 * It is text screening, not geometry, so it needs no kernel and runs in
 * milliseconds despite living beside the corpus. It is here rather than in the
 * root suite because it reads corpus fixtures, and the corpus owns them.
 */

const CORPUS = new URL('corpus/', import.meta.url);

const stepFixtures = readdirSync(fileURLToPath(CORPUS))
  .filter((name) => name.endsWith('.step'))
  .sort();

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, CORPUS)), 'utf8');

/** The only corpus fixture known to carry the defect. */
const NON_CONFORMANT = 'a-export-bored-plate.step';

describe('STEP inner-loop winding', () => {
  it('finds both mis-wound caps in the known non-conformant fixture', () => {
    const { findings, screened, unscreened } = screenStepInnerLoops(
      read(NON_CONFORMANT)
    );

    expect(screened).toBe(2);
    expect(unscreened).toBe(0);
    // Both caps, and both with the circle axis pointing the same way as the
    // face normal — which is exactly what makes the bound run CCW about it.
    expect(
      findings.map((finding) => ({
        faceId: finding.faceId,
        normal: finding.normal,
        circleAxis: finding.circleAxis
      }))
    ).toEqual([
      { faceId: 63, normal: [0, 0, -1], circleAxis: [0, 0, -1] },
      { faceId: 199, normal: [0, 0, 1], circleAxis: [0, 0, 1] }
    ]);
  });

  it('clears a correctly wound bore written by the current exporter', () => {
    // The negative control, and the half that makes a null result mean
    // anything: this sample also has a circular inner bound, so a screen that
    // simply flagged every bore would fail here.
    const sample = new URL('../../samples/parametric-bracket.step', import.meta.url);
    const { findings, screened } = screenStepInnerLoops(
      readFileSync(fileURLToPath(sample), 'utf8')
    );

    expect(screened).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });

  it('holds the corpus inventory to the one fixture already known', () => {
    const offenders = stepFixtures.filter(
      (name) => screenStepInnerLoops(read(name)).findings.length > 0
    );

    expect(offenders).toEqual([NON_CONFORMANT]);
  });

  it('reports what it could not judge instead of calling it clean', () => {
    // Multi-edge inner loops need the loop's signed area, which this screen
    // does not compute. Those fixtures are UNKNOWN, not clean, and saying so
    // is the point: a silent zero here would read as corpus-wide coverage.
    const unscreened = stepFixtures
      .map((name) => [name, screenStepInnerLoops(read(name)).unscreened] as const)
      .filter(([, count]) => count > 0);

    expect(Object.fromEntries(unscreened)).toEqual({
      'e-analytic-fillet-plate.step': 6,
      'f-hostile-occt-authored-box.step': 6
    });
  });
});
