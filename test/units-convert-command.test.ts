/**
 * I03 stored-unit conversion, phase 5: the replayable `units.convert`
 * command (plan `docs/plans/i03-stored-unit-conversion-plan.md` §5.1–§5.3),
 * its kernel authoring path (`prepareUnitsConversion`), undo, the schema
 * gate, refusals and the residual-risk warnings. The checkpoint and the
 * collaboration refusal are covered in `apps/web/src/lib/unitsConversion.test.ts`,
 * and every parity scenario in `test/parity/units-convert-command.spec.ts`.
 */
import { createHash } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  UNITS_CONVERT_SCHEMA_VERSION,
  UnitsConversionError,
  addDatumAxis,
  addPrimitiveFeature,
  applyReferenceMap,
  assertDocumentContentSchema,
  applyUnitsConversion,
  conversionReferenceTargets,
  convertDocumentUnits,
  createProjectDocument,
  documentHistoryBytes,
  diffSaveStates,
  estimateUnitsConvertUndo,
  filletEdges,
  recordConversionReferences,
  updateFeature,
  listConversionReferenceSites,
  runUnitsConversion,
  setParameter,
  unitsConvertFactor,
  unitsConvertPayloadProblem,
  unitsConvertValueCount,
  type UnitsConversionWarning,
  type UnitsConvertInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  prepareUnitsConversion,
  presentReferenceRefusal,
  topologyHashOfWitness,
  type UnitsConversionPreparation
} from '@openzcad/kernel-adapter/exact';
import {
  MAX_UNDO_BYTES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  encodeImportedMeshPayload,
  toUserId,
  type EdgeTopologyReferenceV5,
  type EdgeWitnessV1,
  type FaceTopologyReferenceV5,
  type FeatureId,
  type ImportedSourceReference,
  type ProjectDocument,
  type SerializedCommand,
  type UnitSystem
} from '@openzcad/shared';

import { PARITY_SCENARIOS } from './parity/scenarios';

const USER = toUserId('user_units_convert_command');

/**
 * What the model is: everything but the record of how it got there
 * (revisions, the log, undo, the version) and the derived projection.
 */
function content(document: ProjectDocument): string {
  const {
    revisions: _revisions,
    commandLog: _log,
    editHistory: _history,
    version: _version,
    derived: _derived,
    checkpoints: _checkpoints,
    ...rest
  } = document;
  return JSON.stringify(rest);
}

function prepared(
  preparation: UnitsConversionPreparation
): Extract<UnitsConversionPreparation, { ok: true }> {
  if (!preparation.ok)
    throw new Error(
      `refused: ${preparation.refusals.map((refusal) => refusal.message).join(' | ')}`
    );
  return preparation;
}

function lastCommand(document: ProjectDocument): SerializedCommand {
  return document.commandLog.at(-1)!;
}

/** A pure document: a parameter-driven box, nothing to re-capture. */
function plainDocument(units: UnitSystem = 'mm'): ProjectDocument {
  let document = createProjectDocument('Plain', USER, units);
  document = setParameter(document, {
    name: 'w',
    expression: '20 mm',
    quantity: 'length'
  });
  document = setParameter(document, { name: 'n', expression: '3' });
  return addPrimitiveFeature(document, {
    name: 'Box',
    primitiveKind: 'box',
    dimensions: { width: 'w', height: 'n * 4', depth: 12.5 }
  });
}

function payloadFor(
  document: ProjectDocument,
  to: UnitSystem,
  references: UnitsConvertInput['references'] = {}
): UnitsConvertInput {
  return {
    from: document.units as UnitsConvertInput['from'],
    to: to as UnitsConvertInput['to'],
    factor: unitsConvertFactor(document.units, to),
    references
  };
}

