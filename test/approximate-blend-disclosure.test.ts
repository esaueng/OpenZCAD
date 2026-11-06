import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type FeatureWarning } from '@openzcad/shared';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';
import { approximateBlendAdvisory } from '../packages/kernel-adapter/src/exact-edge-modifiers';
import { displayMeshGapsAdvisory } from '../packages/kernel-adapter/src/exact-feature-warnings';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
import { sphereCylinderUnionInputs } from './support/sphere-cylinder-union';

/**
 * Owner decision, 2026-11-06 (kernel robustness plan): an approximate blend
 * is allowed only when it is disclosed. A fillet whose band the kernel can
 * only fit as NURBS used to carry just the display-mesh advisory, which said
 * volume and STEP export "use the exact solid" — true of the B-rep, false of
 * the band. The feature now says the band is approximate, and the mesh advice
 * no longer calls a body with NURBS faces exact.
 */
const forFeature = (
  warnings: readonly FeatureWarning[] | undefined,
  name: string
) => (warnings ?? []).filter((warning) => warning.featureName === name);

describe('approximate blend disclosure copy', () => {
  it('reads as one plain sentence the card keeps verbatim', () => {
    for (const kind of ['fillet', 'chamfer'] as const) {
      const text = approximateBlendAdvisory(kind);
      expect(text).toMatch(new RegExp(`^This ${kind} is approximate:`));
      expect(text).not.toMatch(/\n/);
      expect(text).not.toMatch(/exact solid/);
      // Not mistaken for kernel prose and swapped for a generic sentence.
      expect(plainRefusal(text)).toEqual({ message: text });
    }
  });

  it('calls the solid exact only when it has no NURBS face', () => {
    expect(displayMeshGapsAdvisory(false)).toMatch(/use the exact solid\.$/);
    expect(displayMeshGapsAdvisory(true)).not.toMatch(/exact/);
    expect(displayMeshGapsAdvisory(true)).toMatch(
      /use the solid model, not the display mesh\.$/
    );
    for (const nurbs of [false, true]) {
      const text = displayMeshGapsAdvisory(nurbs);
      expect(text).toMatch(/display mesh has gaps/);
      expect(plainRefusal(text)).toEqual({ message: text });
    }
  });
});

describe('approximate blend disclosure', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => {
    adapter.dispose();
  });

  it('discloses the NURBS band of a sphere/cylinder seam fillet', async () => {
    const { document, sphere, cylinder } = sphereCylinderUnionInputs();
    const manager = new CommandManager(document);
    manager.execute(
      commandFactories.booleanBodies({
        name: 'Union',
        operation: 'union',
        targetBodyIds: [sphere, cylinder]
      })
    );
    const unionId = manager.document.bodyOrder.at(-1)!;
    const joined = await adapter.syncDocument(manager.document);
    const union = joined.bodyRepresentations[unionId]!;
    const sphereFaces = new Set(
      union
        .topology!.faces.filter(
          (face) => face.geometry?.surfaceType === 'sphere'
        )
        .map((face) => face.hash)
    );
    const wallFaces = new Set(
      union
        .topology!.faces.filter(
          (face) => face.geometry?.surfaceType === 'cylinder'
        )
        .map((face) => face.hash)
    );
    const seams = union.topology!.edges.filter((edge) => {
      const faces = edge.adjacentFaceHashes ?? [];
      return (
        faces.some((hash) => sphereFaces.has(hash)) &&
        faces.some((hash) => wallFaces.has(hash))
      );
    });
    expect(seams.length).toBeGreaterThan(0);

    const rounded = filletEdges(manager.document, {
      name: 'Fillet',
      targetBodyId: unionId,
      edgeHashes: seams.map((edge) => edge.hash),
      size: 2
    });
    const derived = await adapter.syncDocument(rounded.document);
    const body = derived.bodyRepresentations[rounded.bodyId]!;
    expect(body.exportableStep).toBe(true);
    expect(
      body.topology!.faces.some(
        (face) => face.geometry?.surfaceType === 'bspline'
      )
    ).toBe(true);

    const fillet = forFeature(derived.featureWarnings, 'Fillet');
    // Advisory, never a refusal: the approximate body is kept.
    expect(fillet.every((warning) => warning.kind === 'advisory')).toBe(true);
    expect(fillet.map((warning) => warning.message)).toContain(
      `Feature "Fillet": ${approximateBlendAdvisory('fillet')}`
    );
    // Nothing on the feature may still call the approximated band exact.
    for (const warning of fillet) {
      expect(warning.message).not.toMatch(/exact solid/);
    }
  });

  it('stays quiet for a fillet with an exact band', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Box fillet', toUserId('user_blend_quality')),
      {
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const boxId = document.bodyOrder[0]!;
    const built = await adapter.syncDocument(document);
    const edge = built.bodyRepresentations[boxId]!.topology!.edges[0]!;
    const rounded = filletEdges(document, {
      name: 'Fillet',
      targetBodyId: boxId,
      edgeHashes: [edge.hash],
      size: 2
    });
    const derived = await adapter.syncDocument(rounded.document);
    expect(derived.warnings).toEqual([]);
    expect(forFeature(derived.featureWarnings, 'Fillet')).toEqual([]);
  });

  it('discloses what the typed blend reports when it is the route taken', async () => {
    // The feature normally runs the evolution entry point, which reports no
    // quality; when it is unavailable the typed twin's verdict is read
    // directly. Force that route and feed it an approximate verdict.
    const evolution = vi
      .spyOn(RemusKernel.prototype, 'filletWithEvolution')
      .mockImplementation(() => {
        throw new Error('evolution unavailable');
      });
    const original = RemusKernel.prototype.filletDetailed;
    const typed = vi
      .spyOn(RemusKernel.prototype, 'filletDetailed')
      .mockImplementation(function (this: RemusKernel, ...args) {
        const result = original.apply(this, args);
        return result.status === 'ok'
          ? {
              ...result,
              details: { ...result.details, quality: 'approximate' }
            }
          : result;
      });
    const fresh = await createExactKernelAdapter();
    try {
      const document = addPrimitiveFeature(
        createProjectDocument('Box fillet', toUserId('user_blend_quality')),
        {
          name: 'Box',
          primitiveKind: 'box',
          dimensions: { width: 30, height: 18, depth: 24 }
        }
      );
      const boxId = document.bodyOrder[0]!;
      const built = await fresh.syncDocument(document);
      const edge = built.bodyRepresentations[boxId]!.topology!.edges[0]!;
      const rounded = filletEdges(document, {
        name: 'Fillet',
        targetBodyId: boxId,
        edgeHashes: [edge.hash],
        size: 2
      });
      const derived = await fresh.syncDocument(rounded.document);
      expect(typed).toHaveBeenCalled();
      expect(
        forFeature(derived.featureWarnings, 'Fillet').map(
          (warning) => [warning.kind, warning.message] as const
        )
      ).toEqual([
        ['advisory', `Feature "Fillet": ${approximateBlendAdvisory('fillet')}`]
      ]);
    } finally {
      fresh.dispose();
      evolution.mockRestore();
      typed.mockRestore();
    }
  });
});
