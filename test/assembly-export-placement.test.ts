import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activateConfiguration,
  addAssemblyComponents,
  addAssemblyJoint,
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  assemblyConfigurationOnlyBodies,
  assemblyConfigurationOverrides,
  createConfigurations,
  createProjectDocument,
  documentForConfiguration,
  documentForConfigurationExport,
  importMeshBody,
  listParameters,
  setAssemblyExplode,
  setConfigurationCell,
  setParameter,
  updateAssemblyComponent
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  solveAssembly,
  toUserId,
  transformToMatrix4,
  type BodyId,
  type FeatureNode,
  type ProjectDocument
} from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { parseStl } from '@openzcad/io-stl';
import { exportedModel } from './support/three-mf-export';
import { coincidentBoxSoup } from './support/mesh-import-fixtures';
import { stepOccurrenceFrames } from './e2e/step-occurrence-frames';

/**
 * AS04 (#2391): IGES and the mesh formats have no product structure, so an
 * assembly's solved part placements are baked into their geometry: every
 * part lands in the file where Assemble (and the STEP occurrences) put it,
 * never at its modelling origin, and never at its exploded offset.
 *
 * F06 (#2389): an export builds the document once, in its active
 * configuration, so while an assembly part shows another configuration the
 * export is refused, naming the part and its row, rather than writing a
 * different part without saying so.
 */

type Box = [number, number, number, number, number, number];

let adapter: ExactKernelAdapter;
let kernel: RemusKernel;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
  kernel = new RemusKernel();
});
afterAll(() => {
  adapter.dispose();
  kernel.free();
});

/**
 * A grounded base and an arm turned a quarter about a vertical pivot at
 * (5, 5, 0) and lifted 10 mm (a cylindrical joint), with an exploded offset
 * that is presentation only.
 */
async function hinge() {
  let document = createProjectDocument('Hinge', toUserId('user_as04'));
  for (const [name, dimensions] of [
    ['Base', { width: 40, height: 10, depth: 20 }],
    ['Arm', { width: 30, height: 4, depth: 6 }]
  ] as const)
    document = addPrimitiveFeature(document, {
      name,
      bodyName: name,
      primitiveKind: 'box',
      dimensions
    });
  const [base, arm] = document.bodyOrder as [BodyId, BodyId];
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_base', name: 'Base', bodyId: base, grounded: true },
      { componentId: 'c_arm', name: 'Arm', bodyId: arm, grounded: false }
    ]
  });
  const pivot = {
    origin: { x: 5, y: 5, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 }
  };
  document = addAssemblyJoint(document, {
    joint: {
      id: 'j_pivot',
      name: 'Pivot',
      kind: 'cylindrical',
      parent: { componentId: 'c_base', frame: pivot },
      child: { componentId: 'c_arm', frame: pivot },
      values: [90, 10],
      limits: [null, null]
    }
  });
  document = setAssemblyExplode(document, {
    offsets: { c_arm: { x: 0, y: 0, z: 500 } }
  });
  const derived = await adapter.syncDocument(document);
  const synced: ProjectDocument = { ...document, derived };
  const boxOf = (bodyId: BodyId): Box => {
    const b = derived.bodyRepresentations[bodyId]!.bbox;
    return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
  };
  const pose = transformToMatrix4(
    solveAssembly(document.assembly!).poses.get('c_arm')!
  );
  return {
    document: synced,
    ids: [...derived.exportableBodyIds],
    base: boxOf(base),
    arm: boxOf(arm),
    posedArm: posedBox(boxOf(arm), pose)
  };
}

/** A box's corners carried by a column-major pose, as their extent. */
function posedBox(box: Box, pose: readonly number[]): Box {
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
    const p = [
      i & 1 ? box[3] : box[0],
      i & 2 ? box[4] : box[1],
      i & 4 ? box[5] : box[2]
    ];
    return [0, 1, 2].map(
      (r) =>
        pose[r]! * p[0]! +
        pose[4 + r]! * p[1]! +
        pose[8 + r]! * p[2]! +
        pose[12 + r]!
    );
  });
  return [
    ...[0, 1, 2].map((axis) => Math.min(...corners.map((c) => c[axis]!))),
    ...[0, 1, 2].map((axis) => Math.max(...corners.map((c) => c[axis]!)))
  ] as Box;
}