describe(
  'units.convert through the kernel authoring path',
  { timeout: 600_000 },
  () => {
    let source: ProjectDocument;
    let toInch: Extract<UnitsConversionPreparation, { ok: true }>;

    beforeAll(async () => {
      const adapter = await createExactKernelAdapter();
      try {
        // The first parity scenario that stores persisted references: the
        // command must carry a non-empty map to be worth testing.
        for (const scenario of PARITY_SCENARIOS) {
          if (scenario.expectedBuildFailure) continue;
          const document = await scenario.build((doc) =>
            adapter.syncDocument(doc)
          );
          if (
            document.units === 'mm' &&
            convertDocumentUnits(document, 'inch').ok &&
            listConversionReferenceSites(document).length > 0
          ) {
            source = document;
            break;
          }
        }
      } finally {
        adapter.dispose();
      }
      expect(source, 'a parity scenario with references').toBeDefined();
      toInch = prepared(
        await prepareUnitsConversion(source, 'inch', {
          actorUserId: source.ownerUserId
        })
      );
    });

    it('records the factor, the units and a reference for every site', () => {
      expect(toInch.payload.from).toBe('mm');
      expect(toInch.payload.to).toBe('inch');
      expect(toInch.payload.factor).toEqual([1, 25.4]);
      expect(Object.keys(toInch.payload.references).sort()).toEqual(
        listConversionReferenceSites(source)
          .map((site) => site.pointer)
          .sort()
      );
      expect(toInch.sourceVersion).toBe(source.version);
      expect(toInch.report.oracleChecks).toBeGreaterThan(0);
      expect(toInch.references.geometry.bodies).toBeGreaterThan(0);
      expect(toInch.undo.exceedsLimit).toBe(false);
    });

    it('converts mm → in to exactly convertDocumentUnits plus the reference map', () => {
      const manager = new CommandManager(source);
      manager.execute(commandFactories.convertUnits(toInch.payload));
      const transformed = convertDocumentUnits(source, 'inch');
      if (!transformed.ok) throw new Error('transform refused');
      const expected = applyReferenceMap(
        transformed.document,
        conversionReferenceTargets(toInch.payload.references)
      );
      if (!expected.ok) throw new Error('map refused');
      expect(manager.document.units).toBe('inch');
      expect(content(manager.document)).toBe(content(expected.document));
      expect(lastCommand(manager.document)).toMatchObject({
        kind: 'units.convert',
        payload: toInch.payload,
        label: 'Convert stored units mm → in'
      });
    });

    it('converts in → mm back to the original model', async () => {
      const manager = new CommandManager(source);
      manager.execute(commandFactories.convertUnits(toInch.payload));
      const back = prepared(
        await prepareUnitsConversion(manager.document, 'mm', {
          actorUserId: manager.document.ownerUserId
        })
      );
      expect(back.payload.factor).toEqual([25.4, 1]);
      manager.execute(commandFactories.convertUnits(back.payload));
      expect(manager.document.units).toBe('mm');
      expect(listConversionReferenceSites(manager.document)).toEqual(
        listConversionReferenceSites(source)
      );
      expect(content(manager.document)).toBe(content(source));
    });

    it('replays a log containing units.convert byte for byte, without the kernel', () => {
      const manager = new CommandManager(source);
      manager.execute(commandFactories.convertUnits(toInch.payload));
      // A later edit, written in the new unit, replays after the conversion.
      manager.execute(
        commandFactories.setParameter({
          name: 'later',
          expression: '2 in',
          quantity: 'length'
        })
      );
      const appended = manager.document.commandLog.slice(
        source.commandLog.length
      );
      expect(appended.map((command) => command.kind)).toEqual([
        'units.convert',
        'parameter.set'
      ]);
      const replayed = replayCommands(source, appended);
      expect(content(replayed)).toBe(content(manager.document));
      // And the pure step on its own is what the kernel verified: the replay
      // of the conversion alone, with no later edit.
      const alone = new CommandManager(source).execute(
        commandFactories.convertUnits(toInch.payload)
      );
      expect(content(replayCommands(source, [lastCommand(alone)]))).toBe(
        content(applyUnitsConversion(source, toInch.payload))
      );
    });

    it('is one undo step, and redo converts again', () => {
      const manager = new CommandManager(source, USER);
      const history = manager.document.editHistory?.entries.length ?? 0;
      manager.execute(commandFactories.convertUnits(toInch.payload));
      const converted = manager.document;
      expect(manager.undoLabel).toBe('Convert stored units mm → in');
      expect(manager.undoEntryKinds).toEqual(['units.convert']);
      expect(manager.document.editHistory!.entries.length).toBe(history + 1);
      // The estimate measured before applying is the entry recorded: the id
      // is another UUID of the same length.
      const entry = manager.document.editHistory!.entries.at(-1)!;
      expect(new TextEncoder().encode(JSON.stringify(entry)).byteLength).toBe(
        estimateUnitsConvertUndo(source, toInch.payload, USER).entryBytes
      );

      manager.undo();
      expect(manager.document.units).toBe('mm');
      expect(content(manager.document)).toBe(content(source));
      expect(manager.document.version).toBeGreaterThan(converted.version);
      manager.redo();
      expect(manager.document.units).toBe('inch');
      expect(content(manager.document)).toBe(content(converted));
    });

    it('refuses a stale or tampered reference map without logging anything', () => {
      const [pointer] = Object.keys(toInch.payload.references);
      const { [pointer!]: _dropped, ...missing } = toInch.payload.references;
      for (const payload of [
        { ...toInch.payload, references: missing },
        {
          ...toInch.payload,
          references: {
            ...toInch.payload.references,
            '/nodes/nope': { from: 7, to: 7 }
          }
        }
      ]) {
        const manager = new CommandManager(source);
        const before = manager.document;
        expect(() =>
          manager.execute(commandFactories.convertUnits(payload))
        ).toThrow(UnitsConversionError);
        expect(manager.document).toBe(before);
        expect(manager.document.commandLog).toHaveLength(
          source.commandLog.length
        );
        const result = runUnitsConversion(source, payload);
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.refusals[0]).toMatchObject({ stage: 'references' });
      }
    });
  }
);

