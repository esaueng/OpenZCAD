import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  assertStorableDocument,
  createProjectDocument,
  documentPrintClearance,
  featureReadsPrintClearance,
  findParameterReferences,
  gearBody,
  gearMeshGearOfBody,
  normalizeDocument,
  parameterQuantityRefusal,
  renameParameter,
  setParameter,
  setPrintClearance,
  threadBody,
  type GearInput
} from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  gearBacklashForClearance,
  isDocumentHistory,
  printClearanceError,
  toUserId,
  type FeatureData,
  type ProjectDocument
} from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

/**
 * L09 document print clearance (schema v60): one radial allowance on the
 * document that threads and gears read where they leave their own unset.
 * Unset, nothing changes and nothing is rewritten.
 */

function newDocument(units: 'mm' | 'inch' = 'mm'): ProjectDocument {
  return createProjectDocument('Fits', toUserId('user_fits'), units);
}

describe('the stored print clearance', () => {
  it('is absent on a new document and on an older one opened today', () => {
    const fresh = newDocument();
    expect(fresh.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect('printClearance' in fresh).toBe(false);
    expect(documentPrintClearance(fresh)).toBeUndefined();
    // A v57 document opens with nothing filled in.
    const older = normalizeDocument({ ...fresh, schemaVersion: 57 } as never);
    expect('printClearance' in older).toBe(false);
  });

  it('takes a length or a typed expression and refuses anything else', () => {
    const document = setParameter(newDocument(), {
      name: 'gap',
      expression: '0.1',
      quantity: 'length'
    });
    expect(
      documentPrintClearance(setPrintClearance(document, { value: 0.2 }))
    ).toBe(0.2);
    expect(
      documentPrintClearance(
        setPrintClearance(document, { value: ' 2 * gap ' })
      )
    ).toBeCloseTo(0.2, 12);
    // Units convert into the document's: 0.2 mm in an inch document.
    expect(
      documentPrintClearance(
        setPrintClearance(newDocument('inch'), { value: '0.2 mm' })
      )
    ).toBeCloseTo(0.2 / 25.4, 12);
    for (const [value, message] of [
      [-0.1, /zero or more/],
      ['-1 mm', /zero or more/],
      ['5 deg', /expected a length/],
      ['nope', /nope/],
      ['', /length or an expression/],
      [Number.NaN, /zero or more/]
    ] as const)
      expect(() => setPrintClearance(document, { value })).toThrow(message);
    // Unchanged is no edit at all.
    const set = setPrintClearance(document, { value: 0.2 });
    expect(setPrintClearance(set, { value: 0.2 })).toBe(set);
    // Clearing removes the field rather than storing a placeholder.
    expect('printClearance' in setPrintClearance(set, { value: null })).toBe(
      false
    );
  });

  it('refuses a stored expression that is not a length (review #1563)', () => {
    // Storage accepts any expression string; the rebuild must still read it
    // as a length rather than take an angle's number as a gap.
    const stored = { ...newDocument(), printClearance: '5 deg' };
    expect(() => documentPrintClearance(stored)).toThrow(
      /Print clearance: .*expected a length/
    );
    expect(
      documentPrintClearance({ ...newDocument('inch'), printClearance: '1 mm' })
    ).toBeCloseTo(1 / 25.4, 12);
  });

  it('is refused on a document that declares an older schema', () => {
    // v59 is the last schema before print clearance (v60); a later bump
    // must not make "the current one minus one" a version that has it.
    const beforePrintClearance = 59;
    const set = setPrintClearance(newDocument(), { value: 0.2 });
    expect(() =>
      normalizeDocument({
        ...set,
        schemaVersion: beforePrintClearance
      } as never)
    ).toThrow(/print clearance require project schema v60/);
    expect(() =>
      setPrintClearance(
        {
          ...newDocument(),
          schemaVersion: beforePrintClearance
        } as never,
        {
          value: 0.2
        }
      )
    ).toThrow(/v60/);
    expect(assertStorableDocument(set).printClearance).toBe(0.2);
    for (const bad of [-1, '', {}, true])
      expect(() =>
        assertStorableDocument({ ...set, printClearance: bad })
      ).toThrow();
    expect(printClearanceError(0)).toBeNull();
    expect(printClearanceError('0.1 mm')).toBeNull();
  });

  it('is one undoable, replayable command', () => {
    const manager = new CommandManager(newDocument());
    manager.execute(commandFactories.setPrintClearance({ value: '0.15 mm' }));
    expect(manager.document.printClearance).toBe('0.15 mm');
    const projectId = manager.document.projectId;
    expect(isDocumentHistory(manager.document.editHistory, projectId)).toBe(
      true
    );
    manager.undo();
    // Undone, it is gone from what is saved.
    expect(manager.document.printClearance).toBeUndefined();
    expect(
      Object.keys(JSON.parse(JSON.stringify(manager.document)) as object)
    ).not.toContain('printClearance');
    manager.redo();
    expect(manager.document.printClearance).toBe('0.15 mm');
    const replayed = replayCommands(newDocument(), manager.document.commandLog);
    expect(replayed.printClearance).toBe('0.15 mm');
    // A stored history change that is not a clearance is refused.
    const history = structuredClone(manager.document.editHistory!);
    const change = history.entries
      .at(-1)!
      .changes.find((entry) => entry.field === 'printClearance')!;
    (change as { after: unknown }).after = -1;
    expect(isDocumentHistory(history, projectId)).toBe(false);
  });

  it('follows a parameter rename, and keeps the parameter it reads', () => {
    let document = setParameter(newDocument(), {
      name: 'gap',
      expression: '0.1',
      quantity: 'length'
    });
    document = setPrintClearance(document, { value: 'gap * 2' });
    const renamed = renameParameter(document, {
      name: 'gap',
      newName: 'fit_gap'
    });
    expect(renamed.printClearance).toBe('fit_gap * 2');
    expect(findParameterReferences(renamed, 'fit_gap')).toEqual([
      expect.objectContaining({
        label: 'The print clearance',
        expressions: ['fit_gap * 2']
      })
    ]);
    expect(() =>
      commandFactories.deleteParameter({ name: 'fit_gap' }).validate(renamed)
    ).toThrow(/The print clearance/);
    expect(parameterQuantityRefusal(renamed, 'fit_gap', 'angle')).toMatch(
      /The print clearance uses "fit_gap \* 2"/
    );
  });

  it('is read by threads and gears without their own value', () => {
    const thread = (data: Partial<FeatureData & { featureKind: 'thread' }>) =>
      featureReadsPrintClearance({
        featureKind: 'thread',
        targetBodyId: 'body_a',
        faceHash: 1,
        profile: 'iso-metric',
        ...data
      } as FeatureData);
    expect(thread({})).toBe(true);
    expect(thread({ clearance: 0 })).toBe(false);
    expect(thread({ profile: 'npt' })).toBe(false);
    expect(thread({ profile: 'bspt' })).toBe(false);
    expect(
      featureReadsPrintClearance({
        featureKind: 'gear',
        backlash: 0.1
      } as FeatureData)
    ).toBe(false);
    expect(
      featureReadsPrintClearance({ featureKind: 'gear' } as FeatureData)
    ).toBe(true);
    // Each flank moves 0.1 along its normal: 0.2 / cos 20° at the pitch circle.
    expect(gearBacklashForClearance(0.1, 20)).toBeCloseTo(
      0.2 / Math.cos(Math.PI / 9),
      12
    );
    expect(gearBacklashForClearance(0, 20)).toBe(0);
  });
});

const GEAR: Omit<GearInput, 'name'> = {
  gearType: 'external',
  sizing: 'module',
  pitch: 2,
  teeth: 20,
  faceWidth: 5,
  origin: { x: 0, y: 0, z: 0 },
  axis: { x: 0, y: 0, z: 1 }
};

describe('the gear-mesh helper reads it as backlash', () => {
  it('thins both gears of a pair by the clearance on each flank', () => {
    const made = gearBody(newDocument(), { name: 'Gear', ...GEAR });
    const plain = gearMeshGearOfBody(made.document, made.bodyId);
    const fitted = gearMeshGearOfBody(
      setPrintClearance(made.document, { value: 0.1 }),
      made.bodyId
    );
    expect('backlash' in plain && plain.backlash).toBe(0);
    expect('backlash' in fitted && fitted.backlash).toBeCloseTo(
      gearBacklashForClearance(0.1, 20),
      12
    );
  });
});

const kernelHasThreads =
  typeof (RemusKernel.prototype as unknown as Record<string, unknown>)
    .cutThreadDetailed === 'function';

describe('threads and gears built with it', { timeout: 240_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => adapter.dispose());

  async function volume(document: ProjectDocument, bodyId: string) {
    const derived = await adapter.syncDocument(document);
    const body = derived.bodyRepresentations[bodyId as never];
    expect(body, derived.warnings.join('\n')).toBeDefined();
    return body!.volume;
  }

  async function threadedBoss(clearance?: number) {
    const document = addPrimitiveFeature(newDocument(), {
      name: 'Shank',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 8 }
    });
    const bodyId = document.bodyOrder[0]!;
    const side = (await adapter.syncDocument(document)).bodyRepresentations[
      bodyId
    ]!.topology!.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    )!;
    return threadBody(document, {
      name: 'Thread',
      targetBodyId: bodyId,
      faceHash: side.hash,
      ...(side.reference ? { faceReference: side.reference } : {}),
      profile: 'iso-metric',
      ...(clearance === undefined ? {} : { clearance })
    });
  }

  it.runIf(kernelHasThreads)(
    'cuts a thread without its own clearance as if it had the document’s',
    async () => {
      const unset = await threadedBoss();
      const baseline = await volume(unset.document, unset.bodyId);
      // The same long-lived adapter: the set clearance must not be served
      // from the build cached before it existed.
      const fitted = await volume(
        setPrintClearance(unset.document, { value: 0.2 }),
        unset.bodyId
      );
      const own = await threadedBoss(0.2);
      expect(fitted).toBeCloseTo(await volume(own.document, own.bodyId), 9);
      // A boss shrinks away from its nut.
      expect(fitted).toBeLessThan(baseline - 1e-3);
      // Cleared again, the build is the original one.
      expect(await volume(unset.document, unset.bodyId)).toBeCloseTo(
        baseline,
        9
      );
      // A thread's own clearance wins, an exact one included.
      const exact = await threadedBoss(0);
      expect(
        await volume(
          setPrintClearance(exact.document, { value: 0.2 }),
          exact.bodyId
        )
      ).toBeCloseTo(baseline, 9);
    }
  );

  it('thins a gear without its own backlash by the clearance on each flank', async () => {
    const unset = gearBody(newDocument(), { name: 'Gear', ...GEAR });
    const baseline = await volume(unset.document, unset.bodyId);
    const fitted = await volume(
      setPrintClearance(unset.document, { value: 0.1 }),
      unset.bodyId
    );
    const own = gearBody(newDocument(), {
      name: 'Gear',
      ...GEAR,
      backlash: gearBacklashForClearance(0.1, 20)
    });
    expect(fitted).toBeCloseTo(await volume(own.document, own.bodyId), 9);
    expect(fitted).toBeLessThan(baseline - 1e-3);
    // A gear's own backlash wins.
    const zero = gearBody(newDocument(), {
      name: 'Gear',
      ...GEAR,
      backlash: 0
    });
    expect(
      await volume(
        setPrintClearance(zero.document, { value: 0.1 }),
        zero.bodyId
      )
    ).toBeCloseTo(baseline, 9);
  });

  it('names the print clearance when it does not resolve', async () => {
    let document = setParameter(newDocument(), {
      name: 'gap',
      expression: '0.1',
      quantity: 'length'
    });
    const made = gearBody(document, { name: 'Gear', ...GEAR });
    document = setPrintClearance(made.document, { value: 'gap' });
    // A later parameter edit leaves the clearance below zero.
    document = setParameter(document, { name: 'gap', expression: '-0.1' });
    expect(() => documentPrintClearance(document)).toThrow(
      /Print clearance: must be zero or more/
    );
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings.join('\n')).toMatch(/Print clearance/);
  });
});
