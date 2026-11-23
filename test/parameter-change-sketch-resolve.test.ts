import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  isParameterResolvedSketchUpdate,
  replayCommands,
  type SerializedCommand
} from '@openzcad/command-system';
import {
  activateConfiguration,
  setConfigurationCell
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';
import { buildConfigurationRow } from '../apps/web/src/lib/configurationRowGeometry';
import { sharedDocumentOnRow } from '../apps/web/src/lib/sharedConfiguration';
import {
  resolveSketchesForValueChange,
  resolvedForDisplay,
  type SolveSketch
} from '../apps/web/src/lib/sketch/parameterResolve';
import { drivenSketchesDocument } from './support/driven-sketches';

/**
 * The document stores each sketch's solved coordinates and the rebuild
 * extrudes from them, so a parameter value that drives a sketch relation
 * must solve that sketch again wherever the value changes, not only in the
 * Parameters table: a configuration row switch, a cell of the active row,
 * an assistant `set_parameter` patch and the read-only builds of another
 * row. Two sketches show it on the pinned kernel: a circle held `gap` from
 * a locked origin by a distance dimension, and the last copy of a linear
 * pattern spaced `pitch * 2`. Each is extruded into its own body, whose
 * centre is where the rebuilt solid really is.
 */

let adapter: ExactKernelAdapter;
const solve: SolveSketch = (document, sketchId) =>
  adapter.solveSketch(document, sketchId);

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

async function fixture() {
  const driven = drivenSketchesDocument();
  /** Each body's centre x as the document rebuilds. */
  const centres = async (candidate: ProjectDocument) => {
    const derived = await adapter.syncDocument(candidate);
    expect(derived.warnings).toEqual([]);
    const x = (bodyId: BodyId) => {
      const { bbox } = derived.bodyRepresentations[bodyId]!;
      return (bbox.min.x + bbox.max.x) / 2;
    };
    return { boss: x(driven.circleBody), copy: x(driven.copyBody) };
  };
  return {
    manager: new CommandManager(driven.document),
    centres,
    storedCircleX: driven.storedCircleX,
    columnOf: driven.columnOf,
    distanceSketch: driven.distanceSketch,
    circleId: driven.circleId
  };
}

function expectCentres(
  actual: { boss: number; copy: number },
  boss: number,
  copy: number
) {
  expect(actual.boss).toBeCloseTo(boss, 6);
  expect(actual.copy).toBeCloseTo(copy, 6);
}

describe('Tweak undo and solved sketch geometry', () => {
  it(
    'refuses a value edit carrying a user sketch edit, as History text writes one',
    { timeout: 180_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const circle = base.nodes[f.circleId as never] as unknown as {
        kind: string;
        data: Record<string, unknown>;
      };
      expect(circle.kind).toBe('sketch-object');
      // A Build user changes an unrelated parameter and moves the circle in
      // one History-text edit; the text compiles to this proposal. A mark
      // smuggled onto the operation is not carried into the command.
      const proposal = {
        proposalId: 'proposal_value_and_move',
        summary: 'Widen the pitch and move the circle.',
        assumptions: [],
        operations: [
          {
            kind: 'set_parameter' as const,
            name: 'pitch',
            expression: '20 mm'
          },
          {
            kind: 'update_sketch_object' as const,
            sketchId: f.distanceSketch,
            objectId: f.circleId,
            data: { ...circle.data, centerY: 4 },
            derivedFrom: 'parameter-resolve'
          }
        ]
      };
      const preflight = await preflightCadPatch(
        base,
        proposal as never,
        (candidate) => adapter.syncDocument(candidate),
        solve
      );
      const plain = preflight.commands.filter(
        (command) =>
          command.kind === 'sketch.object.update' &&
          !isParameterResolvedSketchUpdate(command)
      );
      expect(plain).toHaveLength(1);
      // The pattern's solved copies are marked; the move is not.
      expect(
        preflight.commands.some(isParameterResolvedSketchUpdate)
      ).toBe(true);
      const manager = new CommandManager(base);
      manager.runTransaction('Apply history text', preflight.commands);
      expect(manager.undoIsParameterOnly).toBe(false);
      manager.undo();
      expect(manager.redoIsParameterOnly).toBe(false);

      // The same value edit alone, with only its solved geometry, is Tweak's.
      const valueOnly = await preflightCadPatch(
        base,
        { ...proposal, operations: [proposal.operations[0]!] },
        (candidate) => adapter.syncDocument(candidate),
        solve
      );
      const tweak = new CommandManager(base);
      tweak.runTransaction('Apply AI patch', valueOnly.commands);
      expect(tweak.undoIsParameterOnly).toBe(true);
      tweak.undo();
      expect(tweak.redoIsParameterOnly).toBe(true);
    }
  );
});

describe('a parameter value changed outside the Parameters table', () => {
  it(
    'switching a configuration row moves the sketches its values drive',
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      expectCentres(await f.centres(base), 30, 58);

      // The row switch alone writes the values but leaves the solved
      // geometry where the Small row put it: the bug.
      const activate = commandFactories.activateConfiguration({
        rowId: 'row_large'
      });
      activate.validate(base);
      const switched = activate.apply(base);
      expectCentres(await f.centres(switched), 30, 58);

      // With the re-solve App runs for every configuration command, the
      // distance circle and the pattern copy follow the Large row, in one
      // history entry.
      const resolved = await resolveSketchesForValueChange(
        base,
        switched,
        solve
      );
      if (!resolved?.ok) throw new Error('the row did not solve');
      expect(resolved.commands.length).toBeGreaterThan(0);
      // Each solved write is marked as the re-solve's own.
      expect(
        resolved.commands.every(
          (command) =>
            command.kind === 'sketch.object.update' &&
            isParameterResolvedSketchUpdate(command)
        )
      ).toBe(true);
      const logStart = base.commandLog.length;
      f.manager.runTransaction('Switch to Large', [
        activate,
        ...resolved.commands
      ]);
      const live = f.manager.document;
      expect(f.storedCircleX(live)).toBeCloseTo(45, 6);
      expectCentres(await f.centres(live), 45, 70);
      // Tweak's undo admits the entry: a row switch and its solved sketches.
      expect(f.manager.undoIsParameterOnly).toBe(true);
      // Solved geometry without a value edit beside it is a sketch edit.
      const sketchOnly = new CommandManager(base);
      sketchOnly.runTransaction('Edit sketch geometry', resolved.commands);
      expect(sketchOnly.undoIsParameterOnly).toBe(false);

      // Replay needs no solver: the recorded log, serialized as a save or a
      // peer carries it, replays to the same geometry and keeps the mark.
      const log = JSON.parse(
        JSON.stringify(live.commandLog.slice(logStart))
      ) as SerializedCommand[];
      const replayed = replayCommands(base, log);
      expect(f.storedCircleX(replayed)).toBeCloseTo(45, 6);
      expectCentres(await f.centres(replayed), 45, 70);
      const replayedLeaves = JSON.stringify(replayed.commandLog);
      expect(replayedLeaves).toContain('"derivedFrom":"parameter-resolve"');
      // A log written before the mark existed replays the same way.
      const unmarked = JSON.parse(
        JSON.stringify(log).replaceAll(',"derivedFrom":"parameter-resolve"', '')
      ) as SerializedCommand[];
      expect(JSON.stringify(unmarked)).not.toContain('derivedFrom');
      expect(f.storedCircleX(replayCommands(base, unmarked))).toBeCloseTo(
        45,
        6
      );

      // And back: the Small row's sizes return.
      const back = activateConfiguration(live, { rowId: 'row_small' });
      const backResolved = await resolveSketchesForValueChange(
        live,
        back,
        solve
      );
      if (!backResolved?.ok) throw new Error('the row did not solve');
      expectCentres(await f.centres(backResolved.document), 30, 58);
    }
  );

  it(
    'an active-row cell edit moves the sketches as a row switch does',
    { timeout: 120_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const cell = setConfigurationCell(base, {
        rowId: 'row_small',
        column: f.columnOf('gap'),
        value: '40 mm'
      });
      const resolved = await resolveSketchesForValueChange(base, cell, solve);
      if (!resolved?.ok) throw new Error('the cell did not solve');
      expect(f.storedCircleX(resolved.document)).toBeCloseTo(40, 6);
      expectCentres(await f.centres(resolved.document), 40, 58);
    }
  );

  it(
    'an assistant set_parameter patch stores the solved sketches in its transaction',
    { timeout: 180_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const derive = (candidate: ProjectDocument) =>
        adapter.syncDocument(candidate);
      const proposal = {
        proposalId: 'proposal_driven_sketches',
        summary: 'Widen the gap and the pattern pitch.',
        assumptions: [],
        operations: [
          { kind: 'set_parameter' as const, name: 'gap', expression: '50 mm' },
          {
            kind: 'set_parameter' as const,
            name: 'pitch',
            expression: '20 mm'
          }
        ]
      };
      const preflight = await preflightCadPatch(base, proposal, derive, solve);
      expect(
        preflight.commands.some(
          (command) => command.kind === 'sketch.object.update'
        )
      ).toBe(true);
      // The previewed candidate and the applied transaction agree.
      expectCentres(await f.centres(preflight.candidate), 50, 90);
      const applied = new CommandManager(base).runTransaction(
        'Apply AI patch',
        preflight.commands
      );
      expect(f.storedCircleX(applied)).toBeCloseTo(50, 6);
      expectCentres(await f.centres(applied), 50, 90);
    }
  );

  it(
    'builds another row for display with that row’s sketch geometry',
    { timeout: 180_000 },
    async () => {
      const f = await fixture();
      const base = f.manager.document;
      const row = await buildConfigurationRow(
        base,
        'row_large',
        async (candidate) => {
          const derived = await adapter.syncDocument(candidate);
          return {
            status: 'ready',
            bodyRepresentations: derived.bodyRepresentations,
            warnings: derived.warnings
          } as never;
        },
        new AbortController().signal,
        solve
      );
      expect(f.storedCircleX(row)).toBeCloseTo(45, 6);
      expectCentres(await f.centres(row), 45, 70);

      const shared = await sharedDocumentOnRow(
        base,
        'row_large',
        async (candidate) => adapter.syncDocument(candidate),
        solve
      );
      expect(shared.note).toBe('Showing Large.');
      expect(f.storedCircleX(shared.document)).toBeCloseTo(45, 6);

      // The live document is never touched by a display build.
      expect(f.storedCircleX(base)).toBeCloseTo(30, 6);
      const unchanged = await resolvedForDisplay(base, base, solve);
      expect(unchanged).toBe(base);
    }
  );
});
