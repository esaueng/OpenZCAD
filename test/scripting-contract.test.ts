import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  compileHistoryEdit,
  compileScript,
  historyModelOf,
  HISTORY_TEXT_VERSION,
  printHistory,
  publishScript,
  readHistoryText,
  SCRIPT_API_VERSION,
  sha256Hex
} from '@openzcad/scripting';
import {
  toUserId,
  type PrimitiveKind,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * L15 stability contract, version 1 (`openzcad history 1`, scripts `api 1`).
 * See docs/scripting.md.
 *
 * The files under test/scripting/contract/v1 are frozen. Within a major
 * version every one of them must keep parsing, printing and building exactly
 * as recorded here, on every release. Editing or removing one, or changing a
 * recorded value, is a breaking change: it needs a new major version, a
 * migration that rewrites old text, and the old major kept readable. The
 * digests below make such an edit deliberate rather than accidental. A case
 * recorded as refused may start building in a later release (a kernel fix);
 * a case that builds may not start refusing within the major.
 */
const DIR = new URL('./scripting/contract/v1/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, DIR), 'utf8');

const FROZEN: Record<string, string> = {
  'scripts/chamfered-lid.ozs':
    'cd187b108747a09196d2e3885326f4a3ca837ce15f5fd972d07ad64ca18d9f34',
  'scripts/cup.ozs':
    '8a25d0fb11390086bd2b473f918d426ba8b92f6028b51eaf6aa1322612611cd2',
  'scripts/refuses-count.ozs':
    '95834be2178f5b797c5ac59706cdb3371ebfe9ad26b4d0641f04588d490028a3',
  'scripts/rounded-tray.ozs':
    '6cb4fb393128347dfd69e6a9ad374412238ed3d6f2ca035c0f909339ee133f61',
  'history/history.ozh':
    '7fe44ae3772f38b97468fdc6ad6bb60484a381b3f2af92fe255c3fa540238462'
};

interface GoldenCase {
  script: string;
  target: { primitiveKind: PrimitiveKind; dimensions: Record<string, number> };
  inputs: Record<string, string>;
  volume: number;
  faceCount: number;
  warnings: string[];
}

const CASES = JSON.parse(read('expected.json')) as GoldenCase[];

describe('L15 stability contract v1', { timeout: 300_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  it('is still version 1 of the text and api 1 of scripts', () => {
    expect(HISTORY_TEXT_VERSION).toBe(1);
    expect(SCRIPT_API_VERSION).toBe(1);
  });

  it.each(Object.entries(FROZEN))('keeps %s byte for byte', (path, digest) => {
    expect(sha256Hex(read(path))).toBe(digest);
  });

  it.each(Object.keys(FROZEN).filter((path) => path.endsWith('.ozs')))(
    '%s still compiles without errors or warnings',
    (path) => {
      expect(compileScript(read(path)).diagnostics).toEqual([]);
    }
  );

  it.each(
    CASES.map(
      (golden) =>
        [`${golden.script} ${JSON.stringify(golden.inputs)}`, golden] as const
    )
  )('%s builds exactly as recorded', async (_, golden) => {
    const document = addPrimitiveFeature(
      createProjectDocument('Contract', toUserId('user_contract')),
      { name: 'Target', ...golden.target }
    );
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.customFeature({
        name: 'Golden',
        targetBodyId: document.bodyOrder[0]!,
        script: publishScript(read(`scripts/${golden.script}.ozs`)).script!,
        inputs: { ...golden.inputs }
      })
    );
    const derived = await adapter.syncDocument(manager.document);
    const body =
      derived.bodyRepresentations[
        listFeaturesInOrder(manager.document).at(-1)!.bodyId!
      ]!;
    expect(derived.warnings).toEqual(golden.warnings);
    expect(body.faceCount).toBe(golden.faceCount);
    expect(Math.abs(body.volume - golden.volume)).toBeLessThanOrEqual(
      1e-6 * golden.volume
    );
  });

  it('prints the frozen document as the frozen text, and reads it back', () => {
    const document = normalizeDocument(
      JSON.parse(read('history/document.json')) as ProjectDocument
    );
    const text = read('history/history.ozh');
    expect(printHistory(document)).toBe(text);
    const result = readHistoryText(text, document);
    expect(result.diagnostics).toEqual([]);
    expect(result.model).toEqual(historyModelOf(document));
    expect(compileHistoryEdit(document, text).proposal).toBeNull();
  });
});
