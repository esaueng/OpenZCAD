import { expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  setParameter,
  transformBody
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';

it('omits off bodies from exact STEP and mesh exports while preserving their rigid height binding', async () => {
  let document = createProjectDocument('Lettering', toUserId('test'));
  document = setParameter(document, { name: 'height', expression: '30' });
  document = addPrimitiveFeature(document, {
    name: 'Holder',
    primitiveKind: 'box',
    dimensions: { width: 20, height: 10, depth: 'height' }
  });
  document = addPrimitiveFeature(document, {
    name: 'Text',
    primitiveKind: 'box',
    dimensions: { width: 0.4, height: 4, depth: 12 }
  });
  const [holder, text] = document.bodyOrder;
  document = transformBody(document, {
    name: 'Text position',
    targetBodyId: text!,
    translation: { x: 20, y: 3, z: '(height - 12) / 2' }
  }).document;
  document = configureParameterToggle(document, {
    name: 'show_text',
    bodyIds: [text!]
  });
  const adapter = await createExactKernelAdapter();
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const first = await adapter.syncDocument(document);
    const taller = setParameter(document, { name: 'height', expression: '44' });
    const second = await adapter.syncDocument(taller);
    expect(first.warnings).toEqual([]);
    expect(second.warnings).toEqual([]);
    const a = first.bodyRepresentations[text!]!.bbox;
    const b = second.bodyRepresentations[text!]!.bbox;
    expect(b.max.z - b.min.z).toBeCloseTo(a.max.z - a.min.z, 8);
    expect(b.min.z - a.min.z).toBeCloseTo(7, 8);
    expect(second.exportableBodyIds).toEqual([holder, text]);
    const visibleStep = await adapter.exportStep(taller, document.bodyOrder);
    const on = kernel.deserializeSolids(
      io.importStep(new TextEncoder().encode(visibleStep))
    );
    expect(on).toHaveLength(2);
    const off = setParameter(taller, { name: 'show_text', expression: '0' });
    const hidden = await adapter.syncDocument(off);
    expect(hidden.exportableBodyIds).toEqual([holder]);
    expect(hidden.bodyRepresentations[text!]!.bbox).toEqual(b);
    // Pass stale/all ids deliberately: the exact adapter enforces the switch,
    // independently of the UI's export menu and derived list.
    const hiddenStep = await adapter.exportStep(off, document.bodyOrder);
    const exported = kernel.deserializeSolids(
      io.importStep(new TextEncoder().encode(hiddenStep))
    );
    expect(exported).toHaveLength(1);
    expect(kernel.validateSolid(exported[0]!)).toBe(0);
    const mesh = await adapter.exportStl(off, document.bodyOrder, 0.1);
    expect(mesh).toBe(await adapter.exportStl(off, [holder!], 0.1));
    await expect(adapter.exportStep(off, [text!])).rejects.toThrow(
      /at least one body/
    );
  } finally {
    adapter.dispose();
    kernel.free();
  }
}, 30_000);
