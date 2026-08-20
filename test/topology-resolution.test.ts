import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import type {
  BodyRepresentation,
  BodyId,
  EdgeTopology,
  FaceTopology,
  FaceTopologyReferenceV5,
  FeatureId
} from '@openzcad/shared';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  resolveEdge,
  resolveFace,
  topologyResolutionMessage
} from '../apps/web/src/lib/topologyResolution';

/**
 * The unit half of these tests uses hand-built topology so each rung of the
 * ladder can be exercised in isolation. The integration half builds a real
 * sphere through `syncDocument`, because the motivating ambiguity is not
 * hypothetical and a synthetic fixture could not prove that.
 */

function face(hash: number, reference?: FaceTopologyReferenceV5): FaceTopology {
  return {
    topologyId: `face:${hash}`,
    hash,
    triangleStart: 0,
    triangleCount: 2,
    ...(reference ? { reference } : {})
  };
}

function edge(hash: number): EdgeTopology {
  return {
    topologyId: `edge:${hash}`,
    hash,
    points: [0, 0, 0, 1, 0, 0]
  };
}

function bodyWith(
  faces: FaceTopology[],
  edges: EdgeTopology[] = []
): BodyRepresentation {
  return {
    bodyId: 'body_1' as BodyId,
    name: 'Part',
    source: 'primitive',
    mesh: { kind: 'mesh', vertices: Float32Array.from([]), indices: Uint32Array.from([]) },
    faceCount: faces.length,
    color: '#888888',
    exportableStep: true,
    consumed: false,
    volume: 1,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    topology: { faces, edges }
  };
}

function lineage(name: string): FaceTopologyReferenceV5 {
  return {
    kind: 'face',
    producingFeatureId: 'feature_1' as FeatureId,
    lineageName: name,
    currentHash: 1,
    witnessVersion: 1,
    witness: {
      surfaceType: 'plane',
      perimeter: 4,
      centroid: [0, 0, 0],
      analytic: { kind: 'none' },
      closure: { u: 'open', v: 'open' }
    }
  };
}

describe('fail-closed topology resolution', () => {
  it('resolves a unique hash', () => {
    const body = bodyWith([face(11), face(22)]);
    const found = resolveFace(body, { hash: 22 });
    expect(found.ok).toBe(true);
    expect(found.ok && found.index).toBe(1);
    expect(found.ok && found.entry.hash).toBe(22);
  });

  it('refuses to choose between two entries carrying one hash', () => {
    // The whole point. `Array.prototype.find` answers "the first one" here,
    // which is a guess wearing the costume of a result.
    const body = bodyWith([face(7), face(7)]);
    const found = resolveFace(body, { hash: 7 });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.reason).toBe('ambiguous');
  });

  it('reports a vanished hash separately from an ambiguous one', () => {
    const body = bodyWith([face(11)]);
    const found = resolveFace(body, { hash: 99 });
    expect(!found.ok && found.reason).toBe('not-found');
  });

  it('reports a missing body distinctly, so the row can say so', () => {
    expect(resolveFace(undefined, { hash: 1 })).toEqual({
      ok: false,
      reason: 'body-missing'
    });
    // A body present but carrying no topology at all is the same story from
    // the user's side, and must not read as "ambiguous".
    const bodiless = { ...bodyWith([]), topology: undefined };
    expect(!resolveFace(bodiless, { hash: 1 }).ok).toBe(true);
  });

  it('prefers a unique lineage match over the hash rung', () => {
    // Both faces carry hash 5; only one carries the lineage name. Lineage
    // disambiguates what the hash cannot, which is what ADR-013 is for.
    const body = bodyWith([face(5), face(5, lineage('top'))]);
    const found = resolveFace(body, { hash: 5, reference: lineage('top') });
    expect(found.ok).toBe(true);
    expect(found.ok && found.index).toBe(1);
  });

  it('falls through to the hash when lineage no longer exists', () => {
    // The case that makes a stricter "lineage miss is terminal" rule wrong.
    // A downstream boolean strips lineage from a face whose geometry — and
    // therefore whose ADR-011 hash, the authoritative identity — is untouched.
    // Failing closed here would strand a still-valid measurement.
    const body = bodyWith([face(5)]);
    const found = resolveFace(body, { hash: 5, reference: lineage('top') });
    expect(found.ok).toBe(true);
    expect(found.ok && found.entry.hash).toBe(5);
  });

  it('fails without falling through when two entries claim one lineage name', () => {
    // Unlike a lineage miss, a lineage COLLISION is not something the hash can
    // adjudicate, so it must not fall through to a rung that might answer.
    const body = bodyWith([face(5, lineage('top')), face(6, lineage('top'))]);
    const found = resolveFace(body, { hash: 5, reference: lineage('top') });
    expect(!found.ok && found.reason).toBe('ambiguous');
  });

  it('resolves edges by the same ladder', () => {
    const body = bodyWith([], [edge(3), edge(4)]);
    expect(resolveEdge(body, { topologyId: 'edge:4' }).ok).toBe(true);
    expect(!resolveEdge(body, { hash: 8 }).ok).toBe(true);

    const twins = bodyWith([], [edge(3), edge(3)]);
    const found = resolveEdge(twins, { hash: 3 });
    expect(!found.ok && found.reason).toBe('ambiguous');
  });

  it('has a plain-words message for every reason', () => {
    // These reach the dock, so none of them may leak a hash or an enum.
    for (const reason of ['body-missing', 'not-found', 'ambiguous'] as const) {
      const message = topologyResolutionMessage(reason);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/hash|topologyId|undefined|[0-9]{6,}/);
    }
  });
});

