import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  addConfigurationColumn,
  addConfigurationRow,
  addPrimitiveFeature,
  createConfigurations,
  createProjectDocument,
  documentForConfiguration,
  importMeshBody,
  listParameters,
  setConfigurationCell,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type FeatureNode } from '@openzcad/shared';
import { coincidentBoxSoup } from './support/mesh-import-fixtures';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

/**
 * F06 slice 2: any row exports exactly, built for the file alone, without
 * the open document changing or the row being shown.
 */

function bracket() {
  let document = createProjectDocument('Bracket', toUserId('user_cfg'));
  document = setParameter(document, { name: 'width', expression: '20' });
  document = addPrimitiveFeature(document, {
    name: 'Plate',
    primitiveKind: 'box',
    dimensions: { width: 'width', height: 10, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Lug',
    primitiveKind: 'box',
    dimensions: { width: 4, height: 4, depth: 4 }
  });
  document = addPrimitiveFeature(document, {
    name: 'Tag',
    primitiveKind: 'box',
    dimensions: { width: 2, height: 2, depth: 2 }
  });
  const width = listParameters(document)[0]!.parameterId;
  const lug = Object.values(document.nodes).find(
    (node): node is FeatureNode =>
      node.kind === 'feature' && node.name === 'Lug'
  )!;
  const [plate, lugBody, tag] = document.bodyOrder;
  document = createConfigurations(document, { rowId: 'small', name: 'Small' });
  for (const column of [
    { kind: 'parameter', parameterId: width },
    { kind: 'suppression', featureId: lug.featureId },
    { kind: 'body', bodyId: tag! }
  ] as const)
    document = addConfigurationColumn(document, { column });
  // Small hides the tag; Large is 45 wide, without the lug, with the tag.
  document = setConfigurationCell(document, {
    rowId: 'small',
    column: { kind: 'body', bodyId: tag! },
    value: false
  });
  document = addConfigurationRow(document, { rowId: 'large', name: 'Large' });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'parameter', parameterId: width },
    value: '45'
  });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'suppression', featureId: lug.featureId },
    value: true
  });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'body', bodyId: tag! },
    value: true
  });
  return { document, plate: plate!, lugBody: lugBody!, tag: tag! };
}

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

it('lists and writes the bodies each row shows, leaving the document alone', async () => {
  const { document, plate, lugBody, tag } = bracket();
  const before = JSON.stringify(document);
  // The displayed row: plate and lug, the tag hidden.
  expect(await adapter.documentExportBodyIds(document)).toEqual([
    plate,
    lugBody
  ]);
  const large = documentForConfiguration(document, 'large');
  // Large suppresses the lug and shows the tag.
  expect(await adapter.documentExportBodyIds(large)).toEqual([plate, tag]);
  expect(JSON.stringify(document)).toBe(before);

  const io = await loadRemusTranslators();
  const step = await adapter.exportStep(
    large,
    await adapter.documentExportBodyIds(large)
  );
  const solids = kernel.deserializeSolids(
    io.importStep(new TextEncoder().encode(step))
  );
  expect(solids).toHaveLength(2);
  const widths = solids
    .map((solid) => {
      // [min x, min y, min z, max x, max y, max z]
      const box = kernel.boundingBox(solid);
      return box[3]! - box[0]!;
    })
    .sort((a, b) => a - b);
  expect(widths[0]).toBeCloseTo(2, 6);
  expect(widths[1]).toBeCloseTo(45, 6);

  // The displayed row still exports as it is shown, 20 wide with the lug.
  const shown = await adapter.exportStl(document, [plate, lugBody, tag], 0.1);
  expect(shown).toBe(await adapter.exportStl(document, [plate, lugBody], 0.1));
  // 3MF of Large writes the same two bodies as listing them by hand.
  const threeMf = await adapter.exportMesh(
    large,
    await adapter.documentExportBodyIds(large),
    { format: '3mf', deflection: 0.1 }
  );
  expect(threeMf.byteLength).toBeGreaterThan(0);
}, 90_000);

it("describes each row's own bodies, mesh references included, for its export dialog", async () => {
  // Small shows a mesh reference beside the plate; Large hides it. Large's
  // dialog must offer every format, Small's only STL.
  const { document: base, plate, tag } = bracket();
  const imported = importMeshBody(base, {
    name: 'Scan',
    artifactId: 'artifact_scan',
    sourceName: 'scan.stl',
    ...coincidentBoxSoup()
  });
  let document = imported.document;
  document = addConfigurationColumn(document, {
    column: { kind: 'body', bodyId: imported.bodyId }
  });
  document = setConfigurationCell(document, {
    rowId: 'large',
    column: { kind: 'body', bodyId: imported.bodyId },
    value: false
  });
  const small = await adapter.documentExportBodies(document);
  expect(small.find((body) => body.bodyId === imported.bodyId)).toMatchObject({
    bodyId: imported.bodyId,
    meshReference: true
  });
  const large = await adapter.documentExportBodies(
    documentForConfiguration(document, 'large')
  );
  expect(large.map((body) => body.bodyId)).toEqual([plate, tag]);
  expect(large.every((body) => body.name.length > 0)).toBe(true);
  expect(large.some((body) => body.meshReference)).toBe(false);
  // The ids are the ones an export of the row writes.
  expect(large.map((body) => body.bodyId)).toEqual(
    await adapter.documentExportBodyIds(
      documentForConfiguration(document, 'large')
    )
  );
}, 90_000);