describe('units.convert without references', () => {
  it('converts a pure document by the recorded payload alone', () => {
    const source = plainDocument();
    const manager = new CommandManager(source);
    manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')));
    const expected = convertDocumentUnits(source, 'inch');
    if (!expected.ok) throw new Error('refused');
    expect(content(manager.document)).toBe(content(expected.document));
    expect(
      content(replayCommands(source, [lastCommand(manager.document)]))
    ).toBe(content(manager.document));
  });

  it('keeps the version monotonic and appends one revision', () => {
    const source = plainDocument();
    const manager = new CommandManager(source);
    manager.execute(commandFactories.convertUnits(payloadFor(source, 'cm')));
    expect(manager.document.version).toBeGreaterThan(source.version);
    expect(manager.document.revisions).toHaveLength(
      source.revisions.length + 1
    );
    expect(manager.document.revisions.at(-1)!.reason).toBe(
      'Convert stored units mm → cm'
    );
  });

  it('refuses a payload that does not match the document, logging nothing', () => {
    const source = plainDocument();
    const cases: [UnitsConvertInput, RegExp][] = [
      [{ ...payloadFor(source, 'inch'), factor: [1, 25] }, /factor/],
      [{ ...payloadFor(source, 'inch'), from: 'cm' }, /stored in mm/],
      [
        { ...payloadFor(source, 'inch'), to: 'm' as never },
        /not millimetres, centimetres or inches/
      ],
      [payloadFor(source, 'mm'), /does not change/]
    ];
    for (const [payload, message] of cases) {
      const manager = new CommandManager(source);
      const before = manager.document;
      expect(() =>
        manager.execute(commandFactories.convertUnits(payload))
      ).toThrow(message);
      expect(manager.document).toBe(before);
      expect(manager.document.commandLog).toHaveLength(
        source.commandLog.length
      );
    }
  });

  it('creates no command when the transform refuses, naming the node and field', async () => {
    let source = setParameter(createProjectDocument('Round', USER, 'mm'), {
      name: 'width',
      expression: '127 mm',
      quantity: 'length'
    });
    source = addPrimitiveFeature(source, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 'round(width)', height: 1, depth: 1 }
    });
    const preparation = await prepareUnitsConversion(source, 'inch', {
      actorUserId: source.ownerUserId
    });
    expect(preparation.ok).toBe(false);
    if (preparation.ok) return;
    expect(preparation.refusals).toEqual([
      expect.objectContaining({
        stage: 'transform',
        code: 'scale-variant',
        subject: expect.stringMatching(/^Box \(/) as string,
        field: 'dimensions.width',
        message: expect.stringContaining('round(width)') as string
      })
    ]);
    const manager = new CommandManager(source);
    expect(() =>
      manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')))
    ).toThrow(UnitsConversionError);
    expect(manager.document.commandLog).toHaveLength(source.commandLog.length);
  });
});

describe('re-capture refusals on the review screen', () => {
  it('restates a blend-orientation refusal in modelling terms, keeping the edge', () => {
    const refusal = presentReferenceRefusal({
      code: 'blend-orientation',
      subject: 'Fillet 1 (feat_fillet)',
      field: 'edgeHashes.0',
      message:
        'Fillet 1 (feat_fillet): selection edge 0 reads A→B, and in the converted build edgeHashes.0 runs the other way or lists its faces the other way round, so the blend would be built mirrored; refusing rather than swapping its sides.'
    });
    expect(refusal).toMatchObject({
      stage: 'references',
      code: 'blend-orientation',
      subject: 'Fillet 1 (feat_fillet)',
      field: 'edgeHashes.0'
    });
    expect(refusal.message).toContain('Fillet 1 (feat_fillet)');
    expect(refusal.message).toContain('mirrored');
    expect(refusal.message).toContain('Stored units were not converted');
    expect(refusal.message).not.toMatch(/edgeHashes|swapping its sides/);
  });

  it('passes the other re-capture refusals through with their own message', () => {
    const busy = {
      code: 'busy' as const,
      subject: 'document',
      message:
        'Another conversion is being checked. Try again when it finishes.'
    };
    expect(presentReferenceRefusal(busy)).toEqual({
      stage: 'references',
      ...busy
    });
  });
});

describe('units.convert schema gate', () => {
  const older = UNITS_CONVERT_SCHEMA_VERSION - 1;

  it('preserves the v154 format and accepts it on current documents', () => {
    expect(UNITS_CONVERT_SCHEMA_VERSION).toBe(154);
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(
      UNITS_CONVERT_SCHEMA_VERSION
    );
  });

  it('refuses the command on an older schema, in execute and in authoring', async () => {
    const source = {
      ...plainDocument(),
      schemaVersion: older
    } as unknown as ProjectDocument;
    const manager = new CommandManager(source);
    expect(() =>
      manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')))
    ).toThrow(/Stored-unit conversions require project schema v/);
    expect(manager.document.commandLog).toHaveLength(source.commandLog.length);
    const preparation = await prepareUnitsConversion(source, 'inch', {
      actorUserId: source.ownerUserId
    });
    expect(preparation).toMatchObject({
      ok: false,
      refusals: [{ stage: 'payload', code: 'schema' }]
    });
  });

  it('refuses a stored log carrying the command on an older schema', () => {
    const source = plainDocument();
    const manager = new CommandManager(source);
    manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')));
    const log = [lastCommand(manager.document)];
    expect(() =>
      replayCommands(
        { ...source, schemaVersion: older } as unknown as ProjectDocument,
        log
      )
    ).toThrow(/Stored-unit conversions require project schema v/);
    expect(
      () =>
        new CommandManager({
          ...manager.document,
          schemaVersion: older
        } as unknown as ProjectDocument)
    ).toThrow(/Stored-unit conversions require project schema v/);
  });
});

