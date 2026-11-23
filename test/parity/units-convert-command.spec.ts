/**
 * I03 stored-unit conversion, phase 5, over the parity corpus (plan §6):
 * every scenario phase 4 accepts is converted by authoring the
 * `units.convert` command through the kernel (`prepareUnitsConversion`:
 * the transform, three cold rebuilds, the oracles) and then replayed
 * without the kernel (`replayCommands`), and the two must be the same
 * document byte for byte. Kept as a `.spec.ts` so it runs in the serial
 * parity job.
 *
 * It also measures the residual-risk warnings (rounding a ratio of
 * lengths, a pole or domain edge in a difference of lengths) over the
 * corpus and the fixture documents, which decides whether they could
 * refuse instead of warn: refusing is only acceptable if it refuses
 * nothing here.
 */
import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CommandManager,
  commandFactories,
  replayCommands
} from '@openzcad/command-system';
import {
  applyUnitsConversion,
  convertDocumentUnits,
  normalizeDocument
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  prepareUnitsConversion
} from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';

import { buildDemoDocument } from '../../apps/web/src/lib/demos';
import { VISUAL_SELECTION_ACCEPTANCE_DEMO } from '../../apps/web/src/lib/demoDefinitions';
import { IMPORT_MODELING_SCENARIOS, PARITY_SCENARIOS } from './scenarios';

const FIXTURE_DOCUMENTS = [
  'test/fixtures/legacy-documents/writer-8dcb1643b.json',
  'test/scripting/contract/v1/history/document.json'
];

/** The model, without the record of how it got there or its projection. */
function content(document: ProjectDocument): string {
  const {
    revisions: _revisions,
    commandLog: _log,
    editHistory: _history,
    version: _version,
    derived: _derived,
    ...rest
  } = document;
  return JSON.stringify(rest);
}

/**
 * Phase 4's refusals (`test/parity/unit-conversion.spec.ts`), by scenario:
 * phase 5 authors exactly the scenarios phase 4 accepts.
 */
const REFUSED: Record<string, string> = {
  'parity:scissors': 'transform',
  'import:boolean-on-nurbs-import': 'references'
};

describe('units.convert authored through the kernel replays without it', () => {
  const documents: { key: string; document: ProjectDocument }[] = [];
  const outcomes = new Map<string, string>();
  const mismatches: string[] = [];
  const lines: string[] = [];

  beforeAll(async () => {
    const adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      if (scenario.expectedBuildFailure) continue;
      documents.push({
        key: `parity:${scenario.key}`,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
    }
    documents.push({
      key: 'demo:visual-selection-acceptance',
      document: await buildDemoDocument(
        VISUAL_SELECTION_ACCEPTANCE_DEMO,
        undefined,
        (doc) => adapter.syncDocument(doc)
      )
    });
    for (const scenario of IMPORT_MODELING_SCENARIOS)
      documents.push({
        key: `import:${scenario.key}`,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
    adapter.dispose();

    for (const { key, document } of documents) {
      const preparation = await prepareUnitsConversion(document, 'inch', {
        actorUserId: document.ownerUserId
      });
      if (!preparation.ok) {
        outcomes.set(key, preparation.refusals[0]!.stage);
        continue;
      }
      outcomes.set(key, 'ok');
      const manager = new CommandManager(document);
      manager.execute(commandFactories.convertUnits(preparation.payload));
      const authored = manager.document;
      const replayed = replayCommands(
        document,
        authored.commandLog.slice(document.commandLog.length)
      );
      if (content(replayed) !== content(authored))
        mismatches.push(`${key}: replay differs from authoring`);
      if (
        content(applyUnitsConversion(document, preparation.payload)) !==
        content(authored)
      )
        mismatches.push(`${key}: the pure step differs from authoring`);
      lines.push(
        `  ${key}: ${Object.keys(preparation.payload.references).length} references, ${preparation.undo.entryBytes} undo bytes, ${preparation.report.warnings.length} warnings`
      );
    }
  }, 1_800_000);

  it('authors every scenario phase 4 accepts, and replay reproduces it byte for byte', () => {
    console.info(
      ['units.convert authored and replayed (mm → in)', ...lines].join('\n')
    );
    expect(mismatches).toEqual([]);
    expect(Object.fromEntries(outcomes)).toEqual(
      Object.fromEntries(
        documents.map(({ key }) => [key, REFUSED[key] ?? 'ok'])
      )
    );
    // Not vacuous: most of the corpus converts.
    expect(
      [...outcomes.values()].filter((outcome) => outcome === 'ok').length
    ).toBeGreaterThan(10);
  });

  it('measures the residual-risk warnings over the corpus and fixtures', () => {
    const corpus = [
      ...documents,
      ...FIXTURE_DOCUMENTS.map((path) => ({
        key: path,
        document: normalizeDocument(
          JSON.parse(readFileSync(path, 'utf8')) as ProjectDocument
        )
      }))
    ];
    const warned: string[] = [];
    let converted = 0;
    for (const { key, document } of corpus)
      for (const target of ['cm', 'inch'] as const) {
        if (document.units === target) continue;
        const result = convertDocumentUnits(document, target);
        if (!result.ok) continue;
        converted += 1;
        for (const warning of result.report.warnings)
          warned.push(
            `${key} → ${target}: ${warning.code} ${warning.field} "${warning.expression}"`
          );
      }
    console.info(
      [
        `stored-unit conversion warnings: ${warned.length} over ${converted} conversions of ${corpus.length} documents`,
        ...warned
      ].join('\n')
    );
    expect(converted).toBeGreaterThan(20);
    // Pinned: a change in what warns is seen in both directions.
    expect(warned).toEqual([]);
  });
});
