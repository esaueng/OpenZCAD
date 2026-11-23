import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  activateConfiguration,
  addConfigurationRow,
  setConfigurationCell
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument, SketchId } from '@openzcad/shared';
import {
  runConfigurationCommand,
  type ConfigurationCommandDeps
} from '../apps/web/src/lib/configurationCommand';
import { drivenSketchesDocument } from './support/driven-sketches';

/**
 * F06: a row switch solves the sketches its values drive before it commits,
 * so two quick picks overlap. The last pick wins, whichever solve finishes
 * first, and an overtaken switch drops quietly.
 */

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);

afterAll(() => {
  adapter.dispose();
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The fixture with a third row, XL: gap 60 mm, pitch 18 mm. */
function threeRows() {
  const driven = drivenSketchesDocument();
  let document = addConfigurationRow(driven.document, {
    rowId: 'row_xl',
    name: 'XL'
  });
  document = setConfigurationCell(document, {
    rowId: 'row_xl',
    column: driven.columnOf('gap'),
    value: '60 mm'
  });
  document = setConfigurationCell(document, {
    rowId: 'row_xl',
    column: driven.columnOf('pitch'),
    value: '18 mm'
  });
  return { ...driven, document };
}

/**
 * Deps over one manager whose solves wait, per row the solved document is
 * on, until that row's gate opens.
 */
function harness(document: ProjectDocument) {
  const holder = { manager: new CommandManager(document) };
  const gates = new Map<string, ReturnType<typeof deferred>>();
  const gate = (rowId: string) => {
    let entry = gates.get(rowId);
    if (!entry) gates.set(rowId, (entry = deferred()));
    return entry;
  };
  const deps: ConfigurationCommandDeps = {
    manager: () => holder.manager,
    solve: async (candidate: ProjectDocument, sketchId: SketchId) => {
      await gate(candidate.configurations!.activeRowId).promise;
      return adapter.solveSketch(candidate, sketchId);
    },
    execute: (command) => {
      holder.manager.execute(command);
      return true;
    },
    executeTransaction: (label, commands) => {
      holder.manager.runTransaction(label, commands);
      return true;
    },
    latestActivation: { current: 0 }
  };
  return { holder, gate, deps };
}

const activate = (rowId: string) =>
  commandFactories.activateConfiguration({ rowId });

describe('quick configuration row switches', () => {
  it(
    'commits the last pick even when an earlier one finishes first',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      const xl = runConfigurationCommand(activate('row_xl'), deps);
      // Large's solves finish first.
      gate('row_large').release();
      await expect(large).resolves.toBeNull();
      expect(holder.manager.document.configurations?.activeRowId).toBe(
        'row_small'
      );
      gate('row_xl').release();
      await expect(xl).resolves.toBeNull();
      const live = holder.manager.document;
      expect(live.configurations?.activeRowId).toBe('row_xl');
      expect(f.storedCircleX(live)).toBeCloseTo(60, 6);
      // One entry: the XL switch and its solved sketches.
      expect(holder.manager.undoIsParameterOnly).toBe(true);
      holder.manager.undo();
      expect(holder.manager.document.configurations?.activeRowId).toBe(
        'row_small'
      );
    }
  );

  it(
    'commits the last pick when it finishes before the earlier one',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      const xl = runConfigurationCommand(activate('row_xl'), deps);
      gate('row_xl').release();
      await expect(xl).resolves.toBeNull();
      gate('row_large').release();
      await expect(large).resolves.toBeNull();
      const live = holder.manager.document;
      expect(live.configurations?.activeRowId).toBe('row_xl');
      expect(f.storedCircleX(live)).toBeCloseTo(60, 6);
    }
  );

  it(
    'does not call a switch done against another project',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      // Another project opens meanwhile, already on a row named row_large.
      holder.manager = new CommandManager({
        ...activateConfiguration(f.document, { rowId: 'row_large' }),
        projectId: 'project_other' as ProjectDocument['projectId'],
        editHistory: undefined
      });
      gate('row_large').release();
      await expect(large).resolves.toBe(
        'The project changed while the sketches were solved. Try again.'
      );
    }
  );

  it(
    'is not silenced by a switch made in another project',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      // The workspace moves to another project and switches a row there,
      // taking the next ticket.
      holder.manager = new CommandManager({
        ...f.document,
        projectId: 'project_other' as ProjectDocument['projectId'],
        editHistory: undefined
      });
      const other = runConfigurationCommand(activate('row_xl'), deps);
      gate('row_large').release();
      // The first switch moved with its project; it is not overtaken.
      await expect(large).resolves.toBe(
        'The project changed while the sketches were solved. Try again.'
      );
      gate('row_xl').release();
      await expect(other).resolves.toBeNull();
      expect(holder.manager.document.configurations?.activeRowId).toBe(
        'row_xl'
      );
    }
  );

  it(
    'keeps the active row when it is picked again after a slower switch',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      // Small is still the active row: picking it again overtakes Large.
      const small = runConfigurationCommand(activate('row_small'), deps);
      await expect(small).resolves.toBeNull();
      gate('row_large').release();
      await expect(large).resolves.toBeNull();
      const live = holder.manager.document;
      expect(live.configurations?.activeRowId).toBe('row_small');
      expect(live).toBe(f.document);
    }
  );

  it(
    'keeps the active row when it is picked again and the switch lands first',
    { timeout: 120_000 },
    async () => {
      const f = threeRows();
      const { holder, gate, deps } = harness(f.document);
      const large = runConfigurationCommand(activate('row_large'), deps);
      const small = runConfigurationCommand(activate('row_small'), deps);
      gate('row_large').release();
      await expect(large).resolves.toBeNull();
      await expect(small).resolves.toBeNull();
      const live = holder.manager.document;
      expect(live.configurations?.activeRowId).toBe('row_small');
      expect(live).toBe(f.document);
    }
  );
});
