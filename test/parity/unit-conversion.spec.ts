/**
 * I03 stored-unit conversion over the parity corpus (plan §6, and the
 * refusal rate §8 asks to measure before the UI is committed to). Kept as a
 * `.spec.ts` so it runs in the serial parity job: every scenario builds
 * through the kernel, and phase 4 rebuilds each conversion three times.
 *
 * - Phase 2 (oracle step 1): the pure transform round-trips the
 *   import-modeling corpus byte for byte. The demo and fixture documents
 *   run in `test/units-convert.test.ts`.
 * - Phase 4 (oracle steps 2–3): every parity and import-modeling scenario
 *   the transform accepts is converted to cm and to inch, its references are
 *   re-captured by rebuild, and the converted model must match the original
 *   scaled. Each scenario's outcome per target is pinned below, refusals
 *   included with their reasons, so a change in what converts is seen in
 *   both directions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CommandManager, commandFactories } from '@openzcad/command-system';

import {
  convertDocumentUnits,
  createBodyFeatureIds,
  createProjectDocument,
  listConversionReferenceSites
} from '@openzcad/document-core';
import {
  computeConversionReferenceMap,
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type ProjectDocument,
  type UnitSystem
} from '@openzcad/shared';

import {
  assertUnitRoundTrips,
  reportRefusalRate
} from '../support/units-convert-round-trip';
import { buildDemoDocument } from '../../apps/web/src/lib/demos';
import { VISUAL_SELECTION_ACCEPTANCE_DEMO } from '../../apps/web/src/lib/demoDefinitions';
import { CORPUS, REPO_ROOT } from './corpus/manifest';
import { IMPORT_MODELING_SCENARIOS, PARITY_SCENARIOS } from './scenarios';

describe('stored-unit conversion over the import-modeling corpus', () => {
  let adapter: ExactKernelAdapter;
  const documents: { key: string; document: ProjectDocument }[] = [];

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    for (const scenario of IMPORT_MODELING_SCENARIOS)
      documents.push({
        key: scenario.key,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
  }, 600_000);
  afterAll(() => adapter?.dispose());

  it('converts every scenario mm → cm, inch and back byte for byte', () => {
    const outcomes = new Map<string, string[]>();
    let checks = 0;
    for (const { key, document } of documents) {
      const { reasons, oracleChecks } = assertUnitRoundTrips(key, document);
      outcomes.set(key, reasons);
      checks += oracleChecks;
    }
    // Not vacuous: the oracle evaluated real fields.
    expect(checks).toBeGreaterThan(20);
    const { refused } = reportRefusalRate(
      'unit conversion (import-modeling corpus)',
      outcomes
    );
    expect(documents.length).toBe(IMPORT_MODELING_SCENARIOS.length);
    expect(refused).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 4: reference re-capture and the geometry oracle
// ---------------------------------------------------------------------------

const TARGETS = ['cm', 'inch'] as const satisfies readonly UnitSystem[];
type Target = (typeof TARGETS)[number];

/**
 * `ok`, or the sorted, de-duplicated refusal reasons
 * (`phase 2|phase 4 code: subject field`).
 */
type Outcome = 'ok' | string[];

/**
 * The measured outcome of every scenario per target. Refusals are pinned,
 * not skipped: a kernel or matcher change that makes one convert flips this
 * red until the pin is updated, and so does a new refusal.
 */
const BOTH = (outcome: Outcome): Record<Target, Outcome> => ({
  cm: outcome,
  inch: outcome
});

