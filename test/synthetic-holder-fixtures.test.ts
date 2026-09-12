import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RemusKernel,
  loadRemusTranslators
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
        await writeFile(fixturePath(file), exported);
      }
      const committed = await readFile(fixturePath(file), 'utf8');
      expect(committed).toBe(exported);
    });
  }
});