function expectBox(actual: Box | undefined, expected: Box, digits = 4) {
  expect(actual).toBeDefined();
  actual!.forEach((value, index) =>
    expect(value).toBeCloseTo(expected[index]!, digits)
  );
}

/** Each solid an IGES file holds, read the way the app imports IGES. */
async function igesSolidBoxes(iges: string): Promise<Box[]> {
  const io = await loadRemusTranslators();
  const step = io.igesBrepAsStep(new TextEncoder().encode(iges));
  return [...kernel.deserializeSolids(io.importStep(step))].map((solid) => {
    expect(kernel.validateSolid(solid)).toBe(0);
    return Array.from(kernel.boundingBox(solid)) as Box;
  });
}

/**
 * Each 3MF build item's world extent by object name: the object's vertices
 * carried by the item's transform (row-vector 3MF convention), read from
 * the model XML itself rather than through the app's importer.
 */
function threeMfItemBoxes(bytes: Uint8Array): Map<string, Box> {
  const xml = exportedModel(bytes);
  const objects = new Map<string, { name: string; points: number[][] }>();
  for (const match of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const id = /\bid="([^"]+)"/.exec(match[1]!)![1]!;
    const name = /\bname="([^"]*)"/.exec(match[1]!)?.[1] ?? id;
    const points = [...match[2]!.matchAll(/<vertex\b([^>]*)\/>/g)].map(
      (vertex) =>
        ['x', 'y', 'z'].map((axis) =>
          Number(new RegExp(`\\b${axis}="([^"]+)"`).exec(vertex[1]!)![1])
        )
    );
    objects.set(id, { name, points });
  }
  const boxes = new Map<string, Box>();
  for (const match of xml.matchAll(/<item\b([^>]*)\/?>/g)) {
    const object = objects.get(/\bobjectid="([^"]+)"/.exec(match[1]!)![1]!)!;
    const t = /\btransform="([^"]+)"/
      .exec(match[1]!)?.[1]
      ?.trim()
      .split(/\s+/)
      .map(Number) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
    const world = object.points.map(([x, y, z]) =>
      [0, 1, 2].map(
        (c) => x! * t[c]! + y! * t[3 + c]! + z! * t[6 + c]! + t[9 + c]!
      )
    );
    boxes.set(object.name, [
      ...[0, 1, 2].map((axis) => Math.min(...world.map((p) => p[axis]!))),
      ...[0, 1, 2].map((axis) => Math.max(...world.map((p) => p[axis]!)))
    ] as Box);
  }
  return boxes;
}

