import { describe, expect, it } from 'vitest';
import { RemusKernel } from './remus-runtime';
import {
  BlendRefusal,
  blendOutcome,
  blendRefusalOf,
  blendReportIsVertexBlend,
  reportBlendRefusal
} from './exact-blend-refusal';
import { kernelRefusalCategoryOf, kernelRefusalOf } from './kernel-refusal';
import {
  applyEdgeModifier,
  edgeModifierFailureMessage
} from './exact-edge-modifiers';

/**
 * The typed blend contract, against the pinned kernel.
 *
 * `filletDetailed` / `chamferDetailed` / `chamferDistanceAngleDetailed`
 * answer as data — a status, a stable `blend_failure_code` code and a
 * category from the shared taxonomy — where the bare calls threw prose.
 * Measured on the pin, this family produces two refusal categories:
 * `internal` for the structural cases (the support-face cliff, the
 * shared-corner vertex blend, the refused-edge subset) and `invalid_input`
 * for malformed requests. Any other category is unobserved on this pin and
 * therefore unasserted rather than guessed.
 */
describe('typed blend outcome', { timeout: 60_000 }, () => {
  it('returns the solid on the success path', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    for (const outcome of [
      blendOutcome(kernel, 'fillet', box, Uint32Array.from([edge]), 2),
      blendOutcome(kernel, 'chamfer', box, Uint32Array.from([edge]), 2),
      blendOutcome(
        kernel,
        'chamferDistanceAngle',
        box,
        Uint32Array.from([edge]),
        2,
        Math.PI / 4
      )
    ]) {
      expect(outcome.status).toBe('ok');
      if (outcome.status === 'ok') {
        expect(kernel.validateSolidRelaxed(outcome.solid)).toBe(0);
      }
    }
  });

  it('refuses an unfittable radius as internal with the cliff code', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    const outcome = blendOutcome(
      kernel,
      'fillet',
      box,
      Uint32Array.from([edge]),
      30
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') {
      return;
    }
    expect(outcome.refusal).toBeInstanceOf(BlendRefusal);
    expect(outcome.refusal.family).toBe('blend');
    expect(outcome.refusal.operation).toBe('fillet');
    expect(outcome.refusal.category).toBe('internal');
    expect(outcome.refusal.kernelCode).toBe('cliff-encountered');
  });

  it('refuses a corner-defeated selection as internal with the vertex code', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    // Every edge at once: measured on the pin, the walking engine gives up
    // at a shared corner at every size from r9 up.
    const all = Array.from(kernel.getSolidEdges(box));

    const outcome = blendOutcome(
      kernel,
      'fillet',
      box,
      Uint32Array.from(all),
      30
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') {
      return;
    }
    expect(outcome.refusal.category).toBe('internal');
    expect(outcome.refusal.kernelCode).toBe('unsupported-vertex-blend');
  });

  it('refuses a partially blendable selection with the subset code', () => {
    const kernel = new RemusKernel();
    const host = kernel.makeBox(30, 18, 24);
    const tool = kernel.copySolid(kernel.makeCylinder(14, 28));
    kernel.transformSolid(
      tool,
      Float64Array.from([1, 0, 0, 15, 0, 1, 0, 9, 0, 0, 1, -2, 0, 0, 0, 1])
    );
    const notched = kernel.cut(host, tool);
    const edges = Array.from(kernel.getSolidEdges(notched));
    expect(edges.length).toBeGreaterThan(12);

    const outcome = blendOutcome(
      kernel,
      'fillet',
      notched,
      Uint32Array.from(edges),
      2
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') {
      return;
    }
    expect(outcome.refusal.category).toBe('internal');
    expect(outcome.refusal.kernelCode).toBe('edges-not-blended');
  });

  it('refuses malformed requests as invalid_input', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    const cases = [
      blendOutcome(kernel, 'fillet', box, Uint32Array.from([999999]), 2),
      blendOutcome(kernel, 'fillet', box, Uint32Array.from([edge]), -1),
      // A setback deeper than the edge it cuts from.
      blendOutcome(kernel, 'chamfer', box, Uint32Array.from([edge]), 30),
      blendOutcome(
        kernel,
        'chamferDistanceAngle',
        box,
        Uint32Array.from([edge]),
        20,
        (80 * Math.PI) / 180
      )
    ];
    for (const outcome of cases) {
      expect(outcome.status).toBe('refused');
      if (outcome.status !== 'refused') {
        continue;
      }
      expect(outcome.refusal.family).toBe('blend');
      expect(outcome.refusal.category).toBe('invalid_input');
      expect(outcome.refusal.kernelCode.length).toBeGreaterThan(0);
    }
    expect(
      cases.every(
        (outcome) =>
          outcome.status === 'refused' &&
          outcome.refusal.category === 'invalid_input'
      )
    ).toBe(true);
  });

  it('is found through a wrapping cause chain by category', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;

    const outcome = blendOutcome(
      kernel,
      'fillet',
      box,
      Uint32Array.from([edge]),
      30
    );
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') {
      return;
    }
    const wrapped = new Error('fillet feature failed', {
      cause: outcome.refusal
    });
    expect(blendRefusalOf(wrapped)).toBe(outcome.refusal);
    expect(kernelRefusalOf(wrapped)).toBe(outcome.refusal);
    expect(kernelRefusalCategoryOf(wrapped)).toBe('internal');
  });
});

