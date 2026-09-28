import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';
import { planFaceOffset } from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';

/**
 * Design review, demo Mounting Bracket: dragging the base plate's top face
 * ±10 mm ended on "The exact kernel could not build this result." Both
 * refusals are real geometry, not an identity or lineage fault — the plate is
 * 8 mm thick, and the boss's underside hangs 6 mm above the plate — and the
 * kernel refuses a face move whose sweep reaches any face it does not share an
 * edge with. The offset plan now measures both limits first and says so; these
 * pin the limits against the kernel itself, through the same plan the UI
 * commits, so the preflight can never refuse an offset the kernel builds.
 */
describe('demo bracket base-plate top face offset', () => {
  let adapter: ExactKernelAdapter;
  let bracket: ProjectDocument;
  let bodyId: BodyId;
  let top: FaceTopology;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'bracket'
    )!;
    bracket = await buildDemoDocument(
      definition,
      toUserId('user_bracket_face_offset'),
      (candidate) => adapter.syncDocument(candidate)
    );
    bodyId = bracket.derived.exportableBodyIds[0] as BodyId;
    const faces =
      bracket.derived.bodyRepresentations[bodyId]?.topology?.faces ?? [];
    top = faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99 &&
        Math.abs((face.geometry.center?.z ?? 0) - 8) < 1e-6
    )!;
  }, 120_000);

  afterAll(() => adapter.dispose());

  function plan(offset: number) {
    return planFaceOffset({
      document: bracket,
      bodyId,
      face: top,
      faceHash: top.hash,
      offset
    });
  }

  async function build(offset: number) {
    const candidate = plan(offset);
    expect(candidate).not.toBeNull();
    const document = new CommandManager(bracket).runTransaction('Offset', [
      candidate!.command
    ]);
    return adapter.syncDocument(document);
  }

  it('picks the plate top: outward +Z at plate_t, carrying lineage', () => {
    expect(top).toBeDefined();
    expect(top.geometry?.normal).toEqual({ x: 0, y: 0, z: 1 });
    // The face resolves through both unions and the fillet by reference;
    // the refusals below are not an identity failure.
    expect(top.reference?.lineageName).toMatch(/primitive\.box\.face\.z-max$/);
  });

  it.each([5, -5])(
    'builds an offset of %s mm inside both limits',
    async (offset) => {
      const candidate = plan(offset);
      expect(candidate?.kind).toBe('direct-edit');
      expect(
        (candidate as { preflightRejection?: string }).preflightRejection
      ).toBeUndefined();
      const derived = await build(offset);
      expect(derived.warnings).toEqual([]);
      const volume = derived.bodyRepresentations[bodyId]?.volume ?? 0;
      const before = bracket.derived.bodyRepresentations[bodyId]!.volume;
      // The face is 2503.45 mm² (the plate top less the two mount holes).
      expect(volume - before).toBeCloseTo(offset * 2503.45, 0);
    },
    60_000
  );

  it('explains an inward offset through the 8 mm plate before the kernel is asked', async () => {
    const candidate = plan(-10);
    expect(candidate?.kind).toBe('direct-edit');
    const rejection = (candidate as { preflightRejection?: string })
      .preflightRejection;
    expect(rejection).toBe(
      'Only 8 mm of material lies behind this face, so it cannot move 10 mm inward.'
    );
    // Adapter-written, so the card shows it as is.
    expect(plainRefusal(rejection!).message).toBe(rejection);
    // And the kernel agrees: this is a real refusal.
    expect((await build(-10)).warnings.join('\n')).toMatch(
      /swept face reaches nonadjacent face/
    );
  }, 60_000);

  it('explains an outward offset into the boss 6 mm above before the kernel is asked', async () => {
    const candidate = plan(10);
    expect(candidate?.kind).toBe('direct-edit');
    expect(
      (candidate as { preflightRejection?: string }).preflightRejection
    ).toBe(
      'Another part of the body is 6 mm in front of this face, so it cannot move 10 mm outward.'
    );
    const warnings = (await build(10)).warnings;
    expect(warnings.join('\n')).toMatch(/swept face reaches nonadjacent face/);
    // Should the kernel's own refusal ever reach the card, it now says what
    // happened rather than "could not build this result".
    expect(
      plainRefusal(warnings[0]!.replace(/^Feature "[^"]+":\s*/, '')).message
    ).toBe(
      'The face would run into another part of the body before it got that far.'
    );
  }, 60_000);

  it('never refuses an offset just inside a limit that the kernel builds', async () => {
    for (const offset of [5.9, -7.9]) {
      expect(
        (plan(offset) as { preflightRejection?: string }).preflightRejection
      ).toBeUndefined();
      expect((await build(offset)).warnings).toEqual([]);
    }
    // At the limit itself the kernel is the judge, and it refuses.
    expect((await build(-8)).warnings.join('\n')).toMatch(
      /swept face reaches nonadjacent face/
    );
    // Just past it, so does the preflight.
    expect(
      (plan(-8.1) as { preflightRejection?: string }).preflightRejection
    ).toBe(
      'Only 8 mm of material lies behind this face, so it cannot move 8.1 mm inward.'
    );
  }, 120_000);
});
