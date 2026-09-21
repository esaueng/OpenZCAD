import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseStepMetadata } from '@openzcad/io-step';
import {
  addPrimitiveFeature,
  createProjectDocument,
  importStepBody,
  setNodeMetadata
} from '@openzcad/document-core';
import { BODY_COLOR_METADATA_KEY, toUserId } from '@openzcad/shared';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

const SEMANTIC_FIXTURE = resolve(
  'test/fixtures/i02-step-assembly-metadata.step'
);
const MULTI_SOLID_FIXTURE = resolve(
  'test/parity/corpus/d-multi-two-boxes.step'
);

describe('I02 STEP metadata qualification', { timeout: 30_000 }, () => {
  it('scans product names and colours while leaving assembly relations explicit', () => {
    const text = readFileSync(SEMANTIC_FIXTURE, 'utf8');
    const metadata = parseStepMetadata('fixture.step', text);

    expect(metadata).toEqual({
      name: 'fixture.step',
      products: ['I02 Assembly', 'Red Link', 'Blue Link'],
      colors: ['Safety red', 'Ocean blue']
    });
    expect(text.match(/NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g)).toHaveLength(2);
    expect(text).toContain('STYLED_ITEM');
  });

  it('imports a multi-solid source as one document body and retains source bytes only', () => {
    const stepText = readFileSync(MULTI_SOLID_FIXTURE, 'utf8');
    const productName = parseStepMetadata('multi.step', stepText).products[0];
    expect(productName).toBe('d-multi-two-boxes');

    const imported = importStepBody(
      createProjectDocument('I02 import', toUserId('user_i02')),
      {
        name: productName!,
        artifactId: 'artifact_i02',
        sourceName: 'd-multi-two-boxes.step',
        stepText
      }
    );
    const featureId = imported.document.featureOrder[0]!;
    const bodyId = imported.document.bodyOrder[0]!;
    const feature = Object.values(imported.document.nodes).find(
      (node) => node.kind === 'feature' && node.featureId === featureId
    );
    const body = Object.values(imported.document.nodes).find(
      (node) => node.kind === 'body' && node.bodyId === bodyId
    );

    expect(feature?.kind).toBe('feature');
    expect(
      feature && feature.kind === 'feature' ? feature.name : undefined
    ).toBe('d-multi-two-boxes');
    expect(body?.kind).toBe('body');
    expect(
      body && body.kind === 'body'
        ? body.metadata?.[BODY_COLOR_METADATA_KEY]
        : undefined
    ).toBeDefined();
    expect(
      Object.values(imported.document.nodes).filter(
        (node) => node.kind === 'assembly'
      )
    ).toHaveLength(1);
    expect(
      feature &&
        feature.kind === 'feature' &&
        feature.data.featureKind === 'imported-step'
        ? feature.data.solidIndices
        : undefined
    ).toBeUndefined();
    expect(
      feature &&
        feature.kind === 'feature' &&
        feature.data.featureKind === 'imported-step'
        ? feature.data.stepText
        : undefined
    ).toBe(stepText);
  });

  describe('kernel writer boundary', () => {
    let adapter: ExactKernelAdapter;

    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    afterAll(() => {
      adapter.dispose();
    });

    it('preserves exact solids but does not emit document names, colours, or assembly relations', async () => {
      let document = addPrimitiveFeature(
        createProjectDocument('I02 export', toUserId('user_i02_export')),
        {
          name: 'Source Name That Must Be Checked',
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      document = setNodeMetadata(document, {
        nodeId: Object.values(document.nodes).find(
          (node) =>
            node.kind === 'body' && node.bodyId === document.bodyOrder[0]
        )!.id,
        metadata: { [BODY_COLOR_METADATA_KEY]: '#12abef' }
      });

      const bodyId = document.bodyOrder[0]!;
      const stepText = await adapter.exportStep(document, [bodyId]);
      const metadata = parseStepMetadata('export.step', stepText);

      expect(await adapter.inspectStep(stepText)).toMatchObject({
        solid: true,
        valid: true,
        volume: 1000
      });
      expect(metadata.products).toEqual(['remus_solid']);
      expect(metadata.colors).toEqual([]);
      expect(stepText).not.toContain('Source Name That Must Be Checked');
      expect(stepText).not.toContain('COLOUR_RGB');
      expect(stepText).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    });
  });
});
