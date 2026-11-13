import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProjectDocument,
  filletEdges,
  gearBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type BodyRepresentation } from '@openzcad/shared';
import { expectPassedThrough } from './support/failed-pass-through';
import {
  between,
  edgeNamed,
  edgeNames,
  expectRimBlend,
  featureEdges,
  modifyEdge,
  teethOnBoss
} from './support/gear-edge-fixtures';

/**
 * M14: a gear body names its edges from the two faces each lies between, so
 * a fillet or chamfer on a rim follows the gear's later edits. Before this
 * gear results published face names only and an edge modifier on one was
 * pinned to an edge hash, which any span, module or tooth-count edit broke.
 */

/** Set-module teeth 6 long, 3 from an end of the Ø22 × 12 boss. */
const SET_MODULE = {
  fit: 'module' as const,
  pitch: 0.9,
  faceWidth: 6,
  offset: 3
};

describe('gear edge names (M14)', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  /** Every pickable edge is named, each name once. */
  function expectAllNamed(body: BodyRepresentation): string[] {
    const names = featureEdges(body).map(
      (edge) => edge.reference?.lineageName
    );
    expect(names).not.toContain(undefined);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^gear\.edge\.between\.[^|]+\|[^|]+$/);
    }
    // A seam bounds one face twice and takes no name.
    for (const edge of body.topology!.edges) {
      if (edge.displayRole === 'seam') expect(edge.reference).toBeUndefined();
    }
    return names as string[];
  }

  it('names every edge of a new gear from the two faces it lies between', async () => {
    const gear = gearBody(
      createProjectDocument('Gear', toUserId('user_gear_edges')),
      {
        name: 'Gear 1',
        gearType: 'external',
        sizing: 'module',
        pitch: 2,
        teeth: 20,
        faceWidth: 5,
        boreDiameter: 8,
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 }
      }
    );
    const derived = await adapter.syncDocument(gear.document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[gear.bodyId]!;
    const names = expectAllNamed(body);
    // 20 teeth × 24 edges and the bore's two rims; the bore's seam is extra.
    expect(names).toHaveLength(482);
    expect(body.topology!.edges).toHaveLength(483);
    for (const name of [
      between('bore', 'cap.start'),
      between('bore', 'cap.end'),
      between('cap.start', 'tooth[3].tip'),
      between('tooth[19].flank.plus', 'tooth[19].tip'),
      between('cap.end', 'root[7]')
    ]) {
      expect(names).toContain(name);
    }
    // Each name is the pair of faces the kernel's own topology puts the
    // edge between.
    const faceName = new Map(
      body.topology!.faces.map(
        (face) => [face.hash, face.reference!.lineageName] as const
      )
    );
    for (const edge of featureEdges(body)) {
      const pair = edge.adjacentFaceHashes!.map((hash) => faceName.get(hash)!);
      expect(pair).toHaveLength(2);
      expect(edge.reference!.lineageName).toBe(
        `gear.edge.between.${[...pair].sort().join('|')}`
      );
    }
    // The faces keep the names and hashes they had: the edge names add to
    // the body's lineage and change none of it.
    const faces = body.topology!.faces.map((face) => face.reference?.lineageName);
    expect(faces).not.toContain(undefined);
    expect(new Set(faces).size).toBe(faces.length);
  });

  it('names the same edges the same way on a second kernel and after an edit and back', async () => {
    const first = await teethOnBoss(adapter, SET_MODULE);
    const names = edgeNames(first.body);
    expectAllNamed(first.body);
    const second = await createExactKernelAdapter();
    try {
      const again = await teethOnBoss(second, SET_MODULE);
      expect(edgeNames(again.body)).toEqual(names);
    } finally {
      second.dispose();
    }
    let document = updateFeature(first.document, {
      featureId: first.gearId,
      data: { faceWidth: 4, offset: 5 }
    });
    const moved = (await adapter.syncDocument(document)).bodyRepresentations[
      first.bodyId
    ]!;
    // The same edges under the same names, wherever they now are.
    expect(Object.keys(edgeNames(moved)).sort()).toEqual(
      Object.keys(names).sort()
    );
    expect(edgeNames(moved)).not.toEqual(names);
    document = updateFeature(document, {
      featureId: first.gearId,
      data: { faceWidth: 6, offset: 3 }
    });
    const back = (await adapter.syncDocument(document)).bodyRepresentations[
      first.bodyId
    ]!;
    expect(edgeNames(back)).toEqual(names);
  });

  it('names whole-face and keep-diameter teeth, leaving unnamed only the halves a collar seam cuts', async () => {
    const whole = await teethOnBoss(adapter, {});
    // A plain boss leaves no face but the gear's: 20 teeth × 24 edges.
    expect(expectAllNamed(whole.body)).toHaveLength(480);

    const partial = await teethOnBoss(adapter, { faceWidth: 6, offset: 3 });
    const edges = featureEdges(partial.body);
    const names = edges.flatMap((edge) =>
      edge.reference ? [edge.reference.lineageName] : []
    );
    expect(new Set(names).size).toBe(names.length);
    // The tips stand flush on the collars, and each collar's seam cuts the
    // arc it shares with one tip in two. Neither half is "the" edge between
    // the two faces, and at one height nothing fixed tells them apart, so
    // both go unnamed rather than risk one taking the other's name. They are
    // smooth edges: no fillet or chamfer applies to them.
    const faceName = new Map(
      partial.body.topology!.faces.map(
        (face) => [face.hash, face.reference!.lineageName] as const
      )
    );
    const unnamed = edges.filter((edge) => !edge.reference);
    expect(unnamed).toHaveLength(4);
    for (const edge of unnamed) expect(edge.isSmooth).toBe(true);
    expect(
      unnamed
        .map((edge) =>
          edge
            .adjacentFaceHashes!.map((hash) => faceName.get(hash)!)
            .sort()
            .join('|')
        )
        .sort()
    ).toEqual([
      'gear.face.collar.end|gear.face.tooth[0].tip',
      'gear.face.collar.end|gear.face.tooth[0].tip',
      'gear.face.collar.start|gear.face.tooth[0].tip',
      'gear.face.collar.start|gear.face.tooth[0].tip'
    ]);
    for (const end of ['start', 'end'] as const) {
      expect(names).not.toContain(between(`collar.${end}`, 'tooth[0].tip'));
      // Every other tip meets the collar in one edge.
      expect(names).toContain(between(`collar.${end}`, 'tooth[7].tip'));
    }
    expect(names.filter((name) => /\.piece\./.test(name))).toEqual([]);
    for (const name of [
      between('cap.start', 'collar.start'),
      between('collar.end', 'shoulder.end[3]'),
      between('root[3]', 'shoulder.start[3]')
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('edge modifiers on a gear’s cap rim (M14)', { timeout: 600_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 60_000);

  afterAll(() => adapter.dispose());

  it.each([
    ['fillet', 'start'],
    ['fillet', 'end'],
    ['chamfer', 'start'],
    ['chamfer', 'end']
  ] as const)(
    'keeps a %s on the top rim through span, offset, tooth-count, module and height edits, teeth anchored at the %s',
    async (kind, anchor) => {
      const gear = await teethOnBoss(adapter, {
        ...SET_MODULE,
        ...(anchor === 'end' ? { anchor } : {})
      });
      // The rim of the face's far cap, between that cap and the collar the
      // teeth leave below it.
      const rim = edgeNamed(gear.body, between('cap.end', 'collar.end'));
      const size = 0.5;
      const modified = modifyEdge(kind, gear.document, gear.bodyId, rim, size);
      let document = modified.document;
      const ids = { gear: gear.bodyId, modified: modified.bodyId };
      const blend = { kind, radius: 11, size, side: 'outer' as const };
      expectRimBlend(await adapter.syncDocument(document), 'as built', ids, {
        ...blend,
        z: 12
      });
      for (const [step, featureId, data, z] of [
        ['shorter teeth', gear.gearId, { faceWidth: 4 }, 12],
        ['nearer the end', gear.gearId, { offset: 2 }, 12],
        ['moved and resized', gear.gearId, { faceWidth: 5, offset: 4 }, 12],
        ['fewer teeth', gear.gearId, { teeth: 18 }, 12],
        ['a finer module', gear.gearId, { pitch: 0.8 }, 12],
        // What a drag of the blank's cap stores.
        ['a taller blank', gear.blankId, { dimensions: { height: 14 } }, 14]
      ] as const) {
        document = updateFeature(document, { featureId, data });
        expectRimBlend(await adapter.syncDocument(document), step, ids, {
          ...blend,
          z
        });
      }
    }
  );

  it('upgrades a fillet stored by hash alone, as every gear edge pick was, so it follows the next edit', async () => {
    const gear = await teethOnBoss(adapter, SET_MODULE);
    const name = between('cap.end', 'collar.end');
    const rim = edgeNamed(gear.body, name);
    const size = 0.5;
    // As documents saved before gear edges had names hold it: no reference.
    const stored = filletEdges(gear.document, {
      name: 'Edge break',
      targetBodyId: gear.bodyId,
      edgeHashes: [rim.hash],
      size
    });
    const ids = { gear: gear.bodyId, modified: stored.bodyId };
    const blend = {
      kind: 'fillet' as const,
      radius: 11,
      size,
      side: 'outer' as const,
      z: 12
    };
    const derived = await adapter.syncDocument(stored.document);
    expectRimBlend(derived, 'by hash', ids, blend);
    // The build that resolved the hash offers the edge's name with it.
    expect(derived.referenceRepairs).toHaveLength(1);
    const repair = derived.referenceRepairs![0]!;
    expect(
      repair.edgeReferences.map((reference) => reference.lineageName)
    ).toEqual([name]);
    expect(repair.edgeReferences[0]!.currentHash).toBe(rim.hash);
    // A taller blank moves the rim, and with it the edge's hash.
    const taller = (document: typeof stored.document) =>
      updateFeature(
        updateFeature(document, {
          featureId: gear.gearId,
          data: { faceWidth: 4, offset: 2, teeth: 18 }
        }),
        { featureId: gear.blankId, data: { dimensions: { height: 14 } } }
      );
    const repaired = updateFeature(stored.document, {
      featureId: repair.featureId,
      data: { edgeReferences: repair.edgeReferences }
    });
    expectRimBlend(await adapter.syncDocument(taller(repaired)), 'edited', ids, {
      ...blend,
      z: 14
    });
    // Left hash-only, the same edit loses the edge, as it did before.
    const unrepaired = await adapter.syncDocument(taller(stored.document));
    expect(
      unrepaired.featureWarnings?.some(
        (warning) =>
          warning.kind === 'build-failed' && warning.featureName === 'Edge break'
      )
    ).toBe(true);
  });

  it('refuses, and never moves to another edge, once the rim is gone, and resolves again when it returns', async () => {
    const gear = await teethOnBoss(adapter, SET_MODULE);
    const rim = edgeNamed(gear.body, between('cap.end', 'collar.end'));
    const size = 0.5;
    const modified = modifyEdge('fillet', gear.document, gear.bodyId, rim, size);
    let document = modified.document;
    const ids = { gear: gear.bodyId, modified: modified.bodyId };
    const blend = {
      kind: 'fillet' as const,
      radius: 11,
      size,
      side: 'outer' as const,
      z: 12
    };
    expectRimBlend(await adapter.syncDocument(document), 'as built', ids, blend);
    for (const [step, edit] of [
      // Teeth up to the top: no collar there, the cap is the toothed ring.
      ['teeth reach the end', { data: { faceWidth: 6, offset: 6 } }],
      // Teeth along the whole face: no collar at either end.
      ['whole face', { clearData: ['faceWidth', 'offset'] }]
    ] as const) {
      document = updateFeature(document, { featureId: gear.gearId, ...edit });
      const derived = await adapter.syncDocument(document);
      const refusal = derived.featureWarnings!.find(
        (warning) => warning.kind === 'build-failed'
      );
      expect(refusal?.featureName, step).toBe('Edge break');
      expect(refusal?.kernelRefusal?.code, step).toBe('reference_missing');
      expect(refusal?.message, step).toMatch(
        /Edge modifier edge is stale: The selected edge lineage no longer exists\./
      );
      // The gear is handed through as it is: no edge was rounded instead.
      expectPassedThrough(derived, modified.bodyId, gear.bodyId);
      const names = derived.bodyRepresentations[
        gear.bodyId
      ]!.topology!.edges.map((edge) => edge.reference?.lineageName);
      expect(names, step).not.toContain(between('cap.end', 'collar.end'));
    }
    // The collar back: the same reference finds its rim again.
    document = updateFeature(document, {
      featureId: gear.gearId,
      data: { faceWidth: 5, offset: 2 }
    });
    expectRimBlend(await adapter.syncDocument(document), 'restored', ids, blend);
  });
});
