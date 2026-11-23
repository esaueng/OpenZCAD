/**
 * I03 stored-unit conversion round trips (plan §6): converting a document to
 * every other supported unit and back must restore it byte for byte, or the
 * conversion must refuse with a reason. Shared by `test/units-convert.test.ts`
 * and the parity corpus spec, which measures the refusal rate.
 */
import { expect } from 'vitest';

import {
  convertDocumentUnits,
  getParameterScope,
  listParameters,
  unitsConversionOracle
} from '@openzcad/document-core';
import type { ProjectDocument, UnitSystem } from '@openzcad/shared';

const CONVERTIBLE: readonly UnitSystem[] = ['mm', 'cm', 'inch'];

/** What a round trip must restore: everything but caches and the version. */
function content(document: ProjectDocument): unknown {
  const {
    derived: _derived,
    version: _version,
    editHistory: _history,
    ...rest
  } = document;
  const nodes = Object.fromEntries(
    Object.entries(rest.nodes).map(([id, node]) => [
      id,
      // Recomputed by evaluation; compared numerically below.
      node.kind === 'parameter' ? { ...node, value: 0 } : node
    ])
  );
  return { ...rest, nodes };
}

function parameterValues(document: ProjectDocument): Record<string, number> {
  return Object.fromEntries(
    listParameters(document).map((parameter) => [
      parameter.name,
      parameter.value
    ])
  );
}

/**
 * Converts `document` to each other unit and back, asserting the round trip
 * restores it exactly and the oracle passes. Returns the refusal reasons
 * (`code: subject`), empty when every conversion succeeded, and how many
 * fields the oracle evaluated.
 */
export function assertUnitRoundTrips(
  key: string,
  document: ProjectDocument
): { reasons: string[]; oracleChecks: number } {
  const source = document.units;
  if (!CONVERTIBLE.includes(source))
    return { reasons: [`source unit ${source}`], oracleChecks: 0 };
  const reasons = new Set<string>();
  let oracleChecks = 0;
  for (const to of CONVERTIBLE) {
    if (to === source) continue;
    const there = convertDocumentUnits(document, to);
    if (!there.ok) {
      for (const refusal of there.refusals)
        reasons.add(`${refusal.code}: ${refusal.subject}`);
      continue;
    }
    expect(there.document.units, key).toBe(to);
    oracleChecks += there.report.oracleChecks;
    expect(
      unitsConversionOracle(document, there.document).refusals,
      `${key} via ${to}`
    ).toEqual([]);
    expect(
      getParameterScope(there.document).errors,
      `${key} via ${to}`
    ).toEqual(getParameterScope(document).errors);
    const back = convertDocumentUnits(there.document, source);
    if (!back.ok)
      throw new Error(
        `${key}: ${to} → ${source} refused: ${back.refusals
          .map((refusal) => refusal.message)
          .join(' | ')}`
      );
    expect(content(back.document), `${key} via ${to}`).toEqual(
      content(document)
    );
    const values = parameterValues(document);
    const restored = parameterValues(back.document);
    for (const [name, value] of Object.entries(values))
      expect(
        Math.abs(restored[name]! - value),
        `${key} via ${to}: ${name}`
      ).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(value)));
  }
  return { reasons: [...reasons], oracleChecks };
}

/** Logs and returns how many documents converted and why the rest refused. */
export function reportRefusalRate(
  label: string,
  outcomes: ReadonlyMap<string, string[]>
): { converted: number; refused: number } {
  const refused = [...outcomes].filter(([, reasons]) => reasons.length > 0);
  const converted = outcomes.size - refused.length;
  console.info(
    [
      `${label}: ${outcomes.size} documents, ${converted} convert, ${refused.length} refused`,
      ...refused.map(([key, reasons]) => `  ${key}: ${reasons.join('; ')}`)
    ].join('\n')
  );
  return { converted, refused: refused.length };
}
