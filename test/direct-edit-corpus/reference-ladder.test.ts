import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, replayCommands } from '@openzcad/command-system';
import { listFeaturesInOrder } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type { BodyRepresentation, ProjectDocument } from '@openzcad/shared';

import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import { GENERIC_REFUSAL } from '../../apps/web/src/lib/refusalLanguage';
import {
  coldSync,
  commitWithCarry,
  refusal,
  sync,
  type Session
} from '../support/combination-matrix';
import {
  LADDERS,
  ladderCommand,
  ladderFaces,
  ladderSteps
} from './distance-ladder';
import {
  assertCylinderSourceRadius,
  assertEditedShape,
  assertSolid,
  faceCensus,
  sameSnapshot
} from './ladder-oracles';
import {
  BOX_CORNER_ONLY_STEPS,
  LADDER_LIMIT_PINS,
  LADDER_MONOTONIC_PINS,
  LADDER_REFUSAL_PINS
} from './pins';
import {
  referencePart,
  type PartName,
  type ReferencePart
} from './reference-parts';

const PARTS = ['A', 'B', 'C', 'D'] as const;
const DIRECTIONS = [-1, 1] as const;
const CELL_TIMEOUT = 30_000;
const reference = new Map<PartName, ReferencePart>();
type Outcome = 'committed' | 'refused';

function historyLengths(document: ProjectDocument) {
  return {
    features: listFeaturesInOrder(document).length,
    commands: document.commandLog.length,
    entries: document.editHistory?.entries.length ?? 0,
    cursor: document.editHistory?.cursor ?? 0
  };
}

function kernelBody(
  derived: Awaited<ReturnType<typeof sync>>,
  part: ReferencePart
): BodyRepresentation {
  expect(refusal(derived, 'rebuild')).toBeNull();
  const body = derived.bodyRepresentations[part.bodyId];
  expect(body?.topology).toBeDefined();
  return body!;
}

let session: Session;
beforeAll(async () => {
  session = {
    adapter: await createExactKernelAdapter(),
    deadline: Date.now() + CELL_TIMEOUT
  };
  for (const name of PARTS)
    reference.set(name, await referencePart(session, name));
}, CELL_TIMEOUT);
afterAll(() => session?.adapter.dispose());

it('preserves the authored part A surface census', () => {
  // Synthetic construction census. The recorded part's census is still
  // needed for the independent comparison called for by the plan.
  expect(faceCensus(reference.get('A')!.body)).toEqual([
    'cone',
    ...Array<string>(12).fill('cylinder'),
    ...Array<string>(7).fill('plane'),
    ...Array<string>(8).fill('sphere'),
    'torus',
    'torus'
  ]);
});

