/**
 * Text through the real kernel, end to end.
 *
 * Phases 1 and 2 stopped at `SketchProfile` objects. This is the first place
 * that proves the doubles the glyph pipeline emits actually become solids:
 * that `makeWire` closes a wire whose edges are exact NURBS beziers, that
 * `addHolesToFace` puts a counter where a counter belongs, and that editing
 * the string regenerates every downstream feature instead of breaking the
 * extrude's profile reference.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  updateSketchObject
} from '@openzcad/document-core';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  buildTextProfileSet,
  setTextFontProvider,
  type LoadedFont
} from '@openzcad/geometry';
import { setBezierProfileEdges } from '@openzcad/kernel-adapter';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyRepresentation,
  type DerivedState,
  type EntityId,
  type ProjectDocument,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import { FontLibrary } from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';
import { inspectTriangleMeshClosure } from '../packages/kernel-adapter/src/boolean-result-validation';

const EXTRUDE_DEPTH = 5;
const library = new FontLibrary(nodeFontDataSource());

type TextObjectData = Extract<SketchObjectData, { objectKind: 'text' }>;

function textObject(text: string, overrides: Partial<TextObjectData> = {}) {
  return {
    objectKind: 'text' as const,
    text,
    fontFamily: 'open-sans',
    fontStyle: 'regular' as const,
    size: 20,
    x: 0,
    y: 0,
    ...overrides
  };
}

interface TextScene {
  document: ProjectDocument;
  sketchId: SketchId;
  textObjectId: EntityId;
}

function textScene(text: string): TextScene {
  const created = addSketchFeature(
    createProjectDocument('Text solids', toUserId('user_text_kernel')),
    {
      name: 'Text sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [textObject(text)]
    }
  );
  const sketch = findSketch(created.document, created.sketchId)!;
  const textObjectId = sketch.objectIds[0]!;
  const document = extrudeSketch(created.document, {
    name: 'Raised text',
    sketchId: created.sketchId,
    distance: EXTRUDE_DEPTH,
    profiles: [{ all: true, sourceEntityIds: [textObjectId] }]
  }).document;
  return { document, sketchId: created.sketchId, textObjectId };
}

function retype(scene: TextScene, text: string): ProjectDocument {
  return updateSketchObject(scene.document, {
    sketchId: scene.sketchId,
    objectId: scene.textObjectId,
    data: textObject(text)
  });
}

function bodyOf(derived: DerivedState): BodyRepresentation {
  const bodies = Object.values(derived.bodyRepresentations).filter(
    (body) => !body.consumed
  );
  if (bodies.length !== 1) {
    throw new Error(`expected one body, saw ${bodies.length}`);
  }
  return bodies[0]!;
}

/** Exact 2D area of the text, straight from the glyph pipeline. */
function textArea(font: LoadedFont, text: string): number {
  return buildTextProfileSet(font, { text, size: 20 }).regions.reduce(
    (total, region) => total + region.area,
    0
  );
}

/**
 * Measured volume against the closed form, as a ratio.
 *
 * The adapter measures volume by integrating at a display-grade deflection
 * (0.08 mm), which is exact for planar walls and lands within ~1e-5 relative
 * on NURBS ones. Comparing the ratio keeps the assertion about the geometry
 * rather than about the integrator's step size, and still fails hard if a
 * counter went missing — a dropped hole is a percent-scale error, not a
 * 1e-5 one.
 */
function volumeRatio(body: BodyRepresentation, expected: number): number {
  return body.volume / expected;
}

/**
 * Connected components of the body's triangle mesh, after welding coincident
 * vertices. One extrude feature can own several disconnected solids, and
 * that is exactly what a word is; counting the components is the direct way
 * to check "one solid per connected letter group".
 */
