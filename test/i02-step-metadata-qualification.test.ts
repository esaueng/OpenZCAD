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
import {
  BODY_COLOR_CHOSEN_METADATA_KEY,
  BODY_COLOR_METADATA_KEY,
  DEFAULT_BODY_COLOR,
  toUserId
} from '@openzcad/shared';
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

    it("writes the document as the product and each body's name and colour on its solid", async () => {
      let document = addPrimitiveFeature(
        createProjectDocument('I02 export', toUserId('user_i02_export')),
        {
          name: "Owner's Block",
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 }
        }
      );
      document = addPrimitiveFeature(document, {
        name: 'Pin',
        primitiveKind: 'cylinder',
        dimensions: { radius: 2, height: 30 }
      });
      const bodyNode = (bodyId: string) =>
        Object.values(document.nodes).find(
          (node) => node.kind === 'body' && node.bodyId === bodyId
        )!;
      const [blockId, pinId] = document.bodyOrder;
      document = setNodeMetadata(document, {
        nodeId: bodyNode(blockId!).id,
        metadata: {
          [BODY_COLOR_METADATA_KEY]: '#12abef',
          [BODY_COLOR_CHOSEN_METADATA_KEY]: true
        }
      });
      const blockName = bodyNode(blockId!).name;
      const pinName = bodyNode(pinId!).name;

      const stepText = await adapter.exportStep(document, [pinId!, blockId!], {
        fileName: 'I02-export.step',
        timestamp: '2026-10-31T12:00:00Z'
      });
      const metadata = parseStepMetadata('export.step', stepText);

      expect(await adapter.inspectStep(stepText)).toMatchObject({
        solid: true,
        valid: true
      });
      expect(stepText).toContain(
        "FILE_NAME('I02-export.step', '2026-10-31T12:00:00Z', (''), (''), 'Remus', 'OpenZCAD', '');"
      );
      expect(stepText).toContain('AUTOMOTIVE_DESIGN');
      expect(metadata.products).toEqual(['I02 export']);
      expect(stepText).not.toContain('remus_solid');

      // Resolve each named solid to its faces' surfaces, so a name or colour
      // can only pass on the solid that really is that body.
      const entities = new Map(
        [...stepText.matchAll(/^(#\d+) = (.*);$/gm)].map((match) => [
          match[1]!,
          match[2]!
        ])
      );
      const refs = (id: string) => entities.get(id)!.match(/#\d+/g) ?? [];
      const isCylinder = (brep: string) =>
        refs(refs(brep)[0]!).some((face) =>
          entities.get(refs(face).at(-1)!)!.startsWith('CYLINDRICAL_SURFACE')
        );
      const solids = [
        ...stepText.matchAll(
          /^(#\d+) = MANIFOLD_SOLID_BREP\('((?:[^']|'')*)', /gm
        )
      ].map((match) => ({
        id: match[1]!,
        name: match[2]!.replaceAll("''", "'")
      }));
      expect(solids.map((solid) => solid.name)).toEqual([pinName, blockName]);
      expect(solids.map((solid) => isCylinder(solid.id))).toEqual([
        true,
        false
      ]);

      const colourOf = (brep: string) => {
        const [styled] = [...entities].find(
          ([id, text]) =>
            text.startsWith('STYLED_ITEM(') && refs(id).at(-1) === brep
        )!;
        let id = refs(styled)[0]!;
        while (!entities.get(id)!.startsWith('COLOUR_RGB(')) id = refs(id)[0]!;
        return entities
          .get(id)!
          .replace(/^COLOUR_RGB\('', /, '')
          .replace(/\)$/, '')
          .split(',')
          .map((channel) => Math.round(Number(channel) * 255));
      };
      expect(colourOf(solids[1]!.id)).toEqual([0x12, 0xab, 0xef]);
      // An unchosen body is written in the colour it is drawn in.
      expect(colourOf(solids[0]!.id)).toEqual(
        [1, 3, 5].map((at) =>
          Number.parseInt(DEFAULT_BODY_COLOR.slice(at, at + 2), 16)
        )
      );
      expect(stepText).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
    });
  });
});