const EXPECTED: Record<string, Record<Target, Outcome>> = {
  'parity:bracket': BOTH('ok'),
  'parity:flange': BOTH('ok'),
  'parity:heatsink': BOTH('ok'),
  'parity:boreGrid': BOTH('ok'),
  'demo:visual-selection-acceptance': BOTH('ok'),
  // An assembly: phase 2 refuses it until assembly values are converted.
  'parity:scissors': BOTH(['phase 2 unsupported-area: assembly']),
  'import:fillet-on-import': BOTH('ok'),
  'import:chamfer-on-import': BOTH('ok'),
  'import:boolean-with-import': BOTH('ok'),
  'import:boss-crossing-a-wall': BOTH('ok'),
  'import:pattern-boolean-with-import': BOTH('ok'),
  'import:shell-on-import': BOTH('ok'),
  // Known kernel refusal: the imported plate's four B-spline faces measure
  // area and volume by tessellation at an absolute deflection in model
  // units (plan §4), so the same surfaces measure differently at another
  // scale: volume by about 7.5e-6 and area by about 0.8% (inch), beyond
  // oracle 2's 1e-6. The geometry is the same; the measurement is not
  // scale-invariant, and the oracle fails closed.
  'import:boolean-on-nurbs-import': BOTH([
    'phase 4 geometry-mismatch: Imported plate area',
    'phase 4 geometry-mismatch: Imported plate volume'
  ])
};

function reasonsOf(
  phase: string,
  refusals: readonly { code: string; subject: string; field?: string }[]
): string[] {
  return [
    ...new Set(
      refusals.map(
        (refusal) =>
          // Generated ids (UUIDs) change per run; names are stable.
          `${phase} ${refusal.code}: ${refusal.subject.replace(/ \([a-z]+_[0-9a-f-]{36}\)/g, '')}${refusal.field ? ` ${refusal.field}` : ''}`
      )
    )
  ].sort();
}

