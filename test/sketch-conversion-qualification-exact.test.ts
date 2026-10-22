import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commandFactories,
  replayCommands,
  prepareLegacySketchConversion
} from '@openzcad/command-system';
import {
  findSketch,
  normalizeDocument,
  assertSketchProvenance
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  parseProjectBackup,
  importProjectCopy
} from '../apps/web/src/lib/projectBackup';
import { currentHoledPlate as buildHoledPlate } from './support/qualifiedConversionFixture';
let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 60_000);
afterAll(() => {
  adapter.dispose();
});
const currentHoledPlate = (typed = true, precise = true) =>
  buildHoledPlate(adapter, typed, precise);
function withCurrentGeometry(document: ProjectDocument): ProjectDocument {
  const channel = document.derived.sketchGeometry;
  if (!channel) throw new Error('Expected exact geometry for the fixture.');
  const copy = structuredClone(document);
  copy.derived.sketchGeometry = structuredClone(channel);
  return copy;
}

function prepared(f: Awaited<ReturnType<typeof currentHoledPlate>>) {
  return commandFactories.convertLegacySketchObject(
    prepareLegacySketchConversion(f.manager.document, {
      sketchId: f.sketchId,
      sourceObjectId: f.sourceObjectId
    })
  );
}

describe('read-only exact qualification for legacy conversion', () => {
  it.each([true, false])(
    'converts selected profiles without retaining neighboring typed seeds; precise=%s',
    async (precise) => {
      const f = await currentHoledPlate(true, precise);
      const before = structuredClone(f.manager.document);
      const neighbors = new Map(
        findSketch(before, f.sketchId)!
          .objectIds.filter((id) => id !== f.sourceObjectId)
          .map((id) => [id, before.nodes[id]])
      );
      expect(() =>
        f.manager.execute(
          commandFactories.convertLegacySketchObject({
            sketchId: f.sketchId,
            sourceObjectId: f.sourceObjectId
          })
        )
      ).toThrow(/topology no longer matches|no longer resolves uniquely/);
      const command = prepared(f);
      expect(
        command.payload.qualification!.authoredInputKey.length
      ).toBeLessThan(64);
      expect(
        command.payload.qualification!.geometryOverrides.length
      ).toBeGreaterThan(0);
      f.manager.execute(command);
      const converted = f.manager.document;
      for (const [id, node] of neighbors)
        expect(converted.nodes[id]).toEqual(node);
      expect(converted.nodes[f.loop[1]!]).toMatchObject({
        data: { x1: '2 cm', x2: '2 cm', y2: 'h' }
      });
      expect(
        findSketch(converted, f.sketchId)!.promotions![0]!.sourceData
      ).toMatchObject({ width: '2 mm', height: '2 mm' });
      const built = await adapter.syncDocument(converted);
      expect(built.warnings).toEqual([]);
      expect(built.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(564, 6);
      const replayed = replayCommands(f.initial, converted.commandLog);
      expect(replayed.derived.sketchGeometry).toBeUndefined();
      expect(replayed.nodes).toEqual(converted.nodes);
      const rebuilt = await adapter.syncDocument(replayed);
      expect(rebuilt.warnings).toEqual([]);
      expect(rebuilt.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(
        564,
        6
      );
      const backup = await parseProjectBackup(
        JSON.stringify({
          format: 'openzcad-project',
          version: 1,
          document: converted,
          files: []
        })
      );
      const reopened = normalizeDocument(backup.document);
      expect(reopened.derived.sketchGeometry).toBeUndefined();
      expect(reopened.nodes).toEqual(converted.nodes);
      expect(
        (await adapter.syncDocument(reopened)).bodyRepresentations[f.plateId]!
          .volume
      ).toBeCloseTo(564, 6);
      const copied = importProjectCopy(
        {
          ...backup,
          saveStates: [{ checkpointId: 'seed', document: f.initial }]
        },
        toUserId('user_conversion_copy')
      );
      const replayedCopy = replayCommands(
        copied.saveStates![0]!.document,
        copied.document.commandLog
      );
      expect(replayedCopy.nodes).toEqual(copied.document.nodes);
      expect(
        (await adapter.syncDocument(replayedCopy)).bodyRepresentations[
          f.plateId
        ]!.volume
      ).toBeCloseTo(564, 6);
      f.manager.undo();
      expect(f.manager.document.nodes).toEqual(before.nodes);
      f.manager.redo();
      expect(f.manager.document.nodes).toEqual(converted.nodes);
      f.manager.execute(
        commandFactories.setParameter({
          name: 'h',
          expression: '0.7 cm',
          quantity: 'length'
        })
      );
      expect(f.manager.document.nodes[f.loop[1]!]).toMatchObject({
        data: { x1: '2 cm', x2: '2 cm', y2: 'h' }
      });
      const heightEdit = replayCommands(
        f.initial,
        f.manager.document.commandLog
      );
      for (const document of [f.manager.document, heightEdit]) {
        const updated = await adapter.syncDocument(document);
        expect(updated.warnings).toEqual([]);
        expect(updated.bodyRepresentations[f.plateId]!.volume).toBeCloseTo(
          660,
          6
        );
      }
    }
  );

  it('requires current exact projection verdicts before preparing a live conversion', async () => {
    const f = await currentHoledPlate();
    for (const state of [
      'missing geometry',
      'missing verdict',
      'broken',
      'foreign',
      'stale'
    ] as const) {
      const document = withCurrentGeometry(f.manager.document);
      if (state === 'missing geometry') delete document.derived.sketchGeometry;
      if (state === 'missing verdict')
        delete document.derived.sketchProjections;
      if (state === 'broken')
        document.derived.sketchProjections![f.projectionId] = {
          status: 'broken',
          reason: 'source unavailable'
        };
      if (state === 'foreign')
        document.derived.sketchGeometry!.projectId =
          'proj_foreign' as ProjectDocument['projectId'];
      if (state === 'stale')
        document.derived.sketchGeometry!.documentVersion -= 1;
      const before = JSON.stringify(document);
      expect(() =>
        prepareLegacySketchConversion(document, {
          sketchId: f.sketchId,
          sourceObjectId: f.sourceObjectId
        })
      ).toThrow(/current exact/);
      expect(JSON.stringify(document)).toBe(before);
    }
  });

  it('retains strict hole multiplicity and authored loop refusal with qualified geometry', async () => {
    const f = await currentHoledPlate();
    for (const kind of ['duplicate hole', 'changed outer edge'] as const) {
      const document = withCurrentGeometry(f.manager.document);
      const feature = Object.values(document.nodes).find(
        (node) =>
          node.kind === 'feature' &&
          node.data.featureKind === 'extrude' &&
          node.data.sketchId === f.sketchId
      )!;
      if (
        feature.kind !== 'feature' ||
        feature.data.featureKind !== 'extrude' ||
        !feature.data.profile ||
        feature.data.profile.all ||
        !feature.data.profile.sourceBoundaryLoops
      )
        throw new Error('Expected precise profile.');
      const loops = feature.data.profile.sourceBoundaryLoops;
      if (kind === 'duplicate hole') loops.holes.push([...loops.holes[0]!]);
      else loops.outer[0] = loops.holes[0]![0]!;
      const before = JSON.stringify(document);
      const command = commandFactories.convertLegacySketchObject(
        prepareLegacySketchConversion(document, {
          sketchId: f.sketchId,
          sourceObjectId: f.sourceObjectId
        })
      );
      expect(() => command.apply(document)).toThrow(
        /topology|boundary|no longer/
      );
      expect(JSON.stringify(document)).toBe(before);
    }
  });

  it('binds qualification to canonical parameters, constraints, source topology and consumer references', async () => {
    const f = await currentHoledPlate();
    const base = f.manager.document;
    const command = prepared(f);
    const mutations = [
      (document: ProjectDocument) => {
        const parameter = Object.values(document.nodes).find(
          (n) => n.kind === 'parameter' && n.name === 'w'
        )!;
        if (parameter.kind === 'parameter') parameter.expression = '4 cm';
      },
      (document: ProjectDocument) => {
        findSketch(document, f.sketchId)!.constraints!.pop();
      },
      (document: ProjectDocument) => {
        const node = document.nodes[f.sourceObjectId]!;
        if (
          node.kind === 'sketch-object' &&
          node.data.objectKind === 'rectangle'
        )
          node.data.width = '3 mm';
      },
      (document: ProjectDocument) => {
        const feature = Object.values(document.nodes).find(
          (n) => n.kind === 'feature' && n.data.featureKind === 'extrude'
        )!;
        if (
          feature.kind === 'feature' &&
          feature.data.featureKind === 'extrude' &&
          feature.data.profile &&
          !feature.data.profile.all
        )
          feature.data.profile.sourceArea += 1;
      },
      (document: ProjectDocument) => {
        const source = Object.values(document.nodes).find(
          (n) => n.kind === 'feature' && n.data.featureKind === 'primitive'
        )!;
        if (
          source.kind === 'feature' &&
          source.data.featureKind === 'primitive'
        )
          source.data.dimensions.width = 40;
      }
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(base);
      mutate(candidate);
      const snapshot = JSON.stringify(candidate);
      expect(() => command.apply(candidate)).toThrow(/changed/);
      expect(JSON.stringify(candidate)).toBe(snapshot);
    }
    const noSidecar = structuredClone(base);
    delete noSidecar.derived.sketchGeometry;
    expect(() => command.apply(noSidecar)).not.toThrow();
    const stale = withCurrentGeometry(base);
    stale.version += 1;
    expect(() =>
      prepareLegacySketchConversion(stale, {
        sketchId: f.sketchId,
        sourceObjectId: f.sourceObjectId
      })
    ).toThrow(/current exact/);
  });

  it('refuses malformed, duplicate, foreign and changed-kind geometry without editing any node', async () => {
    const f = await currentHoledPlate();
    const base = f.manager.document;
    const payload = prepared(f).payload;
    const mutations = [
      (value: typeof payload) => {
        value.qualification!.version = 2 as 1;
      },
      (value: typeof payload) => {
        value.qualification!.geometryOverrides.push(
          structuredClone(value.qualification!.geometryOverrides[0]!)
        );
      },
      (value: typeof payload) => {
        value.qualification!.geometryOverrides[0]!.objectId = 'ent_foreign';
      },
      (value: typeof payload) => {
        value.qualification!.geometryOverrides[0]!.objectId = f.sourceObjectId;
      },
      (value: typeof payload) => {
        Object.assign(value.qualification!.geometryOverrides[0]!.geometry, {
          x1: Number.NaN
        });
      },
      (value: typeof payload) => {
        Object.assign(value.qualification!.geometryOverrides[0]!.geometry, {
          projection: { mode: 'unlinked' }
        });
      },
      (value: typeof payload) => {
        value.qualification!.geometryOverrides[0]!.geometry = {
          objectKind: 'circle',
          centerX: 0,
          centerY: 0,
          radius: 1
        };
      },
      (value: typeof payload) => {
        delete value.expectedSource;
      }
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(payload);
      mutate(candidate);
      const snapshot = JSON.stringify(base);
      expect(() =>
        commandFactories.convertLegacySketchObject(candidate).apply(base)
      ).toThrow();
      expect(JSON.stringify(base)).toBe(snapshot);
    }
    // Historical carriers validate witness shape after the source no longer exists.
    f.manager.execute(commandFactories.convertLegacySketchObject(payload));
    const converted = structuredClone(f.manager.document);
    expect(() => assertSketchProvenance(converted)).not.toThrow();
    const serialized = converted.commandLog.find(
      (c) => c.kind === 'sketch.legacy.convert'
    )!;
    (
      serialized.payload as typeof payload
    ).qualification!.geometryOverrides.push(
      structuredClone(payload.qualification!.geometryOverrides[0]!)
    );
    expect(() => assertSketchProvenance(converted)).toThrow(
      /qualification.*malformed/
    );
  });
});