describe('the undo-size estimate (plan §5.2)', () => {
  it('measures the entry exactly as the manager records it', () => {
    const source = plainDocument();
    const manager = new CommandManager(source, USER);
    const estimate = estimateUnitsConvertUndo(
      source,
      payloadFor(source, 'inch'),
      USER
    );
    manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')));
    const entry = manager.document.editHistory!.entries.at(-1)!;
    expect(estimate).toEqual({
      entryBytes: new TextEncoder().encode(JSON.stringify(entry)).byteLength,
      historyBytes: documentHistoryBytes(manager.document.editHistory!),
      limitBytes: MAX_UNDO_BYTES,
      exceedsLimit: false,
      stepsDropped: 0,
      keepsOnlyConversion: false
    });
  });

  it('counts the earlier steps a conversion pushes out of a full history', () => {
    const source = plainDocument();
    const payload = payloadFor(source, 'inch');
    const after = applyUnitsConversion(source, payload);
    // Ten earlier steps that leave about 1.5 kB of the bound free, less
    // than the conversion's own entry (about 2.6 kB) needs.
    const side = Math.floor((MAX_UNDO_BYTES - 1_500) / 20) - 70;
    const filler = (index: number) => ({
      id: crypto.randomUUID(),
      label: `Step ${index}`,
      changes: [
        {
          kind: 'value' as const,
          field: 'name' as const,
          before: 'a'.repeat(side),
          after: 'b'.repeat(side)
        }
      ]
    });
    const entries = Array.from({ length: 10 }, (_, index) => filler(index));
    const full: ProjectDocument = {
      ...source,
      editHistory: {
        schemaVersion: 1,
        projectId: source.projectId,
        actorUserId: USER,
        entries,
        cursor: entries.length,
        trimmed: 0
      }
    };
    const estimate = estimateUnitsConvertUndo(full, payload, USER, after);
    expect(estimate.exceedsLimit).toBe(false);
    expect(estimate.entryBytes).toBeGreaterThan(1_500);
    expect(estimate.stepsDropped).toBe(1);
    // Another actor's history is not this user's undo: nothing to drop.
    expect(
      estimateUnitsConvertUndo(full, payload, toUserId('someone_else'), after)
        .stepsDropped
    ).toBe(0);
  });

  it('says when the entry alone exceeds the bound, so nothing can undo it', () => {
    const source = plainDocument();
    const huge = {
      ...source,
      nodes: {
        ...source.nodes,
        bulk: {
          id: 'bulk',
          parentId: null,
          revisionId: null,
          name: 'y'.repeat(MAX_UNDO_BYTES),
          kind: 'folder'
        }
      }
    } as unknown as ProjectDocument;
    const estimate = estimateUnitsConvertUndo(
      source,
      payloadFor(source, 'inch'),
      USER,
      huge
    );
    expect(estimate.exceedsLimit).toBe(true);
  });
});

describe('the undo bound keeps the conversion step (plan §5.2)', () => {
  const source = plainDocument();
  const payload = payloadFor(source, 'inch');
  const converted = applyUnitsConversion(source, payload);
  /** The converted document carrying `length` extra bytes in one node. */
  const padded = (length: number) =>
    ({
      ...converted,
      nodes: {
        ...converted.nodes,
        bulk: {
          id: 'bulk',
          parentId: null,
          revisionId: null,
          name: 'y'.repeat(length),
          kind: 'folder'
        }
      }
    }) as unknown as ProjectDocument;
  const estimate = (length: number, before = source) =>
    estimateUnitsConvertUndo(before, payload, USER, padded(length));
  /** The padding whose history, with the conversion alone, is `bytes`. */
  const paddingFor = (bytes: number) => {
    const probe = estimate(1_000);
    return 1_000 + bytes - probe.historyBytes;
  };

  it('keeps the entry when its history is exactly the bound', () => {
    const at = estimate(paddingFor(MAX_UNDO_BYTES));
    expect(at.historyBytes).toBe(MAX_UNDO_BYTES);
    expect(at.exceedsLimit).toBe(false);
  });

  it('drops it one byte over, though the bare entry is under the bound', () => {
    const over = estimate(paddingFor(MAX_UNDO_BYTES + 1));
    expect(over.historyBytes).toBe(MAX_UNDO_BYTES + 1);
    // The envelope tips it over: the entry alone measures under 8 MB.
    expect(over.entryBytes).toBeLessThan(MAX_UNDO_BYTES);
    expect(over.exceedsLimit).toBe(true);
  });

  it('keeps it just under the bound, dropping every earlier step', () => {
    const filler = {
      id: crypto.randomUUID(),
      label: 'Step',
      changes: [
        {
          kind: 'value' as const,
          field: 'name' as const,
          before: 'a'.repeat(1_000),
          after: 'b'
        }
      ]
    };
    const before: ProjectDocument = {
      ...source,
      editHistory: {
        schemaVersion: 1,
        projectId: source.projectId,
        actorUserId: USER,
        entries: [filler, { ...filler, id: crypto.randomUUID() }],
        cursor: 2,
        trimmed: 0
      }
    };
    const under = estimate(paddingFor(MAX_UNDO_BYTES - 10), before);
    expect(under.exceedsLimit).toBe(false);
    expect(under.stepsDropped).toBe(2);
    expect(under.keepsOnlyConversion).toBe(true);
  });

  it('refuses to author a conversion it could not undo', async () => {
    // The box's bare depth scales, so its node is in the entry twice
    // (before and after): a 4.5 MB name puts the entry over the bound.
    const plain = plainDocument();
    const boxId = Object.keys(plain.nodes).find(
      (id) => plain.nodes[id]!.name === 'Box'
    )!;
    const document = {
      ...plain,
      nodes: {
        ...plain.nodes,
        [boxId]: { ...plain.nodes[boxId]!, name: 'x'.repeat(4_500_000) }
      }
    } as ProjectDocument;
    const preparation = await prepareUnitsConversion(document, 'inch', {
      actorUserId: document.ownerUserId
    });
    expect(preparation).toMatchObject({
      ok: false,
      refusals: [{ stage: 'payload', code: 'undo-too-large' }]
    });
  });
});