describe('stored-unit conversion: references re-captured and verified by rebuild', () => {
  let adapter: ExactKernelAdapter;
  const documents: { key: string; document: ProjectDocument }[] = [];
  const outcomes = new Map<string, Record<Target, Outcome>>();
  const timings: string[] = [];

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    for (const scenario of PARITY_SCENARIOS) {
      if (scenario.expectedBuildFailure) continue;
      documents.push({
        key: `parity:${scenario.key}`,
        document: await scenario.build((doc) => adapter.syncDocument(doc))
      });
    }
    // Not a parity scenario, but the seeded part with the most v5 face and
    // edge references (a fillet on a bored boss): more reference coverage.
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
      const row = {} as Record<Target, Outcome>;
      for (const target of TARGETS) {
        const converted = convertDocumentUnits(document, target);
        if (!converted.ok) {
          row[target] = reasonsOf('phase 2', converted.refusals);
          continue;
        }
        const result = await computeConversionReferenceMap(
          document,
          converted.document
        );
        if (result.report) {
          const { timings: t, sites, geometry } = result.report;
          timings.push(
            `  ${key} → ${target}: builds ${Math.round(t.source)}/${Math.round(t.translate)}/${Math.round(t.verify)} ms, sites ${sites.topology}+${sites.hash}+${sites.profileId}, bodies ${geometry.bodies}`
          );
        }
        if (!result.ok) {
          row[target] = reasonsOf('phase 4', result.refusals);
          continue;
        }
        // Round trip (plan §6): converting back re-captures every reference
        // to exactly the witness, hash and name the source document holds.
        const back = convertDocumentUnits(result.document, document.units);
        if (!back.ok) {
          row[target] = reasonsOf('round trip, phase 2', back.refusals);
          continue;
        }
        const returned = await computeConversionReferenceMap(
          result.document,
          back.document
        );
        if (!returned.ok) {
          row[target] = reasonsOf('round trip, phase 4', returned.refusals);
          continue;
        }
        expect(
          listConversionReferenceSites(returned.document),
          `${key} via ${target}`
        ).toEqual(listConversionReferenceSites(document));
        row[target] = 'ok';
      }
      outcomes.set(key, row);
    }
  }, 1_800_000);

  it('converts every scenario to cm and inch, or refuses with a pinned reason', () => {
    const lines: string[] = [];
    for (const target of TARGETS) {
      const refused = [...outcomes].filter(([, row]) => row[target] !== 'ok');
      lines.push(
        `mm → ${target}: ${outcomes.size} scenarios, ${outcomes.size - refused.length} convert, ${refused.length} refused (${((100 * refused.length) / outcomes.size).toFixed(0)}%)`,
        ...refused.map(
          ([key, row]) => `  ${key}: ${(row[target] as string[]).join('; ')}`
        )
      );
    }
    console.info(
      [
        'stored-unit conversion refusal rate (phase 4)',
        ...lines,
        'timings:',
        ...timings
      ].join('\n')
    );
    expect(Object.fromEntries(outcomes)).toEqual(EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// STEP corpus: import, convert, export, and the file keeps its size
// ---------------------------------------------------------------------------

/**
 * The b-unit files that import into a document. The unassigned cone has no
 * solids by design, and `b-unit-no-global-context` (units declared but never
 * bound) builds no body when imported into a document today, so there is
 * nothing of either to convert.
 */
const STEP_UNIT_FILES = CORPUS.filter(
  (entry) =>
    entry.category === 'b-units' &&
    !entry.expectNoSolids &&
    entry.id !== 'b-unit-no-global-context'
);

const STEP_USER = toUserId('user_parity_unit_conversion');

/** The one body an mm document importing `stepText` builds. */
async function importIntoMillimetres(
  adapter: ExactKernelAdapter,
  name: string,
  stepText: string
): Promise<{
  document: ProjectDocument;
  derived: DerivedState;
  body: BodyRepresentation;
}> {
  const manager = new CommandManager(
    createProjectDocument(name, STEP_USER, 'mm')
  );
  const ids = createBodyFeatureIds();
  manager.execute(
    commandFactories.importStep({
      name,
      artifactId: `artifact_${name}`,
      sourceName: `${name}.step`,
      stepText,
      ids
    })
  );
  const derived = await adapter.syncDocument(manager.document);
  const body = derived.bodyRepresentations[ids.bodyId];
  if (!body) throw new Error(`${name}: the import built no body`);
  return { document: manager.document, derived, body };
}

describe('stored-unit conversion of imported STEP keeps exported size', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });
  afterAll(() => adapter?.dispose());

  it('has b-unit files to measure', () => {
    expect(STEP_UNIT_FILES.map((entry) => entry.id)).toEqual([
      'b-unit-mm-cube',
      'b-unit-inch-cube',
      'b-unit-degree-cone'
    ]);
  });

  for (const entry of STEP_UNIT_FILES)
    for (const target of TARGETS)
      it(`${entry.id}: import (mm), convert to ${target}, export, re-import`, async () => {
        const stepText = readFileSync(join(REPO_ROOT, entry.path), 'utf8');
        const source = await importIntoMillimetres(adapter, entry.id, stepText);
        const converted = convertDocumentUnits(source.document, target);
        if (!converted.ok) throw new Error(converted.refusals[0]!.message);
        const result = await computeConversionReferenceMap(
          source.document,
          converted.document
        );
        expect(result.ok ? [] : result.refusals).toEqual([]);
        if (!result.ok) return;

        // Exported in the document's (new) unit, the file states that unit,
        // so a fresh millimetre import reads the same physical part.
        const derived = await adapter.syncDocument(result.document);
        const exported = await adapter.exportStep(
          result.document,
          derived.exportableBodyIds,
          {
            fileName: `${entry.id}-${target}.step`,
            timestamp: '2026-11-22T00:00:00Z'
          }
        );
        const reread = await importIntoMillimetres(
          adapter,
          `${entry.id}-reread`,
          exported
        );
        expect(
          Math.abs(reread.body.volume - source.body.volume)
        ).toBeLessThanOrEqual(1e-6 * source.body.volume);
        for (const corner of ['min', 'max'] as const)
          for (const axis of ['x', 'y', 'z'] as const)
            expect(
              Math.abs(
                reread.body.bbox[corner][axis] - source.body.bbox[corner][axis]
              ),
              `${entry.id} → ${target} bbox.${corner}.${axis}`
            ).toBeLessThanOrEqual(
              1e-6 * Math.max(1, Math.abs(source.body.bbox[corner][axis]))
            );
      });
});