describe('assembly placements in formats without structure (AS04, #2391)', () => {
  it('writes each IGES solid where the assembly solved its part', async () => {
    const { document, ids, base, arm, posedArm } = await hinge();
    // The pose really moves the arm, and the explode never reaches a file.
    expect(posedArm).not.toEqual(arm);
    expect(posedArm[2]).toBeCloseTo(arm[2] + 10, 6);

    const boxes = await igesSolidBoxes(await adapter.exportIges(document, ids));
    expect(boxes).toHaveLength(2);
    const near = (target: Box) =>
      boxes.find((box) =>
        box.every((value, index) => Math.abs(value - target[index]!) < 1e-4)
      );
    expectBox(near(base), base);
    expectBox(near(posedArm), posedArm);
    // Nothing is left at the arm's modelling origin.
    expect(near(arm)).toBeUndefined();

    // Agrees with the STEP occurrence: its frame in the part is the inverse
    // of the pose, so carrying that origin by the pose gives the origin.
    const step = await adapter.exportStep(document, ids);
    const frames = stepOccurrenceFrames(step).filter((frame) =>
      frame.origin.some((value) => Math.abs(value) > 1e-9)
    );
    expect(frames).toHaveLength(1);
  }, 120_000);

  it('writes IGES posed in the export unit too', async () => {
    const { document, ids, base, posedArm } = await hinge();
    const boxes = await igesSolidBoxes(
      await adapter.exportIges(document, ids, { units: 'inch' })
    );
    // The reader returns millimetres from the declared inch unit.
    const near = (target: Box) =>
      boxes.find((box) =>
        box.every((value, index) => Math.abs(value - target[index]!) < 1e-3)
      );
    expectBox(near(base), base, 3);
    expectBox(near(posedArm), posedArm, 3);
  }, 120_000);

  it('places each 3MF object where the assembly solved its part', async () => {
    const { document, ids, base, posedArm } = await hinge();
    const bytes = await adapter.exportMesh(document, ids, {
      format: '3mf',
      deflection: 0.05
    });
    const boxes = threeMfItemBoxes(bytes);
    expect([...boxes.keys()].sort()).toEqual(['Arm', 'Base']);
    // Boxes tessellate onto their own corners, so the extent is exact.
    expectBox(boxes.get('Base'), base);
    expectBox(boxes.get('Arm'), posedArm);
  }, 120_000);

  it('writes binary STL facets posed', async () => {
    const { document, ids, base, posedArm } = await hinge();
    const bytes = await adapter.exportMesh(document, ids, {
      format: 'stl-binary',
      deflection: 0.05
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const count = view.getUint32(80, true);
    const all: number[][] = [];
    for (let i = 0; i < count; i += 1)
      for (let v = 0; v < 3; v += 1) {
        const at = 84 + i * 50 + 12 + v * 12;
        all.push([0, 1, 2].map((c) => view.getFloat32(at + c * 4, true)));
      }
    const extent = [
      ...[0, 1, 2].map((axis) => Math.min(...all.map((p) => p[axis]!))),
      ...[0, 1, 2].map((axis) => Math.max(...all.map((p) => p[axis]!)))
    ];
    const expected = [
      ...[0, 1, 2].map((axis) => Math.min(base[axis]!, posedArm[axis]!)),
      ...[3, 4, 5].map((axis) => Math.max(base[axis]!, posedArm[axis]!))
    ] as Box;
    expectBox(extent as Box, expected, 3);
  }, 120_000);

  it.each(['stl-ascii', 'stl-binary'] as const)(
    'writes an imported mesh reference posed in %s',
    async (format) => {
      const { document, base, scan, ids, posedScan } = await meshHinge();
      expect(posedScan).not.toEqual(scan);
      const extent = async (bodyIds: BodyId[]) =>
        stlExtent(
          await adapter.exportMesh(document, bodyIds, {
            format,
            deflection: 0.05
          })
        );
      // The reference alone, then beside an exact part.
      expectBox(await extent([ids.scan]), posedScan, 3);
      expectBox(
        await extent([ids.base, ids.scan]),
        [
          ...[0, 1, 2].map((axis) => Math.min(base[axis]!, posedScan[axis]!)),
          ...[3, 4, 5].map((axis) => Math.max(base[axis]!, posedScan[axis]!))
        ] as Box,
        3
      );
      // The other mesh formats take no reference at all, so none of them
      // can write it unposed.
      for (const other of ['3mf', 'obj', 'ply', 'glb'] as const)
        await expect(
          adapter.exportMesh(document, [ids.scan], {
            format: other,
            deflection: 0.05
          })
        ).rejects.toThrow(/mesh reference has no exact solid/);
    },
    120_000
  );
});

/** Every STL vertex's extent, ASCII or binary. */
function stlExtent(bytes: Uint8Array): Box {
  const parsed = parseStl(bytes.slice().buffer, 'assembly.stl');
  const axis = (a: number) =>
    Array.from(parsed.vertices).filter((_, i) => i % 3 === a);
  return [
    ...[0, 1, 2].map((a) => Math.min(...axis(a))),
    ...[0, 1, 2].map((a) => Math.max(...axis(a)))
  ] as Box;
}

/** The hinge, with an imported mesh reference as its moving part. */
async function meshHinge() {
  const imported = importMeshBody(
    createProjectDocument('Scan hinge', toUserId('user_as04')),
    {
      name: 'Scan',
      artifactId: 'artifact_scan_hinge',
      sourceName: 'scan.stl',
      ...coincidentBoxSoup()
    }
  );
  let document = addPrimitiveFeature(imported.document, {
    name: 'Base',
    bodyName: 'Base',
    primitiveKind: 'box',
    dimensions: { width: 40, height: 10, depth: 20 }
  });
  const scanId = imported.bodyId;
  const baseId = document.bodyOrder.find((id) => id !== scanId)!;
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_base', name: 'Base', bodyId: baseId, grounded: true },
      { componentId: 'c_scan', name: 'Scan', bodyId: scanId, grounded: false }
    ]
  });
  const pivot = {
    origin: { x: 5, y: 5, z: 0 },
    zAxis: { x: 0, y: 0, z: 1 },
    xAxis: { x: 1, y: 0, z: 0 }
  };
  document = addAssemblyJoint(document, {
    joint: {
      id: 'j_pivot',
      name: 'Pivot',
      kind: 'cylindrical',
      parent: { componentId: 'c_base', frame: pivot },
      child: { componentId: 'c_scan', frame: pivot },
      values: [90, 10],
      limits: [null, null]
    }
  });
  const derived = await adapter.syncDocument(document);
  expect(derived.bodyRepresentations[scanId]?.meshReference).toBe(true);
  const boxOf = (bodyId: BodyId): Box => {
    const b = derived.bodyRepresentations[bodyId]!.bbox;
    return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
  };
  const pose = transformToMatrix4(
    solveAssembly(document.assembly!).poses.get('c_scan')!
  );
  const synced: ProjectDocument = { ...document, derived };
  return {
    document: synced,
    ids: { base: baseId, scan: scanId },
    base: boxOf(baseId),
    scan: boxOf(scanId),
    posedScan: posedBox(boxOf(scanId), pose)
  };
}