describe('stored-unit conversion warnings (residual risks)', () => {
  function warningsOf(
    width: string,
    parameters: [string, string, 'length'?][]
  ): UnitsConversionWarning[] {
    let document = createProjectDocument('Risk', USER, 'mm');
    for (const [name, expression, quantity] of parameters)
      document = setParameter(document, {
        name,
        expression,
        ...(quantity ? { quantity } : {})
      });
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width, height: 1, depth: 1 }
    });
    const result = convertDocumentUnits(document, 'inch');
    if (!result.ok)
      throw new Error(result.refusals.map((r) => r.message).join(' | '));
    return result.report.warnings;
  }

  it('warns on rounding a ratio of lengths, naming the field', () => {
    expect(
      warningsOf('round(width / 1 mm) * 1 mm', [['width', '127 mm', 'length']])
    ).toEqual([
      expect.objectContaining({
        code: 'rounding-of-length-ratio',
        subject: expect.stringMatching(/^Box \(/) as string,
        field: 'dimensions.width',
        expression: 'round(width / 1 mm) * 1 mm',
        operation: 'round'
      })
    ]);
  });

  it('warns on rounding a parameter computed from a length', () => {
    const warnings = warningsOf('floor(ratio) * 1 mm', [
      ['width', '127 mm', 'length'],
      ['ratio', 'width / 1 mm']
    ]);
    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'rounding-of-length-ratio',
        field: 'dimensions.width',
        operation: 'floor'
      })
    ]);
  });

  it('warns on a pole and a domain edge in a difference of lengths', () => {
    expect(
      warningsOf('100 mm * 1 mm / (width - 3 mm)', [
        ['width', '23 mm', 'length']
      ])
    ).toEqual([
      expect.objectContaining({
        code: 'pole-or-domain-edge',
        field: 'dimensions.width',
        operation: '/'
      })
    ]);
    expect(
      warningsOf('sqrt((width - 3 mm) * 1 mm)', [['width', '7 mm', 'length']])
    ).toEqual([
      expect.objectContaining({
        code: 'pole-or-domain-edge',
        operation: 'sqrt'
      })
    ]);
    // Through a parameter holding the difference.
    expect(
      warningsOf('100 mm * 1 mm / gap', [
        ['width', '23 mm', 'length'],
        ['gap', 'width - 3 mm', 'length']
      ])
    ).toEqual([
      expect.objectContaining({
        code: 'pole-or-domain-edge',
        field: 'dimensions.width',
        operation: '/'
      })
    ]);
  });

  it('stays quiet on continuous forms and unit-free rounding', () => {
    for (const [width, parameters] of [
      ['w * 2', [['w', '10 mm', 'length']]],
      ['round(n) * 1 mm', [['n', '7.6']]],
      ['w / 2 + 1 mm', [['w', '10 mm', 'length']]],
      ['100 mm * 1 mm / w', [['w', '10 mm', 'length']]],
      ['min(w, 3 mm)', [['w', '10 mm', 'length']]]
    ] as [string, [string, string, 'length'?][]][])
      expect(warningsOf(width, parameters), width).toEqual([]);
  });

  it('reports warnings in the preparation the review screen reads', async () => {
    let document = setParameter(createProjectDocument('Risk', USER, 'mm'), {
      name: 'width',
      expression: '127 mm',
      quantity: 'length'
    });
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 'round(width / 1 mm) * 1 mm', height: 1, depth: 1 }
    });
    const preparation = prepared(
      await prepareUnitsConversion(document, 'inch', {
        actorUserId: document.ownerUserId
      })
    );
    expect(preparation.report.warnings).toHaveLength(1);
    expect(unitsConvertValueCount(preparation.report)).toBeGreaterThan(0);
  });
});

