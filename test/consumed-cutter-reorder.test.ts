/**
 * #2334 (ADR-025): a History reorder must not move a cutter's placement past
 * the Subtract that consumes the cutter.
 *
 * Every id the placement reads is still produced in time after that move, so
 * the order gate passed and the reorder committed. The Subtract then consumed
 * the cylinder where it was created, the placement edited a body the history
 * had already replaced, and STEP export wrote the vent at the origin, open to
 * the stock's corner, behind one advisory in Diagnostics.
 *
 * The move is now refused, naming the placed body and its consumer, with the
 * order and the exported solid left as they were. A reorder of independent
 * steps still commits and exports the same DATA, and a stored history that
 * already holds the fork replays, reports it, and can be put right.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  HISTORY,
  PLACEMENT,
  REFUSAL,
  SUBTRACT,
  VENT,
  VENT_BODY,
  historyNames,
  stepCylinders,
  stepData,
  ventedBlock
} from './support/history-reorder';

describe('reordering a cutter placement past its consuming Subtract', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  /** The STEP export of everything the document shows, and its warnings. */
  async function exported(document: ProjectDocument) {
    const derived = await adapter.syncDocument(document);
    const step = (await adapter.exportStepBodies(document)).text;
    return { derived, step, vents: stepCylinders(step) };
  }

  const index = (name: (typeof HISTORY)[number]) => HISTORY.indexOf(name);

  it('builds the vent on its placed axis', async () => {
    const { manager, result } = ventedBlock();
    expect(historyNames(manager.document)).toEqual([...HISTORY]);
    const { derived, vents } = await exported(manager.document);
    expect(derived.warnings).toEqual([]);
    expect(vents).toHaveLength(1);
    expect(vents[0]).toMatchObject({ radius: VENT.radius });
    expect(vents[0]!.x).toBeCloseTo(VENT.x, 9);
    expect(vents[0]!.y).toBeCloseTo(VENT.y, 9);
    // Stock less the blind pocket (23 × 19 × 10) and the through vent.
    expect(derived.bodyRepresentations[result]!.volume).toBeCloseTo(
      64 * 42 * 16 - 23 * 19 * 10 - Math.PI * VENT.radius ** 2 * 16,
      3
    );
  });

  it('refuses the move, by either row, and leaves the order and the export alone', async () => {
    const { manager, features } = ventedBlock();
    const before = manager.document;
    const baseline = await exported(before);

    // The issue's gesture: the placement's grip, Down once.
    const down = commandFactories.moveFeature({
      featureId: features[PLACEMENT],
      toIndex: index(SUBTRACT)
    });
    // History's order gate asks the command before anything rebuilds.
    expect(() => down.validate(manager.document)).toThrow(REFUSAL);
    expect(() => manager.execute(down)).toThrow(REFUSAL);
    // The Subtract's grip, Up once, reaches the same order.
    expect(() =>
      manager.execute(
        commandFactories.moveFeature({
          featureId: features[SUBTRACT],
          toIndex: index(PLACEMENT)
        })
      )
    ).toThrow(REFUSAL);
    // The assistant and every multi-step gesture commit through here.
    expect(() => manager.runTransaction('Preflight AI patch', [down])).toThrow(
      REFUSAL
    );

    expect(manager.document).toBe(before);
    expect(historyNames(manager.document)).toEqual([...HISTORY]);
    expect(manager.canUndo).toBe(true);
    const after = await exported(manager.document);
    expect(stepData(after.step)).toBe(stepData(baseline.step));
    expect(after.vents).toEqual(baseline.vents);
  });

  it('still commits a reorder of independent steps, with the same export', async () => {
    const { manager, features } = ventedBlock();
    const baseline = await exported(manager.document);
    // The cylinder's creation ahead of the pocket tool's placement: neither
    // reads the other's body.
    manager.execute(
      commandFactories.moveFeature({
        featureId: features[VENT_BODY],
        toIndex: index('Place pocket tool')
      })
    );
    expect(historyNames(manager.document)).toEqual([
      'Stock',
      'Pocket tool',
      VENT_BODY,
      'Place pocket tool',
      PLACEMENT,
      SUBTRACT
    ]);
    const moved = await exported(manager.document);
    expect(moved.derived.warnings).toEqual([]);
    expect(stepData(moved.step)).toBe(stepData(baseline.step));
    // The placement may also move up, away from its consumer.
    manager.execute(
      commandFactories.moveFeature({
        featureId: features[PLACEMENT],
        toIndex: index(VENT_BODY)
      })
    );
    expect(historyNames(manager.document)).toEqual([
      'Stock',
      'Pocket tool',
      VENT_BODY,
      PLACEMENT,
      'Place pocket tool',
      SUBTRACT
    ]);
    const earlier = await exported(manager.document);
    expect(earlier.derived.warnings).toEqual([]);
    expect(earlier.vents).toEqual(baseline.vents);
    manager.undo();
    manager.undo();
    expect(historyNames(manager.document)).toEqual([...HISTORY]);
  });

  it('replays a stored history that already holds the fork, and accepts its repair', async () => {
    const { manager, features } = ventedBlock();
    const baseline = await exported(manager.document);
    // The log a client predating the refusal wrote.
    const forked = replayCommands(
      createProjectDocument('Vented block', toUserId('user_2334'), 'mm'),
      [
        ...manager.document.commandLog,
        commandFactories
          .moveFeature({
            featureId: features[PLACEMENT],
            toIndex: index(SUBTRACT)
          })
          .serialize()
      ]
    );
    expect(historyNames(forked)).toEqual([
      ...HISTORY.slice(0, 4),
      SUBTRACT,
      PLACEMENT
    ]);
    const stored = await exported(forked);
    // Unchanged for a stored document: it builds as it did, and says so.
    expect(
      (stored.derived.featureWarnings ?? []).map((entry) => [
        entry.featureName,
        entry.kind
      ])
    ).toContainEqual([PLACEMENT, 'history-fork']);
    expect(stored.vents).toHaveLength(1);
    expect(stored.vents[0]!.x).toBeCloseTo(0, 9);
    expect(stored.vents[0]!.y).toBeCloseTo(0, 9);

    // It stays editable: an unrelated edit, a reorder that leaves the fork
    // where it is, and the move that removes it.
    const reopened = new CommandManager(forked);
    reopened.execute(
      commandFactories.updateFeature({
        featureId: features.Stock,
        data: { dimensions: { width: 64, height: 42, depth: 16 } }
      })
    );
    reopened.execute(
      commandFactories.moveFeature({
        featureId: features[VENT_BODY],
        toIndex: index('Place pocket tool')
      })
    );
    reopened.execute(
      commandFactories.moveFeature({
        featureId: features[VENT_BODY],
        toIndex: index(VENT_BODY)
      })
    );
    reopened.execute(
      commandFactories.moveFeature({
        featureId: features[PLACEMENT],
        toIndex: index(PLACEMENT)
      })
    );
    expect(historyNames(reopened.document)).toEqual([...HISTORY]);
    const repaired = await exported(reopened.document);
    expect(repaired.derived.warnings).toEqual([]);
    expect(repaired.vents).toEqual(baseline.vents);
  });
});