/**
 * The report string is byte-identical to what the bare calls threw, so the
 * two still-allowlisted readers (the refused-edge counts, the cliff ceiling)
 * keep working without touching an untyped call. Pinned by comparing the
 * two live on the pin rather than by quoting kernel prose here.
 */
describe('blend refusal report compatibility', { timeout: 60_000 }, () => {
  it('reconstructs the legacy throw for every structural shape', () => {
    const kernel = new RemusKernel();
    const box = kernel.makeBox(30, 18, 24);
    const edge = Array.from(kernel.getSolidEdges(box))[0]!;
    const all = Array.from(kernel.getSolidEdges(box));

    const legacyThrow = (run: () => number): string => {
      try {
        run();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('The legacy call was expected to refuse.');
    };

    const cliff = blendOutcome(
      kernel,
      'fillet',
      box,
      Uint32Array.from([edge]),
      30
    );
    expect(cliff.status).toBe('refused');
    if (cliff.status === 'refused') {
      expect(reportBlendRefusal(cliff.refusal)).toBe(
        legacyThrow(() => kernel.fillet(box, Uint32Array.from([edge]), 30))
      );
    }

    const vertex = blendOutcome(
      kernel,
      'fillet',
      box,
      Uint32Array.from(all),
      30
    );
    expect(vertex.status).toBe('refused');
    if (vertex.status === 'refused') {
      expect(reportBlendRefusal(vertex.refusal)).toBe(
        legacyThrow(() => kernel.fillet(box, Uint32Array.from(all), 30))
      );
    }
  });
});

/**
 * The shared-corner cause reads the typed code, not the sentence.
 *
 * `blendReportIsVertexBlend` matches the stable `blend_failure_code`
 * prefix the typed refusal carries. A report whose detail happens to
 * contain the same English WITHOUT that code prefix must not claim the
 * cause — that is the regression a return to substring matching would
 * introduce, and this is the test that fails if it does.
 */
describe(
  'shared-corner cause without prose matching',
  { timeout: 60_000 },
  () => {
    it('fires on the code prefix, never on the sentence', () => {
      expect(
        blendReportIsVertexBlend(
          'unsupported-vertex-blend: blend: unsupported vertex blend at Id(8): 2 stripes meet'
        )
      ).toBe(true);
      expect(
        blendReportIsVertexBlend(
          'blend: unsupported vertex blend at Id(8): 2 stripes meet'
        )
      ).toBe(false);
      expect(blendReportIsVertexBlend(null)).toBe(false);
      expect(blendReportIsVertexBlend('')).toBe(false);
    });

    it('names the shared corner end to end from the typed refusal', () => {
      const kernel = new RemusKernel();
      const box = kernel.makeBox(30, 18, 24);
      const all = Array.from(kernel.getSolidEdges(box));

      // An extreme size so every ladder rung (288, 72, 9) refuses alongside
      // the request: measured on the pin, the whole selection is
      // vertex-refused from r9 up, which is what lets the message reach past
      // the size-bound branch to the structural cause.
      let reported: string | null = null;
      expect(
        applyEdgeModifier(kernel, box, all, 'fillet', 576, (message) => {
          reported = message;
        })
      ).toBeNull();
      expect(reported).not.toBeNull();
      expect(blendReportIsVertexBlend(reported)).toBe(true);

      const message = edgeModifierFailureMessage(
        kernel,
        box,
        all,
        'fillet',
        576,
        false,
        reported
      );
      expect(message).toContain(
        'Fillet could not be created on 12 selected edges with radius 576.'
      );
      expect(message).toContain(
        'Two of these rounds would run into each other at a shared corner'
      );
    });
  }
);