describe(
  'imported meshes keep their payload (plan §3.4)',
  { timeout: 180_000 },
  () => {
    /** A closed 10 × 20 × 30 box as a triangle soup. */
    function boxSoup(): { vertices: number[]; indices: number[] } {
      const corner = (index: number) => [
        index & 1 ? 10 : 0,
        index & 2 ? 20 : 0,
        index & 4 ? 30 : 0
      ];
      const vertices: number[] = [];
      for (const [a, b, c, e] of [
        [0, 2, 3, 1],
        [4, 5, 7, 6],
        [0, 1, 5, 4],
        [2, 6, 7, 3],
        [0, 4, 6, 2],
        [1, 3, 7, 5]
      ])
        for (const index of [a, b, c, a, c, e])
          vertices.push(...corner(index!));
      return {
        vertices,
        indices: vertices.map((_, index) => index).slice(0, 36)
      };
    }

    const bytes = encodeImportedMeshPayload(boxSoup());
    const ref: ImportedSourceReference = {
      marker: 'openzcad-source-ref',
      version: 1,
      hashAlgorithm: 'sha256',
      checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      logicalBytes: bytes.byteLength
    };
    const options = {
      resolveSourceBytes: async () => bytes,
      actorUserId: USER
    };

    function meshDocument(): ProjectDocument {
      const manager = new CommandManager(
        createProjectDocument('Scan', USER, 'mm')
      );
      manager.execute(
        commandFactories.importMesh({
          name: 'scan.stl',
          artifactId: 'artifact_scan',
          sourceName: 'scan.stl',
          triangleCount: 12,
          meshPayloadRef: ref
        })
      );
      return manager.document;
    }

    function meshData(document: ProjectDocument) {
      const node = Object.values(document.nodes).find(
        (candidate) =>
          candidate.kind === 'feature' &&
          candidate.data.featureKind === 'imported-mesh'
      );
      if (node?.kind !== 'feature' || node.data.featureKind !== 'imported-mesh')
        throw new Error('no mesh');
      return node.data;
    }

    it('records the payload unit, leaves the blob, and keeps the physical size', async () => {
      const source = meshDocument();
      const toInch = prepared(
        await prepareUnitsConversion(source, 'inch', options)
      );
      expect(toInch.report.meshPayloads).toBe(1);
      const manager = new CommandManager(source);
      manager.execute(commandFactories.convertUnits(toInch.payload));
      const data = meshData(manager.document);
      expect(data.payloadUnits).toBe('mm');
      expect(data.meshPayloadRef).toEqual(ref);

      const adapter = await createExactKernelAdapter(options);
      try {
        const derived = await adapter.syncDocument(manager.document);
        const body =
          derived.bodyRepresentations[manager.document.bodyOrder[0]!]!;
        expect(body.volume).toBeCloseTo(6000 / 25.4 ** 3, 9);
      } finally {
        adapter.dispose();
      }

      // Back to millimetres, the payload is in the document's unit again.
      const back = prepared(
        await prepareUnitsConversion(manager.document, 'mm', options)
      );
      manager.execute(commandFactories.convertUnits(back.payload));
      expect('payloadUnits' in meshData(manager.document)).toBe(false);
      expect(content(manager.document)).toBe(content(source));
    });
  }
);