function meshComponents(body: BodyRepresentation): number {
  const { vertices, indices } = body.mesh;
  const keyOf = (index: number): string => {
    const at = index * 3;
    return [vertices[at], vertices[at + 1], vertices[at + 2]]
      .map((value) => Math.round((value ?? 0) * 1e6))
      .join(',');
  };
  const parent = new Map<string, string>();
  const find = (key: string): string => {
    let root = key;
    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    return root;
  };
  const add = (key: string): void => {
    if (!parent.has(key)) {
      parent.set(key, key);
    }
  };
  for (let at = 0; at + 2 < indices.length; at += 3) {
    const keys = [
      keyOf(indices[at]!),
      keyOf(indices[at + 1]!),
      keyOf(indices[at + 2]!)
    ];
    keys.forEach(add);
    const first = find(keys[0]!);
    for (const key of keys.slice(1)) {
      parent.set(find(key), first);
    }
  }
  return new Set([...parent.keys()].map(find)).size;
}

describe('text built by the exact kernel', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;
  let openSans: LoadedFont;

  beforeAll(async () => {
    openSans = await library.load('open-sans', 'regular');
    setTextFontProvider((family, style) => library.peek(family, style));
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    setTextFontProvider(null);
    setBezierProfileEdges(true);
    adapter.dispose();
  });

  it('extrudes "TEXT" 5 mm into one solid per letter', async () => {
    const scene = textScene('TEXT');
    const derived = await adapter.syncDocument(scene.document);
    expect(derived.warnings).toEqual([]);
    const body = bodyOf(derived);

    // Volume is the exact 2D glyph area times the depth. Nothing in this
    // number is read back from the kernel's own tessellation. 'TEXT' is
    // entirely straight-sided, so this holds to 1e-4 absolute rather than
    // the relative bound the curved letters need.
    expect(body.volume).toBeCloseTo(
      textArea(openSans, 'TEXT') * EXTRUDE_DEPTH,
      4
    );

    // 'T', 'E', 'X' and 'T' are four disconnected letters, so the extrude
    // produces four solids. Each is a prism: two caps plus one wall per
    // boundary segment, and T is 8-sided while E and X are 12-sided.
    expect(body.faceCount).toBe(10 + 14 + 14 + 10);
    expect(meshComponents(body)).toBe(4);

    const closure = inspectTriangleMeshClosure(
      body.mesh.vertices,
      body.mesh.indices
    );
    expect(closure.triangles).toBeGreaterThan(0);
    expect(closure.boundaryEdges).toBe(0);
    expect(closure.nonManifoldEdges).toBe(0);
    expect(closure.inconsistentWindingEdges).toBe(0);
  });

  it('gives counters real through-holes and plain letters none', async () => {
    // 'Bo' has three counters between two letters; 'Il' has none. If
    // `addHolesToFace` silently dropped the inner wires, the volumes would
    // be the outer areas and the face counts would not differ.
    const holed = await adapter.syncDocument(textScene('Bo').document);
    const solid = await adapter.syncDocument(textScene('Il').document);
    expect(holed.warnings).toEqual([]);
    expect(solid.warnings).toEqual([]);

    const holedBody = bodyOf(holed);
    const solidBody = bodyOf(solid);
    expect(
      volumeRatio(holedBody, textArea(openSans, 'Bo') * EXTRUDE_DEPTH)
    ).toBeCloseTo(1, 4);
    expect(
      volumeRatio(solidBody, textArea(openSans, 'Il') * EXTRUDE_DEPTH)
    ).toBeCloseTo(1, 4);
    // The counters carry real volume: without them 'Bo' would measure the
    // outer areas, which is 19 % more.
    const outerOnly = buildTextProfileSet(openSans, {
      text: 'Bo',
      size: 20
    }).regions.reduce(
      (total, region) => total + Math.abs(region.outer.signedArea),
      0
    );
    expect(outerOnly * EXTRUDE_DEPTH).toBeGreaterThan(holedBody.volume * 1.15);

    // The exact area already subtracts the counters. A through-hole also
    // shows up as extra inner walls, which 'Il' has none of.
    const set = buildTextProfileSet(openSans, { text: 'Bo', size: 20 });
    expect(set.regions.map((region) => region.holes.length)).toEqual([2, 1]);
    const holeWalls = set.regions.reduce(
      (total, region) =>
        total +
        region.holes.reduce((walls, hole) => walls + hole.segments.length, 0),
      0
    );
    expect(holeWalls).toBeGreaterThan(0);
    const outerWalls = set.regions.reduce(
      (total, region) => total + region.outer.segments.length,
      0
    );
    // caps + outer walls + hole walls, over two letters.
    expect(holedBody.faceCount).toBe(2 * 2 + outerWalls + holeWalls);

    expect(meshComponents(holedBody)).toBe(2);
    expect(meshComponents(solidBody)).toBe(2);

    const closure = inspectTriangleMeshClosure(
      holedBody.mesh.vertices,
      holedBody.mesh.indices
    );
    expect(closure.boundaryEdges).toBe(0);
    expect(closure.nonManifoldEdges).toBe(0);
  });

  it('keeps glyph curves exact rather than faceting them', async () => {
    const derived = await adapter.syncDocument(textScene('o').document);
    const body = bodyOf(derived);
    const surfaces = body.topology?.faces ?? [];
    expect(surfaces.length).toBeGreaterThan(0);
    // Open Sans's 'o' is 12 quadratics outside and 12 inside; a faceted
    // build would need hundreds of walls to hit the same volume.
    expect(body.faceCount).toBeLessThan(40);
    expect(
      volumeRatio(body, textArea(openSans, 'o') * EXTRUDE_DEPTH)
    ).toBeCloseTo(1, 4);
  });

  it('regenerates after the string is edited, with no broken reference', async () => {
    const scene = textScene('TEXT');
    const before = bodyOf(await adapter.syncDocument(scene.document));

    // The edit that this whole feature exists for: change the string and
    // every downstream feature must rebuild. Every region's fingerprint,
    // area and sample point changes, and so does the region count.
    const edited = retype(scene, 'BOX');
    const derived = await adapter.syncDocument(edited);
    expect(
      derived.warnings.filter((warning) =>
        warning.includes('Broken profile reference')
      )
    ).toEqual([]);
    expect(derived.warnings).toEqual([]);

    const after = bodyOf(derived);
    expect(
      volumeRatio(after, textArea(openSans, 'BOX') * EXTRUDE_DEPTH)
    ).toBeCloseTo(1, 4);
    expect(after.volume).not.toBeCloseTo(before.volume, 3);
    // 'B' and 'O' have counters, 'X' does not, so the rebuilt body carries
    // through-holes the previous one did not.
    expect(after.faceCount).toBeGreaterThan(before.faceCount);

    const closure = inspectTriangleMeshClosure(
      after.mesh.vertices,
      after.mesh.indices
    );
    expect(closure.boundaryEdges).toBe(0);
    expect(closure.nonManifoldEdges).toBe(0);
  });

  it('regenerates after a size edit', async () => {
    const scene = textScene('TEXT');
    const base = bodyOf(await adapter.syncDocument(scene.document));
    const resized = updateSketchObject(scene.document, {
      sketchId: scene.sketchId,
      objectId: scene.textObjectId,
      data: textObject('TEXT', { size: 40 })
    });
    const derived = await adapter.syncDocument(resized);
    expect(derived.warnings).toEqual([]);
    // Doubling the em quadruples the area and so the volume.
    expect(bodyOf(derived).volume).toBeCloseTo(base.volume * 4, 3);
  });

  it('fails closed, naming the cause, when the face is not loaded', async () => {
    setTextFontProvider(null);
    try {
      const scene = textScene('TEXT');
      const derived = await adapter.syncDocument(scene.document);
      // Fail-closed: no body, and the warning says the font is missing
      // rather than "the entities bound nothing".
      expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
      expect(derived.warnings.join('\n')).toContain('font provider');
    } finally {
      setTextFontProvider((family, style) => library.peek(family, style));
    }
  });

  it('refuses the legacy single-profile sweep instead of approximating', async () => {
    // An extrude with no profile reference sweeps the sketch's first object
    // as one polygonal loop. Text is many regions with holes and exact
    // beziers; that path can express none of it, so it must refuse rather
    // than quietly build the wrong solid.
    const created = addSketchFeature(
      createProjectDocument('Legacy sweep', toUserId('user_text_legacy')),
      {
        name: 'Text sketch',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [textObject('O')]
      }
    );
    const document = extrudeSketch(created.document, {
      name: 'Legacy extrude',
      sketchId: created.sketchId,
      distance: EXTRUDE_DEPTH
    }).document;

    const derived = await adapter.syncDocument(document);
    expect(Object.keys(derived.bodyRepresentations)).toHaveLength(0);
    expect(derived.warnings.join('\n')).toContain(
      'Text must be extruded through its detected sketch regions'
    );
  });

  it('embosses onto a slab and censuses the faces of the fuse', async () => {
    // The emboss flow: a slab, text extruded above it, fused. Glyph stems
    // are thin and their contact with the slab is coplanar — the sliver case
    // where a boolean can quietly return a faceted approximation, which is
    // exactly what the census is watching for.
    const withSlab = addPrimitiveFeature(
      createProjectDocument('Emboss', toUserId('user_text_emboss')),
      {
        name: 'Slab',
        primitiveKind: 'box',
        dimensions: { width: 120, height: 40, depth: 4 }
      }
    );
    const slabId = withSlab.bodyOrder.at(-1)!;
    const created = addSketchFeature(withSlab, {
      name: 'Label',
      planeRef: { type: 'canonical', plane: 'XY', offset: 2 },
      objects: [textObject('TEXT', { x: 8, y: 12 })]
    });
    const sketch = findSketch(created.document, created.sketchId)!;
    const withExtrude = extrudeSketch(created.document, {
      name: 'Raised label',
      sketchId: created.sketchId,
      distance: EXTRUDE_DEPTH,
      profiles: [{ all: true, sourceEntityIds: [sketch.objectIds[0]!] }]
    });
    const manager = new CommandManager(withExtrude.document);
    const document = manager.execute(
      commandFactories.booleanBodies({
        name: 'Emboss',
        operation: 'union',
        targetBodyIds: [slabId, withExtrude.bodyId]
      })
    );

    const derived = await adapter.syncDocument(document);
    const body = bodyOf(derived);
    const closure = inspectTriangleMeshClosure(
      body.mesh.vertices,
      body.mesh.indices
    );
    expect(closure.boundaryEdges).toBe(0);
    expect(closure.nonManifoldEdges).toBe(0);
    expect(meshComponents(body)).toBe(1);

    // Whatever the kernel does here, the census must have an opinion that
    // agrees with the face count. This asserts the two are consistent rather
    // than pinning a kernel behaviour that may improve.
    const facetWarnings = derived.warnings.filter((warning) =>
      warning.includes('faces')
    );
    const slabPlusText = 6 + (10 + 14 + 14 + 10);
    if (facetWarnings.length === 0) {
      expect(body.faceCount).toBeLessThanOrEqual(slabPlusText * 4 + 32);
    } else {
      expect(body.faceCount).toBeGreaterThan(slabPlusText * 4 + 32);
    }
  });

  it('produces the same solid through the flattening fallback, loudly', async () => {
    const scene = textScene('o');
    const exact = bodyOf(await adapter.syncDocument(scene.document));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setBezierProfileEdges(false);
    try {
      const fallback = bodyOf(await adapter.syncDocument(scene.document));
      // Silent degradation is forbidden: taking the fallback says so.
      expect(warn).toHaveBeenCalled();
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'flattened to line segments instead of exact NURBS edges'
      );
      // The fallback is a real degradation: the same letter now needs far
      // more walls, and its volume is a polygon's, slightly under the curve.
      expect(fallback.faceCount).toBeGreaterThan(exact.faceCount * 3);
      expect(fallback.volume).toBeLessThan(exact.volume);
      expect(fallback.volume / exact.volume).toBeGreaterThan(0.999);
      const closure = inspectTriangleMeshClosure(
        fallback.mesh.vertices,
        fallback.mesh.indices
      );
      expect(closure.boundaryEdges).toBe(0);
      expect(closure.nonManifoldEdges).toBe(0);
    } finally {
      setBezierProfileEdges(true);
      warn.mockRestore();
    }
  });
});
