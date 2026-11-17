import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  holeBody,
  listFeaturesInOrder,
  shellBody
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type ProjectDocument
} from '@openzcad/shared';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { expectPassedThrough } from './support/failed-pass-through';

/**
 * Issue #1630: a 65 × 40 × 10 plate with a Ø8 through hole and an R2 fillet
 * on one top outside edge refuses a Shell opened through its top face, at
 * any wall thickness; with the fillet suppressed the same Shell builds.
 *
 * The limitation is the kernel's. Remus closes the wall an opened face
 * exposes with flat rim faces in that face's plane. A fillet that runs
 * tangent into the opened face leaves the inner skin's edge one wall
 * thickness below that plane, so that rim loop lies in no opened plane and
 * the shell is refused (`crates/operations/src/shell_op.rs`, "a free loop of
 * the shelled body lies in none of the opened faces' planes"). No smaller
 * wall can help.
 *
 * Until the kernel closes that rim, the app must refuse by type, keep the
 * filleted plate, and say what is in the way rather than "try a thinner
 * wall". The outcome is pinned: a kernel that learns the configuration fails
 * here and the result is then qualified (closed, wall thickness, volume)
 * instead of absorbed.
 */

const user = toUserId('user_shell_filleted_opening');
const last = (document: ProjectDocument): BodyId => document.bodyOrder.at(-1)!;

function topFace(body: BodyRepresentation) {
  return body.topology!.faces.find(
    (face) =>
      face.geometry?.surfaceType === 'plane' &&
      (face.geometry.normal?.z ?? 0) > 0.999 &&
      Math.abs(face.geometry.center.z - body.bbox.max.z) < 1e-6
  )!;
}

