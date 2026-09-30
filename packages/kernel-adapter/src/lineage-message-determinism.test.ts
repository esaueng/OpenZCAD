/**
 * Published lineage diagnostics must be arena-independent.
 *
 * The H02 fresh-build publication oracle
 * (docs/qa/2026-09-29/h02-cache-safety.md, PR #488) failed on both main and
 * the hardened measurement cache because `lineageDiagnostics[*].message`
 * values quoted raw kernel handles: a warm adapter restoring a checkpoint
 * and replaying a suffix allocates different handles than a cold adapter
 * rebuilding identical geometry, so the same model published different
 * sentences. Every producer that used to embed a handle is driven here twice
 * over the same geometry — once with the arena's natural numbering, once
 * with every handle shifted far away — and the projected publication must be
 * byte-identical. Internal diagnostics keep `sourceHandle`/`resultHandles`
 * for debugging; only the published sentence is handle-free.
 */
import { describe, expect, it } from 'vitest';
import type {
  EdgeWitnessV1,
  FaceWitnessV1,
  FeatureId,
  TopologyLineageDiagnostic
} from '@openzcad/shared';

import { RemusKernel } from './remus-runtime';
import { topologyCandidatesForSolid } from './exact-lineage-builders';
import { projectRemusLineageDiagnostic } from './exact-shape-utils';
import {
  createRemusSemanticLineage,
  deriveRemusBooleanEvolutionLineage,
  deriveRemusMoveFacesDirectEditLineage,
  deriveRemusPatternInstanceLineage,
  propagateRemusRigidTransformLineage,
  reconcileRemusBooleanLineage,
  type RemusBooleanEntityEvolution,
  type RemusLineageState,
  type RemusTopologyCandidate
} from './remus-lineage';

const FEATURE = 'feature_determinism' as FeatureId;
/** The second arena: every handle shifted clear of the first allocation. */
const FAR = 4000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function translateX(distance: number): number[] {
  return [1, 0, 0, distance, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function shift(
  candidates: readonly RemusTopologyCandidate[],
  delta: number
): RemusTopologyCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    handle: candidate.handle + delta
  }));
}

/** Digit-free semantic names, so any handle leaking back is visible. */
function faceName(candidate: RemusTopologyCandidate): string {
  const witness = candidate.witness as FaceWitnessV1;
  const analytic = witness.analytic;
  if (analytic.kind !== 'plane' || !witness.centroid) {
    throw new Error('fixture faces must be planes with a centroid');
  }
  // The stored normal is sign-canonical, so both x faces of a box carry the
  // same normal; the centroid says which side of the box the face is on.
  const [x, y] = analytic.normal;
  const axisIndex = x !== 0 ? 0 : y !== 0 ? 1 : 2;
  return `face-${'xyz'[axisIndex]}-${
    witness.centroid[axisIndex] === 0 ? 'low' : 'high'
  }`;
}

function edgeName(candidate: RemusTopologyCandidate): string {
  const witness = candidate.witness as EdgeWitnessV1;
  if (witness.closed) {
    throw new Error('fixture edges must be open');
  }
  const [start, end] = witness.endpoints;
  const runs = [0, 1, 2].filter((axis) => start[axis] !== end[axis]);
  if (runs.length !== 1) {
    throw new Error('fixture edges must be axis-aligned');
  }
  const run = runs[0]!;
  const at = [0, 1, 2]
    .filter((axis) => axis !== run)
    .map((axis) => `${'xyz'[axis]}-${start[axis] === 0 ? 'low' : 'high'}`)
    .join('-');
  return `edge-run-${'xyz'[run]}-at-${at}`;
}

function nameOf(candidate: RemusTopologyCandidate): string {
  return candidate.kind === 'face' ? faceName(candidate) : edgeName(candidate);
}

function inFreshKernel(
  build: (kernel: RemusKernel) => RemusLineageState
): RemusLineageState {
  const kernel = new RemusKernel();
  try {
    return build(kernel);
  } finally {
    kernel.free();
  }
}

/**
 * The regression invariant: the same geometry built under two arena
 * numberings publishes byte-identical diagnostics, and at least one is
 * produced, so the comparison cannot pass vacuously.
 */
function expectArenaIndependent(
  build: (delta: number) => RemusLineageState
): TopologyLineageDiagnostic[] {
  const near = build(0).diagnostics.map(projectRemusLineageDiagnostic);
  const far = build(FAR).diagnostics.map(projectRemusLineageDiagnostic);
  expect(near.length).toBeGreaterThan(0);
  expect(far).toEqual(near);
  return near;
}

function boxCandidates(
  kernel: RemusKernel,
  delta: number
): RemusTopologyCandidate[] {
  return shift(topologyCandidatesForSolid(kernel, kernel.makeBox(10, 8, 6)), delta);
}

