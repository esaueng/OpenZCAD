import { expect, it, vi } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import { directEditBody } from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import type {
  BodyId,
  BodyRepresentation,
  DerivedState,
  GeometryReadyState,
  ProjectDocument
} from '@openzcad/shared';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../packages/kernel-adapter/src/boolean-result-validation';
import {
  displayTessellationForExtents,
  previewDisplayTessellation
} from '../packages/kernel-adapter/src/display-tessellation';
import {
  RemusKernel,
  loadRemusTranslators
} from '../packages/kernel-adapter/src/remus-runtime';
import { filletedUnion } from './support/filleted-union';
import {
  LADDERS,
  ladderCommand,
  ladderFaces
} from './direct-edit-corpus/distance-ladder';
import {
  boxVolume,
  expectVolume,
  integratedVolume
} from './direct-edit-corpus/ladder-oracles';
import {
  BOX,
  RIM,
  referencePart,
  unequalCorner
} from './direct-edit-corpus/reference-parts';

/**
 * Everything a release accepts, without its display: the mesh, the faces'
 * triangle ranges in it (a release is drafted) and the sampled points of
 * freeform edges, which an incremental build already sampled differently
 * from a cold one before releases reused prepared edits.
 */
function accepted(derived: DerivedState) {
  const exact = JSON.parse(
    JSON.stringify(derived.bodyRepresentations, (key, value: unknown) =>
      key === 'mesh' ||
      key === 'triangleStart' ||
      key === 'triangleCount' ||
      key === 'points'
        ? undefined
        : value
    )
  ) as DerivedState['bodyRepresentations'];
  return {
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings,
    exportableBodyIds: derived.exportableBodyIds,
    bodies: Object.fromEntries(
      Object.entries(exact).map(([id, body]) => [
        id,
        { volume: body.volume, topology: body.topology }
      ])
    )
  };
}

/**
 * The release of a boss diameter drag commits the resize its preview
 * prepared (`commitPreparedGroupEditJournaled`) instead of rebuilding it
 * (`resizeCylindricalFaceJournaled`), which on the owner's 32-feature part
 * cut the release check by about 130 ms.
 *
 * That needs the release to restore the checkpoint the preview prepared
 * on. Here, as on that part, the checkpoint schedule is full, so the live
 * build of a history ending in a face offset keeps the offset's source but
 * not its result. The first preview frame of the appended resize replays
 * that offset; replayed display-only, its checkpoint was one the checked
 * release could not restore, so the release replayed the prefix again and
 * resized the wall afresh.
 */