/**
 * #2389's fixture: a plate whose width the configuration drives (Narrow 20,
 * Wide 45) and an Indicator lug that Wide suppresses, both assembly parts.
 */
function configuredPlate() {
  let document = createProjectDocument('Stop', toUserId('user_f06'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    bodyName: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Indicator lug',
    bodyName: 'Indicator lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  const width = listParameters(document)[0]!.parameterId;
  const lug = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Indicator lug'
  )!;
  const [plate, lugBody] = document.bodyOrder as [BodyId, BodyId];
  document = createConfigurations(document, {
    rowId: 'narrow',
    name: 'Narrow'
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'parameter', parameterId: width }
  });
  document = addConfigurationColumn(document, {
    column: { kind: 'suppression', featureId: lug.featureId }
  });
  document = addConfigurationRow(document, { rowId: 'wide', name: 'Wide' });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  document = setConfigurationCell(document, {
    rowId: 'wide',
    column: { kind: 'suppression', featureId: lug.featureId },
    value: true
  });
  document = addAssemblyComponents(document, {
    components: [
      { componentId: 'c_plate', name: 'Plate', bodyId: plate, grounded: true },
      {
        componentId: 'c_lug',
        name: 'Indicator lug',
        bodyId: lugBody,
        grounded: true
      }
    ]
  });
  return { document, ids: [plate, lugBody] };
}

async function everyExport(document: ProjectDocument, ids: BodyId[]) {
  return Promise.allSettled([
    adapter.exportStep(document, ids),
    adapter.exportStepBodies(document),
    adapter.exportIges(document, ids),
    adapter.exportMesh(document, ids, { format: '3mf', deflection: 0.1 }),
    adapter.exportMesh(document, ids, { format: 'glb', deflection: 0.1 }),
    adapter.exportStl(document, ids)
  ]);
}

