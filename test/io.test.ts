import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createProjectDocument, addPrimitiveFeature } from '@openzcad/document-core';
import { parseStepMetadata } from '@openzcad/io-step';
import { exportBodiesToStl, parseStl } from '@openzcad/io-stl';
import { createMockKernelAdapter } from '@openzcad/kernel-adapter';
import { attachDerivedState, getLatestBodyId } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';

describe('io adapters', () => {
  it('parses STL metadata and exports derived STL', async () => {
    const stlPath = resolve('samples/simple-block.stl');
    const stlSource = readFileSync(stlPath);
    const parsed = parseStl(stlSource.buffer.slice(stlSource.byteOffset, stlSource.byteOffset + stlSource.byteLength), 'simple-block.stl');
    expect(parsed.triangleCount).toBeGreaterThan(0);

    const kernel = createMockKernelAdapter();
    let document = createProjectDocument('IO Test', toUserId('user_test'));
    document = addPrimitiveFeature(document, {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 5, height: 6, depth: 7 }
    });
    document = attachDerivedState(document, kernel.syncDocument(document));
    const bodyId = getLatestBodyId(document);
    expect(bodyId).toBeTruthy();
    const stl = await exportBodiesToStl(kernel, document, [bodyId!]);
    expect(stl).toContain('solid openzcad');
  });

  it('parses STEP metadata without inventing B-Rep geometry', async () => {
    const stepPath = resolve('samples/simple-assembly.step');
    const text = readFileSync(stepPath, 'utf8');
    const kernel = createMockKernelAdapter();
    const metadata = await parseStepMetadata(kernel, 'simple-assembly.step', text);
    expect(metadata.products).toContain('Simple Block');
  });
});

