import { beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addAssemblyComponents,
  addPrimitiveFeature,
  addSketchFeature,
  assemblyBomTable,
  assemblyBomToCsv,
  createProjectDocument,
  deriveAssemblyBom,
  findSketch,
  holeBody,
  listFeaturesInOrder,
  standardPartBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * M17 slice 3: standard parts in the AS03 bill of materials. A part is
 * listed by its catalogue designation, parts of one designation are one
 * row whichever feature placed them, and a part in a hole counts once per
 * bore at the length the build matched.
 */

const owner = toUserId('user_m17_bom');
const allLive = () => true;
const ORIGIN = { x: 0, y: 0, z: 0 };
const DOWN = { x: 0, y: 0, z: -1 };

function screws(lengths: number[], units: 'mm' | 'inch' = 'mm') {
  const manager = new CommandManager(
    createProjectDocument('Rig', owner, units)
  );
  for (const [index, length] of lengths.entries())
    manager.execute(
      commandFactories.standardPartBody({
        name: `Screw ${index + 1}`,
        partKind: 'screw',
        system: 'iso',
        size: 'M6',
        length,
        origin: { x: 20 * index, y: 0, z: 0 },
        axis: DOWN
      })
    );
  return manager;
}

function assemble(manager: CommandManager): ProjectDocument {
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: manager.document.bodyOrder.map((bodyId, index) => ({
        componentId: `comp_${index}`,
        name: `Instance ${index + 1}`,
        bodyId,
        grounded: index === 0
      }))
    })
  );
  return manager.document;
}

describe('M17 standard parts in the bill of materials', () => {
  it('lists parts by designation, one row per designation', () => {
    const document = assemble(screws([20, 20, 30]));
    const bom = deriveAssemblyBom(document, allLive);
    expect(bom.rows.map((row) => [row.name, row.quantity])).toEqual([
      ['ISO 4762 M6×1 × 20 socket head cap screw', 2],
      ['ISO 4762 M6×1 × 30 socket head cap screw', 1]
    ]);
    expect(bom.totalQuantity).toBe(3);
    // The CSV keeps its columns; the part cell is the designation.
    const csv = assemblyBomToCsv(assemblyBomTable(bom));
    expect(csv.split('\n')[0]).toBe(
      'item,quantity,part,instances,source_body,status'
    );
    expect(csv.split('\n')[1]).toMatch(
      /^1,2,ISO 4762 M6×1 × 20 socket head cap screw,Instance 1; Instance 2,/
    );
  });

  it('keeps the designation when a body is renamed or rigidly copied', () => {
    const manager = screws([20]);
    const bodyId = manager.document.bodyOrder[0]!;
    manager.execute(
      commandFactories.transformBody({
        name: 'Copy',
        targetBodyId: bodyId,
        translation: { x: 0, y: 30, z: 0 },
        copy: true
      })
    );
    const document = assemble(manager);
    const bom = deriveAssemblyBom(document, allLive);
    expect(bom.rows).toHaveLength(1);
    expect(bom.rows[0]).toMatchObject({
      name: 'ISO 4762 M6×1 × 20 socket head cap screw',
      quantity: 2
    });
  });

  it('designates an inch document’s ANSI parts in inches', () => {
    const manager = new CommandManager(
      createProjectDocument('Rig', owner, 'inch')
    );
    for (const input of [
      { partKind: 'screw', system: 'ansi', size: '1/4', length: 0.75 },
      { partKind: 'nut', system: 'ansi', size: '1/4' },
      { partKind: 'washer', system: 'ansi', size: '1/4' }
    ] as const)
      manager.execute(
        commandFactories.standardPartBody({
          name: input.partKind,
          ...input,
          origin: ORIGIN,
          axis: DOWN
        })
      );
    const bom = deriveAssemblyBom(assemble(manager), allLive);
    expect(bom.rows.map((row) => row.name)).toEqual([
      'ASME B18.3 1/4-20 UNC × 3/4" socket head cap screw',
      'ASME B18.2.2 1/4-20 UNC hex nut',
      'ASME B18.22.1 1/4 plain washer'
    ]);
  });
});

describe('M17 standard parts in the bill of materials: built', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  function topFace(derived: DerivedState, bodyId: BodyId) {
    const body = derived.bodyRepresentations[bodyId]!;
    return body.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.999 &&
        Math.abs(
          (face.geometry.centroid ?? face.geometry.center).z - body.bbox.max.z
        ) < 1e-6
    )!;
  }

  it('counts a screw in each bore of a hole at its matched length', async () => {
    const plate = addPrimitiveFeature(
      createProjectDocument('Plate', owner, 'mm'),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const sketched = addSketchFeature(plate, {
      name: 'Points',
      planeRef: { type: 'canonical', plane: 'XY', offset: 10 },
      objects: [
        { objectKind: 'point', x: 10, y: 10 },
        { objectKind: 'point', x: 30, y: 30 }
      ]
    });
    const plateId = sketched.document.bodyOrder[0]!;
    const face = topFace(
      await adapter.syncDocument(sketched.document),
      plateId
    );
    const holed = holeBody(sketched.document, {
      name: 'Hole 1',
      targetBodyId: plateId,
      faceHash: face.hash,
      ...(face.reference ? { faceReference: face.reference } : {}),
      style: 'simple',
      diameter: 6.6,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid',
      points: {
        sketchId: sketched.sketchId,
        pointIds: findSketch(
          sketched.document,
          sketched.sketchId
        )!.objectIds.map(String)
      },
      standard: { system: 'iso', size: 'M6', kind: 'clearance' }
    }).document;
    const hole = listFeaturesInOrder(holed).at(-1)!;
    const holeId = hole.featureId;
    const withScrews = standardPartBody(holed, {
      name: 'Screws',
      partKind: 'screw',
      system: 'iso',
      size: 'M6',
      origin: ORIGIN,
      axis: DOWN,
      hole: { featureId: holeId }
    }).document;
    const assembled = addAssemblyComponents(withScrews, {
      components: [
        {
          componentId: 'plate',
          name: 'Plate',
          bodyId: hole.bodyId!,
          grounded: true
        },
        {
          componentId: 'screws',
          name: 'Screws',
          bodyId: listFeaturesInOrder(withScrews).at(-1)!.bodyId!,
          grounded: false
        }
      ]
    });
    const derived = await adapter.syncDocument(assembled);
    expect(
      [
        ...derived.warnings,
        ...(derived.featureWarnings ?? []).map((w) => w.message)
      ].join('\n')
    ).toBe('');
    const built = { ...assembled, derived };
    const bom = deriveAssemblyBom(built);
    // 10 through, a 5.2 nut and two pitches: the preferred 20.
    expect(bom.rows.map((row) => [row.name, row.quantity])).toEqual([
      ['Plate Body', 1],
      ['ISO 4762 M6×1 × 20 socket head cap screw', 2]
    ]);
    expect(bom.totalQuantity).toBe(3);
  }, 900_000);
});
