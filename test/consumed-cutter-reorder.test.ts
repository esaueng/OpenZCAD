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
 *
 * Two things the first refusal got wrong are held here too. A stored fork
 * exempts only the step-and-consumer pairs it already holds, so a reorder in
 * such a document cannot move another cut to the unplaced position. And the
 * order is judged where a commit ends, not after each of its commands, so a
 * transaction may pass through a forking order on its way to a sound one.
 *
 * And a suppressed step counts as a consumer only while its pass-through
 * takes the body. After an earlier consumer it passes nothing, so moving it
 * among the later steps changes nothing that is built and is not refused.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  assertFeatureReorderCommits,
  commandFactories,
  commandsForCadPatch,
  composeCommands,
  replayCommands
} from '@openzcad/command-system';
import {
  createBodyFeatureIds,
  createProjectDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  CUT_A,
  CUT_B,
  HISTORY,
  PLACEMENT,
  REFUSAL,
  SHARED_HISTORY,
  SHARED_PLACEMENT,
  SHARED_VENT,
  SUBTRACT,
  SUPPRESSED_CUT,
  SUPPRESSED_HISTORY,
  VENT,
  VENT_BODY,
  historyNames,
  sharedVentFork,
  stepCylinders,
  stepData,
  suppressedVentCut,
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
    // History's order gate asks this before anything rebuilds.
    expect(() =>
      assertFeatureReorderCommits(manager.document, down.payload)
    ).toThrow(REFUSAL);
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

  it('judges a transaction by the order it ends on, not each move on the way', async () => {
    const { manager, features } = ventedBlock();
    const spare = createBodyFeatureIds();
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Unrelated box',
        bodyName: 'Unrelated box',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 4, depth: 4 },
        ids: spare
      })
    );
    const start = manager.document;
    const baseline = await exported(start);
    const last = HISTORY.length;
    // The placement to the end, then the Subtract to the end. After the
    // first move the placement runs after its consumer; after the second it
    // is ahead of it again, with the unrelated box above both.
    const moves = () => [
      commandFactories.moveFeature({
        featureId: features[PLACEMENT],
        toIndex: last
      }),
      commandFactories.moveFeature({
        featureId: features[SUBTRACT],
        toIndex: last
      })
    ];
    const settled = [
      ...HISTORY.slice(0, 4),
      'Unrelated box',
      PLACEMENT,
      SUBTRACT
    ];

    // The first move, run alone, is the refused reorder.
    expect(() =>
      assertFeatureReorderCommits(start, moves()[0]!.payload)
    ).toThrow(REFUSAL);
    expect(() => manager.execute(moves()[0]!)).toThrow(REFUSAL);
    expect(() => manager.runTransaction('One move', [moves()[0]!])).toThrow(
      REFUSAL
    );
    expect(manager.document).toBe(start);

    // One CAD patch holding both moves compiles, and commits as one step.
    const patch = commandsForCadPatch(start, {
      proposalId: 'proposal_2334',
      summary: 'Move the unrelated box ahead of the vent placement.',
      assumptions: [],
      operations: [
        {
          kind: 'reorder_feature',
          featureId: features[PLACEMENT],
          toIndex: last
        },
        {
          kind: 'reorder_feature',
          featureId: features[SUBTRACT],
          toIndex: last
        }
      ]
    });
    manager.runTransaction('Reorder from a patch', patch);
    expect(historyNames(manager.document)).toEqual(settled);
    const moved = await exported(manager.document);
    expect(moved.derived.warnings).toEqual([]);
    expect(moved.vents).toEqual(baseline.vents);
    expect(stepData(moved.step)).toBe(stepData(baseline.step));
    manager.undo();
    expect(historyNames(manager.document)).toEqual(historyNames(start));

    // A composed command is one edit too.
    manager.execute(composeCommands('Reorder together', moves()));
    expect(historyNames(manager.document)).toEqual(settled);
    manager.undo();

    // A transaction that ENDS on the forking order is still refused whole.
    const undone = manager.document;
    expect(() =>
      manager.runTransaction('Ends forked', [
        commandFactories.moveFeature({
          featureId: spare.featureId,
          toIndex: 0
        }),
        commandFactories.moveFeature({
          featureId: features[PLACEMENT],
          toIndex: last
        })
      ])
    ).toThrow(REFUSAL);
    expect(manager.document).toBe(undone);
  });

  describe('in a stored history that already forks', () => {
    const at = (name: (typeof SHARED_HISTORY)[number]) =>
      SHARED_HISTORY.indexOf(name);
    const refusal = `Cannot reorder: “${SHARED_PLACEMENT}” would run after “${CUT_B}” already replaced “${SHARED_VENT}”, which branches the history. Keep “${SHARED_PLACEMENT}” before “${CUT_B}”.`;

    /** Where each vent cut stands: [x, y, radius] per cylindrical surface. */
    const cuts = (vents: Awaited<ReturnType<typeof exported>>['vents']) =>
      vents
        .map((vent) => [Math.round(vent.x), Math.round(vent.y), vent.radius])
        .sort((a, b) => a[0]! - b[0]!);

    it('refuses a move that puts the placement after a second consumer', async () => {
      const { document, features } = sharedVentFork();
      expect(historyNames(document)).toEqual([...SHARED_HISTORY]);
      const stored = await exported(document);
      // As stored: Cut A at the origin, where the cutter was made, and Cut B
      // on the placed axis. The placement and Cut B both fork already.
      expect(
        (stored.derived.featureWarnings ?? []).map((entry) => [
          entry.featureName,
          entry.kind
        ])
      ).toEqual([
        [SHARED_PLACEMENT, 'history-fork'],
        [CUT_B, 'history-fork']
      ]);
      expect(cuts(stored.vents)).toEqual([
        [0, 0, VENT.radius],
        [VENT.x, VENT.y, VENT.radius]
      ]);

      const manager = new CommandManager(document);
      const before = manager.document;
      for (const move of [
        // Cut B above Cut A.
        { featureId: features[CUT_B], toIndex: at(CUT_A) },
        // Cut B above the placement.
        { featureId: features[CUT_B], toIndex: at(SHARED_PLACEMENT) },
        // The placement below Cut B: the forks the document REPORTS do not
        // change, both still being listed against Cut A.
        { featureId: features[SHARED_PLACEMENT], toIndex: at(CUT_B) }
      ]) {
        const command = commandFactories.moveFeature(move);
        expect(() =>
          assertFeatureReorderCommits(manager.document, command.payload)
        ).toThrow(refusal);
        expect(() => manager.execute(command)).toThrow(refusal);
        expect(() => manager.runTransaction('Reorder', [command])).toThrow(
          refusal
        );
      }
      expect(manager.document).toBe(before);
      const after = await exported(manager.document);
      expect(stepData(after.step)).toBe(stepData(stored.step));

      // What the refused order would have exported: the vent of Cut B gone
      // from (52, 21), and a second corner cut at the origin.
      const lost = await exported(
        replayCommands(
          createProjectDocument('Shared vent', toUserId('user_2334'), 'mm'),
          [
            ...document.commandLog,
            commandFactories
              .moveFeature({ featureId: features[CUT_B], toIndex: at(CUT_A) })
              .serialize()
          ]
        )
      );
      expect(cuts(lost.vents)).toEqual([
        [0, 0, VENT.radius],
        [0, 0, VENT.radius]
      ]);
    });

    it('stays editable, and accepts the moves that take the fork apart', async () => {
      const { document, features } = sharedVentFork();
      const manager = new CommandManager(document);
      // An unrelated step moved through the fork, and back.
      manager.execute(
        commandFactories.moveFeature({
          featureId: features['Lift Stock B'],
          toIndex: at(SHARED_PLACEMENT)
        })
      );
      manager.undo();
      // The placement ahead of both cuts: both now cut on the placed axis.
      manager.execute(
        commandFactories.moveFeature({
          featureId: features[SHARED_PLACEMENT],
          toIndex: at(CUT_A)
        })
      );
      expect(historyNames(manager.document)).toEqual([
        ...SHARED_HISTORY.slice(0, 4),
        SHARED_PLACEMENT,
        CUT_A,
        CUT_B
      ]);
      const placed = await exported(manager.document);
      expect(cuts(placed.vents)).toEqual([
        [VENT.x, VENT.y, VENT.radius],
        [VENT.x, VENT.y, VENT.radius]
      ]);
      // The two cuts are the pair they were, and may swap.
      manager.execute(
        commandFactories.moveFeature({
          featureId: features[CUT_B],
          toIndex: at(CUT_B) - 1
        })
      );
      expect(historyNames(manager.document).slice(-2)).toEqual([CUT_B, CUT_A]);
      const swapped = await exported(manager.document);
      expect(cuts(swapped.vents)).toEqual(cuts(placed.vents));
    });

    it('moves a suppressed cut that passes nothing through, with the same export', async () => {
      const { document, features, suppressedCutNode, suppressedCutBody } =
        suppressedVentCut();
      expect(historyNames(document)).toEqual([...SUPPRESSED_HISTORY]);
      /** Each step's warnings, by step: they are listed in history order. */
      const warnings = (derived: Awaited<ReturnType<typeof exported>>) =>
        (derived.derived.featureWarnings ?? [])
          .map((entry) => `${entry.featureName}: ${entry.kind}`)
          .sort();
      const stored = await exported(document);
      // Cut A consumed the cutter, so the suppressed cut stands for nothing.
      expect(stored.derived.bodyRepresentations[suppressedCutBody]).toBe(
        undefined
      );
      expect(cuts(stored.vents)).toEqual([
        [0, 0, VENT.radius],
        [VENT.x, VENT.y, VENT.radius]
      ]);

      const manager = new CommandManager(document);
      const where = (name: (typeof SUPPRESSED_HISTORY)[number]) =>
        historyNames(manager.document).indexOf(name);
      const move = (toIndex: number) =>
        commandFactories.moveFeature({
          featureId: features[SUPPRESSED_CUT],
          toIndex
        });
      // Directly above Cut B, then above the placement too: the build skips
      // it at either place exactly as it did last.
      for (const above of [CUT_B, SHARED_PLACEMENT] as const) {
        const command = move(where(above));
        expect(() =>
          assertFeatureReorderCommits(manager.document, command.payload)
        ).not.toThrow();
        manager.execute(command);
        expect(where(SUPPRESSED_CUT)).toBe(where(above) - 1);
        const moved = await exported(manager.document);
        expect(warnings(moved)).toEqual(warnings(stored));
        expect(stepData(moved.step)).toBe(stepData(stored.step));
      }
      expect(historyNames(manager.document).slice(-4)).toEqual([
        CUT_A,
        SUPPRESSED_CUT,
        SHARED_PLACEMENT,
        CUT_B
      ]);

      // Above Cut A it is the cutter's first consumer. Its pass-through
      // would then take the cutter and show it under the cut's own id, so
      // that move is still refused, as any consumer's is.
      const first = move(where(CUT_A));
      const refused = `Cannot reorder: “${CUT_A}” would run after “${SUPPRESSED_CUT}” already replaced “${SHARED_VENT}”, which branches the history. Keep “${CUT_A}” before “${SUPPRESSED_CUT}”.`;
      const settled = manager.document;
      expect(() =>
        assertFeatureReorderCommits(manager.document, first.payload)
      ).toThrow(refused);
      expect(() => manager.execute(first)).toThrow(refused);
      expect(manager.document).toBe(settled);
      const passed = await exported(
        replayCommands(
          createProjectDocument('Shared vent', toUserId('user_2334'), 'mm'),
          [...settled.commandLog, first.serialize()]
        )
      );
      expect(passed.derived.bodyRepresentations[suppressedCutBody]).not.toBe(
        undefined
      );
      expect(stepData(passed.step)).not.toBe(stepData(stored.step));

      // Resuming the moved cut is reported, not refused: it forks against
      // Cut A, as it would have where it was stored.
      const resume = (target: CommandManager) =>
        target.execute(
          commandFactories.setNodeMetadata({
            nodeId: suppressedCutNode,
            metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: null }
          })
        );
      resume(manager);
      expect(warnings(await exported(manager.document))).toContain(
        `${SUPPRESSED_CUT}: history-fork`
      );
      const inPlace = new CommandManager(document);
      resume(inPlace);
      expect(warnings(await exported(inPlace.document))).toContain(
        `${SUPPRESSED_CUT}: history-fork`
      );
      // Running, it is a consumer the placement is judged against.
      expect(() =>
        manager.execute(
          commandFactories.moveFeature({
            featureId: features[SUPPRESSED_CUT],
            toIndex: where(CUT_B)
          })
        )
      ).not.toThrow();
      expect(() =>
        manager.execute(
          commandFactories.moveFeature({
            featureId: features[SUPPRESSED_CUT],
            toIndex: where(SHARED_PLACEMENT)
          })
        )
      ).toThrow(
        `Cannot reorder: “${SHARED_PLACEMENT}” would run after “${SUPPRESSED_CUT}” already replaced “${SHARED_VENT}”, which branches the history. Keep “${SHARED_PLACEMENT}” before “${SUPPRESSED_CUT}”.`
      );
    });
  });
});
