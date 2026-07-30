import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  chamferEdges,
  createProjectDocument,
  directEditBody,
  extrudeSketch,
  filletEdges,
  findSketch,
  patternBody,
  transformBody,
  updateSketchObject
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId, type ParamValue } from '@openzcad/shared';
import { computeSketchRegions, profileContainsPoint } from '@openzcad/geometry';
import { CommandManager, commandFactories } from '@openzcad/command-system';

const NORMAL_PROJECTED_RADIUS_PX = 240;
const CLOSE_PROJECTED_RADIUS_PX = 1200;
const MAX_PROJECTED_CHORD_ERROR_PX = 0.5;

function projectedChordError(
  points: number[],
  radius: number,
  projectedRadius: number
): number {
  let maximum = 0;
  for (let index = 0; index + 5 < points.length; index += 3) {
    const midpointRadius = Math.hypot(
      (points[index]! + points[index + 3]!) / 2,
      (points[index + 1]! + points[index + 4]!) / 2
    );
    maximum = Math.max(maximum, (radius - midpointRadius) / radius);
  }
  return maximum * projectedRadius;
}

function circularMeshRing(
  vertices: number[],
  radius: number,
  z: number
): number[] {
  const tolerance = Math.max(radius * 1e-5, 1e-6);
  const points = new Map<string, [number, number, number]>();
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    const x = vertices[index]!;
    const y = vertices[index + 1]!;
    const pointZ = vertices[index + 2]!;
    if (
      Math.abs(pointZ - z) <= tolerance &&
      Math.abs(Math.hypot(x, y) - radius) <= tolerance
    ) {
      const angle = Math.atan2(y, x);
      points.set(angle.toFixed(8), [x, y, pointZ]);
    }
  }
  const ordered = [...points.values()].sort(
    (left, right) =>
      Math.atan2(left[1], left[0]) - Math.atan2(right[1], right[0])
  );
  return [...ordered, ordered[0]!].flat();
}