describe('assembly parts in another configuration (F06, #2389)', () => {
  it('refuses every export while a part shows a row the model is not in', async () => {
    const { document: start, ids } = configuredPlate();
    const document = updateAssemblyComponent(start, {
      componentId: 'c_plate',
      configurationId: 'wide'
    });
    const before = JSON.stringify(document);
    for (const result of await everyExport(document, ids)) {
      expect(result.status).toBe('rejected');
      expect(String((result as PromiseRejectedResult).reason)).toMatch(
        /Export refused: Assemble shows Plate in Wide, but an export writes every part in the active configuration, Narrow\. Set its Configuration to follow the model, or make Wide the active configuration/
      );
    }
    // The model's own active row is untouched.
    expect(JSON.stringify(document)).toBe(before);
    expect(document.configurations?.activeRowId).toBe('narrow');
  }, 120_000);

  it('refuses a part kept in a row whose body the active row suppresses', async () => {
    const { document: start, ids } = configuredPlate();
    let document = updateAssemblyComponent(start, {
      componentId: 'c_lug',
      configurationId: 'narrow'
    });
    document = updateAssemblyComponent(document, {
      componentId: 'c_plate',
      configurationId: 'narrow'
    });
    // Wide active: the lug is suppressed in the model, kept by its part.
    document = activateConfiguration(document, { rowId: 'wide' });
    expect(await adapter.documentExportBodyIds(document)).toEqual([ids[0]]);
    // The app's export scope adds the body only the part's row builds.
    const synced: ProjectDocument = {
      ...document,
      derived: await adapter.syncDocument(document)
    };
    expect(assemblyConfigurationOnlyBodies(synced)).toEqual([
      { bodyId: ids[1], name: 'Indicator lug' }
    ]);
    for (const result of await everyExport(synced, ids))
      expect(String((result as PromiseRejectedResult).reason)).toMatch(
        /Assemble shows Plate in Narrow and Indicator lug in Narrow, but an export writes every part in the active configuration, Wide\. Set their Configuration to follow the model, or make Narrow the active configuration/
      );
    // The lug alone, which the active row does not build, is still named.
    await expect(adapter.exportStep(synced, [ids[1]!])).rejects.toThrow(
      /Assemble shows Indicator lug in Narrow, but/
    );
  }, 120_000);

  it('refuses only for parts inside the export scope', async () => {
    const { document: start, ids } = configuredPlate();
    const document = updateAssemblyComponent(start, {
      componentId: 'c_plate',
      configurationId: 'wide'
    });
    const [plate, lug] = ids as [BodyId, BodyId];
    // The plate hidden or unselected: the lug alone exports.
    for (const result of await Promise.allSettled([
      adapter.exportStep(document, [lug]),
      adapter.exportIges(document, [lug]),
      adapter.exportMesh(document, [lug], { format: '3mf', deflection: 0.1 }),
      adapter.exportMesh(document, [lug], {
        format: 'stl-binary',
        deflection: 0.1
      }),
      adapter.exportStl(document, [lug])
    ]))
      expect(result.status).toBe('fulfilled');
    expect(assemblyConfigurationOverrides(document, [lug])).toEqual([]);
    await expect(adapter.exportStep(document, [plate])).rejects.toThrow(
      /Assemble shows Plate in Wide/
    );
    // A whole-model export holds every part.
    await expect(adapter.exportStepBodies(document)).rejects.toThrow(
      /Assemble shows Plate in Wide/
    );
  }, 120_000);

  it('exports another row with every part in it, pinned or not', async () => {
    // Narrow active; Plate names Narrow, the lug names Wide.
    const { document: start, ids } = configuredPlate();
    let document = updateAssemblyComponent(start, {
      componentId: 'c_plate',
      configurationId: 'narrow'
    });
    document = updateAssemblyComponent(document, {
      componentId: 'c_lug',
      configurationId: 'wide'
    });
    // Built as it stands, the Wide row keeps Plate pinned to Narrow, which
    // its export would refuse.
    expect(
      assemblyConfigurationOverrides(documentForConfiguration(document, 'wide'))
    ).toHaveLength(1);
    const wide = documentForConfigurationExport(document, 'wide');
    expect(wide.configurations?.activeRowId).toBe('wide');
    expect(
      wide.assembly?.components.map((c) => c.configurationId ?? null)
    ).toEqual([null, null]);
    expect(assemblyConfigurationOverrides(wide)).toEqual([]);
    const shown = await adapter.documentExportBodyIds(wide);
    expect(shown).toEqual([ids[0]]);
    for (const result of await everyExport(wide, shown))
      expect(result.status).toBe('fulfilled');
    // The written plate is Wide's 45 mm.
    const boxes = await igesSolidBoxes(await adapter.exportIges(wide, shown));
    expect(boxes).toHaveLength(1);
    expect(boxes[0]![3] - boxes[0]![0]).toBeCloseTo(45, 4);
    // The open document is untouched, and its active row keeps the pins.
    expect(document.configurations?.activeRowId).toBe('narrow');
    expect(documentForConfigurationExport(document, 'narrow')).toBe(document);
  }, 240_000);

  it('exports a part that names the active row, or follows the model', async () => {
    const { document: start, ids } = configuredPlate();
    const named = updateAssemblyComponent(start, {
      componentId: 'c_plate',
      configurationId: 'narrow'
    });
    const following = updateAssemblyComponent(named, {
      componentId: 'c_plate',
      configurationId: null
    });
    for (const document of [named, following])
      for (const result of await everyExport(document, ids))
        expect(result.status).toBe('fulfilled');
  }, 240_000);
});