describe('#1630 shell through a face a fillet runs into', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  /** Plate → hole → fillet on the top edge along `edge` → shell the top. */
  async function recipe(edge: 'x' | 'y', thickness: number) {
    let document = addPrimitiveFeature(createProjectDocument('Plate', user), {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: { width: 65, height: 40, depth: 10 }
    });
    let derived = await adapter.syncDocument(document);
    const top = topFace(derived.bodyRepresentations[last(document)]!);
    document = holeBody(document, {
      name: 'Hole',
      targetBodyId: last(document),
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: 8,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid'
    }).document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const drilled = derived.bodyRepresentations[last(document)]!;
    // One top outside edge: the one at the plate's minimum x (or y) side.
    const side = edge === 'x' ? 0 : 1;
    const picked = drilled.topology!.edges.filter((candidate) => {
      for (let index = 0; index < candidate.points.length; index += 3) {
        if (
          Math.abs(candidate.points[index + side]! - drilled.bbox.min[edge]) >
            1e-6 ||
          Math.abs(candidate.points[index + 2]! - drilled.bbox.max.z) > 1e-6
        )
          return false;
      }
      return true;
    });
    expect(picked).toHaveLength(1);
    document = filletEdges(document, {
      name: 'Fillet',
      targetBodyId: last(document),
      edgeHashes: [picked[0]!.hash],
      ...(picked[0]!.reference
        ? { edgeReferences: [picked[0]!.reference] }
        : {}),
      size: 2
    }).document;
    derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const filletedId = last(document);
    const filleted = derived.bodyRepresentations[filletedId]!;
    const opening = topFace(filleted);
    document = shellBody(document, {
      name: 'Shell',
      targetBodyId: filletedId,
      openingFaceHashes: [opening.hash],
      ...(opening.reference
        ? { openingFaceReferences: [opening.reference] }
        : {}),
      thickness
    }).document;
    return { document, filletedId, filleted };
  }

  function shellWarning(document: ProjectDocument, derived: DerivedState) {
    const shell = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Shell'
    )!;
    return (derived.featureWarnings ?? []).find(
      (warning) => warning.featureId === shell.featureId
    );
  }

  const ADVICE =
    'Shell cannot close this opening yet: the wall it exposes has no flat rim. That happens when two open faces share an edge, or a fillet or other rounded face blends into an open face. A thinner wall will not help. Open faces that do not touch, or suppress the fillet.';

  it.each([
    ['x', 2],
    ['x', 1],
    ['x', 0.5],
    ['y', 2]
  ] as const)(
    'refuses by type and keeps the filleted plate (fillet along %s, %s mm wall)',
    async (edge, thickness) => {
      const { document, filletedId, filleted } = await recipe(edge, thickness);
      const derived = await adapter.syncDocument(document);
      const warning = shellWarning(document, derived);
      // Typed, so the card and Done read a refusal rather than parse prose.
      expect(warning).toMatchObject({
        kind: 'build-failed',
        kernelRefusal: {
          family: 'modeling',
          category: 'unsupported',
          code: 'shell_refused'
        }
      });
      expect(warning!.message).toContain(
        "a free loop of the shelled body lies in none of the opened faces' planes"
      );
      // None of the shell's geometry is made: the filleted plate is handed
      // through under the Shell's result id, unchanged (ADR-017).
      expectPassedThrough(derived, last(document), filletedId);
      expect(derived.bodyRepresentations[last(document)]!.volume).toBeCloseTo(
        filleted.volume,
        9
      );
      // What the card says: the cause, not "try a thinner wall".
      const plain = plainRefusal(
        warning!.message.replace(/^Feature "Shell": /, ''),
        warning!.kernelRefusal
      );
      expect(plain.message).toBe(ADVICE);
      expect(plain.detail).toContain('Remus shell refused');
      expect(plain.category).toBe('unsupported');
    },
    300_000
  );

  it('reads the same for a plain box opened through two adjacent faces', async () => {
    // The kernel gives this sentence for any opening without a flat rim,
    // and a box with its top and one side opened has no fillet to blame:
    // the card must name that cause too.
    let document = addPrimitiveFeature(createProjectDocument('Box', user), {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 65, height: 40, depth: 10 }
    });
    const built = await adapter.syncDocument(document);
    const box = built.bodyRepresentations[last(document)]!;
    const side = box.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.x ?? 0) > 0.999
    )!;
    document = shellBody(document, {
      name: 'Shell',
      targetBodyId: last(document),
      openingFaceHashes: [topFace(box).hash, side.hash],
      thickness: 2
    }).document;
    const derived = await adapter.syncDocument(document);
    const warning = shellWarning(document, derived);
    expect(warning?.kernelRefusal).toMatchObject({
      family: 'modeling',
      category: 'unsupported',
      code: 'shell_refused'
    });
    const plain = plainRefusal(
      warning!.message.replace(/^Feature "Shell": /, ''),
      warning!.kernelRefusal
    );
    expect(plain.message).toBe(ADVICE);
    expect(plain.message).toContain('two open faces share an edge');
  }, 300_000);

  it('shells the same plate at 2 mm once the fillet is suppressed', async () => {
    const { document } = await recipe('x', 2);
    const fillet = listFeaturesInOrder(document).find(
      (feature) => feature.name === 'Fillet'
    )!;
    const suppressed: ProjectDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [fillet.id]: {
          ...fillet,
          metadata: {
            ...fillet.metadata,
            [FEATURE_SUPPRESSED_METADATA_KEY]: true
          }
        }
      }
    };
    const derived = await adapter.syncDocument(suppressed);
    expect(shellWarning(suppressed, derived)).toBeUndefined();
    const shell = derived.bodyRepresentations[last(suppressed)]!;
    // The plate less its Ø8 bore, less the 61 × 36 × 8 pocket open through
    // the top, plus the Ø12 column the pocket leaves around the bore.
    expect(shell.volume).toBeCloseTo(
      65 * 40 * 10 - Math.PI * 4 * 4 * 10 - 61 * 36 * 8 + Math.PI * 6 * 6 * 8,
      4
    );
  }, 300_000);
});
