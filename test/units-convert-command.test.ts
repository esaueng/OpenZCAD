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
  addPrimitiveFeature,
  applyReferenceMap,
  applyUnitsConversion,
  convertDocumentUnits,
  createProjectDocument,
  diffSaveStates,
  estimateUnitsConvertUndo,
  listConversionReferenceSites,
  runUnitsConversion,
  setParameter,
  unitsConvertFactor,
  unitsConvertValueCount,
  type UnitsConversionWarning,
  type UnitsConvertInput
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  prepareUnitsConversion,
  type UnitsConversionPreparation
} from '@openzcad/kernel-adapter/exact';
import {
  MAX_UNDO_BYTES,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  encodeImportedMeshPayload,
  toUserId,
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
      toInch = prepared(await prepareUnitsConversion(source, 'inch'));
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
        toInch.payload.references
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
        await prepareUnitsConversion(manager.document, 'mm')
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
          references: { ...toInch.payload.references, '/nodes/nope': 7 }
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
    const preparation = await prepareUnitsConversion(source, 'inch');
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

describe('units.convert schema gate', () => {
  const older = UNITS_CONVERT_SCHEMA_VERSION - 1;

  it('is the current schema', () => {
    expect(UNITS_CONVERT_SCHEMA_VERSION).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
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
    const preparation = await prepareUnitsConversion(source, 'inch');
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
      limitBytes: MAX_UNDO_BYTES,
      exceedsLimit: false,
      stepsDropped: 0
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
      await prepareUnitsConversion(document, 'inch')
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
    const options = { resolveSourceBytes: async () => bytes };

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