describe('against real kernel output', () => {
  it("refuses a sphere's twin hemispheres, which really do share one hash", async () => {
    // Not a synthetic fixture: Remus's sphere publishes two faces carrying
    // one hash, because the hemispheres are geometrically identical and
    // ADR-011 hashes geometry. Before this change, picking either bound to
    // the first with no indication anything was wrong.
    const adapter = await createExactKernelAdapter();
    let doc = createProjectDocument('Sphere', toUserId('user_res'));
    doc = addPrimitiveFeature(doc, {
      name: 'Ball',
      primitiveKind: 'sphere',
      dimensions: { radius: 10 }
    });
    const derived = await adapter.syncDocument(doc);
    const body = Object.values(derived.bodyRepresentations)[0]!;

    const faces = body.topology?.faces ?? [];
    expect(faces).toHaveLength(2);
    expect(new Set(faces.map((entry) => entry.hash)).size).toBe(1);

    const found = resolveFace(body, { hash: faces[0]!.hash });
    expect(found.ok).toBe(false);
    expect(!found.ok && found.reason).toBe('ambiguous');

    adapter.dispose();
  }, 120_000);

  it('still resolves every face and edge of a box and a cylinder', async () => {
    // The guard on the guard: failing closed is only correct if it does not
    // fire on ordinary geometry. Every sub-shape of these two must resolve.
    const adapter = await createExactKernelAdapter();
    for (const [primitiveKind, dimensions] of [
      ['box', { width: 20, depth: 20, height: 20 }],
      ['cylinder', { radius: 10, height: 20 }]
    ] as const) {
      let doc = createProjectDocument('P', toUserId('user_res'));
      doc = addPrimitiveFeature(doc, {
        name: primitiveKind,
        primitiveKind,
        dimensions
      });
      const derived = await adapter.syncDocument(doc);
      const body = Object.values(derived.bodyRepresentations)[0]!;

      for (const entry of body.topology?.faces ?? []) {
        expect(resolveFace(body, { hash: entry.hash }).ok).toBe(true);
      }
      for (const entry of body.topology?.edges ?? []) {
        expect(resolveEdge(body, { hash: entry.hash }).ok).toBe(true);
      }
    }
    adapter.dispose();
  }, 120_000);
});
