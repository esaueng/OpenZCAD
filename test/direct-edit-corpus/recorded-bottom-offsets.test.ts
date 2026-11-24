import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, replayCommands } from '@openzcad/command-system';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, FaceTopology } from '@openzcad/shared';

import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import { GENERIC_REFUSAL } from '../../apps/web/src/lib/refusalLanguage';
import { coldSync, sync, type Session } from '../support/combination-matrix';
import { runChainDetailed, type ChainCell } from './chain-generator';
import { LADDERS, ladderCommand, ladderFaces } from './distance-ladder';
import {
  assertSolid,
  expectVolume,
  faceCensus,
  sameSnapshot
} from './ladder-oracles';
import { LADDER_REFUSAL_PINS } from './pins';
import {
  BASE_CHAMFER,
  BOX,
  POST,
  referencePart,
  type ReferencePart
} from './reference-parts';
import { faceSelector } from './resolve';

/**
 * CAD part QA P0, observation O2: the recording applied "Offset face by
 * −18 mm" on the bottom face and later refused −14 mm on it. A larger move
 * building where a smaller one refuses breaks the monotonic rule, and the
 * older kernel could report success on a wrong solid, so success alone
 * proves nothing: every leg that builds is checked for where the face went,
 * its footprint and the volume it removed.
 *
 * Two starting revisions, each paired on the same bottom face:
 *
 * - `twin`: Part A as authored, whose census matches the recorded part
 *   (`reference-ladder.test.ts`). Its 12 mm plate puts both moves past the
 *   9 mm inward limit (plate depth − root blend − base chamfer).
 * - `deep`: the same construction on a 30 mm plate, so both moves sit inside
 *   the limit (27 mm) and the pair tests the monotonic rule where a build is
 *   expected rather than where both legs must refuse.
 *
 * The recorded session's own state between the two moves is not available
 * here; it is reproduced only from a private Save reproduction capture.
 */
const DISTANCES = [-14, -18] as const;
const TIMEOUT = 60_000;
const DEEP = { depth: 30, postHeight: 42 };
const bottomLadder = LADDERS.find(
  (ladder) => ladder.part === 'A' && ladder.target === 'bottom'
)!;
const chamferPin = LADDER_REFUSAL_PINS.find(
  (pin) => pin.target === 'A/bottom'
)!;

let session: Session;
const parts = new Map<'twin' | 'deep', ReferencePart>();
beforeAll(async () => {
  session = {
    adapter: await createExactKernelAdapter(),
    deadline: Date.now() + TIMEOUT
  };
  parts.set('twin', await referencePart(session, 'A'));
  parts.set('deep', await referencePart(session, 'A', DEEP));
}, TIMEOUT);
afterAll(() => session?.adapter.dispose());

const planes = (body: BodyRepresentation, z: -1 | 1) =>
  body.topology!.faces.filter(
    (face) =>
      face.geometry?.surfaceType === 'plane' && face.geometry.normal?.z === z
  );
const cones = (body: BodyRepresentation) =>
  body.topology!.faces.filter((face) => face.geometry?.surfaceType === 'cone');

type Leg = { outcome: 'built' | 'refused'; body: BodyRepresentation };

/** The monotonic rule on the pair: −14 builds whenever −18 does. */
function expectMonotonic([smaller, larger]: Leg[]): void {
  if (larger!.outcome === 'built') expect(smaller!.outcome).toBe('built');
}