describe('exact hybrid kernel adapter', () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  it('derives exact B-rep measurements and topology', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Exact box', toUserId('user_exact')),
      {
        name: 'Exact box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );

    const derived = await adapter.syncDocument(document);
    const body = Object.values(derived.bodyRepresentations)[0];

    expect(body?.volume).toBeCloseTo(6000, 6);
    expect(body?.faceCount).toBe(6);
    expect(body?.mesh.indices.length).toBeGreaterThan(0);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(body?.topology?.edges.every((edge) => edge.points.length >= 6)).toBe(
      true
    );
    // Face hashes are geometric fingerprints: unique per face, positive, and
    // stable across identical rebuilds (they are NOT ordinals).
    const faceHashes = body?.topology?.faces.map((face) => face.hash) ?? [];
    expect(new Set(faceHashes).size).toBe(6);
    expect(faceHashes.every((hash) => Number.isInteger(hash) && hash > 0)).toBe(
      true
    );
    expect(faceHashes).not.toEqual([1, 2, 3, 4, 5, 6]);
    const resynced = await adapter.syncDocument(document);
    const resyncedBody = Object.values(resynced.bodyRepresentations)[0];
    expect(resyncedBody?.topology?.faces.map((face) => face.hash)).toEqual(
      faceHashes
    );
    // Every face carries measured geometry for drag affordances.
    expect(
      body?.topology?.faces.every(
        (face) =>
          face.geometry &&
          face.geometry.surfaceType === 'plane' &&
          face.geometry.area > 0 &&
          face.geometry.normal !== undefined
      )
    ).toBe(true);
    const edgeHashes = body?.topology?.edges.map((edge) => edge.hash) ?? [];
    expect(new Set(edgeHashes).size).toBe(12);
    expect(edgeHashes.every((hash) => Number.isInteger(hash) && hash > 0)).toBe(
      true
    );
    expect(edgeHashes).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(derived.warnings).toEqual([]);
  });

  it('keeps cylinder surfaces and exact edge outlines smooth across scale and zoom', async () => {
    for (const radius of [0.5, 10, 1000]) {
      const document = addPrimitiveFeature(
        createProjectDocument(
          `Cylinder ${radius * 2}`,
          toUserId(`user_cylinder_${radius}`)
        ),
        {
          name: `Cylinder ${radius * 2}`,
          primitiveKind: 'cylinder',
          dimensions: { radius, height: radius * 2 }
        }
      );

      const derived = await adapter.syncDocument(document);
      const bodyId = document.bodyOrder[0]!;
      const body = derived.bodyRepresentations[bodyId]!;
      const cylindricalFace = body.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      const circularEdges =
        body.topology?.edges.filter((edge) => edge.points.length > 6) ?? [];

      // The authored/exported solid remains analytic; only its disposable
      // viewport representation is tessellated.
      expect(cylindricalFace?.geometry?.radius).toBeCloseTo(radius, 7);
      expect(circularEdges).toHaveLength(2);

      // Shared display tolerances give the shaded rim and exact edge overlay
      // compatible resolution at every model scale. Full circles repeat their
      // first point so Line2 also draws the closing segment.
      const surfaceRing = circularMeshRing(
        body.mesh.vertices,
        radius,
        radius * 2
      );
      expect(surfaceRing.length / 3 - 1).toBeGreaterThanOrEqual(100);
      expect(surfaceRing.length / 3 - 1).toBeLessThan(160);
      expect(body.mesh.indices.length / 3).toBeLessThan(600);

      for (const edge of circularEdges) {
        expect(
          Math.hypot(
            edge.points.at(-3)! - edge.points[0]!,
            edge.points.at(-2)! - edge.points[1]!,
            edge.points.at(-1)! - edge.points[2]!
          )
        ).toBeLessThan(Math.max(radius * 1e-12, 1e-12));
        expect(edge.points.length / 3 - 1).toBeGreaterThanOrEqual(100);
        expect(edge.points.length / 3 - 1).toBeLessThan(160);
        for (const projectedRadius of [
          NORMAL_PROJECTED_RADIUS_PX,
          CLOSE_PROJECTED_RADIUS_PX
        ]) {
          expect(
            projectedChordError(edge.points, radius, projectedRadius)
          ).toBeLessThanOrEqual(MAX_PROJECTED_CHORD_ERROR_PX);
        }
      }

      for (const projectedRadius of [
        NORMAL_PROJECTED_RADIUS_PX,
        CLOSE_PROJECTED_RADIUS_PX
      ]) {
        expect(
          projectedChordError(surfaceRing, radius, projectedRadius)
        ).toBeLessThanOrEqual(MAX_PROJECTED_CHORD_ERROR_PX);
      }

      const step = await adapter.exportStep(document, [bodyId]);
      expect(step).toContain('CYLINDRICAL_SURFACE');
    }
  });

  it('removes boolean seams from a unioned physical part', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Uniform bracket', toUserId('user_exact')),
      {
        name: 'Base plate',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 30, depth: 6 }
      }
    );
    const withWall = addPrimitiveFeature(withBase, {
      name: 'Wall plate',
      primitiveKind: 'box',
      dimensions: { width: 40, height: 6, depth: 24 }
    });
    const wallId = withWall.bodyOrder.at(-1)!;
    const positioned = transformBody(withWall, {
      name: 'Seat wall on base',
      targetBodyId: wallId,
      translation: { x: 0, y: 24, z: 5.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Uniform bracket',
        operation: 'union',
        targetBodyIds: [positioned.bodyOrder[0]!, wallId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];

    expect(derived.warnings).toEqual([]);
    expect(
      Object.values(derived.bodyRepresentations).filter(
        (candidate) => !candidate.consumed
      )
    ).toHaveLength(1);
    expect(body?.volume).toBeCloseTo(40 * 30 * 6 + 40 * 6 * 23.5, 4);
    // An L prism has six rectangular side faces plus its L-shaped front/back.
    // Coplanar boolean fragments inflate this to fourteen faces and render
    // false seams in the shaded-with-edges viewport.
    expect(body?.faceCount).toBe(8);

    const step = await adapter.exportStep(document, [resultId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('diagnoses a disconnected BrepKit union without rewriting legacy history', async () => {
    const withLower = addPrimitiveFeature(
      createProjectDocument('Separated union', toUserId('user_exact')),
      {
        name: 'Lower',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const lowerId = withLower.bodyOrder.at(-1)!;
    const withUpper = addPrimitiveFeature(withLower, {
      name: 'Upper',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const upperId = withUpper.bodyOrder.at(-1)!;
    const positioned = transformBody(withUpper, {
      name: 'Leave a gap',
      targetBodyId: upperId,
      translation: { x: 0, y: 0, z: 12 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Separated union',
        operation: 'union',
        targetBodyIds: [lowerId, upperId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    expect(derived.warnings).toContain(
      'Feature "Separated union": Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
    expect(derived.bodyRepresentations[resultId]?.volume).toBeCloseTo(2000, 4);
    expect(derived.bodyRepresentations[lowerId]?.consumed).toBe(true);
    expect(derived.bodyRepresentations[upperId]?.consumed).toBe(true);
  });

  it('diagnoses the same disconnected union through the OCCT route', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Source box', toUserId('user_exact')),
      {
        name: 'Source box',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const importManager = new CommandManager(
      createProjectDocument('OCCT separated union', toUserId('user_exact'))
    );
    const imported = importManager.execute(
      commandFactories.importStep({
        name: 'Imported lower',
        artifactId: 'artifact_union_gap',
        sourceName: 'lower.step',
        stepText: step
      })
    );
    const lowerId = imported.bodyOrder.at(-1)!;
    const withUpper = addPrimitiveFeature(imported, {
      name: 'Upper',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    const upperId = withUpper.bodyOrder.at(-1)!;
    const positioned = transformBody(withUpper, {
      name: 'Leave a gap',
      targetBodyId: upperId,
      translation: { x: 0, y: 0, z: 12 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'OCCT separated union',
        operation: 'union',
        targetBodyIds: [lowerId, upperId]
      })
    );

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toContain(
      'Feature "OCCT separated union": Union does not fill empty space. The selected solids form 2 disconnected groups. The closest gap is 2 mm. Move or extend a body until every solid touches or overlaps.'
    );
  });

  it('keeps a coaxial cylinder cut as smooth analytic B-rep surfaces', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Bottle cap', toUserId('user_exact')),
      {
        name: 'Cap outer',
        primitiveKind: 'cylinder',
        dimensions: { radius: 32.9, height: 25 }
      }
    );
    const outer = withOuter.bodyOrder.at(-1)!;
    const withCavity = addPrimitiveFeature(withOuter, {
      name: 'Cap cavity',
      primitiveKind: 'cylinder',
      dimensions: { radius: 30.4, height: 21.5 }
    });
    const cavity = withCavity.bodyOrder.at(-1)!;
    const positioned = transformBody(withCavity, {
      name: 'Position cap cavity',
      targetBodyId: cavity,
      translation: { x: 0, y: 0, z: 3.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Water bottle bottom cap',
        operation: 'subtract',
        targetBodyIds: [outer, cavity]
      })
    );

    const derived = await adapter.syncDocument(document);
    const resultId = document.bodyOrder.at(-1)!;
    const body = derived.bodyRepresentations[resultId];
    const expectedVolume =
      Math.PI * 32.9 ** 2 * 25 - Math.PI * 30.4 ** 2 * 21.5;

    expect(derived.warnings).toEqual([]);
    expect(body?.faceCount).toBe(5);
    expect(body?.topology?.edges).toHaveLength(6);
    expect(body?.volume).toBeCloseTo(expectedVolume, 4);

    const step = await adapter.exportStep(document, [resultId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    expect(step.match(/ADVANCED_FACE/g)).toHaveLength(5);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('extrudes a detected ring region with its hole as exact geometry', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ring sketch', toUserId('user_exact')),
      {
        name: 'Ring profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 63, centerX: 0, centerY: 0 },
          { objectKind: 'circle', radius: 40, centerX: 0, centerY: 0 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const regions = computeSketchRegions(objects, resolve);
    const ring = regions.find((region) => region.holes.length === 1)!;
    expect(ring).toBeTruthy();

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Ring extrude',
      sketchId,
      distance: 10,
      profile: {
        regionFingerprint: ring.regionFingerprint,
        samplePoint: ring.samplePoint,
        sourceArea: ring.area
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    // Tessellated volume of a curved ring carries deflection error; assert
    // within 0.5% of the analytic value.
    const expectedVolume = Math.PI * (63 ** 2 - 40 ** 2) * 10;
    expect(
      Math.abs((body?.volume ?? 0) - expectedVolume) / expectedVolume
    ).toBeLessThan(0.005);
    // Two cylindrical walls + two annular caps.
    expect(body?.faceCount).toBe(4);

    const step = await adapter.exportStep(document, [bodyId]);
    expect(step.match(/CYLINDRICAL_SURFACE/g)).toHaveLength(2);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('fuses adjacent selected cells without an internal wall', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Overlapping cells', toUserId('user_exact')),
      {
        name: 'Overlapping circles',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 10, centerX: -5, centerY: 0 },
          { objectKind: 'circle', radius: 10, centerX: 5, centerY: 0 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const profiles = computeSketchRegions(objects, resolve);
    const left = profiles.find((profile) =>
      profileContainsPoint(profile, { x: -8, y: 0 })
    )!;
    const lens = profiles.find((profile) =>
      profileContainsPoint(profile, { x: 0, y: 0 })
    )!;
    const reference = (profile: (typeof profiles)[number]) => ({
      profileId: profile.profileId,
      regionFingerprint: profile.regionFingerprint,
      samplePoint: profile.samplePoint,
      sourceArea: profile.area,
      sourceEntityIds: profile.sourceEntityIds
    });

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Merged cells',
      sketchId,
      distance: 7,
      profiles: [reference(left), reference(lens)]
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    expect(body?.volume).toBeCloseTo(Math.PI * 10 ** 2 * 7, 0);
    // The curved wall remains split at the source-circle intersections, but
    // there are exactly two planar caps and no planar wall at the canceled
    // arrangement edge.
    const surfaceTypes =
      body?.topology?.faces.map((face) => face.geometry?.surfaceType) ?? [];
    expect(surfaceTypes.filter((surface) => surface === 'plane')).toHaveLength(
      2
    );
    expect(
      surfaceTypes.filter((surface) => surface === 'cylinder')
    ).toHaveLength(5);
  });

  it('remaps a profile reference through a parametric source-curve edit', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Parametric profile', toUserId('user_exact')),
      {
        name: 'Editable disk',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objectId = sketch.objectIds[0]!;
    const profile = computeSketchRegions(
      sketch.objectIds.flatMap((id) => {
        const node = withSketch.nodes[id];
        return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
      }),
      resolve
    )[0]!;
    const { document: extruded, bodyId } = extrudeSketch(withSketch, {
      name: 'Parametric disk extrude',
      sketchId,
      distance: 5,
      profiles: [
        {
          profileId: profile.profileId,
          regionFingerprint: profile.regionFingerprint,
          samplePoint: profile.samplePoint,
          sourceArea: profile.area,
          sourceEntityIds: profile.sourceEntityIds
        }
      ]
    });
    const edited = updateSketchObject(extruded, {
      sketchId,
      objectId,
      data: {
        objectKind: 'circle',
        radius: 20,
        centerX: 0,
        centerY: 0
      }
    });

    const derived = await adapter.syncDocument(edited);
    expect(derived.warnings).toEqual([]);
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 20 ** 2 * 5,
      0
    );
  });

  it('extrudes a chord-split region and resolves by fallback when the fingerprint drifts', async () => {
    const resolve = (value: ParamValue): number =>
      typeof value === 'number' ? value : Number(value);
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Split disk', toUserId('user_exact')),
      {
        name: 'Split profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          { objectKind: 'circle', radius: 20, centerX: 0, centerY: 0 },
          { objectKind: 'line', x1: -30, y1: 5, x2: 30, y2: 5 }
        ]
      }
    );
    const sketch = findSketch(withSketch, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = withSketch.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const regions = computeSketchRegions(objects, resolve);
    expect(regions).toHaveLength(2);
    const major = regions[0]!; // sorted largest-first

    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Major piece',
      sketchId,
      distance: 8,
      profile: {
        // Deliberately wrong fingerprint: the fallback (sample point inside
        // + area within 1%) must resolve it.
        regionFingerprint: major.regionFingerprint + 1,
        samplePoint: major.samplePoint,
        sourceArea: major.area
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId];
    const expectedVolume = major.area * 8;
    expect(
      Math.abs((body?.volume ?? 0) - expectedVolume) / expectedVolume
    ).toBeLessThan(0.005);

    const step = await adapter.exportStep(document, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('fails closed when a referenced region no longer exists', async () => {
    const { document: withSketch, sketchId } = addSketchFeature(
      createProjectDocument('Ghost region', toUserId('user_exact')),
      {
        name: 'Disk profile',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [{ objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }]
      }
    );
    const { document, bodyId } = extrudeSketch(withSketch, {
      name: 'Ghost extrude',
      sketchId,
      distance: 5,
      profile: {
        regionFingerprint: 123456789,
        samplePoint: { x: 500, y: 500 },
        sourceArea: 42
      }
    });
    const derived = await adapter.syncDocument(document);
    expect(
      derived.warnings.some((warning) =>
        warning.includes('Broken profile reference')
      )
    ).toBe(true);
    expect(derived.bodyRepresentations[bodyId]).toBeUndefined();
  });

  it('offsets a planar face outward and inward as a direct edit', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Offset target', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(base);
    const body = Object.values(derived.bodyRepresentations)[0];
    const topFace = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99
    );
    expect(topFace).toBeTruthy();

    const outward = directEditBody(base, {
      name: 'Raise top face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: topFace!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: topFace!.geometry!.area,
        sourceCenter: topFace!.geometry!.center,
        sourceNormal: topFace!.geometry!.normal!,
        offset: 5
      }
    }).document;
    const raised = await adapter.syncDocument(outward);
    expect(raised.warnings).toEqual([]);
    const raisedBody = raised.bodyRepresentations[bodyId];
    expect(raisedBody?.volume).toBeCloseTo(10 * 20 * 35, 4);
    // A clean offset keeps the box a box.
    expect(raisedBody?.faceCount).toBe(6);

    const inward = directEditBody(base, {
      name: 'Sink top face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: topFace!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: topFace!.geometry!.area,
        sourceCenter: topFace!.geometry!.center,
        sourceNormal: topFace!.geometry!.normal!,
        offset: -5
      }
    }).document;
    const sunk = await adapter.syncDocument(inward);
    expect(sunk.warnings).toEqual([]);
    expect(sunk.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );

    const step = await adapter.exportStep(outward, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('fails closed when the offset face fingerprint no longer resolves', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Stale face', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    const stale = directEditBody(base, {
      name: 'Offset a ghost face',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: 987654321,
        sourceSurfaceType: 'plane',
        sourceArea: 300,
        sourceCenter: { x: 0, y: 0, z: 0 },
        sourceNormal: { x: 0, y: 0, z: 1 },
        offset: 5
      }
    }).document;
    const derived = await adapter.syncDocument(stale);
    expect(
      derived.warnings.some((warning) => warning.includes('no longer exists'))
    ).toBe(true);
    // The target body still builds at its original size.
    expect(derived.bodyRepresentations[bodyId]?.volume).toBeCloseTo(6000, 4);
  });

  it('resizes a cylindrical bore as a direct edit', async () => {
    const withBlock = addPrimitiveFeature(
      createProjectDocument('Bore resize', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 40, depth: 10 }
      }
    );
    const blockId = withBlock.bodyOrder.at(-1)!;
    const withDrill = addPrimitiveFeature(withBlock, {
      name: 'Drill',
      primitiveKind: 'cylinder',
      dimensions: { radius: 3, height: 10 }
    });
    const drillId = withDrill.bodyOrder.at(-1)!;
    const positioned = transformBody(withDrill, {
      name: 'Center drill',
      targetBodyId: drillId,
      translation: { x: 20, y: 20, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(positioned);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Drilled block',
        operation: 'subtract',
        targetBodyIds: [blockId, drillId]
      })
    );
    const resultId = document.bodyOrder.at(-1)!;

    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[resultId];
    const bore = body?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(bore?.geometry?.radius).toBeCloseTo(3, 4);
    expect(bore?.geometry?.axisStart).toBeTruthy();

    const resized = directEditBody(document, {
      name: 'Widen bore',
      targetBodyId: resultId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: bore!.hash,
        sourceRadius: bore!.geometry!.radius!,
        sourceAxisStart: bore!.geometry!.axisStart!,
        sourceAxisEnd: bore!.geometry!.axisEnd!,
        concavity: 'hole',
        radius: 5
      }
    }).document;
    const widened = await adapter.syncDocument(resized);
    expect(widened.warnings).toEqual([]);
    // Volume is measured from the tessellation, so allow its deflection error.
    expect(widened.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 25 * 10,
      0
    );
    // Rebuilds resolve the widened bore deterministically.
    const again = await adapter.syncDocument(resized);
    expect(again.warnings).toEqual([]);
    expect(again.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      widened.bodyRepresentations[resultId]!.volume,
      6
    );
    // The widened bore stays one analytic cylindrical face.
    const widenedFaces = widened.bodyRepresentations[resultId]?.topology?.faces;
    const widenedBore = widenedFaces?.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(widenedBore).toHaveLength(1);
    expect(widenedBore?.[0]?.geometry?.radius).toBeCloseTo(5, 4);

    // Moving the wall back inward sweeps the annular sleeve between the two
    // radii through material that is already there. The kernel builds that
    // tube itself, so shrinking goes through the same call as growing.
    const shrunkDoc = directEditBody(resized, {
      name: 'Shrink bore',
      targetBodyId: resultId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: widenedBore![0]!.hash,
        sourceRadius: widenedBore![0]!.geometry!.radius!,
        sourceAxisStart: widenedBore![0]!.geometry!.axisStart!,
        sourceAxisEnd: widenedBore![0]!.geometry!.axisEnd!,
        concavity: 'hole',
        radius: 4
      }
    }).document;
    const shrunk = await adapter.syncDocument(shrunkDoc);
    expect(shrunk.warnings).toEqual([]);
    expect(shrunk.bodyRepresentations[resultId]?.volume).toBeCloseTo(
      40 * 40 * 10 - Math.PI * 16 * 10,
      0
    );
    // The narrowed wall is one analytic cylinder at the new radius, not the
    // old wall left in place and not a ring of planar strips.
    const shrunkBore = shrunk.bodyRepresentations[
      resultId
    ]?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(shrunkBore).toHaveLength(1);
    expect(shrunkBore?.[0]?.geometry?.radius).toBeCloseTo(4, 4);

    // Composing the resize from booleans used to leave a solid that OCCT
    // rejected on import, so this body could only be checked in-app. The
    // native op's own closed-shell gate makes it exportable.
    const step = await adapter.exportStep(shrunkDoc, [resultId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('grows and shrinks a free-standing boss', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Boss resize', toUserId('user_exact')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 12, height: 15 }
      }
    );
    const bossId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const wall = derived.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall?.geometry?.radius).toBeCloseTo(12, 4);
    const resize = (radius: number) =>
      directEditBody(document, {
        name: 'Resize boss',
        targetBodyId: bossId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall!.hash,
          sourceRadius: wall!.geometry!.radius!,
          sourceAxisStart: wall!.geometry!.axisStart!,
          sourceAxisEnd: wall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;

    const grown = await adapter.syncDocument(resize(15));
    expect(grown.warnings).toEqual([]);
    const body = grown.bodyRepresentations[bossId];
    expect(body?.volume).toBeCloseTo(Math.PI * 225 * 15, 0);
    // The grown wall is one analytic cylinder, not a ring of boolean strips.
    const walls = body?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(walls).toHaveLength(1);
    expect(walls?.[0]?.geometry?.radius).toBeCloseTo(15, 4);

    const shrunk = await adapter.syncDocument(resize(9));
    expect(shrunk.warnings).toEqual([]);
    const shrunkBody = shrunk.bodyRepresentations[bossId];
    expect(shrunkBody?.volume).toBeCloseTo(Math.PI * 81 * 15, 0);
    const shrunkWalls = shrunkBody?.topology?.faces.filter(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(shrunkWalls).toHaveLength(1);
    expect(shrunkWalls?.[0]?.geometry?.radius).toBeCloseTo(9, 4);

    // Resizing to the radius the wall is already at leaves no sleeve to
    // sweep, so it is rejected rather than kept as a feature that does
    // nothing.
    const unchanged = await adapter.syncDocument(resize(12));
    expect(
      unchanged.warnings.some((warning) =>
        warning.includes('Radius must differ from the current radius')
      )
    ).toBe(true);
    expect(unchanged.bodyRepresentations[bossId]?.volume).toBeCloseTo(
      derived.bodyRepresentations[bossId]!.volume,
      6
    );
  });

  it('keeps small, large, and transformed radius edits as exact cylinders', async () => {
    const cases: Array<{
      name: string;
      sourceRadius: number;
      targetRadius: number;
      height: number;
      transform?: {
        translation: { x: number; y: number; z: number };
        rotationDeg: { x: number; y: number; z: number };
      };
    }> = [
      {
        name: 'very small',
        sourceRadius: 0.00002,
        targetRadius: 0.00003,
        height: 0.00008
      },
      {
        name: 'very large',
        sourceRadius: 2_000_000,
        targetRadius: 3_500_000,
        height: 4_000_000
      },
      {
        name: 'transformed',
        sourceRadius: 6,
        targetRadius: 9.5,
        height: 24,
        transform: {
          translation: { x: 41, y: -17, z: 23 },
          rotationDeg: { x: 35, y: 20, z: 15 }
        }
      }
    ];

    for (const testCase of cases) {
      const base = addPrimitiveFeature(
        createProjectDocument(
          `${testCase.name} cylinder`,
          toUserId(`user_${testCase.name.replace(' ', '_')}`)
        ),
        {
          name: 'Post',
          primitiveKind: 'cylinder',
          dimensions: {
            radius: testCase.sourceRadius,
            height: testCase.height
          }
        }
      );
      const bodyId = base.bodyOrder.at(-1)!;
      const document = testCase.transform
        ? transformBody(base, {
            name: 'Place post',
            targetBodyId: bodyId,
            ...testCase.transform
          }).document
        : base;

      const source = await adapter.syncDocument(document);
      expect(source.warnings).toEqual([]);
      const sourceWall = source.bodyRepresentations[
        bodyId
      ]?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      expect(sourceWall?.geometry?.radius).toBeCloseTo(
        testCase.sourceRadius,
        10
      );

      const edited = directEditBody(document, {
        name: 'Resize post',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: sourceWall!.hash,
          sourceRadius: sourceWall!.geometry!.radius!,
          sourceAxisStart: sourceWall!.geometry!.axisStart!,
          sourceAxisEnd: sourceWall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius: testCase.targetRadius
        }
      }).document;
      const resized = await adapter.syncDocument(edited);
      expect(resized.warnings).toEqual([]);

      const body = resized.bodyRepresentations[bodyId]!;
      const walls =
        body.topology?.faces.filter(
          (face) => face.geometry?.surfaceType === 'cylinder'
        ) ?? [];
      expect(body.faceCount).toBe(3);
      expect(walls).toHaveLength(1);
      expect(walls[0]!.geometry!.radius! / testCase.targetRadius).toBeCloseTo(
        1,
        10
      );
      expect(
        body.volume /
          (Math.PI *
            testCase.targetRadius *
            testCase.targetRadius *
            testCase.height)
      ).toBeCloseTo(1, 3);

      const sourceStart = sourceWall!.geometry!.axisStart!;
      const sourceEnd = sourceWall!.geometry!.axisEnd!;
      const resizedStart = walls[0]!.geometry!.axisStart!;
      const resizedEnd = walls[0]!.geometry!.axisEnd!;
      const pointDistance = (
        left: { x: number; y: number; z: number },
        right: { x: number; y: number; z: number }
      ) =>
        Math.hypot(
          left.x - right.x,
          left.y - right.y,
          left.z - right.z
        );
      const aligned = Math.max(
        pointDistance(sourceStart, resizedStart),
        pointDistance(sourceEnd, resizedEnd)
      );
      const reversed = Math.max(
        pointDistance(sourceStart, resizedEnd),
        pointDistance(sourceEnd, resizedStart)
      );
      const axisTolerance =
        Math.max(
          testCase.sourceRadius,
          testCase.targetRadius,
          testCase.height
        ) * 1e-7;
      expect(Math.min(aligned, reversed)).toBeLessThanOrEqual(axisTolerance);

      const step = await adapter.exportStep(edited, [bodyId]);
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  });

  it('offsets a cylinder cap after repeated radius edits', async () => {
    let document = addPrimitiveFeature(
      createProjectDocument('Edited cylinder cap', toUserId('user_exact')),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 12, height: 30.25 }
      }
    );
    const bodyId = document.bodyOrder.at(-1)!;

    for (const radius of [9, 13, 8, 10, 5.5, 6.5]) {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const wall = derived.bodyRepresentations[bodyId]?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      expect(wall).toBeTruthy();
      document = directEditBody(document, {
        name: 'Resize boss',
        targetBodyId: bodyId,
        operation: {
          kind: 'resize-cylindrical-face',
          faceHash: wall!.hash,
          sourceRadius: wall!.geometry!.radius!,
          sourceAxisStart: wall!.geometry!.axisStart!,
          sourceAxisEnd: wall!.geometry!.axisEnd!,
          concavity: 'boss',
          radius
        }
      }).document;
    }

    const resized = await adapter.syncDocument(document);
    expect(resized.warnings).toEqual([]);
    const body = resized.bodyRepresentations[bodyId];
    expect(body?.volume).toBeCloseTo(Math.PI * 6.5 * 6.5 * 30.25, 0);
    const top = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.99
    );
    expect(top).toBeTruthy();

    const offset = directEditBody(document, {
      name: 'Lower top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top!.hash,
        sourceSurfaceType: 'plane',
        sourceArea: top!.geometry!.area,
        sourceCenter: top!.geometry!.center,
        sourceNormal: top!.geometry!.normal!,
        offset: -4.5
      }
    }).document;
    const lowered = await adapter.syncDocument(offset);
    expect(lowered.warnings).toEqual([]);
    expect(lowered.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 6.5 * 6.5 * (30.25 - 4.5),
      0
    );
    expect(lowered.bodyRepresentations[bodyId]?.faceCount).toBe(3);
    const step = await adapter.exportStep(offset, [bodyId]);
    await expect(adapter.inspectStep(step)).resolves.toMatchObject({
      solid: true,
      valid: true
    });
  });

  it('offsets both caps of a transformed analytic cylinder', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument(
        'Transformed cylinder caps',
        toUserId('user_exact')
      ),
      {
        name: 'Post',
        primitiveKind: 'cylinder',
        dimensions: { radius: 6, height: 20 }
      }
    );
    const bodyId = base.bodyOrder.at(-1)!;
    let document = transformBody(base, {
      name: 'Place post',
      targetBodyId: bodyId,
      translation: { x: 4, y: -3, z: 8 },
      rotationDeg: { x: 35, y: 20, z: 15 }
    }).document;

    const capAlongAxis = async (direction: 1 | -1) => {
      const derived = await adapter.syncDocument(document);
      expect(derived.warnings).toEqual([]);
      const body = derived.bodyRepresentations[bodyId];
      const wall = body?.topology?.faces.find(
        (face) => face.geometry?.surfaceType === 'cylinder'
      );
      const start = wall!.geometry!.axisStart!;
      const end = wall!.geometry!.axisEnd!;
      const axisLength = Math.hypot(
        end.x - start.x,
        end.y - start.y,
        end.z - start.z
      );
      const axis = {
        x: (end.x - start.x) / axisLength,
        y: (end.y - start.y) / axisLength,
        z: (end.z - start.z) / axisLength
      };
      return body!.topology!.faces.find((face) => {
        const normal = face.geometry?.normal;
        return (
          face.geometry?.surfaceType === 'plane' &&
          normal !== undefined &&
          Math.abs(
            normal.x * axis.x +
              normal.y * axis.y +
              normal.z * axis.z -
              direction
          ) < 1e-6
        );
      })!;
    };

    const top = await capAlongAxis(1);
    document = directEditBody(document, {
      name: 'Raise top',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: top.hash,
        sourceSurfaceType: 'plane',
        sourceArea: top.geometry!.area,
        sourceCenter: top.geometry!.center,
        sourceNormal: top.geometry!.normal!,
        offset: 3
      }
    }).document;

    const bottom = await capAlongAxis(-1);
    document = directEditBody(document, {
      name: 'Lower bottom',
      targetBodyId: bodyId,
      operation: {
        kind: 'offset-face',
        faceHash: bottom.hash,
        sourceSurfaceType: 'plane',
        sourceArea: bottom.geometry!.area,
        sourceCenter: bottom.geometry!.center,
        sourceNormal: bottom.geometry!.normal!,
        offset: 2
      }
    }).document;

    const expanded = await adapter.syncDocument(document);
    expect(expanded.warnings).toEqual([]);
    expect(expanded.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      Math.PI * 6 * 6 * 25,
      0
    );
    expect(expanded.bodyRepresentations[bodyId]?.faceCount).toBe(3);
  });

  it('grows a boss fused into a plate', async () => {
    // A boss fused into a plate puts the union tool against a coaxial
    // cylindrical face. The kernel used to hand back the original solid —
    // valid, but unchanged — and only the adapter's read-back guard caught
    // it. brepkit 2.129.0 grows the wall natively, so the edit now lands.
    // The guard itself still matters and is exercised by the shrink cases
    // above, which continue to fail closed.
    const plate = addPrimitiveFeature(
      createProjectDocument('Fused boss', toUserId('user_exact')),
      {
        name: 'Plate',
        primitiveKind: 'box',
        dimensions: { width: 60, height: 60, depth: 8 }
      }
    );
    const plateId = plate.bodyOrder.at(-1)!;
    const withPost = addPrimitiveFeature(plate, {
      name: 'Post',
      primitiveKind: 'cylinder',
      dimensions: { radius: 12, height: 15 }
    });
    const postId = withPost.bodyOrder.at(-1)!;
    const placed = transformBody(withPost, {
      name: 'Center post',
      targetBodyId: postId,
      translation: { x: 30, y: 30, z: 8 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const manager = new CommandManager(placed);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Plate with boss',
        operation: 'union',
        targetBodyIds: [plateId, postId]
      })
    );
    const bossId = document.bodyOrder.at(-1)!;
    const derived = await adapter.syncDocument(document);
    const wall = derived.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(wall?.geometry?.radius).toBeCloseTo(12, 4);

    const grownDoc = directEditBody(document, {
      name: 'Resize boss',
      targetBodyId: bossId,
      operation: {
        kind: 'resize-cylindrical-face',
        faceHash: wall!.hash,
        sourceRadius: wall!.geometry!.radius!,
        sourceAxisStart: wall!.geometry!.axisStart!,
        sourceAxisEnd: wall!.geometry!.axisEnd!,
        concavity: 'boss',
        radius: 15
      }
    }).document;
    const grown = await adapter.syncDocument(grownDoc);
    expect(grown.warnings).toEqual([]);

    // The post stands on the plate rather than inside it, so the body is the
    // plate plus a full cylinder: 60*60*8 + pi*r^2*15. Growing r from 12 to
    // 15 takes it from ~35586 to ~39403. Volume is measured from the
    // tessellation, whose inscribed mesh under-reports a cylinder, so compare
    // against the exact figure with a relative tolerance rather than a fixed
    // number of digits — the absolute error scales with the cylinder.
    const plateVolume = 60 * 60 * 8;
    const nearExactly = (actual: number | undefined, exact: number): void => {
      expect(actual).toBeDefined();
      expect(Math.abs(actual! - exact) / exact).toBeLessThan(1e-3);
    };
    nearExactly(
      derived.bodyRepresentations[bossId]?.volume,
      plateVolume + Math.PI * 12 * 12 * 15
    );
    nearExactly(
      grown.bodyRepresentations[bossId]?.volume,
      plateVolume + Math.PI * 15 * 15 * 15
    );

    // The wall itself must read back at the new radius, not merely enclose
    // more volume.
    const grownWall = grown.bodyRepresentations[bossId]?.topology?.faces.find(
      (face) => face.geometry?.surfaceType === 'cylinder'
    );
    expect(grownWall?.geometry?.radius).toBeCloseTo(15, 4);
  });

  it('imports STEP through OCCT with complete exact topology', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Source', toUserId('user_exact')),
      {
        name: 'Source box',
        primitiveKind: 'box',
        dimensions: { width: 7, height: 8, depth: 9 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);
    const base = createProjectDocument('Import', toUserId('user_exact'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported box',
        artifactId: 'artifact_test',
        sourceName: 'box.step',
        stepText: step
      })
    );

    const derived = await adapter.syncDocument(manager.document);
    const body = Object.values(derived.bodyRepresentations)[0];
    expect(body?.source).toBe('imported-step');
    expect(body?.volume).toBeCloseTo(504, 4);
    expect(body?.topology?.faces).toHaveLength(6);
    expect(
      body?.topology?.faces.reduce(
        (total, face) => total + face.triangleCount,
        0
      )
    ).toBe((body?.mesh.indices.length ?? 0) / 3);
    expect(body?.topology?.edges).toHaveLength(12);
    expect(derived.warnings).toEqual([]);

    const moved = transformBody(manager.document, {
      name: 'Move imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      translation: { x: 5, y: 6, z: 7 },
      rotationDeg: { x: 0, y: 0, z: 0 }
    }).document;
    const movedBody = Object.values(
      (await adapter.syncDocument(moved)).bodyRepresentations
    )[0];
    expect(movedBody?.bbox.min.x).toBeCloseTo(5, 6);
    expect(movedBody?.bbox.min.y).toBeCloseTo(6, 6);
    expect(movedBody?.bbox.min.z).toBeCloseTo(7, 6);
    expect(movedBody?.volume).toBeCloseTo(504, 4);

    const importedEdgeHash = body?.topology?.edges[0]?.hash;
    expect(importedEdgeHash).toBeTypeOf('number');
    const filleted = filletEdges(manager.document, {
      name: 'Fillet imported STEP',
      targetBodyId: manager.document.bodyOrder[0]!,
      edgeHashes: [importedEdgeHash!],
      size: 0.5
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    expect(filletDerived.warnings).toEqual([]);
    expect(
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!]?.volume
    ).toBeLessThan(504);
    expect(manager.document.commandLog[0]?.kind).toBe('import.step');
  });

  it('measures and resizes an imported exact through hole in both directions', async () => {
    const withOuter = addPrimitiveFeature(
      createProjectDocument('Through-hole source', toUserId('user_exact')),
      {
        name: 'Outer cylinder',
        primitiveKind: 'cylinder',
        dimensions: { radius: 15, height: 10 }
      }
    );
    const outerId = withOuter.bodyOrder.at(-1)!;
    const withTool = addPrimitiveFeature(withOuter, {
      name: 'Hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 4, height: 20 }
    });
    const toolId = withTool.bodyOrder.at(-1)!;
    const positioned = transformBody(withTool, {
      name: 'Pass tool through part',
      targetBodyId: toolId,
      translation: { x: 0, y: 0, z: -5 }
    }).document;
    const sourceManager = new CommandManager(positioned);
    const source = sourceManager.execute(
      commandFactories.booleanBodies({
        name: 'Tube',
        operation: 'subtract',
        targetBodyIds: [outerId, toolId]
      })
    );
    const sourceBodyId = source.bodyOrder.at(-1)!;
    const step = await adapter.exportStep(source, [sourceBodyId]);

    const base = createProjectDocument('Direct edit', toUserId('user_exact'));
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported tube',
        artifactId: 'artifact_through_hole',
        sourceName: 'tube.step',
        stepText: step
      })
    );
    const importedBodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const recognizedHoles = imported.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.filter(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    const hole = imported.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );

    expect(recognizedHoles).toHaveLength(1);
    expect(hole?.geometry).toMatchObject({
      surfaceType: 'cylinder',
      radius: 4,
      diameter: 8,
      axialLength: 10,
      editableDimension: 'diameter'
    });
    expect(hole?.geometry?.area).toBeCloseTo(Math.PI * 8 * 10, 4);

    manager.execute(
      commandFactories.directEditBody({
        name: 'Resize through hole',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: hole!.hash,
          sourceDiameter: 8,
          sourceAxisStart: hole!.geometry!.axisStart!,
          sourceAxisEnd: hole!.geometry!.axisEnd!,
          diameter: 12
        }
      })
    );
    const enlarged = await adapter.syncDocument(manager.document);
    const enlargedBody = enlarged.bodyRepresentations[importedBodyId]!;
    const enlargedHole = enlargedBody.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    expect(enlarged.warnings).toEqual([]);
    expect(enlargedHole?.geometry?.diameter).toBeCloseTo(12, 6);
    expect(enlargedBody.volume).toBeCloseTo(
      Math.PI * (15 ** 2 - 6 ** 2) * 10,
      4
    );

    manager.execute(
      commandFactories.directEditBody({
        name: 'Shrink through hole',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: enlargedHole!.hash,
          sourceDiameter: 12,
          sourceAxisStart: enlargedHole!.geometry!.axisStart!,
          sourceAxisEnd: enlargedHole!.geometry!.axisEnd!,
          diameter: 4
        }
      })
    );
    const shrunk = await adapter.syncDocument(manager.document);
    const shrunkBody = shrunk.bodyRepresentations[importedBodyId]!;
    const shrunkHole = shrunkBody.topology?.faces.find(
      (face) => face.geometry?.featureType === 'through-hole'
    );
    expect(shrunk.warnings).toEqual([]);
    expect(shrunkHole?.geometry?.diameter).toBeCloseTo(4, 6);
    expect(shrunkBody.volume).toBeCloseTo(Math.PI * (15 ** 2 - 2 ** 2) * 10, 4);

    const editedStep = await adapter.exportStep(manager.document, [
      importedBodyId
    ]);
    await expect(adapter.inspectStep(editedStep)).resolves.toMatchObject({
      solid: true,
      valid: true
    });

    manager.execute(
      commandFactories.directEditBody({
        name: 'Remove imported feature',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'remove-face-feature',
          faceHash: shrunkHole!.hash,
          sourceSurfaceType: 'cylinder',
          sourceArea: shrunkHole!.geometry!.area,
          sourceCenter: shrunkHole!.geometry!.center,
          sourceDiameter: 4,
          sourceAxisStart: shrunkHole!.geometry!.axisStart,
          sourceAxisEnd: shrunkHole!.geometry!.axisEnd
        }
      })
    );
    const removed = await adapter.syncDocument(manager.document);
    const removedBody = removed.bodyRepresentations[importedBodyId]!;
    expect(removed.warnings).toEqual([]);
    expect(removedBody.volume).toBeCloseTo(Math.PI * 15 ** 2 * 10, 4);
    expect(removedBody.faceCount).toBe(3);
    expect(
      removedBody.topology?.faces.some(
        (face) => face.geometry?.featureType === 'through-hole'
      )
    ).toBe(false);

    manager.undo();
    const restored = await adapter.syncDocument(manager.document);
    expect(
      restored.bodyRepresentations[importedBodyId]?.topology?.faces.find(
        (face) => face.geometry?.featureType === 'through-hole'
      )?.geometry?.diameter
    ).toBeCloseTo(4, 6);
    expect(
      manager.document.commandLog.slice(-2).map((entry) => entry.kind)
    ).toEqual(['feature.direct-edit', 'feature.direct-edit']);

    manager.execute(
      commandFactories.directEditBody({
        name: 'Mismatched topology edit',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'resize-through-hole',
          faceHash: shrunkHole!.hash,
          sourceDiameter: 4,
          sourceAxisStart: {
            ...shrunkHole!.geometry!.axisStart!,
            x: shrunkHole!.geometry!.axisStart!.x + 1
          },
          sourceAxisEnd: shrunkHole!.geometry!.axisEnd!,
          diameter: 6
        }
      })
    );
    const mismatched = await adapter.syncDocument(manager.document);
    expect(mismatched.warnings).toContain(
      'Feature "Mismatched topology edit": Selected face no longer matches its recorded hole axis.'
    );
    expect(mismatched.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      Math.PI * (15 ** 2 - 2 ** 2) * 10,
      4
    );
  });

  it('offsets a planar face of an imported STEP body in both directions', async () => {
    const source = addPrimitiveFeature(
      createProjectDocument('Offset source', toUserId('user_exact')),
      {
        name: 'Beam',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 20, depth: 30 }
      }
    );
    const step = await adapter.exportStep(source, [source.bodyOrder[0]!]);

    const base = createProjectDocument(
      'Imported offset',
      toUserId('user_exact')
    );
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Imported beam',
        artifactId: 'artifact_offset_face',
        sourceName: 'beam.step',
        stepText: step
      })
    );
    const importedBodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const importedBody = imported.bodyRepresentations[importedBodyId];
    expect(importedBody?.volume).toBeCloseTo(6000, 4);
    // The box is corner-origin, so the top face's center sits at z = depth.
    const topFace = importedBody?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 30) < 1e-6
    );
    expect(topFace).toBeTruthy();
    expect(topFace?.geometry?.area).toBeCloseTo(200, 4);

    manager.execute(
      commandFactories.directEditBody({
        name: 'Raise imported top face',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: topFace!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: topFace!.geometry!.area,
          sourceCenter: topFace!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 5
        }
      })
    );
    const raised = await adapter.syncDocument(manager.document);
    const raisedBody = raised.bodyRepresentations[importedBodyId];
    expect(raised.warnings).toEqual([]);
    expect(raisedBody?.volume).toBeCloseTo(10 * 20 * 35, 4);
    // A clean offset keeps the box a box.
    expect(raisedBody?.faceCount).toBe(6);
    const raisedTop = raisedBody?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 35) < 1e-6
    );
    expect(raisedTop).toBeTruthy();

    manager.execute(
      commandFactories.directEditBody({
        name: 'Sink imported top face',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: raisedTop!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: raisedTop!.geometry!.area,
          sourceCenter: raisedTop!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: -10
        }
      })
    );
    const sunk = await adapter.syncDocument(manager.document);
    expect(sunk.warnings).toEqual([]);
    expect(sunk.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );

    const editedStep = await adapter.exportStep(manager.document, [
      importedBodyId
    ]);
    await expect(adapter.inspectStep(editedStep)).resolves.toMatchObject({
      solid: true,
      valid: true
    });

    // Cutting deeper than the body is tall would leave nothing; the volume
    // gate fails closed and the body keeps building at its prior size.
    const sunkTop = sunk.bodyRepresentations[
      importedBodyId
    ]?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs(face.geometry.center.z - 25) < 1e-6
    );
    expect(sunkTop).toBeTruthy();
    manager.execute(
      commandFactories.directEditBody({
        name: 'Sink past the floor',
        targetBodyId: importedBodyId,
        operation: {
          kind: 'offset-face',
          faceHash: sunkTop!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: sunkTop!.geometry!.area,
          sourceCenter: sunkTop!.geometry!.center,
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: -40
        }
      })
    );
    const overcut = await adapter.syncDocument(manager.document);
    expect(
      overcut.warnings.some((warning) =>
        warning.includes('does not produce a valid solid')
      )
    ).toBe(true);
    expect(overcut.bodyRepresentations[importedBodyId]?.volume).toBeCloseTo(
      10 * 20 * 25,
      4
    );
  });

  it('offsets a planar face on the dense sample bracket without unify breakage', async () => {
    // Regression: on this 821-face import, unifySameDomain after the prism
    // fuse produces a shape BRepCheck rejects; the offset must fall back to
    // the seamed-but-valid boolean result instead of failing the feature.
    const step = readFileSync(
      resolve('samples/parametric-bracket.step'),
      'utf8'
    );
    const base = createProjectDocument(
      'Bracket offset',
      toUserId('user_exact')
    );
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.importStep({
        name: 'Bracket',
        artifactId: 'artifact_bracket_offset',
        sourceName: 'parametric-bracket.step',
        stepText: step
      })
    );
    const bodyId = manager.document.bodyOrder[0]!;
    const imported = await adapter.syncDocument(manager.document);
    const body = imported.bodyRepresentations[bodyId];
    const volumeBefore = body?.volume ?? 0;
    const target = body?.topology?.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        Math.abs((face.geometry.area ?? 0) - 540) < 1
    );
    expect(target).toBeTruthy();

    manager.execute(
      commandFactories.directEditBody({
        name: 'Offset bracket face',
        targetBodyId: bodyId,
        operation: {
          kind: 'offset-face',
          faceHash: target!.hash,
          sourceSurfaceType: 'plane',
          sourceArea: target!.geometry!.area,
          sourceCenter: target!.geometry!.center,
          sourceNormal: { x: 0, y: -1, z: 0 },
          offset: 3
        }
      })
    );
    const edited = await adapter.syncDocument(manager.document);
    expect(edited.warnings).toEqual([]);
    expect(edited.bodyRepresentations[bodyId]?.volume).toBeCloseTo(
      volumeBefore + 3 * target!.geometry!.area,
      3
    );
  });

  it('builds selected-edge fillet and chamfer features', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Edge modifiers', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');
    expect(edgeHash).not.toBe(1);
    const repeated = await adapter.syncDocument(base);
    expect(
      Object.values(repeated.bodyRepresentations)[0]?.topology?.edges.map(
        (edge) => edge.hash
      )
    ).toEqual(
      Object.values(baseDerived.bodyRepresentations)[0]?.topology?.edges.map(
        (edge) => edge.hash
      )
    );

    const filleted = filletEdges(base, {
      name: 'Fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const filletDerived = await adapter.syncDocument(filleted);
    const filletBody =
      filletDerived.bodyRepresentations[filleted.bodyOrder.at(-1)!];
    expect(filletDerived.warnings).toEqual([]);
    expect(filletBody?.volume).toBeLessThan(8000);
    expect(filletBody?.faceCount).toBeGreaterThan(6);

    const chamfered = chamferEdges(base, {
      name: 'Chamfer',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 2
    }).document;
    const chamferDerived = await adapter.syncDocument(chamfered);
    const chamferBody =
      chamferDerived.bodyRepresentations[chamfered.bodyOrder.at(-1)!];
    expect(chamferDerived.warnings).toEqual([]);
    expect(chamferBody?.volume).toBeLessThan(8000);
    expect(chamferBody?.faceCount).toBeGreaterThan(6);
  });

  it('allows a fillet radius larger than half the selected edge length', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Short edge fillet', toUserId('user_exact')),
      {
        name: 'Shallow block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 5 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const baseBody = Object.values(baseDerived.bodyRepresentations)[0]!;
    const shortEdge = baseBody.topology?.edges.find((edge) => {
      const pointCount = edge.points.length;
      return (
        pointCount >= 6 &&
        Math.abs(
          Math.hypot(
            edge.points[pointCount - 3]! - edge.points[0]!,
            edge.points[pointCount - 2]! - edge.points[1]!,
            edge.points[pointCount - 1]! - edge.points[2]!
          ) - 5
        ) < 1e-6
      );
    });
    expect(shortEdge).toBeTruthy();

    const filleted = filletEdges(base, {
      name: 'Short-edge fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [shortEdge!.hash],
      size: 2.9
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(0);
    expect(body?.volume).toBeLessThan(baseBody.volume);
    expect(body?.bbox).toEqual(baseBody.bbox);
  });

  it('fillets all twelve original box edges in one exact feature', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('All-edge fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 18, depth: 24 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHashes = Object.values(
      baseDerived.bodyRepresentations
    )[0]?.topology?.edges.map((edge) => edge.hash);
    expect(edgeHashes).toHaveLength(12);

    const filleted = filletEdges(base, {
      name: 'All edges',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: edgeHashes!,
      size: 2
    }).document;
    const derived = await adapter.syncDocument(filleted);
    const body = derived.bodyRepresentations[filleted.bodyOrder.at(-1)!];

    expect(derived.warnings).toEqual([]);
    expect(body?.volume).toBeGreaterThan(0);
    expect(body?.volume).toBeLessThan(40 * 18 * 24);
    expect(body?.faceCount).toBeGreaterThan(6);
    expect(body?.bbox.min.x).toBeCloseTo(0, 1);
    expect(body?.bbox.min.y).toBeCloseTo(0, 1);
    expect(body?.bbox.min.z).toBeCloseTo(0, 1);
    expect(body?.bbox.max.x).toBeCloseTo(40, 1);
    expect(body?.bbox.max.y).toBeCloseTo(18, 1);
    expect(body?.bbox.max.z).toBeCloseTo(24, 1);

    const step = await adapter.exportStep(filleted, [
      filleted.bodyOrder.at(-1)!
    ]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection).toMatchObject({ solid: true, valid: true });
    // BrepKit's STEP reader reconstructs NURBS blend trims independently,
    // which can shift measured volume slightly while preserving a valid solid.
    expect(
      Math.abs(inspection.volume - body!.volume) / body!.volume
    ).toBeLessThan(0.01);
  });

  it('fillets an edge of an already-filleted body (sequential fillets)', async () => {
    // BrepKit can extend a second blend from most planar-adjacent edges. Edges
    // bounded entirely by an existing NURBS blend are reported as an
    // actionable failure instead of BrepKit's no-op fallback being accepted.
    const base = addPrimitiveFeature(
      createProjectDocument('Sequential fillets', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const firstEdgeHash = Object.values(baseDerived.bodyRepresentations)[0]
      ?.topology?.edges[0]?.hash;
    expect(firstEdgeHash).toBeTypeOf('number');

    const first = filletEdges(base, {
      name: 'First fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [firstEdgeHash!],
      size: 2
    }).document;
    const firstDerived = await adapter.syncDocument(first);
    const firstBodyId = first.bodyOrder.at(-1)!;
    const firstBody = firstDerived.bodyRepresentations[firstBodyId];
    expect(firstDerived.warnings).toEqual([]);
    expect(firstBody?.topology?.edges.length).toBeGreaterThan(12);

    // Fillet every edge of the filleted body one at a time. Successful convex
    // or concave blends may remove or add volume, but must produce a distinct,
    // positive solid. Unsupported blend-on-blend cases must fail cleanly.
    let succeeded = 0;
    let failed = 0;
    for (const edge of firstBody!.topology!.edges) {
      const second = filletEdges(first, {
        name: `Second fillet ${edge.hash}`,
        targetBodyId: firstBodyId,
        edgeHashes: [edge.hash],
        size: 2
      }).document;
      const derived = await adapter.syncDocument(second);
      if (derived.warnings.length === 0) {
        succeeded += 1;
        const body = derived.bodyRepresentations[second.bodyOrder.at(-1)!];
        expect(body?.volume).toBeGreaterThan(0);
        expect(body?.volume).not.toBeCloseTo(firstBody!.volume, 6);
      } else {
        failed += 1;
        // The failure must carry the actionable diagnostic, not a raw crash.
        expect(derived.warnings[0]).toMatch(/edit that earlier feature/i);
      }
    }
    expect(succeeded).toBeGreaterThanOrEqual(7);
    expect(failed).toBeLessThanOrEqual(8);
  });

  it('fillets the result of a boolean subtract', async () => {
    const withBase = addPrimitiveFeature(
      createProjectDocument('Boolean fillet', toUserId('user_exact')),
      {
        name: 'Base',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      }
    );
    const withCutter = addPrimitiveFeature(withBase, {
      name: 'Cutter',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 30, depth: 10 }
    });
    const manager = new CommandManager(withCutter);
    const subtracted = manager.execute(
      commandFactories.booleanBodies({
        name: 'Subtract',
        operation: 'subtract',
        targetBodyIds: [withCutter.bodyOrder[0]!, withCutter.bodyOrder[1]!]
      })
    );
    const subtractedDerived = await adapter.syncDocument(subtracted);
    expect(subtractedDerived.warnings).toEqual([]);
    const booleanBodyId = subtracted.bodyOrder.at(-1)!;
    const booleanBody = subtractedDerived.bodyRepresentations[booleanBodyId];
    expect(booleanBody?.topology?.edges.length).toBeGreaterThan(0);

    const filleted = filletEdges(subtracted, {
      name: 'Boolean fillet',
      targetBodyId: booleanBodyId,
      edgeHashes: [booleanBody!.topology!.edges[0]!.hash],
      size: 1
    }).document;
    const derived = await adapter.syncDocument(filleted);
    expect(derived.warnings).toEqual([]);
    expect(
      derived.bodyRepresentations[filleted.bodyOrder.at(-1)!]?.volume
    ).toBeGreaterThan(0);
  });

  it('reports an actionable diagnostic when an edge fillet is invalid', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Invalid fillet', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 20, height: 20, depth: 20 }
      }
    );
    const baseDerived = await adapter.syncDocument(base);
    const edgeHash = Object.values(baseDerived.bodyRepresentations)[0]?.topology
      ?.edges[0]?.hash;
    expect(edgeHash).toBeTypeOf('number');
    const invalid = filletEdges(base, {
      name: 'Oversized fillet',
      targetBodyId: base.bodyOrder[0]!,
      edgeHashes: [edgeHash!],
      size: 50
    }).document;
    const derived = await adapter.syncDocument(invalid);

    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain(
      'Fillet could not be created on 1 selected edge with radius 50.'
    );
    expect(derived.warnings[0]).toContain('Try a smaller radius');
    expect(derived.warnings[0]).not.toContain('WebAssembly.Exception');
  });

  it('builds linear and circular exact body patterns', async () => {
    const base = addPrimitiveFeature(
      createProjectDocument('Patterns', toUserId('user_exact')),
      {
        name: 'Block',
        primitiveKind: 'box',
        dimensions: { width: 4, height: 5, depth: 6 }
      }
    );
    const targetBodyId = base.bodyOrder[0]!;
    const linear = patternBody(base, {
      name: 'Linear pattern',
      targetBodyId,
      patternKind: 'linear',
      count: 3,
      axis: 'x',
      spacing: 10
    }).document;
    const linearDerived = await adapter.syncDocument(linear);
    const linearBodyId = linear.bodyOrder.at(-1)!;
    const linearBody = linearDerived.bodyRepresentations[linearBodyId];
    expect(linearDerived.warnings).toEqual([]);
    expect(linearBody?.volume).toBeCloseTo(4 * 5 * 6 * 3, 4);
    const linearStep = await adapter.exportStep(linear, [linearBodyId]);
    const linearInspection = await adapter.inspectStep(linearStep);
    expect(linearInspection).toMatchObject({ solid: true, valid: true });
    expect(linearInspection.volume).toBeCloseTo(linearBody!.volume, 4);

    const moved = transformBody(base, {
      name: 'Offset',
      targetBodyId,
      translation: { x: 12, y: 0, z: 0 }
    }).document;
    const circular = patternBody(moved, {
      name: 'Circular pattern',
      targetBodyId,
      patternKind: 'circular',
      count: 4,
      axis: 'z',
      angleDeg: 360
    }).document;
    const circularDerived = await adapter.syncDocument(circular);
    const circularBody =
      circularDerived.bodyRepresentations[circular.bodyOrder.at(-1)!];
    expect(circularDerived.warnings).toEqual([]);
    expect(circularBody?.volume).toBeCloseTo(4 * 5 * 6 * 4, 4);
  });

  it('exports STEP that reimports as a valid exact solid', async () => {
    const document = addPrimitiveFeature(
      createProjectDocument('Round trip', toUserId('user_exact')),
      {
        name: 'Round trip box',
        primitiveKind: 'box',
        dimensions: { width: 12, height: 8, depth: 5 }
      }
    );
    const bodyId = document.bodyOrder[0]!;
    const step = await adapter.exportStep(document, [bodyId]);
    const inspection = await adapter.inspectStep(step);
    expect(inspection.solid).toBe(true);
    expect(inspection.valid).toBe(true);
    expect(inspection.volume).toBeCloseTo(480, 4);
  });

  it.each([
    ['mm', 1],
    ['cm', 10],
    ['m', 1000],
    ['inch', 25.4]
  ] as const)(
    'exports %s documents at their physical millimetre scale',
    async (units, millimetersPerUnit) => {
      const document = addPrimitiveFeature(
        createProjectDocument('Unit export', toUserId('user_exact'), units),
        {
          name: 'Unit box',
          primitiveKind: 'box',
          dimensions: { width: 2, height: 3, depth: 4 }
        }
      );
      const step = await adapter.exportStep(document, [document.bodyOrder[0]!]);
      const inspection = await adapter.inspectStep(step);
      expect(inspection).toMatchObject({ solid: true, valid: true });
      expect(inspection.volume).toBeCloseTo(24 * millimetersPerUnit ** 3, 3);
    }
  );
});