describe('the save-state diff of a conversion', () => {
  it('shows one summary row instead of a row per scaled value', () => {
    const before = plainDocument();
    const manager = new CommandManager(before);
    manager.execute(commandFactories.convertUnits(payloadFor(before, 'inch')));
    const diff = diffSaveStates(before, manager.document);
    const transformed = convertDocumentUnits(before, 'inch');
    if (!transformed.ok) throw new Error('refused');
    expect(diff.unitConversion).toEqual({
      from: 'mm',
      to: 'inch',
      values: unitsConvertValueCount(transformed.report)
    });
    expect(diff.unitConversion!.values).toBeGreaterThan(0);
    expect(diff.properties).toEqual([]);
    expect(diff.features.changed).toEqual([]);
    expect(diff.parameters).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('still lists edits made after the conversion', () => {
    const before = plainDocument();
    const manager = new CommandManager(before);
    manager.execute(commandFactories.convertUnits(payloadFor(before, 'inch')));
    manager.execute(
      commandFactories.setParameter({
        name: 'n',
        expression: '4'
      })
    );
    const diff = diffSaveStates(before, manager.document);
    expect(diff.unitConversion?.to).toBe('inch');
    expect(diff.parameters).toEqual([
      expect.objectContaining({ name: 'n', before: '3', after: '4' })
    ]);
  });

  it('falls back to a units row when no recorded conversion applies', () => {
    const before = plainDocument();
    const after = { ...plainDocument('inch'), nodes: before.nodes };
    const diff = diffSaveStates(before, after);
    expect(diff.unitConversion).toBeUndefined();
    expect(diff.properties).toEqual([
      { field: 'units', before: 'mm', after: 'inch' }
    ]);
  });
});

/** A synthetic edge reference along x, from x0 to x1 (in some unit). */
function xEdge(
  producingFeatureId: FeatureId,
  x0: number,
  x1: number,
  lineageName = 'primitive.box.edge.x.y-min.z-min'
): EdgeTopologyReferenceV5 {
  const q = (value: number) => Math.round(value / 1e-6);
  const witness: EdgeWitnessV1 = {
    curveType: 'line',
    length: q(x1 - x0),
    closed: false,
    endpoints: [
      [q(x0), 0, 0],
      [q(x1), 0, 0]
    ],
    midpoint: [q((x0 + x1) / 2), 0, 0]
  };
  return {
    kind: 'edge',
    producingFeatureId,
    lineageName,
    currentHash: topologyHashOfWitness('edge', witness),
    witnessVersion: 1,
    witness
  };
}

/**
 * A box with a variable fillet on one picked edge, stored with its edge
 * runs and per-end radii: four kinds of reference site, among them the
 * boolean `edgeRuns` flag. No kernel: the references are synthetic.
 */
function variableFillet(run = true): {
  document: ProjectDocument;
  filletId: FeatureId;
  boxId: FeatureId;
} {
  const box = plainDocument();
  const bodyId = box.bodyOrder.at(-1)!;
  const boxId = box.featureOrder.at(-1)!;
  const edge = xEdge(boxId, 0, 20);
  const { document } = filletEdges(box, {
    name: 'Round',
    targetBodyId: bodyId,
    edgeHashes: [edge.currentHash],
    edgeReferences: [edge],
    size: 1,
    endRadius: 1,
    radiusLaw: 'linear',
    vertexRadii: [
      { edge: 0, end: 0, radius: 1 },
      { edge: 0, end: 1, radius: 2 }
    ],
    edgeRuns: [run]
  });
  return {
    document,
    filletId: document.featureOrder.at(-1)!,
    boxId
  };
}

/**
 * What re-capture would record converting `source` mm → in: each edge
 * reference scaled (its ends keep their order), each hash its reference's
 * new hash, each end index and edge-run flag unchanged.
 */
function recapturedToInch(
  source: ProjectDocument
): ReturnType<typeof recordConversionReferences> {
  const map: Record<string, EdgeTopologyReferenceV5 | number | boolean> = {};
  const sites = listConversionReferenceSites(source);
  for (const site of sites)
    if (site.kind === 'topology' && site.reference.kind === 'edge') {
      const witness = site.reference.witness;
      if (witness.closed) throw new Error('closed edge');
      map[site.pointer] = xEdge(
        site.reference.producingFeatureId,
        (witness.endpoints[0][0] * 1e-6) / 25.4,
        (witness.endpoints[1][0] * 1e-6) / 25.4,
        site.reference.lineageName
      );
    } else if (site.kind === 'edge-end') map[site.pointer] = site.value;
  for (const site of sites)
    if (site.kind === 'hash') {
      const reference = Object.entries(map).find(
        ([, value]) =>
          typeof value === 'object' &&
          sites.some(
            (other) =>
              other.kind === 'topology' &&
              other.reference.currentHash === site.hash &&
              value.lineageName === other.reference.lineageName
          )
      );
      map[site.pointer] = (
        reference![1] as EdgeTopologyReferenceV5
      ).currentHash;
    }
  return recordConversionReferences(source, map);
}

describe('review findings on PR 1990', () => {
  it('accepts the edge-run flag re-capture records, and replays it', () => {
    for (const run of [true, false]) {
      const { document: source } = variableFillet(run);
      const references = recapturedToInch(source);
      const pointer = Object.keys(references).find((key) =>
        key.endsWith('/edgeRuns/0')
      )!;
      expect(references[pointer]).toEqual({ from: run, to: run });
      const payload = payloadFor(source, 'inch', references);
      const manager = new CommandManager(source);
      manager.execute(commandFactories.convertUnits(payload));
      expect(manager.document.units).toBe('inch');
      const fillet = Object.values(manager.document.nodes).find(
        (node) => node.kind === 'feature' && node.name === 'Round'
      );
      expect(
        (fillet as { data: { edgeRuns: boolean[] } }).data.edgeRuns
      ).toEqual([run]);
      expect(
        content(replayCommands(source, [lastCommand(manager.document)]))
      ).toBe(content(manager.document));
    }
  });

  it('refuses to replay over a selection that changed at the same place', () => {
    const { document: source, filletId, boxId } = variableFillet();
    const payload = payloadFor(source, 'inch', recapturedToInch(source));
    const command = lastCommand(
      new CommandManager(source).execute(commandFactories.convertUnits(payload))
    );
    // Unchanged: the recorded preconditions hold, and it replays.
    expect(replayCommands(source, [command]).units).toBe('inch');

    // Reordered history: an edit that switched the fillet from edge A to
    // edge B now comes before the conversion.
    const other = xEdge(boxId, 0, 30, 'primitive.box.edge.x.y-max.z-min');
    const reselected = updateFeature(source, {
      featureId: filletId,
      data: { edgeHashes: [other.currentHash], edgeReferences: [other] }
    });
    let refused: unknown;
    try {
      replayCommands(reselected, [command]);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(UnitsConversionError);
    const refusals = (refused as UnitsConversionError).refusals;
    expect(refusals.map((refusal) => refusal.code)).toEqual(
      expect.arrayContaining(['reference-changed'])
    );
    expect(
      refusals.every((refusal) => refusal.code === 'reference-changed')
    ).toBe(true);
    expect(refusals.map((refusal) => refusal.field).sort()).toEqual([
      'edgeHashes.0',
      'edgeReferences.0'
    ]);
    expect(refusals[0]!.message).toContain('Round (');
    // Nothing was partially applied: the result is a refusal, not a document.
    expect(runUnitsConversion(reselected, payload)).toMatchObject({
      ok: false
    });
  });

  it('refuses a payload whose recorded precondition is missing', () => {
    const { document: source } = variableFillet();
    const references = Object.fromEntries(
      Object.entries(recapturedToInch(source)).map(([pointer, entry]) => [
        pointer,
        { to: entry.to }
      ])
    ) as unknown as UnitsConvertInput['references'];
    expect(
      runUnitsConversion(source, payloadFor(source, 'inch', references))
    ).toMatchObject({ ok: false, refusals: [{ stage: 'payload' }] });
  });

  it('compares a pre-upgrade save state with a converted project as one summary', () => {
    const current = plainDocument();
    const manager = new CommandManager(current);
    manager.execute(commandFactories.convertUnits(payloadFor(current, 'inch')));
    // The checkpoint was saved before the upgrade, on schema v153.
    const before = {
      ...current,
      schemaVersion: UNITS_CONVERT_SCHEMA_VERSION - 1
    } as unknown as ProjectDocument;
    const diff = diffSaveStates(before, manager.document);
    expect(diff.unitConversion).toMatchObject({ from: 'mm', to: 'inch' });
    expect(diff.properties).toEqual([]);
    expect(diff.features.changed).toEqual([]);
    expect(diff.parameters).toEqual([]);
  });
});

/**
 * A box with a cylinder datum axis on one of its faces: one stored face
 * reference, a topology site with no hash beside it. No kernel: synthetic.
 */
function faceAxisDocument(): { document: ProjectDocument; pointer: string } {
  const box = plainDocument();
  const bodyId = box.bodyOrder.at(-1)!;
  const boxId = box.featureOrder.at(-1)!;
  const faceReference: FaceTopologyReferenceV5 = {
    kind: 'face',
    producingFeatureId: boxId,
    lineageName: 'primitive.box.face.side',
    currentHash: 41,
    witnessVersion: 1,
    witness: {
      surfaceType: 'cylinder',
      perimeter: 1_000,
      centroid: null,
      analytic: { kind: 'none' },
      closure: { u: 'closed', v: 'open' }
    }
  };
  const { document } = addDatumAxis(box, {
    name: 'Axis',
    definition: {
      kind: 'cylinder',
      source: { type: 'face', bodyId, faceReference }
    }
  });
  const site = listConversionReferenceSites(document).find(
    (candidate) =>
      candidate.kind === 'topology' && candidate.reference.kind === 'face'
  )!;
  return { document, pointer: site.pointer };
}

describe('scoped re-check findings on PR 1990', () => {
  const malformedFace = (reference: FaceTopologyReferenceV5) =>
    ({
      ...reference,
      currentHash: 77,
      witness: {}
    }) as unknown as FaceTopologyReferenceV5;

  it('refuses a malformed face reference as a payload and at replay', () => {
    const { document: source, pointer } = faceAxisDocument();
    const from = listConversionReferenceSites(source).find(
      (site) => site.pointer === pointer
    );
    if (from?.kind !== 'topology' || from.reference.kind !== 'face')
      throw new Error('no face site');
    const good: FaceTopologyReferenceV5 = {
      ...from.reference,
      currentHash: 42
    };
    // Well formed, it converts: the site is real and replay writes it.
    expect(
      runUnitsConversion(
        source,
        payloadFor(source, 'inch', {
          [pointer]: { from: from.reference, to: good }
        })
      ).ok
    ).toBe(true);

    for (const references of [
      { [pointer]: { from: from.reference, to: malformedFace(good) } },
      { [pointer]: { from: malformedFace(from.reference), to: good } }
    ]) {
      const payload = payloadFor(source, 'inch', references);
      expect(unitsConvertPayloadProblem(source, payload)).toMatch(
        /invalid entry/
      );
      expect(runUnitsConversion(source, payload)).toMatchObject({
        ok: false,
        refusals: [{ stage: 'payload' }]
      });
      expect(() =>
        replayCommands(source, [
          {
            kind: 'units.convert',
            payload,
            replayVersion: 1,
            label: 'Convert stored units mm → in',
            timestamp: new Date(0).toISOString()
          }
        ])
      ).toThrow(/invalid entry/);
    }

    // Applying the map refuses it too, whoever built the map.
    const converted = convertDocumentUnits(source, 'inch');
    if (!converted.ok) throw new Error('refused');
    expect(
      applyReferenceMap(converted.document, {
        [pointer]: malformedFace(good)
      })
    ).toMatchObject({
      ok: false,
      refusals: [{ code: 'invalid-reference', pointer }]
    });
  });

  it('refuses a stored log whose units.convert payload has the old shape', () => {
    const source = plainDocument();
    const manager = new CommandManager(source);
    manager.execute(commandFactories.convertUnits(payloadFor(source, 'inch')));
    const stored = lastCommand(manager.document);
    // Pre-review shape: pointer → new value, with no recorded `from`.
    const old: SerializedCommand = {
      ...stored,
      payload: {
        ...(stored.payload as UnitsConvertInput),
        references: { '/nodes/a/data/edgeHashes/0': 12 }
      }
    };
    const document = {
      ...manager.document,
      commandLog: [...manager.document.commandLog.slice(0, -1), old]
    } as ProjectDocument;
    expect(() => assertDocumentContentSchema(document)).toThrow(
      /units\.convert|conversion/i
    );
    expect(() => new CommandManager(document)).toThrow(
      /units\.convert|conversion/i
    );
    // The well-formed log still opens.
    expect(() => assertDocumentContentSchema(manager.document)).not.toThrow();
  });
});
