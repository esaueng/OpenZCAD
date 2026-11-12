import { describe, expect, it } from 'vitest';
import type { BodyId, FeatureNode } from '@openzcad/shared';
import type { ExactBuildResult, ExactShape } from './exact-types';
import {
  captureFeatureEntryState,
  passFailedFeatureThrough
} from './exact-suppression';

const input = 'body_input' as BodyId;
const output = 'body_output' as BodyId;
const tool = 'body_tool' as BodyId;

function emptyResult(): ExactBuildResult {
  return {
    shapes: new Map(),
    sketchBases: new Map(),
    datumFrames: new Map(),
    datumAxes: new Map(),
    consumed: new Set(),
    importedStepDiagnostics: new Map(),
    meshBodies: new Set(),
    partialRevolveBodies: new Set(),
    warnings: [],
    featureWarnings: [],
    referenceRepairs: []
  };
}

function feature(data: Record<string, unknown>): FeatureNode {
  return {
    featureId: 'feat_failed',
    name: 'Failed',
    bodyId: output,
    metadata: {},
    data
  } as unknown as FeatureNode;
}

const shape = (solid: number): ExactShape => ({ solids: [solid] });

describe('passFailedFeatureThrough', () => {
  it('rolls back what the builder wrote before it threw, then passes the input through', () => {
    const result = emptyResult();
    result.shapes.set(input, shape(1));
    result.meshBodies.add(input);
    const fillet = feature({
      featureKind: 'fillet',
      targetBodyId: input,
      edgeHashes: [],
      radius: 1
    });
    const entry = captureFeatureEntryState(result, fillet);
    expect(entry).not.toBeNull();
    // A half-run builder: a partial result under its own id and an input
    // marked consumed, plus a stray body, before it threw.
    result.shapes.set(output, shape(99));
    result.shapes.set('body_stray' as BodyId, shape(98));
    result.consumed.add(input);
    result.partialRevolveBodies.add(output);
    const shapes = result.shapes;

    expect(passFailedFeatureThrough(result, fillet, entry)).toBe(true);
    // The same containers the build context holds, refilled in place.
    expect(result.shapes).toBe(shapes);
    expect([...result.shapes.keys()]).toEqual([input, output]);
    expect(result.shapes.get(output)!.solids).toEqual([1]);
    expect(result.shapes.get(output)).not.toBe(result.shapes.get(input));
    expect([...result.consumed]).toEqual([input]);
    // Origin flags travel with the passed body, and only those.
    expect([...result.meshBodies].sort()).toEqual([input, output].sort());
    expect([...result.partialRevolveBodies]).toEqual([]);
  });

  it('passes nothing when the input was already consumed or never built', () => {
    const consumed = emptyResult();
    consumed.shapes.set(input, shape(1));
    consumed.consumed.add(input);
    const hole = feature({ featureKind: 'hole', targetBodyId: input });
    expect(
      passFailedFeatureThrough(
        consumed,
        hole,
        captureFeatureEntryState(consumed, hole)
      )
    ).toBe(false);
    expect(consumed.shapes.has(output)).toBe(false);

    const missing = emptyResult();
    expect(
      passFailedFeatureThrough(
        missing,
        hole,
        captureFeatureEntryState(missing, hole)
      )
    ).toBe(false);
    expect(missing.shapes.size).toBe(0);
  });

  it('follows the suppression table: mirror, thicken and split pass nothing; a boolean leaves its tools', () => {
    for (const kind of ['mirror', 'thicken', 'split'] as const) {
      const result = emptyResult();
      result.shapes.set(input, shape(1));
      const failed = feature({ featureKind: kind, targetBodyId: input });
      // Nothing to roll back for a kind that cannot pass through either: its
      // partial state is left exactly as before the amendment.
      expect(captureFeatureEntryState(result, failed)).toBeNull();
      expect(passFailedFeatureThrough(result, failed, null)).toBe(false);
      expect(result.shapes.has(output)).toBe(false);
      expect(result.consumed.size).toBe(0);
    }

    const result = emptyResult();
    result.shapes.set(input, shape(1));
    result.shapes.set(tool, shape(2));
    const union = feature({
      featureKind: 'boolean',
      operation: 'union',
      targetBodyIds: [input, tool]
    });
    const entry = captureFeatureEntryState(result, union);
    result.consumed.add(tool);
    expect(passFailedFeatureThrough(result, union, entry)).toBe(true);
    expect(result.shapes.get(output)!.solids).toEqual([1]);
    expect([...result.consumed]).toEqual([input]);
  });
});
