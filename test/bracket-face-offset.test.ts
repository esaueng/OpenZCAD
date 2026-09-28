import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager } from '@openzcad/command-system';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { buildDemoDocument, DEMO_DEFINITIONS } from '../apps/web/src/lib/demos';
import {
  planFaceOffset,
  withFaceTravelHint
} from '../apps/web/src/lib/interaction/faceOffsetPlan';
import { plainRefusal } from '../apps/web/src/lib/refusalLanguage';

/**
 * Design review, demo Mounting Bracket: dragging the base plate's top face
 * ±10 mm ended on "The exact kernel could not build this result." Both
 * refusals are real geometry, not an identity or lineage fault — the plate is
 * 8 mm thick, and the boss's underside hangs 6 mm above the plate — and the
 * kernel refuses a face move whose sweep reaches any face it does not share an
 * edge with. The display mesh suggests a distance, but only the exact kernel
 * can refuse the edit.
 */
describe('demo bracket base-plate top face offset', () => {
  let adapter: ExactKernelAdapter;
  let bracket: ProjectDocument;
  let bodyId: BodyId;
  let top: FaceTopology;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
    const definition = DEMO_DEFINITIONS.find(
      (candidate) => candidate.key === 'bracket'
    )!;
    bracket = await buildDemoDocument(
      definition,
      toUserId('user_bracket_face_offset'),
      (candidate) => adapter.syncDocument(candidate)
    );
    bodyId = bracket.derived.exportableBodyIds[0] as BodyId;
    const faces =
      bracket.derived.bodyRepresentations[bodyId]?.topology?.faces ?? [];
    top = faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99 &&
        Math.abs((face.geometry.center?.z ?? 0) - 8) < 1e-6
    )!;
  }, 120_000);

  afterAll(() => adapter.dispose());

  function plan(offset: number) {
    return planFaceOffset({
      document: bracket,
      bodyId,
      face: top,
      faceHash: top.hash,
      offset
    });
  }

  async function build(offset: number) {
    const candidate = plan(offset);
    expect(candidate).not.toBeNull();
    const document = new CommandManager(bracket).runTransaction('Offset', [
      candidate!.command
    ]);
    return adapter.syncDocument(document);
  }

  it('picks the plate top: outward +Z at plate_t, carrying lineage', () => {
    expect(top).toBeDefined();
    expect(top.geometry?.normal).toEqual({ x: 0, y: 0, z: 1 });
    // The face resolves through both unions and the fillet by reference;
    // the refusals below are not an identity failure.
    expect(top.reference?.lineageName).toMatch(/primitive\.box\.face\.z-max$/);
  });

  it.each([5, -5])(
    'builds an offset of %s mm inside both limits',
    async (offset) => {
      const candidate = plan(offset);
      expect(candidate?.kind).toBe('direct-edit');
      expect(
        (candidate as { travelHint?: string }).travelHint
      ).toBeUndefined();
      const derived = await build(offset);
      expect(derived.warnings).toEqual([]);
      const volume = derived.bodyRepresentations[bodyId]?.volume ?? 0;
      const before = bracket.derived.bodyRepresentations[bodyId]!.volume;
      // The face is 2503.45 mm² (the plate top less the two mount holes).
      expect(volume - before).toBeCloseTo(offset * 2503.45, 0);
    },
    60_000
  );

  it('adds an approximate inward distance after the exact collision refusal', async () => {
    const candidate = plan(-10);
    expect(candidate?.kind).toBe('direct-edit');
    const hint = (candidate as { travelHint?: string }).travelHint;
    expect(hint).toBe(
      'The display mesh suggests about 8 mm of material behind this face.'
    );
    const warnings = (await build(-10)).warnings;
    expect(warnings.join('\n')).toMatch(/swept face reaches nonadjacent face/);
    const exact = plainRefusal(warnings[0]!.replace(/^Feature "[^"]+":\s*/, ''));
    expect(withFaceTravelHint(exact.message, hint)).toBe(
      `${exact.message}\n${hint}`
    );
  }, 60_000);

  it('adds an approximate outward distance after the exact collision refusal', async () => {
    const candidate = plan(10);
    expect(candidate?.kind).toBe('direct-edit');
    const hint = (candidate as { travelHint?: string }).travelHint;
    expect(hint).toBe(
      'The display mesh suggests another part of the body about 6 mm in front of this face.'
    );
    const warnings = (await build(10)).warnings;
    expect(warnings.join('\n')).toMatch(/swept face reaches nonadjacent face/);
    // Should the kernel's own refusal ever reach the card, it now says what
    // happened rather than "could not build this result".
    expect(
      plainRefusal(warnings[0]!.replace(/^Feature "[^"]+":\s*/, '')).message
    ).toBe(
      'The face would run into another part of the body before it got that far.'
    );
    expect(
      withFaceTravelHint('The resulting body came back invalid.', hint)
    ).toBe('The resulting body came back invalid.');
  }, 60_000);

  it('never refuses an offset just inside a limit that the kernel builds', async () => {
    for (const offset of [5.9, -7.9]) {
      expect(
        (plan(offset) as { travelHint?: string }).travelHint
      ).toBeUndefined();
      expect((await build(offset)).warnings).toEqual([]);
    }
    // At the limit itself the kernel is the judge, and it refuses.
    expect((await build(-8)).warnings.join('\n')).toMatch(
      /swept face reaches nonadjacent face/
    );
    // Just past it, the mesh suggests a distance; the kernel still decides.
    expect(
      (plan(-8.1) as { travelHint?: string }).travelHint
    ).toBe(
      'The display mesh suggests about 8 mm of material behind this face.'
    );
  }, 120_000);

  it('keeps an exact build available when the display mesh suggests a false obstacle', async () => {
    const withMeshArtifact = structuredClone(bracket);
    const representation = withMeshArtifact.derived.bodyRepresentations[bodyId]!;
    const mesh = representation.mesh;
    const first = mesh.indices[top.triangleStart * 3]!;
    const second = mesh.indices[top.triangleStart * 3 + 1]!;
    const third = mesh.indices[top.triangleStart * 3 + 2]!;
    const x =
      (mesh.vertices[first * 3]! +
        mesh.vertices[second * 3]! +
        mesh.vertices[third * 3]!) /
      3;
    const y =
      (mesh.vertices[first * 3 + 1]! +
        mesh.vertices[second * 3 + 1]! +
        mesh.vertices[third * 3 + 1]!) /
      3;
    const triangleStart = mesh.indices.length / 3;
    const vertexStart = mesh.vertices.length / 3;
    representation.mesh = {
      ...mesh,
      vertices: Float32Array.from([
        ...mesh.vertices,
        x,
        y,
        9,
        x + 0.01,
        y,
        9,
        x,
        y + 0.01,
        9
      ]),
      indices: Uint32Array.from([
        ...mesh.indices,
        vertexStart,
        vertexStart + 1,
        vertexStart + 2
      ])
    };
    representation.topology!.faces.push({
      topologyId: 'mesh-artifact',
      hash: 999_999,
      triangleStart,
      triangleCount: 1
    });

    const candidate = planFaceOffset({
      document: withMeshArtifact,
      bodyId,
      face: top,
      faceHash: top.hash,
      offset: 5
    });
    expect(candidate?.kind).toBe('direct-edit');
    expect((candidate as { travelHint?: string }).travelHint).toContain(
      'about 1 mm'
    );
    const document = new CommandManager(withMeshArtifact).runTransaction('Offset', [
      candidate!.command
    ]);
    expect((await adapter.syncDocument(document)).warnings).toEqual([]);
  }, 60_000);
});
