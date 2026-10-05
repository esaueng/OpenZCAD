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
  type BezierRegionCurve,
  type LoadedFont,
  type TextSegment,
  type Vec2Like
} from '@openzcad/geometry';
import {
  DEFAULT_EXACT_BEZIER_EDGES,
  bezierProfileEdgesEnabled,
  setBezierProfileEdges
} from '@openzcad/kernel-adapter';
import {
  kernelReadsBezierAsCircle,
  kernelSafeBezierPieces
} from '../packages/kernel-adapter/src/profile-bezier-edges';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';
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
function textArea(font: LoadedFont, text: string, size = 20): number {
  return buildTextProfileSet(font, { text, size }).regions.reduce(
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
    await library.load('inter', 'regular');
    setTextFontProvider((family, style) => library.peek(family, style));
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    setTextFontProvider(null);
    setBezierProfileEdges(DEFAULT_EXACT_BEZIER_EDGES);
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
    // caps + outer walls + hole walls, over two letters. One glyph segment is
    // one wall on the exact path, so this is an equality — and it is the
    // assertion that would catch a counter being dropped or a wall being
    // silently subdivided.
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

  it('keeps glyph curves exact rather than faceting them, when opted in', async () => {
    // Exact walls are opt-in now (they misclassify — see the default test at
    // the bottom of this file). This still has to hold for whoever enables
    // them, and for the day the kernel defect is fixed and it goes back to
    // being the default.
    setBezierProfileEdges(true);
    const derived = await adapter
      .syncDocument(textScene('o').document)
      .finally(() => setBezierProfileEdges(DEFAULT_EXACT_BEZIER_EDGES));
    const body = bodyOf(derived);
    const surfaces = body.topology?.faces ?? [];
    expect(surfaces.length).toBeGreaterThan(0);

    // The direct statement of the claim, not a proxy for it: every wall of a
    // curved glyph must be a spline surface, and the only planes may be the
    // two caps. Volume alone would not catch this — a fine enough polygon
    // reproduces the volume to well inside the tolerance below.
    const set = buildTextProfileSet(openSans, { text: 'o', size: 20 });
    const bezierWalls = [set.regions[0]!.outer, ...set.regions[0]!.holes]
      .flatMap((loop) => loop.segments)
      .filter((segment) => segment.kind !== 'line').length;
    expect(bezierWalls).toBeGreaterThan(0);
    const byType = surfaces.reduce<Record<string, number>>((counts, face) => {
      const type = face.geometry?.surfaceType ?? 'unknown';
      counts[type] = (counts[type] ?? 0) + 1;
      return counts;
    }, {});
    expect(byType.plane ?? 0).toBe(2);
    expect(byType.bspline ?? 0).toBeGreaterThanOrEqual(bezierWalls);

    // Open Sans's 'o' is 12 quadratics outside and 12 inside; a faceted
    // build would need hundreds of walls to hit the same volume.
    expect(body.faceCount).toBeLessThan(40);
    expect(
      volumeRatio(body, textArea(openSans, 'o') * EXTRUDE_DEPTH)
    ).toBeCloseTo(1, 4);
  });

  it("says so when a font's own overlaps cost it its curves", async () => {
    // The common flattening path, and the one the plan did not anticipate:
    // real fonts draw a glyph as overlapping strokes inside one
    // self-intersecting contour. A B-Rep face cannot take that, so those
    // glyphs go through the polygon union — which works on polylines and
    // returns polylines. Inter has 36 such glyphs in ASCII; Open Sans has
    // none. Identical documents, identical letter, opposite outcomes.
    // Opt into exact edges for the duration: this contrast is about outline
    // *fidelity* — what the font costs itself — and with the flattening
    // default in force both fonts would come back as polylines and the
    // comparison would prove nothing.
    setBezierProfileEdges(true);
    const interScene = textScene('e');
    const interDocument = updateSketchObject(interScene.document, {
      sketchId: interScene.sketchId,
      objectId: interScene.textObjectId,
      data: textObject('e', { fontFamily: 'inter' })
    });

    const flattened = await adapter.syncDocument(interDocument);
    expect(flattened.warnings.join('\n')).toContain(
      "reached the kernel as polylines rather than the font's own curves"
    );
    // And what that warning MEANS, which the string cannot say. The body
    // below is real, measured and exportable; it is merely faceted. A commit
    // gate that refused on this would throw away work that succeeded, which
    // is what it did while every warning looked alike.
    expect(flattened.featureWarnings?.map((entry) => entry.kind)).toContain(
      'advisory'
    );
    const flattenedFaces = bodyOf(flattened).topology?.faces ?? [];
    expect(
      flattenedFaces.filter((face) => face.geometry?.surfaceType === 'bspline')
    ).toHaveLength(0);

    const exact = await adapter
      .syncDocument(textScene('e').document)
      .finally(() => setBezierProfileEdges(DEFAULT_EXACT_BEZIER_EDGES));
    expect(exact.warnings).toEqual([]);
    const exactFaces = bodyOf(exact).topology?.faces ?? [];
    expect(
      exactFaces.filter((face) => face.geometry?.surfaceType === 'bspline')
        .length
    ).toBeGreaterThan(0);
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

    // The emboss volume is closed form, and it is the assertion that actually
    // constrains the result: the slab, plus the part of the text prism that
    // stands above it. The text sketch sits 2 mm up and is extruded 5 mm, so
    // 2 mm of every glyph prism is buried in the 4 mm slab.
    const glyphArea = textArea(openSans, 'TEXT');
    const expected = 120 * 40 * 4 + glyphArea * EXTRUDE_DEPTH - glyphArea * 2;
    expect(volumeRatio(body, expected)).toBeCloseTo(1, 5);

    // Separately, the census must have an opinion that agrees with the face
    // count. This asserts the two are consistent rather than pinning a kernel
    // behaviour that may improve.
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

  /**
   * Emboss and engrave with a CURVED letter, through both wall modes. The
   * Remus keeps both the default exact-Bezier path and the optional flattened
   * path accurate. The flattened path used to lose about 1.4% of the
   * closed-form volume without warning; keeping it in this loop pins the
   * upstream correction as a positive result.
   *
   * The existing emboss case above uses 'TEXT', which is entirely
   * straight-sided — so no boolean test touched a bezier wall, which is
   * exactly where the risk lives. 'Bo' has three counters and curved stems.
   *
   * This is also the measurement that decides the default. Exact walls are
   * misclassified in the middle of the bezier cap band, but emboss and engrave
   * contact the slab on a FLAT face, so the question is whether that
   * misclassification actually reaches the boolean. Asserting closed-form
   * volume answers it: a boolean that consulted a lying classifier does not
   * land within 1e-4 of the right number by luck.
   */
  for (const exact of [false, true]) {
    const label = exact ? 'exact bezier walls' : 'flattened walls';
    it(`embosses and engraves a curved glyph with ${label}`, async () => {
      setBezierProfileEdges(exact);
      try {
        const glyphArea = textArea(openSans, 'Bo');
        for (const operation of ['union', 'subtract'] as const) {
          const withSlab = addPrimitiveFeature(
            createProjectDocument('Curved', toUserId('user_text_curved')),
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
            objects: [textObject('Bo', { x: 8, y: 12 })]
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
              name: operation === 'union' ? 'Emboss' : 'Engrave',
              operation,
              targetBodyIds: [slabId, withExtrude.bodyId]
            })
          );
          const body = bodyOf(await adapter.syncDocument(document));
          const closure = inspectTriangleMeshClosure(
            body.mesh.vertices,
            body.mesh.indices
          );
          expect(closure.boundaryEdges, `${label} ${operation}`).toBe(0);
          expect(closure.nonManifoldEdges, `${label} ${operation}`).toBe(0);

          // The glyph prism spans z 2..7 against a slab of z 0..4, so a union
          // adds the 3 mm standing proud and a subtract removes the 2 mm
          // buried in it.
          const slab = 120 * 40 * 4;
          const expected =
            operation === 'union'
              ? slab + glyphArea * (EXTRUDE_DEPTH - 2)
              : slab - glyphArea * 2;
          expect(
            volumeRatio(body, expected),
            `${label} ${operation} volume`
          ).toBeCloseTo(1, 4);
        }
      } finally {
        setBezierProfileEdges(DEFAULT_EXACT_BEZIER_EDGES);
      }
    });
  }

  // Locks the decision, not an incidental value. Exact walls are the default
  // because the curved-glyph emboss and engrave above land correct through
  // them — not because the misclassification repro was fixed. It is still
  // open. Anyone flipping this should have a measurement, the way the pair of
  // tests above is one.
  it('defaults to exact walls, which curved booleans are measured to survive', () => {
    expect(DEFAULT_EXACT_BEZIER_EDGES).toBe(true);
    expect(bezierProfileEdgesEnabled()).toBe(true);
  });

  it('takes the exact default without warning about it', async () => {
    const scene = textScene('o');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const derived = await adapter.syncDocument(scene.document);
      const exact = bodyOf(derived);
      expect(derived.warnings).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
      const closure = inspectTriangleMeshClosure(
        exact.mesh.vertices,
        exact.mesh.indices
      );
      expect(closure.boundaryEdges).toBe(0);
      expect(closure.nonManifoldEdges).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Engrave and emboss with the text sketched ON the slab's top face — the
   * way the UI does it — rather than buried below it as the cases above are.
   * The exact kernel refuses a Bezier-walled tool whose cap lies on the
   * target's face (remus#953, `exact_only_unattainable`); the adapter
   * rebuilds that tool with a hair of travel across the face on the side
   * where it cannot change the result (`exact-pierce-tool.ts`). Both routes
   * the app uses are covered: the extrude's own operation and target, and an
   * explicit boolean after a plain new-body extrude.
   */
  describe('on the face it was sketched on', () => {
    const SLAB = { width: 62, height: 50, depth: 10 } as const;
    const TEXT = 'Boa';
    const SIZE = 8;
    const DEPTH = 2;

    interface Hole {
      centerX: number;
      centerY: number;
      radius: number;
    }

    function onFaceScene(
      route: 'extrude' | 'boolean',
      operation: 'subtract' | 'union',
      hole?: Hole,
      /** A sealed 6 x 3 x 2 cavity whose roof is at z = `top`. */
      cavity?: { centerX: number; centerY: number; top: number }
    ): ProjectDocument {
      const withBox = addPrimitiveFeature(
        createProjectDocument('On face', toUserId('user_text_on_face')),
        { name: 'Slab', primitiveKind: 'box', dimensions: { ...SLAB } }
      );
      let withSlab = withBox;
      let slabId = withBox.bodyOrder.at(-1)!;
      if (hole) {
        // A through-hole drilled before the text, overshooting both faces.
        const drill = addSketchFeature(withBox, {
          name: 'Drill',
          planeRef: { type: 'canonical', plane: 'XY', offset: -1 },
          objects: [{ objectKind: 'circle', ...hole }]
        });
        const drilled = extrudeSketch(drill.document, {
          name: 'Hole',
          sketchId: drill.sketchId,
          distance: SLAB.depth + 2,
          operation: 'cut',
          targetBodyId: slabId
        });
        withSlab = drilled.document;
        slabId = drilled.bodyId;
      }
      if (cavity) {
        // Cut down from a buried plane, so the top face stays whole.
        const { top, ...center } = cavity;
        const pocket = addSketchFeature(withSlab, {
          name: 'Cavity',
          planeRef: { type: 'canonical', plane: 'XY', offset: top },
          objects: [{ objectKind: 'rectangle', ...center, width: 6, height: 3 }]
        });
        const hollowed = extrudeSketch(pocket.document, {
          name: 'Cavity cut',
          sketchId: pocket.sketchId,
          distance: -2,
          operation: 'cut',
          targetBodyId: slabId
        });
        withSlab = hollowed.document;
        slabId = hollowed.bodyId;
      }
      const created = addSketchFeature(withSlab, {
        name: 'Label',
        // The slab's top face: the box spans z 0..depth.
        planeRef: { type: 'canonical', plane: 'XY', offset: SLAB.depth },
        objects: [textObject(TEXT, { size: SIZE, x: 8, y: 12 })]
      });
      const sketch = findSketch(created.document, created.sketchId)!;
      const extruded = extrudeSketch(created.document, {
        name: 'Label text',
        sketchId: created.sketchId,
        distance: operation === 'subtract' ? -DEPTH : DEPTH,
        profiles: [{ all: true, sourceEntityIds: [sketch.objectIds[0]!] }],
        ...(route === 'extrude'
          ? {
              operation: operation === 'subtract' ? 'cut' : 'add',
              targetBodyId: slabId
            }
          : {})
      });
      if (route === 'extrude') return extruded.document;
      return new CommandManager(extruded.document).execute(
        commandFactories.booleanBodies({
          name: operation === 'subtract' ? 'Engrave' : 'Emboss',
          operation,
          targetBodyIds: [slabId, extruded.bodyId]
        })
      );
    }

    for (const route of ['extrude', 'boolean'] as const) {
      for (const operation of ['subtract', 'union'] as const) {
        const verb = operation === 'subtract' ? 'engraves' : 'embosses';
        it(`${verb} on-face text through the ${route} route`, async () => {
          const document = onFaceScene(route, operation);
          const derived = await adapter.syncDocument(document);
          // The boolean was built: no feature failed on a kernel refusal.
          expect(
            derived.featureWarnings?.filter(
              (entry) => entry.kind === 'build-failed'
            ) ?? []
          ).toEqual([]);
          if (!(route === 'boolean' && operation === 'union')) {
            expect(derived.warnings).toEqual([]);
          }
          // Known follow-up, not this fix: the union connectivity gate cannot
          // certify glyph-to-slab contact (no certified distance for Bezier
          // walls, and the exact intersect refuses the pair), so the boolean
          // Union still files a "disconnected groups" advisory although the
          // fused body below is the right one. It does so with the text
          // buried 0.5 mm as well, so it is not caused by the pierce.

          const body = bodyOf(derived);
          const closure = inspectTriangleMeshClosure(
            body.mesh.vertices,
            body.mesh.indices
          );
          expect(closure.boundaryEdges).toBe(0);
          expect(closure.nonManifoldEdges).toBe(0);
          expect(meshComponents(body)).toBe(1);

          // Closed form: the slab plus or minus the glyph area times the
          // user's depth. A pierce that leaked into the result would move
          // this by its own 0.01 mm sliver, and a refusal would leave the
          // bare slab.
          const glyphVolume = textArea(openSans, TEXT, SIZE) * DEPTH;
          const slab = SLAB.width * SLAB.height * SLAB.depth;
          const expected =
            operation === 'subtract' ? slab - glyphVolume : slab + glyphVolume;
          expect(volumeRatio(body, expected)).toBeCloseTo(1, 5);
          // ...and neither does it reach the published size. The cut trims
          // the pierced walls back to the face, but the kernel boxes a
          // trimmed B-spline face by its untrimmed surface, so the slab read
          // 10.01 tall — inside one display deflection, where the mesh alone
          // could not prove the box loose (refineBoundsAtSplineFaces).
          const actualTop =
            operation === 'subtract' ? SLAB.depth : SLAB.depth + DEPTH;
          expect(body.bbox.max.z).toBeGreaterThanOrEqual(actualTop);
          // The reported side keeps its outward tessellation tolerance,
          // while still displaying 10.00 rather than the untrimmed 10.01.
          expect(body.bbox.max.z).toBeLessThan(actualTop + 0.005);

          // The travel never reaches the document: the extrude still stores
          // the user's distance and no back distance.
          const extrude = Object.values(document.nodes).find(
            (node) => node.kind === 'feature' && node.name === 'Label text'
          );
          expect(extrude?.kind === 'feature' && extrude.data).toMatchObject({
            featureKind: 'extrude',
            distance: operation === 'subtract' ? -DEPTH : DEPTH
          });
          expect(
            extrude?.kind === 'feature' &&
              extrude.data.featureKind === 'extrude' &&
              extrude.data.backDistance
          ).toBeFalsy();
        });
      }
    }

    /**
     * The pierce must never be taken over a pre-existing hole: the sliver
     * would cap it (emboss) or reach past its rim (engrave). The B's stem
     * is 0.66 mm wide at this size, so the hole under it is 0.4 mm across
     * to sit wholly inside the glyph's material.
     */
    const UNDER_B_STEM: Hole = { centerX: 9.113, centerY: 13.5, radius: 0.2 };
    const CLEAR_OF_TEXT: Hole = { centerX: 50, centerY: 40, radius: 0.5 };
    const slabWith = (hole: Hole) =>
      SLAB.width * SLAB.height * SLAB.depth -
      Math.PI * hole.radius ** 2 * SLAB.depth;

    // Engrave goes through the boolean route here: on a drilled slab the
    // extrude-cut route refuses earlier, in its overlap measurement, before
    // any boolean runs (a separate, pre-existing limit). Emboss goes through
    // the extrude route, since the boolean Union still files its glyph
    // connectivity advisory (see above).
    for (const operation of ['subtract', 'union'] as const) {
      const verb = operation === 'subtract' ? 'engrave' : 'emboss';
      const route = operation === 'subtract' ? 'boolean' : 'extrude';
      it(`keeps the refusal for an on-face ${verb} over a hole in the face`, async () => {
        const derived = await adapter.syncDocument(
          onFaceScene(route, operation, UNDER_B_STEM)
        );
        // The user's own refusal, unchanged: the gate declined the retry.
        const failed = (derived.featureWarnings ?? []).filter(
          (entry) => entry.kind === 'build-failed'
        );
        expect(failed).toHaveLength(1);
        expect(failed[0]!.featureName).toBe(
          route === 'boolean' ? 'Engrave' : 'Label text'
        );
        expect(failed[0]!.kernelRefusal).toMatchObject({
          family: 'boolean',
          code: 'exact_only_unattainable'
        });
        expect(failed[0]!.message).toContain(
          operation === 'subtract'
            ? 'could not be cut exactly'
            : 'could not be combined exactly'
        );
        // And the drilled slab is left exactly as it was, beside the text
        // body the refused boolean did not consume.
        const bodies = Object.values(derived.bodyRepresentations).filter(
          (body) => !body.consumed
        );
        expect(bodies).toHaveLength(route === 'boolean' ? 2 : 1);
        const slab = bodies.reduce((largest, body) =>
          body.volume > largest.volume ? body : largest
        );
        expect(volumeRatio(slab, slabWith(UNDER_B_STEM))).toBeCloseTo(1, 6);
      });

      it(`still pierces an on-face ${verb} when the hole is clear of the text`, async () => {
        const derived = await adapter.syncDocument(
          onFaceScene(route, operation, CLEAR_OF_TEXT)
        );
        expect(derived.warnings).toEqual([]);
        const glyphVolume = textArea(openSans, TEXT, SIZE) * DEPTH;
        const expected =
          slabWith(CLEAR_OF_TEXT) +
          (operation === 'subtract' ? -glyphVolume : glyphVolume);
        expect(volumeRatio(bodyOf(derived), expected)).toBeCloseTo(1, 5);
      });
    }

    it('keeps the refusal for an on-face emboss over a thin-roofed cavity', async () => {
      // The emboss's pierce runs 0.01 into the slab; a sealed cavity roofed
      // 0.007 under the text would have its top filled by it. The face has
      // no hole, so of the gate's checks only the through-thickness band
      // declines it. On this kernel pin the pierced union over that roof is
      // refused too, so this case pins the end-to-end outcome; the band
      // check itself is proved in exact-pierce-tool.test.ts.
      const cavity = { centerX: 15, centerY: 14, top: SLAB.depth - 0.007 };
      const derived = await adapter.syncDocument(
        onFaceScene('extrude', 'union', undefined, cavity)
      );
      const failed = (derived.featureWarnings ?? []).filter(
        (entry) => entry.kind === 'build-failed'
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]!.featureName).toBe('Label text');
      expect(failed[0]!.kernelRefusal).toMatchObject({
        family: 'boolean',
        code: 'exact_only_unattainable'
      });
      expect(
        volumeRatio(
          bodyOf(derived),
          SLAB.width * SLAB.height * SLAB.depth - 6 * 3 * 2
        )
      ).toBeCloseTo(1, 6);
    });
  });

  it('keeps a curved letter to a handful of walls rather than hundreds', async () => {
    const scene = textScene('o');
    const exact = bodyOf(await adapter.syncDocument(scene.document));

    setBezierProfileEdges(false);
    try {
      const flattened = bodyOf(await adapter.syncDocument(scene.document));
      // This ratio is the whole user-visible difference. Every flattened wall
      // is a separate face the viewer outlines, so an 'o' built this way reads
      // as striped instead of round.
      expect(flattened.faceCount).toBeGreaterThan(exact.faceCount * 3);
      // Flattening inscribes the curve, so it also loses a little volume.
      expect(flattened.volume).toBeLessThan(exact.volume);
      expect(flattened.volume / exact.volume).toBeGreaterThan(0.999);
      const closure = inspectTriangleMeshClosure(
        flattened.mesh.vertices,
        flattened.mesh.indices
      );
      expect(closure.boundaryEdges).toBe(0);
      expect(closure.nonManifoldEdges).toBe(0);
    } finally {
      setBezierProfileEdges(DEFAULT_EXACT_BEZIER_EDGES);
    }
  });

  /**
   * Open Sans's lowercase 'b' at em 10 could not be cut into or embossed onto
   * a face it crossed, while 'd' and 'p' — the same bowl mirrored and dropped
   * — could. The cause is one segment: the quadratic that runs up the inside
   * of the stem where it meets the bowl, 0.48 mm long and within 0.1 µm of
   * straight. The pinned kernel's extrude reads that nearly straight parabola
   * as a circle (it fits one of radius 302 mm to 1e-5) and builds its wall as
   * that cylinder, which misses the wall's own bezier cap edges by up to
   * 10 µm; every exact boolean that has to trim the wall then refuses. The
   * adapter now splits such a curve, exactly, into pieces the kernel reads
   * as lines (`kernelSafeBezierPieces`).
   */
  describe('a nearly straight glyph curve the kernel reads as a circle', () => {
    // Open Sans 'b' at em 10, outer loop segment 14, placed at (20, 20).
    const A = { x: 21.62109375, y: 24.5849609375 };
    const C = { x: 21.630859375, y: 24.755859375 };
    const B = { x: 21.64794921875, y: 25.0634765625 };

    function controlPoints(segment: TextSegment): Vec2Like[] {
      if (segment.kind === 'line') return [segment.a, segment.b];
      if (segment.kind === 'quadratic') {
        return [segment.a, segment.control, segment.b];
      }
      return [segment.a, segment.control1, segment.control2, segment.b];
    }

    function quadraticParams(points: readonly Vec2Like[]): Float64Array {
      const count = points.length;
      return Float64Array.from([
        count - 1,
        count,
        ...Array<number>(count).fill(0),
        ...Array<number>(count).fill(1),
        ...points.flatMap((point) => [point.x, point.y]),
        ...Array<number>(count).fill(1)
      ]);
    }

    /** A prism on the bezier A-C-B closed by two lines, from z0 down. */
    function sliverPrism(
      kernel: RemusKernel,
      curves: readonly (readonly Vec2Like[])[],
      z0: number,
      depth: number
    ): number {
      const apex = { x: 21.6650390625, y: 27.59765625 };
      const last = curves.at(-1)!.at(-1)!;
      const edges = [
        ...curves.map((points) =>
          kernel.liftCurve2dToPlane(
            3,
            quadraticParams(points),
            0,
            0,
            z0,
            1,
            0,
            0,
            0,
            0,
            1,
            0,
            1
          )
        ),
        kernel.makeLineEdge(last.x, last.y, z0, apex.x, apex.y, z0),
        kernel.makeLineEdge(apex.x, apex.y, z0, A.x, A.y, z0)
      ];
      const face = kernel.makePlanarFaceFromWire(
        kernel.makeWire(Uint32Array.from(edges), true)
      );
      return kernel.extrude(face, 0, 0, -1, depth);
    }

    function curvedWallTypes(kernel: RemusKernel, solid: number): string[] {
      return Array.from(kernel.getSolidFaces(solid))
        .map((face) => kernel.getSurfaceType(face))
        .filter((type) => type !== 'plane');
    }

    it('pins the kernel defect on a three-edge prism', () => {
      // A kernel canary, not app behaviour. When this fails the pinned
      // kernel stopped misreading the curve (the remus extrude side-face
      // path gained the exact-circle check its cap-edge pass already has),
      // and kernelSafeBezierPieces can be retired.
      const kernel = new RemusKernel();
      try {
        const slab = kernel.makeBox(62, 50, 10);
        const crossing = sliverPrism(kernel, [[A, C, B]], 10.5, 2.5);
        expect(curvedWallTypes(kernel, crossing)).toEqual(['cylinder']);
        expect(() =>
          kernel.booleanWithQuality('cut', slab, crossing, true)
        ).toThrow(/exact-only/);
        // Buried in the slab, so no face crosses the wall, it cuts.
        const buried = sliverPrism(kernel, [[A, C, B]], 9.5, 2);
        expect(
          kernel.booleanWithQuality('cut', slab, buried, true).quality
        ).toBe('exact');

        // The same curve as the adapter now hands it over: split exactly,
        // every piece a ruled B-spline wall, and the cut goes through.
        const curve: BezierRegionCurve = {
          kind: 'bezier',
          a: A,
          b: B,
          controls: [C],
          sourceObjectId: 'probe'
        };
        const pieces = kernelSafeBezierPieces(curve);
        expect(pieces.length).toBeGreaterThan(1);
        const split = sliverPrism(
          kernel,
          pieces.map((piece) => [piece.a, ...piece.controls, piece.b]),
          10.5,
          2.5
        );
        expect(curvedWallTypes(kernel, split)).toEqual(
          pieces.map(() => 'bspline')
        );
        const cut = kernel.booleanWithQuality('cut', slab, split, true);
        expect(cut.quality).toBe('exact');
        // The split tool removes its own footprint, 2 mm deep. (The volume
        // integrator is good to ~1e-5 relative on spline walls.)
        const footprint = kernel.volume(split, 0.08) / 2.5;
        expect(
          (62 * 50 * 10 - kernel.volume(cut.solid, 0.08)) / 2 / footprint
        ).toBeCloseTo(1, 4);
      } finally {
        kernel.free();
      }
    });

    it("predicts the kernel's verdict on every Open Sans glyph curve", () => {
      // The adapter only splits what the kernel would misread, so the
      // prediction has to agree with the pinned kernel itself. A curve and
      // its chord make a D-shaped face; its curved wall shows the verdict.
      const kernel = new RemusKernel();
      let curves = 0;
      let circles = 0;
      let refused = 0;
      try {
        for (const size of [5, 10]) {
          const set = buildTextProfileSet(openSans, {
            text: 'abdghjpqvwAKMNQW46',
            size
          });
          for (const region of set.regions) {
            for (const loop of [region.outer, ...region.holes]) {
              for (const segment of loop.segments) {
                if (segment.kind === 'line') continue;
                const points = controlPoints(segment);
                const first = points[0]!;
                const last = points.at(-1)!;
                const face = kernel.makePlanarFaceFromWire(
                  kernel.makeWire(
                    Uint32Array.of(
                      kernel.liftCurve2dToPlane(
                        3,
                        quadraticParams(points),
                        0,
                        0,
                        0,
                        1,
                        0,
                        0,
                        0,
                        0,
                        1,
                        0,
                        1
                      ),
                      kernel.makeLineEdge(
                        last.x,
                        last.y,
                        0,
                        first.x,
                        first.y,
                        0
                      )
                    ),
                    true
                  )
                );
                const flagged = kernelReadsBezierAsCircle(points);
                let solid: number;
                try {
                  solid = kernel.extrude(face, 0, 0, 1, 1);
                } catch (error) {
                  // The same misreading, met earlier: the cap-edge pass
                  // recognizes the curve as a circle, then refuses it on
                  // its own midpoint check. Only a flagged curve may do it.
                  expect(String(error)).toMatch(/recognized extrude circle/);
                  expect(flagged).toBe(true);
                  refused += 1;
                  continue;
                }
                const cylinder = curvedWallTypes(kernel, solid).includes(
                  'cylinder'
                );
                expect(flagged).toBe(cylinder);
                curves += 1;
                if (cylinder) circles += 1;
              }
            }
          }
        }
      } finally {
        kernel.free();
      }
      // Both verdicts must actually occur for the agreement to mean much.
      expect(curves).toBeGreaterThan(200);
      expect(circles).toBeGreaterThan(5);
      expect(refused).toBeLessThan(curves / 10);
    });

    it('subdivides large Lora glyph curves beyond the small-count search', async () => {
      const font = await library.load('lora', 'regular');
      const profiles = buildTextProfileSet(font, { text: 'F', size: 180 });
      let largestSplit = 0;
      let flagged = 0;
      for (const region of profiles.regions) {
        for (const segment of region.outer.segments) {
          if (segment.kind === 'line') continue;
          const points = controlPoints(segment);
          if (!kernelReadsBezierAsCircle(points)) continue;
          const curve: BezierRegionCurve = {
            kind: 'bezier',
            a: segment.a,
            b: segment.b,
            controls:
              segment.kind === 'quadratic'
                ? [segment.control]
                : [segment.control1, segment.control2],
            sourceObjectId: 'large-glyph-probe'
          };
          flagged += 1;
          const pieces = kernelSafeBezierPieces(curve);
          largestSplit = Math.max(largestSplit, pieces.length);
          expect(pieces[0]!.a).toBe(curve.a);
          expect(pieces.at(-1)!.b).toBe(curve.b);
          for (const piece of pieces) {
            expect(
              kernelReadsBezierAsCircle([piece.a, ...piece.controls, piece.b])
            ).toBe(false);
          }
        }
      }
      expect(flagged).toBeGreaterThan(0);
      expect(largestSplit).toBeGreaterThan(64);
      expect(largestSplit).toBeLessThanOrEqual(1024);
    });

    it('splits exactly, sharing every joint', () => {
      const curve: BezierRegionCurve = {
        kind: 'bezier',
        a: A,
        b: B,
        controls: [C],
        sourceObjectId: 'probe'
      };
      const pieces = kernelSafeBezierPieces(curve);
      expect(pieces[0]!.a).toBe(A);
      expect(pieces.at(-1)!.b).toBe(B);
      for (let index = 1; index < pieces.length; index += 1) {
        expect(pieces[index]!.a).toBe(pieces[index - 1]!.b);
      }
      // Every piece traces the original polynomial: piece k over [0, 1] is
      // the curve over [k/n, (k+1)/n].
      const at = (points: readonly Vec2Like[], t: number): Vec2Like => {
        const [p0, p1, p2] = points as [Vec2Like, Vec2Like, Vec2Like];
        const u = 1 - t;
        return {
          x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
          y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y
        };
      };
      pieces.forEach((piece, index) => {
        for (const t of [0.25, 0.5, 0.75]) {
          const mine = at([piece.a, ...piece.controls, piece.b], t);
          const original = at([A, C, B], (index + t) / pieces.length);
          expect(
            Math.hypot(mine.x - original.x, mine.y - original.y)
          ).toBeLessThan(1e-12);
        }
        expect(
          kernelReadsBezierAsCircle([piece.a, ...piece.controls, piece.b])
        ).toBe(false);
      });
      // A curve the kernel reads correctly is handed over untouched.
      const round: BezierRegionCurve = {
        ...curve,
        controls: [{ x: 22, y: 24.8 }]
      };
      expect(kernelSafeBezierPieces(round)).toEqual([round]);
    });

    const SLAB = { width: 62, height: 50, depth: 10 } as const;

    function labelScene(
      text: string,
      distance: number,
      options: { offset?: number; rotation?: number } = {}
    ): { document: ProjectDocument; sketchId: SketchId; objectId: EntityId } {
      const withBox = addPrimitiveFeature(
        createProjectDocument('Label', toUserId('user_text_label')),
        { name: 'Slab', primitiveKind: 'box', dimensions: { ...SLAB } }
      );
      const slabId = withBox.bodyOrder.at(-1)!;
      const created = addSketchFeature(withBox, {
        name: 'Label',
        planeRef: {
          type: 'canonical',
          plane: 'XY',
          offset: options.offset ?? SLAB.depth
        },
        objects: [
          textObject(text, {
            size: 10,
            x: 20,
            y: 20,
            ...(options.rotation === undefined
              ? {}
              : { rotation: options.rotation })
          })
        ]
      });
      const objectId = findSketch(created.document, created.sketchId)!
        .objectIds[0]!;
      const document = extrudeSketch(created.document, {
        name: 'Label text',
        sketchId: created.sketchId,
        distance,
        operation: distance < 0 ? 'cut' : 'add',
        targetBodyId: slabId,
        profiles: [{ all: true, sourceEntityIds: [objectId] }]
      }).document;
      return { document, sketchId: created.sketchId, objectId };
    }

    async function expectLabel(
      document: ProjectDocument,
      text: string,
      depth: number
    ): Promise<BodyRepresentation> {
      const derived = await adapter.syncDocument(document);
      expect(derived.featureWarnings ?? []).toEqual([]);
      expect(derived.warnings).toEqual([]);
      const body = bodyOf(derived);
      const glyphs = textArea(openSans, text, 10) * Math.abs(depth);
      const slab = SLAB.width * SLAB.height * SLAB.depth;
      expect(
        volumeRatio(body, depth < 0 ? slab - glyphs : slab + glyphs)
      ).toBeCloseTo(1, 5);
      const closure = inspectTriangleMeshClosure(
        body.mesh.vertices,
        body.mesh.indices
      );
      expect(closure.boundaryEdges).toBe(0);
      expect(closure.nonManifoldEdges).toBe(0);
      return body;
    }

    it("cuts a 'b' whose walls cross the face", async () => {
      // Sketched 0.5 above the face and cut 2.5 down: a genuine through-face
      // tool with no coplanar cap, so the pierce never runs.
      await expectLabel(
        labelScene('b', -2.5, { offset: SLAB.depth + 0.5 }).document,
        'b',
        -2
      );
    });

    it("engraves and embosses 'Bob' on the face, upright and turned", async () => {
      const engraved = await expectLabel(
        labelScene('Bob', -2).document,
        'Bob',
        -2
      );
      expect(engraved.bbox.max.z).toBeGreaterThanOrEqual(SLAB.depth);
      expect(engraved.bbox.max.z).toBeLessThan(SLAB.depth + 0.005);
      await expectLabel(labelScene('Bob', 2).document, 'Bob', 2);
      await expectLabel(
        labelScene('Bob', -2, { rotation: 89 }).document,
        'Bob',
        -2
      );
    });

    it("re-enters an engraved 'Boa' and retypes it to 'Bob'", async () => {
      // The reported flow: the edit used to be refused with "Subtract
      // refused ... The sketch edit was not saved."
      const scene = labelScene('Boa', -2);
      await expectLabel(scene.document, 'Boa', -2);
      const edited = updateSketchObject(scene.document, {
        sketchId: scene.sketchId,
        objectId: scene.objectId,
        data: textObject('Bob', { size: 10, x: 20, y: 20 })
      });
      await expectLabel(edited, 'Bob', -2);
    });
  });
});