for (const ladder of LADDERS) {
  const target = `${ladder.part}/${ladder.target}`;
  describe(target, () => {
    const outcomes = new Map<number, Outcome>();
    for (const sign of DIRECTIONS) {
      for (const distance of ladderSteps(ladder, sign)) {
        it(
          `${distance} mm`,
          async () => {
            session.deadline = Date.now() + CELL_TIMEOUT;
            const part = reference.get(ladder.part)!;
            const faces = ladderFaces(part, ladder);
            const command = ladderCommand(part, ladder, faces, distance);
            const before = new CommandManager(part.document);
            const lengths = historyLengths(before.document);
            const draft = new CommandManager(before.document);
            draft.execute(command);
            const derived = await sync(session, draft.document, part.bodyId, {
              proposeCarry: true
            });
            const failure = derived.featureWarnings?.find(
              (warning) =>
                warning.kind === 'build-failed' || warning.kind === 'refusal'
            );
            const pin = LADDER_REFUSAL_PINS.find(
              (entry) =>
                entry.target === target && entry.distances.includes(distance)
            );
            if (failure) {
              outcomes.set(distance, 'refused');
              const rejection = validatedFeatureRejection({
                featureName: failure.featureName,
                featureId: failure.featureId,
                bodyPresent:
                  derived.bodyRepresentations[part.bodyId] !== undefined,
                warnings: derived.warnings,
                featureWarnings: derived.featureWarnings,
                documentMoved: false
              });
              expect(rejection?.message).toBeTruthy();
              expect(rejection?.message).not.toBe(GENERIC_REFUSAL);
              expect(failure.kernelRefusal).toBeDefined();
              expect(pin, rejection?.message).toBeDefined();
              expect(rejection?.message).toBe(pin!.message);
              expect(failure.kernelRefusal).toMatchObject({
                family: pin!.family,
                category: pin!.category,
                code: pin!.code
              });
              expect(before.document).toBe(part.document);
              expect(historyLengths(before.document)).toEqual(lengths);
              sameSnapshot(
                kernelBody(
                  await sync(session, before.document, part.bodyId),
                  part
                ),
                part.body
              );
              if (target === 'D/wall')
                await assertCylinderSourceRadius(session, distance);
              return;
            }

            outcomes.set(distance, 'committed');
            expect(pin, 'The pinned refusal now builds').toBeUndefined();
            const after = kernelBody(derived, part);
            expect(
              derived.featureWarnings?.filter((warning) =>
                /approximate/i.test(warning.message)
              ) ?? []
            ).toEqual([]);
            const commit = await commitWithCarry(
              session,
              before.document,
              command.label,
              [command],
              derived,
              part.bodyId
            );
            if ('stopped' in commit) throw new Error(commit.stopped.evidence);
            const { manager } = commit;
            expect(historyLengths(manager.document)).toMatchObject({
              features: lengths.features + 1,
              entries: lengths.entries + 1,
              cursor: lengths.cursor + 1
            });
            const cornerOnly =
              target === 'B/edge-round' &&
              BOX_CORNER_ONLY_STEPS.includes(distance);
            await assertSolid(session, manager.document, after, cornerOnly);
            await assertEditedShape(
              session,
              part,
              ladder,
              faces,
              distance,
              after,
              cornerOnly
            );

            const serialized = manager.document.commandLog.slice(
              lengths.commands
            );
            const replayed = replayCommands(before.document, serialized);
            sameSnapshot(
              kernelBody(await coldSync(session, replayed, part.bodyId), part),
              after
            );

            manager.undo();
            expect(historyLengths(manager.document).features).toBe(
              lengths.features
            );
            sameSnapshot(
              kernelBody(
                await sync(session, manager.document, part.bodyId),
                part
              ),
              part.body
            );
            manager.redo();
            sameSnapshot(
              kernelBody(
                await sync(session, manager.document, part.bodyId),
                part
              ),
              after
            );
          },
          CELL_TIMEOUT
        );
      }
    }

    it('checks the geometric limits and the monotonic rule in each direction', () => {
      const departures: number[] = [];
      const nonmonotonic: Array<{
        firstRefusal: number;
        laterSuccesses: number[];
      }> = [];
      for (const sign of DIRECTIONS) {
        const steps = ladderSteps(ladder, sign);
        const limit = sign < 0 ? ladder.inward : ladder.outward;
        const firstRefusal = steps.findIndex(
          (distance) => outcomes.get(distance) === 'refused'
        );
        expect(steps.filter((distance) => !outcomes.has(distance))).toEqual([]);
        departures.push(
          ...steps.filter((distance) => {
            const below = limit === null || Math.abs(distance) < limit;
            return below !== (outcomes.get(distance) === 'committed');
          })
        );
        if (firstRefusal < 0) continue;
        const laterSuccesses = steps
          .slice(firstRefusal + 1)
          .filter((distance) => outcomes.get(distance) === 'committed');
        if (laterSuccesses.length)
          nonmonotonic.push({
            firstRefusal: steps[firstRefusal]!,
            laterSuccesses
          });
      }
      expect(departures).toEqual(
        LADDER_LIMIT_PINS.find((pin) => pin.target === target)?.distances ?? []
      );
      expect(nonmonotonic).toEqual(
        LADDER_MONOTONIC_PINS.filter((pin) => pin.target === target).map(
          ({ firstRefusal, laterSuccesses }) => ({
            firstRefusal,
            laterSuccesses
          })
        )
      );
    });
  });
}

it('each ladder pin applies to exactly one measured cell or direction', () => {
  const targets = new Set(
    LADDERS.map((ladder) => `${ladder.part}/${ladder.target}`)
  );
  const cells = new Set(
    LADDERS.flatMap((ladder) =>
      DIRECTIONS.flatMap((sign) =>
        ladderSteps(ladder, sign).map(
          (distance) => `${ladder.part}/${ladder.target}/${distance}`
        )
      )
    )
  );
  const pinned = LADDER_REFUSAL_PINS.flatMap((pin) =>
    pin.distances.map((distance) => `${pin.target}/${distance}`)
  );
  expect(pinned.filter((cell) => !cells.has(cell))).toEqual([]);
  expect(new Set(pinned).size).toBe(pinned.length);
  expect(
    [...LADDER_LIMIT_PINS, ...LADDER_MONOTONIC_PINS].filter(
      (pin) => !targets.has(pin.target)
    )
  ).toEqual([]);
});
