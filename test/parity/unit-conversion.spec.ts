/**
 * I03 stored-unit conversion over the import-modeling corpus (plan §6, the
 * refusal rate §8 asks to measure). Kept as a `.spec.ts` so it runs in the
 * serial parity job: each scenario imports and rebuilds a STEP part first.
 * The demo and fixture documents run in `test/units-convert.test.ts`.
 *
 * Phase 2 checks the pure transform only (oracle step 1). The geometry
 * oracle and reference re-capture (steps 2–3) are phase 4's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type { ProjectDocument } from '@openzcad/shared';

import {
  assertUnitRoundTrips,
  reportRefusalRate
} from '../support/units-convert-round-trip';
import { IMPORT_MODELING_SCENARIOS } from './scenarios';

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