async function offsetBottom(
  part: ReferencePart,
  distance: number
): Promise<Leg> {
  session.deadline = Date.now() + TIMEOUT;
  const faces = ladderFaces(part, bottomLadder);
  const command = ladderCommand(part, bottomLadder, faces, distance);
  const draft = new CommandManager(part.document);
  draft.execute(command);
  const derived = await sync(session, draft.document, part.bodyId, {
    proposeCarry: true
  });
  const failure = derived.featureWarnings?.find(
    (warning) => warning.kind === 'build-failed' || warning.kind === 'refusal'
  );
  if (failure) {
    const rejection = validatedFeatureRejection({
      featureName: failure.featureName,
      featureId: failure.featureId,
      bodyPresent: derived.bodyRepresentations[part.bodyId] !== undefined,
      warnings: derived.warnings,
      featureWarnings: derived.featureWarnings,
      documentMoved: false
    });
    expect(rejection?.message).not.toBe(GENERIC_REFUSAL);
    expect(rejection?.message).toBe(chamferPin.message);
    expect(failure.kernelRefusal).toMatchObject({
      family: chamferPin.family,
      category: chamferPin.category,
      code: chamferPin.code
    });
    // A refusal changes nothing: the starting revision rebuilds as it was.
    const kept = await sync(session, part.document, part.bodyId);
    sameSnapshot(kept.bodyRepresentations[part.bodyId]!, part.body);
    return { outcome: 'refused', body: part.body };
  }

  const after = derived.bodyRepresentations[part.bodyId]!;
  const [bottom] = faces as [FaceTopology];
  const moved = planes(after, -1);
  // Face position: the one bottom plane, moved in by |distance|.
  expect(moved).toHaveLength(1);
  expect(moved[0]!.geometry!.center.z).toBeCloseTo(-distance, 7);
  // Footprint: the same outline, translated. The base chamfer's conical
  // corners travel with it rather than being rebuilt, so the cut-away slab
  // is a prism of the unchamfered plate section.
  expect(moved[0]!.geometry!.area).toBeCloseTo(bottom.geometry!.area, 6);
  expect(moved[0]!.geometry!.center.x).toBeCloseTo(
    bottom.geometry!.center.x,
    7
  );
  expect(moved[0]!.geometry!.center.y).toBeCloseTo(
    bottom.geometry!.center.y,
    7
  );
  expect(cones(after)).toHaveLength(6);
  for (const cone of cones(after))
    expect(cone.geometry!.center.z).toBeCloseTo(BASE_CHAMFER / 2 - distance, 7);
  // The opposite end did not move.
  expect(
    planes(after, 1)
      .map((face) => face.geometry!.center.z)
      .sort()
  ).toEqual(
    planes(part.body, 1)
      .map((face) => face.geometry!.center.z)
      .sort()
  );
  expect(faceCensus(after)).toEqual(faceCensus(part.body));
  // Volume: the slab removed is the plate section times the distance.
  expectVolume(after.volume, part.body.volume + part.baseSection! * distance);
  await assertSolid(session, draft.document, after);
  const replayed = replayCommands(
    part.document,
    draft.document.commandLog.slice(part.document.commandLog.length)
  );
  sameSnapshot(
    (await coldSync(session, replayed, part.bodyId)).bodyRepresentations[
      part.bodyId
    ]!,
    after
  );
  return { outcome: 'built', body: after };
}

describe('O2: bottom-face −14 / −18 mm from one starting revision', () => {
  it(
    'refuses both moves on the recorded-census twin with the typed chamfer-carry reason',
    async () => {
      const twin = parts.get('twin')!;
      // Both moves pass the plate's 9 mm inward limit.
      expect(BOX.depth).toBe(12);
      const legs = [];
      for (const distance of DISTANCES)
        legs.push(await offsetBottom(twin, distance));
      expect(legs.map((leg) => leg.outcome)).toEqual(['refused', 'refused']);
      expectMonotonic(legs);
    },
    TIMEOUT
  );

  it(
    'builds both moves inside the limit on a deeper plate, each the right solid',
    async () => {
      const deep = parts.get('deep')!;
      expect(
        planes(deep.body, 1)
          .map((f) => f.geometry!.center.z)
          .sort()
      ).toEqual([DEEP.depth, DEEP.postHeight].sort());
      const legs = [];
      for (const distance of DISTANCES)
        legs.push(await offsetBottom(deep, distance));
      expect(legs.map((leg) => leg.outcome)).toEqual(['built', 'built']);
      expectMonotonic(legs);
      // −18 on a 30 mm plate leaves the twin's 12 mm plate and 24 mm post.
      expectVolume(legs[1]!.body.volume, parts.get('twin')!.body.volume);
      expect(POST.height).toBe(DEEP.postHeight - (DEEP.depth - BOX.depth));
    },
    TIMEOUT
  );

  // A seeded single-step chain per leg on the twin, so the chain oracles
  // (typed, explained, unchanged, pinned) hold the −14 mm refusal too. The
  // recorded session's own state is not reconstructed here; that needs a
  // Save reproduction capture, kept out of the repository.
  it(
    'keeps the −14 mm refusal as a seeded chain regression',
    async () => {
      const face = faceSelector(
        ladderFaces(parts.get('twin')!, bottomLadder)[0]!
      );
      for (const distance of DISTANCES) {
        const cell: ChainCell = {
          id: `A/o2-bottom${distance}/1`,
          part: 'A',
          seed: 14,
          length: 1,
          steps: [
            { kind: 'offset-face', stepId: 'step-0', face, offset: distance }
          ]
        };
        const run = await runChainDetailed(session.adapter, cell);
        expect(run.outcome.state, run.outcome.evidence).toBe('qualified');
        expect(
          run.executed.map(({ status, pin, kernelRefusal }) => ({
            status,
            pin,
            code: kernelRefusal?.code
          }))
        ).toEqual([
          { status: 'refused', pin: 'chamfer-rim', code: chamferPin.code }
        ]);
      }
    },
    2 * TIMEOUT
  );
});
