import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  gearBody,
  normalizeDocument,
  setParameter
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  historyModelOf,
  printHistory,
  readHistoryText
} from '@openzcad/scripting';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { FRAME_TIMING_SCENES } from './fixtures/frame-timing-scenes';
import { importedDetail } from './fixtures/imported-detail';
import { LOOKDEV_SCENES } from './fixtures/lookdev-scenes';
import { nativeDetail } from './fixtures/native-detail';
import { circle, stackedLoft } from './fixtures/stacked-loft';
import { elbowPath, roundProfile, sweptAlong } from './fixtures/swept-elbow';

/**
 * L15 identity law over real documents: the text printed from a document
 * reads back, against that document, to exactly the history it holds, with
 * no errors. The kernel-built cases carry real V5 references (fillets,
 * chamfers, holes, shells), so the `face()`/`edge()` round trip is exercised
 * on witnesses the exact build wrote, not on hand-made ones.
 */
type Built = ProjectDocument | { document: ProjectDocument };

function documentOf(built: Built): ProjectDocument {
  return 'document' in built && !('nodes' in built)
    ? built.document
    : (built as ProjectDocument);
}

const corpus: {
  name: string;
  build(adapter: ExactKernelAdapter): Promise<Built> | Built;
}[] = [
  ...[...LOOKDEV_SCENES, ...FRAME_TIMING_SCENES].map((scene) => ({
    name: `scene ${scene.id}`,
    build: (adapter: ExactKernelAdapter) => scene.build(adapter)
  })),
  { name: 'native hole', build: (adapter) => nativeDetail(adapter, 'hole') },
  {
    name: 'native counterbore',
    build: (adapter) =>
      nativeDetail(adapter, 'hole', {
        style: 'counterbore',
        depthMode: 'blind'
      })
  },
  {
    name: 'native chamfer',
    build: (adapter) => nativeDetail(adapter, 'chamfer', {}, 2)
  },
  {
    name: 'imported fillet',
    build: (adapter) => importedDetail(adapter, 'fillet')
  },
  {
    name: 'ruled loft',
    build: () => stackedLoft('ruled', [circle(25), circle(10, 12)])
  },
  {
    name: 'swept elbow',
    build: () => sweptAlong(roundProfile(4), elbowPath, 'standard')
  },
  {
    name: 'parameter-driven gear',
    build: () => {
      let document = createProjectDocument(
        'Gear',
        toUserId('user_text_corpus')
      );
      document = setParameter(document, { name: 'teeth', expression: '24' });
      document = setParameter(document, {
        name: 'face',
        expression: '8 mm',
        quantity: 'length'
      });
      document = addPrimitiveFeature(document, {
        name: 'Hub',
        primitiveKind: 'cylinder',
        dimensions: { radius: 'face', height: 'face * 2' }
      });
      return gearBody(document, {
        name: 'Gear',
        gearType: 'external',
        sizing: 'module',
        pitch: 1.5,
        teeth: 'teeth',
        faceWidth: 'face',
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 }
      }).document;
    }
  },
  {
    name: 'legacy writer document',
    // Normalized as every read normalizes a stored document.
    build: () =>
      normalizeDocument(
        JSON.parse(
          readFileSync(
            new URL(
              './fixtures/legacy-documents/writer-8dcb1643b.json',
              import.meta.url
            ),
            'utf8'
          )
        ) as ProjectDocument
      )
  }
];

describe(
  'L15 history text identity law over the fixture corpus',
  { timeout: 300_000 },
  () => {
    let adapter: ExactKernelAdapter;
    beforeAll(async () => {
      adapter = await createExactKernelAdapter();
    });

    it.each(corpus)(
      '$name prints and reads back to its own history',
      async ({ build }) => {
        const document = documentOf(await build(adapter));
        const text = printHistory(document);
        const read = readHistoryText(text, document);
        expect(
          read.diagnostics.filter(
            (diagnostic) => diagnostic.severity === 'error'
          )
        ).toEqual([]);
        expect(read.model).toEqual(historyModelOf(document));
        // Printing is a pure function of the document.
        expect(printHistory(structuredClone(document))).toBe(text);
      }
    );

    it('carries kernel-written picks as lineage, not as hashes', async () => {
      const document = documentOf(
        await nativeDetail(adapter, 'chamfer', {}, 2)
      );
      const text = printHistory(document);
      expect(text).toMatch(/edgeReferences: \[\s*edge\(#feat_/);
      expect(text).not.toMatch(/edgeHashes/);
    });
  }
);