it('releases a boss resize from the checkpoint its preview prepared', async () => {
  const adapter = await createExactKernelAdapter({
    historyCheckpointLimit: 3
  });
  const fresh = await createExactKernelAdapter({ historyCheckpointLimit: 0 });
  const prepared = vi.spyOn(
    RemusKernel.prototype as unknown as {
      commitPreparedGroupEditJournaled(handle: number, radius: number): string;
    },
    'commitPreparedGroupEditJournaled'
  );
  const rebuilt = vi.spyOn(
    RemusKernel.prototype,
    'resizeCylindricalFaceJournaled'
  );
  try {
    const model = await filletedUnion(adapter);
    const wall = model.body.topology!.faces.find(
      (face) =>
        face.reference?.lineageName ===
        'boolean.face.operand.0.primitive.cylinder.face.wall'
    )!;
    expect(wall.geometry?.radius).toBeCloseTo(6, 9);
    const resize = (radius: number): ProjectDocument =>
      directEditBody(model.document, {
        name: 'Resize Cylinder',
        targetBodyId: model.bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall.hash,
          ...(wall.reference ? { faceReference: wall.reference } : {}),
          sourceRadius: 6,
          sourceAxisStart: wall.geometry!.axisStart!,
          sourceAxisEnd: wall.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;

    // The drag, as the app sends it, then the release's check.
    for (const radius of [6.4, 6.8, 7])
      await adapter.previewGeometry(resize(radius), {
        deferTopology: true,
        proposeCarry: true
      });
    prepared.mockClear();
    rebuilt.mockClear();
    const release = await adapter.syncDocument(
      resize(7),
      undefined,
      undefined,
      undefined,
      { lineageDemand: [], proposeCarry: true }
    );
    expect(prepared).toHaveBeenCalledTimes(1);
    expect(rebuilt).not.toHaveBeenCalled();

    // Exactly what a cold, fully checked rebuild accepts.
    expect(accepted(release)).toEqual(
      accepted(
        await fresh.syncDocument(resize(7), undefined, undefined, undefined, {
          lineageDemand: [],
          proposeCarry: true
        })
      )
    );
  } finally {
    prepared.mockRestore();
    rebuilt.mockRestore();
    adapter.dispose();
    fresh.dispose();
  }
}, 120_000);

function bandsAt(derived: DerivedState, bodyId: BodyId, radius: number) {
  return derived.bodyRepresentations[bodyId]!.topology!.faces.filter(
    (face) =>
      face.geometry?.featureType === 'blend' &&
      Math.abs(face.geometry.blendRadius! - radius) < 1e-8
  ).length;
}

/** The enclosed volume of a body's closed display mesh. */
function displayVolume(
  state: Pick<GeometryReadyState, 'bodyRepresentations'>,
  bodyId: BodyId
): number {
  const { mesh } = state.bodyRepresentations[bodyId]!;
  const closure = inspectTriangleMeshClosure(mesh.vertices, mesh.indices);
  expect(
    isClosedConsistentlyOrientedMesh(closure),
    JSON.stringify(closure)
  ).toBe(true);
  return integratedVolume(mesh.vertices, mesh.indices);
}

/**
 * WS1's two-resolution error estimate for a drag-frame mesh: the cold
 * rebuild's exact solid, read back from its STEP export, tessellated at the
 * prepared-drag display quality and integrated directly, against its exact
 * volume.
 */
async function dragMeshError(
  adapter: Awaited<ReturnType<typeof createExactKernelAdapter>>,
  document: ProjectDocument,
  body: BodyRepresentation
): Promise<number> {
  const step = await adapter.exportStep(document, [body.bodyId]);
  const io = await loadRemusTranslators();
  const kernel = new RemusKernel();
  try {
    const [solid] = kernel.deserializeSolids(
      io.importStep(new TextEncoder().encode(step))
    );
    const drag = previewDisplayTessellation(
      displayTessellationForExtents(BOX.width, BOX.height, BOX.depth)
    );
    const mesh = kernel.tessellateSolidGroupedBinary(
      solid!,
      drag.linearDeflection,
      drag.angularDeflection
    );
    return Math.abs(
      integratedVolume(mesh.positions, mesh.indices) - body.volume
    );
  } finally {
    kernel.free();
  }
}

/**
 * The preview of a connected blend resize, its release and a cold replay all
 * build the group route (`resizeBlend`). The prepared journaled commit is the
 * single-band `resizeBlendJournaled`: released from a drag, part B's twelve
 * equal rounds kept only the picked corner's new radius, while the preview
 * and a reopened document resized all twelve.
 */
it('releases a connected blend resize as its preview and replay build it', async () => {
  const adapter = await createExactKernelAdapter();
  const fresh = await createExactKernelAdapter();
  const prepare = vi.spyOn(
    RemusKernel.prototype as unknown as {
      prepareResizeBlend(solid: number, face: number, radius: number): number;
    },
    'prepareResizeBlend'
  );
  try {
    const session = { adapter, deadline: Date.now() + 120_000 };
    const part = await referencePart(session, 'B');
    const ladder = LADDERS.find(
      (entry) => entry.part === 'B' && entry.target === 'edge-round'
    )!;
    const faces = ladderFaces(part, ladder);
    const resize = (radius: number): ProjectDocument => {
      const draft = new CommandManager(part.document);
      draft.execute(ladderCommand(part, ladder, faces, radius - RIM));
      return draft.document;
    };
    // 3.75 is the ladder's L/2 step and 5.88 the last radius at which the
    // twelve-edge Fillet still builds. From 5.89 the group route itself
    // re-blends only the picked corner; 5.9 is the ladder's L − 0.1 step.
    // The closed form holds the corpus tolerance at the ladder step; next to
    // the limit only the independent Fillet history does.
    for (const [radius, uniform, closedForm] of [
      [3.75, true, true],
      [5.88, true, false],
      [5.89, false, false],
      [5.9, false, false]
    ] as const) {
      session.deadline = Date.now() + 120_000;
      prepare.mockClear();
      let preview: GeometryReadyState | undefined;
      for (const frame of [radius - 0.5, radius - 0.25, radius])
        preview = await adapter.previewGeometry(resize(frame), {
          deferTopology: true,
          proposeCarry: true
        });
      // The frames ran on the prepared group edit a release then keeps.
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(preview!.warnings).toEqual([]);
      const released = resize(radius);
      const release = await adapter.syncDocument(
        released,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [], proposeCarry: true }
      );
      expect(release.warnings).toEqual([]);
      const cold = await fresh.syncDocument(
        released,
        undefined,
        undefined,
        undefined,
        { lineageDemand: [], proposeCarry: true }
      );

      // What the last frame drew is what was kept and what replay rebuilds,
      // measured on the display meshes alone.
      const error = await dragMeshError(
        fresh,
        released,
        cold.bodyRepresentations[part.bodyId]!
      );
      const shown = displayVolume(preview!, part.bodyId);
      expectVolume(shown, displayVolume(release, part.bodyId), error);
      expectVolume(shown, displayVolume(cold, part.bodyId), error);

      const volume = release.bodyRepresentations[part.bodyId]!.volume;
      if (uniform) {
        if (closedForm) expectVolume(volume, boxVolume(radius));
        const history = await referencePart(session, 'B', { rim: radius });
        expectVolume(volume, history.body.volume);
        expect(bandsAt(release, part.bodyId, radius)).toBe(12);
      } else {
        const history = await unequalCorner(session, radius);
        expectVolume(volume, history.body.volume);
        expect(bandsAt(release, part.bodyId, radius)).toBe(1);
      }
      expect(accepted(release)).toEqual(accepted(cold));
    }
  } finally {
    prepare.mockRestore();
    adapter.dispose();
    fresh.dispose();
  }
}, 240_000);
