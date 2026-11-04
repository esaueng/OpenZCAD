import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RemusKernel,
  loadRemusTranslators,
  remusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { syntheticHolderStep } from './support/synthetic-holder';

/**
 * The committed STEP files the Playwright acceptance drives through the real
 * product (`test/e2e/growing-holder.spec.ts`) are this kernel's own export of
 * the synthetic holder, so they are redistributable and carry nothing of the
 * private hammer. This keeps them from drifting: regenerate with
 * `OPENZCAD_WRITE_HOLDER_FIXTURES=1 pnpm exec vitest run test/synthetic-holder-fixtures.test.ts`
 * whenever the holder or the exporter changes, then commit the files.
 */
const FIXTURES = [
  { file: 'synthetic-holder.step', options: {} },
  { file: 'synthetic-holder-open.step', options: { holes: false } }
] as const;

const fixturePath = (file: string) =>
  fileURLToPath(new URL(`./fixtures/hammer-holder/${file}`, import.meta.url));

describe('synthetic holder STEP fixtures', { timeout: 120_000 }, () => {
  let kernel: RemusKernel;
  beforeAll(async () => {
    await loadRemusTranslators();
    kernel = new RemusKernel();
  });
  afterAll(() => kernel.free());

  for (const { file, options } of FIXTURES) {
    it(`${file} is the kernel's export of the synthetic holder`, async () => {
      const exported = new TextDecoder().decode(
        syntheticHolderStep(kernel, options)
      );
      if (process.env.OPENZCAD_WRITE_HOLDER_FIXTURES === '1') {
        // A serializer refresh must not silently change the acceptance model.
        const oldBytes = new TextEncoder().encode(
          await readFile(fixturePath(file), 'utf8')
        );
        const [oldSolid] = kernel.deserializeSolids(
          remusTranslators().importStep(oldBytes)
        );
        const [newSolid] = kernel.deserializeSolids(
          remusTranslators().importStep(new TextEncoder().encode(exported))
        );
        expect(oldSolid).toBeDefined();
        expect(newSolid).toBeDefined();
        expect(kernel.validateSolid(oldSolid!)).toBe(0);
        expect(kernel.validateSolid(newSolid!)).toBe(0);
        expect(kernel.getSolidFaces(newSolid!).length).toBe(
          kernel.getSolidFaces(oldSolid!).length
        );
        const oldBounds = kernel.boundingBox(oldSolid!);
        [...kernel.boundingBox(newSolid!)].forEach((value, i) =>
          expect(value).toBeCloseTo(oldBounds[i]!, 9)
        );
        expect(kernel.volume(newSolid!, 1e-5)).toBeCloseTo(
          kernel.volume(oldSolid!, 1e-5),
          5
        );
        await writeFile(fixturePath(file), exported);
      }
      const committed = await readFile(fixturePath(file), 'utf8');
      expect(committed).toBe(exported);
    });
  }
});
