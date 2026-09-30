import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { OcctKernel } from 'occt-wasm';
import { convertFreecadToStep } from '@openzcad/io-freecad';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { createProjectDocument } from '@openzcad/document-core';
import {
  CommandManager,
  commandFactories,
  composeCommands
} from '@openzcad/command-system';
import { qualifyFreecadStep } from '../../apps/web/src/lib/freecadExactQualification';
import { toUserId } from '@openzcad/shared';

let adapter: ExactKernelAdapter;
let oracle: OcctKernel;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
  oracle = await OcctKernel.init();
});
afterAll(() => {
  adapter.dispose();
  oracle[Symbol.dispose]();
});

it('converts independent saved solids through Remus, undo/reload and exact STEP export in millimetres', async () => {
  const input = readFileSync('test/fixtures/freecad/two-solids.FCStd');
  const converted = await convertFreecadToStep(input);
  expect(converted.savedObjectCount).toBe(2);
  expect(converted.solidCount).toBe(2);
  await qualifyFreecadStep(converted.stepText, 2, 'mm');
  await qualifyFreecadStep(converted.stepText, 2, 'inch');
  const inspection = await adapter.inspectStep(
    new TextEncoder().encode(converted.stepText).buffer
  );
  expect(inspection).toMatchObject({
    solid: true,
    valid: true,
    solidIndices: [0, 1]
  });
  const document = {
    ...createProjectDocument('FreeCAD import', toUserId('user_freecad')),
    units: 'mm' as const
  };
  const manager = new CommandManager(document);
  manager.execute(
    composeCommands(
      'Import FreeCAD bodies',
      [0, 1].map((index) =>
        commandFactories.importStep({
          name: `FreeCAD Body ${index + 1}`,
          sourceName: 'two-solids.FCStd.step',
          artifactId: 'artifact_test',
          stepText: converted.stepText,
          solidIndices: [index]
        })
      )
    )
  );
  expect(manager.document.bodyOrder).toHaveLength(2);
  const rebuilt = await adapter.syncDocument(manager.document);
  expect(rebuilt.warnings).toEqual([]);
  expect(Object.keys(rebuilt.bodyRepresentations)).toHaveLength(2);
  const total = Object.values(rebuilt.bodyRepresentations).reduce(
    (sum, body) => sum + (body.volume ?? 0),
    0
  );
  expect(total).toBeCloseTo(6000 + 5 * 8 * 12, 5);
  const restored = JSON.parse(
    JSON.stringify(manager.document)
  ) as typeof manager.document;
  expect((await adapter.syncDocument(restored)).warnings).toEqual([]);
  const exported = await adapter.exportStep(restored, restored.bodyOrder);
  const shape = oracle.importStep(exported);
  expect(oracle.isValid(shape)).toBe(true);
  expect(oracle.getSubShapes(shape, 'solid')).toHaveLength(2);
  expect(oracle.getVolume(shape)).toBeCloseTo(6000 + 5 * 8 * 12, 5);
  manager.undo();
  expect(manager.document.bodyOrder).toHaveLength(0);
  manager.redo();
  expect(manager.document.bodyOrder).toHaveLength(2);
});