function find(
  candidates: readonly RemusTopologyCandidate[],
  kind: 'face' | 'edge',
  name: string
): RemusTopologyCandidate {
  const match = candidates.find(
    (candidate) => candidate.kind === kind && nameOf(candidate) === name
  );
  if (!match) {
    throw new Error(`fixture lost ${name}`);
  }
  return match;
}

describe('published lineage diagnostic messages are arena-independent', () => {
  it('publishes a boolean evolution/carrier disagreement without handles', () => {
    // reconcileRemusBooleanLineage: the journal and the analytic carrier
    // rule name one result differently; neither name is published.
    const build = (delta: number) =>
      inFreshKernel((kernel) => {
        const candidates = boxCandidates(kernel, delta);
        const carrier = createRemusSemanticLineage(
          FEATURE,
          'primitive',
          candidates.map((candidate) => ({
            ...candidate,
            lineageName: nameOf(candidate)
          }))
        );
        const assignments = candidates.map((candidate) => ({
          ...candidate,
          lineageName: nameOf(candidate)
        }));
        const swapNames = (left: number, right: number) => {
          const a = assignments.find((entry) => entry.handle === left)!;
          const b = assignments.find((entry) => entry.handle === right)!;
          const name = a.lineageName;
          Object.assign(a, { lineageName: b.lineageName });
          Object.assign(b, { lineageName: name });
        };
        swapNames(
          find(candidates, 'face', 'face-z-high').handle,
          find(candidates, 'face', 'face-x-high').handle
        );
        swapNames(
          find(candidates, 'edge', 'edge-run-z-at-x-low-y-low').handle,
          find(candidates, 'edge', 'edge-run-z-at-x-high-y-low').handle
        );
        const evolution = createRemusSemanticLineage(
          FEATURE,
          'boolean',
          assignments
        );
        return reconcileRemusBooleanLineage(carrier, evolution);
      });
    const published = expectArenaIndependent(build);
    expect(published.map((entry) => entry.message).sort()).toEqual([
      'Boolean evolution named a result edge edge-run-z-at-x-high-y-low where the analytic carrier rule named it edge-run-z-at-x-low-y-low; neither is published.',
      'Boolean evolution named a result edge edge-run-z-at-x-low-y-low where the analytic carrier rule named it edge-run-z-at-x-high-y-low; neither is published.',
      'Boolean evolution named a result face face-x-high where the analytic carrier rule named it face-z-high; neither is published.',
      'Boolean evolution named a result face face-z-high where the analytic carrier rule named it face-x-high; neither is published.'
    ]);
    for (const entry of published) {
      expect(entry.status).toBe('unsupported');
      expect(entry.message).not.toMatch(/\d/);
    }
  });

  it('publishes an unverified boolean evolution claim without handles', () => {
    // deriveRemusBooleanEvolutionLineage: a journal that maps a result face
    // to a source on a different analytic carrier, and a "preserved" edge
    // whose witness changed, are both refused by name only.
    const build = (delta: number) =>
      inFreshKernel((kernel) => {
        const candidates = boxCandidates(kernel, delta);
        const lineage = createRemusSemanticLineage(
          FEATURE,
          'primitive',
          candidates.map((candidate) => ({
            ...candidate,
            lineageName: nameOf(candidate)
          }))
        );
        const faces = candidates.filter((entry) => entry.kind === 'face');
        const edges = candidates.filter((entry) => entry.kind === 'edge');
        const faceMap = new Map(faces.map((face) => [face.handle, face.handle]));
        const swapFaces = [
          find(candidates, 'face', 'face-z-high'),
          find(candidates, 'face', 'face-x-high')
        ];
        faceMap.set(swapFaces[0]!.handle, swapFaces[1]!.handle);
        faceMap.set(swapFaces[1]!.handle, swapFaces[0]!.handle);
        const preserved = new Map(edges.map((edge) => [edge.handle, edge.handle]));
        const swapEdges = [
          find(candidates, 'edge', 'edge-run-z-at-x-low-y-low'),
          find(candidates, 'edge', 'edge-run-z-at-x-high-y-low')
        ];
        preserved.set(swapEdges[0]!.handle, swapEdges[1]!.handle);
        preserved.set(swapEdges[1]!.handle, swapEdges[0]!.handle);
        const evolution: RemusBooleanEntityEvolution = {
          solid: 1000 + delta,
          faces: faceMap,
          edges: {
            preserved,
            modified: new Map(),
            generated: new Map(),
            unresolved: new Set()
          }
        };
        return deriveRemusBooleanEvolutionLineage({
          producingFeatureId: FEATURE,
          evolution,
          resultSolid: 1000 + delta,
          operands: [{ lineage, candidates, role: 'target' }],
          resultCandidates: candidates
        });
      });
    const published = expectArenaIndependent(build);
    const messages = published.map((entry) => entry.message).sort();
    expect(messages).toEqual(
      [
        'Boolean evolution called an edge preserved from edge-run-z-at-x-high-y-low, but its exact witness changed.',
        'Boolean evolution called an edge preserved from edge-run-z-at-x-low-y-low, but its exact witness changed.',
        'Boolean evolution claimed face-x-high for a result face that does not share its exact analytic carrier.',
        'Boolean evolution claimed face-z-high for a result face that does not share its exact analytic carrier.'
      ].sort()
    );
    for (const message of messages) {
      expect(message).not.toMatch(/\d/);
    }
  });

  it('publishes a pattern journal disagreement without handles', () => {
    // deriveRemusPatternInstanceLineage: the kernel journal claims a
    // different instance face than the transformed witness matched.
    const build = (delta: number) =>
      inFreshKernel((kernel) => {
        const source = kernel.makeBox(10, 8, 6);
        const instance = kernel.copyAndTransformSolid(
          source,
          new Float64Array(translateX(20))
        );
        const sourceCandidates = shift(
          topologyCandidatesForSolid(kernel, source).filter(
            (candidate) => candidate.kind === 'face'
          ),
          delta
        );
        const instanceCandidates = shift(
          topologyCandidatesForSolid(kernel, instance).filter(
            (candidate) => candidate.kind === 'face'
          ),
          delta
        );
        const sourceLineage = createRemusSemanticLineage(
          FEATURE,
          'primitive',
          sourceCandidates.map((candidate) => ({
            ...candidate,
            lineageName: faceName(candidate)
          }))
        );
        return deriveRemusPatternInstanceLineage({
          producingFeatureId: FEATURE,
          sourceLineage,
          sourceCandidates,
          instances: [
            {
              instance: 'copy',
              matrix: translateX(20),
              candidates: instanceCandidates,
              claimedFaces: new Map([
                [
                  find(sourceCandidates, 'face', 'face-z-high').handle,
                  find(instanceCandidates, 'face', 'face-x-high').handle
                ]
              ])
            }
          ]
        });
      });
    const published = expectArenaIndependent(build);
    expect(published).toHaveLength(1);
    expect(published[0]!.message).toBe(
      'The pattern journal claimed a different result face for face-z-high than its exact witness matched.'
    );
    expect(published[0]!.message).not.toMatch(/\d/);
  });

  it('publishes a transform merge without handles', () => {
    // propagateRemusRigidTransformLineage: two source references land on
    // one result face, so neither name is published.
    const build = (delta: number) =>
      inFreshKernel((kernel) => {
        const faces = boxCandidates(kernel, delta).filter(
          (candidate) => candidate.kind === 'face'
        );
        const twin = find(faces, 'face', 'face-z-high');
        const assignments = faces.map((candidate) => ({
          ...candidate,
          lineageName: faceName(candidate)
        }));
        assignments.push({
          ...twin,
          handle: twin.handle + 777,
          lineageName: 'face-z-high-twin'
        });
        const source = createRemusSemanticLineage(
          FEATURE,
          'primitive',
          assignments
        );
        return propagateRemusRigidTransformLineage(source, faces, IDENTITY);
      });
    const published = expectArenaIndependent(build);
    const merges = published.filter(
      (entry) => entry.message.startsWith('Multiple source lineages merged')
    );
    expect(merges).toHaveLength(1);
    expect(merges[0]!.message).toBe(
      'Multiple source lineages merged into one transform result face.'
    );
    expect(merges[0]!.status).toBe('merged');
    for (const entry of published) {
      expect(entry.message).not.toMatch(/\d/);
    }
  });

  it('publishes a direct-edit naming conflict without handles', () => {
    // deriveRemusMoveFacesDirectEditLineage: the construction history and
    // the unchanged-witness derivation name one result face differently.
    const build = (delta: number) =>
      inFreshKernel((kernel) => {
        const faces = boxCandidates(kernel, delta).filter(
          (candidate) => candidate.kind === 'face'
        );
        const source = createRemusSemanticLineage(
          FEATURE,
          'primitive',
          faces.map((candidate) => ({
            ...candidate,
            lineageName: faceName(candidate)
          }))
        );
        const state = deriveRemusMoveFacesDirectEditLineage({
          source,
          sourceCandidates: faces,
          resultCandidates: faces,
          relation: {
            faceMap: new Map([
              [
                find(faces, 'face', 'face-z-high').handle,
                find(faces, 'face', 'face-x-high').handle
              ]
            ]),
            conflictedSources: new Set<number>()
          }
        });
        if (!state) {
          throw new Error('fixture lost the direct-edit lineage');
        }
        return state;
      });
    const published = expectArenaIndependent(build);
    const conflicts = published.filter((entry) =>
      entry.message.startsWith('Direct-edit construction history named')
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.message).toBe(
      'Direct-edit construction history named a result face face-z-high where the measured witnesses named it face-x-high; neither is published.'
    );
    expect(conflicts[0]!.status).toBe('hash-only');
    expect(conflicts[0]!.message).not.toMatch(/\d/);
    // The carry summary may quote counts — they derive from the geometry and
    // the journal, never from arena numbering, and the cross-arena equality
    // above is what pins that.
    expect(published.length).toBeGreaterThan(1);
  });
});
