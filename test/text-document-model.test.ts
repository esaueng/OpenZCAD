/**
 * The property this whole feature stands on: editing a text object's string
 * must not break the extrude that consumes it.
 *
 * Extrude profile references are fail-closed and normally match on region
 * fingerprint, area and sample point. Every one of those changes when "HI"
 * becomes "HELLO" — and so does the number of regions — so the ordinary
 * matching tiers cannot survive the edit. The `{ all: true, sourceEntityIds }`
 * reference matches on entity identity alone, and that is what is exercised
 * here, end to end through `resolveRegionProfiles` and a real document.
 *
 * The region sets are real: they come from the bundled fonts through the
 * Phase 1 glyph pipeline, so the counts, areas and hole structure are the ones
 * the kernel will actually see.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import {
  CommandManager,
  commandFactories,
  commandsForCadPatch,
  replayCommands
} from '@openzcad/command-system';
import {
  addSketchFeature,
  addSketchObjects,
  createProjectDocument,
  extrudeSketch,
  findSketch,
  getLatestSketchId,
  normalizeDocument,
  resolveParamValue,
  updateSketchObject
} from '@openzcad/document-core';
import {
  buildTextProfileSet,
  computeSketchProfileAnalysis,
  flattenLoop,
  regionFingerprintOf,
  type RegionLoop,
  type SketchProfile,
  type SketchProfileSource,
  type SketchRegionObject,
  type TextLoop,
  type TextRegion
} from '@openzcad/geometry';
import {
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type EntityId,
  type FeatureNode,
  type ProjectDocument,
  type SketchNode,
  type SketchObjectData
} from '@openzcad/shared';
import { resolveRegionProfiles } from '../packages/kernel-adapter/src/region-profile';
import { FontLibrary } from '../packages/geometry/src/text/loader';
import { nodeFontDataSource } from '../packages/geometry/src/text/nodeFontSource';
import type { LoadedFont } from '../packages/geometry/src/text/loader';

const user = () => toUserId('user_text');

// ---------------------------------------------------------------------------
// A text profile source, standing in for the Phase 3 adapter.
//
// `computeSketchProfileAnalysis` is synchronous and pure; glyph outlines need
// font bytes, which are fetched. Phase 2 therefore only opens the seam — this
// is the caller-side implementation the tests inject, built on the real
// Phase 1 pipeline. Loops are flattened because `RegionCurve` has no bezier
// kind yet; that is Phase 3's job and is irrelevant to reference resolution,
// which never looks at curve kinds.
// ---------------------------------------------------------------------------

const FLATTEN_TOLERANCE_RATIO = 1 / 500;

function loopFrom(
  loop: TextLoop,
  objectId: string,
  tolerance: number
): RegionLoop {
  const polyline = flattenLoop(loop.segments, tolerance);
  const curves = polyline.map((a, index) => ({
    kind: 'line' as const,
    a,
    b: polyline[(index + 1) % polyline.length]!,
    sourceObjectId: objectId
  }));
  return { curves, polyline };
}

function profileFrom(
  region: TextRegion,
  objectId: string,
  tolerance: number
): SketchProfile {
  const outer = loopFrom(region.outer, objectId, tolerance);
  const holes = region.holes.map((hole) => loopFrom(hole, objectId, tolerance));
  const regionFingerprint = regionFingerprintOf(outer, holes);
  return {
    profileId: `${objectId}:${regionFingerprint}:${region.boundingBox.min.x.toFixed(6)}`,
    regionFingerprint,
    sourceEntityIds: [objectId],
    outer,
    holes,
    signedArea: region.area,
    area: region.area,
    centroid: region.samplePoint,
    boundingBox: region.boundingBox,
    validity: 'valid',
    diagnostics: [],
    samplePoint: region.samplePoint
  };
}

function textProfileSource(
  fonts: Map<string, LoadedFont>
): SketchProfileSource {
  return (object: SketchRegionObject, resolve) => {
    const data = object.data;
    if (data.objectKind !== 'text') {
      return null;
    }
    const font = fonts.get(`${data.fontFamily}|${data.fontStyle}`);
    if (!font) {
      throw new Error(`Test font ${data.fontFamily} was not preloaded.`);
    }
    const size = resolve(data.size);
    const set = buildTextProfileSet(font, {
      text: data.text,
      size,
      x: resolve(data.x),
      y: resolve(data.y),
      rotation:
        data.rotation === undefined
          ? 0
          : (resolve(data.rotation) * Math.PI) / 180,
      align: data.align
    });
    return set.regions.map((region) =>
      profileFrom(region, object.id, size * FLATTEN_TOLERANCE_RATIO)
    );
  };
}

// ---------------------------------------------------------------------------
// Document scaffolding.
// ---------------------------------------------------------------------------

type TextObjectData = Extract<SketchObjectData, { objectKind: 'text' }>;

function textObject(text: string, size = 10): TextObjectData {
  return {
    objectKind: 'text',
    text,
    fontFamily: 'open-sans',
    fontStyle: 'regular',
    size,
    x: 0,
    y: 0
  };
}

interface TextScene {
  document: ProjectDocument;
  textObjectId: EntityId;
  sketch: SketchNode;
  extrude: Extract<FeatureNode['data'], { featureKind: 'extrude' }>;
}

function sketchNode(document: ProjectDocument, sketchId: string): SketchNode {
  const sketch = findSketch(document, sketchId as SketchNode['sketchId']);
  if (!sketch) {
    throw new Error('sketch missing');
  }
  return sketch;
}

function extrudeData(
  document: ProjectDocument
): Extract<FeatureNode['data'], { featureKind: 'extrude' }> {
  for (const node of Object.values(document.nodes)) {
    if (node.kind === 'feature' && node.data.featureKind === 'extrude') {
      return node.data;
    }
  }
  throw new Error('extrude missing');
}

/** A sketch holding one text object, extruded through an `all: true` reference. */
function textScene(text: string, size = 10): TextScene {
  const created = addSketchFeature(createProjectDocument('Text', user()), {
    name: 'Text sketch',
    planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
    objects: [textObject(text, size)]
  });
  const sketch = sketchNode(created.document, created.sketchId);
  const textObjectId = sketch.objectIds[0]!;
  const document = extrudeSketch(created.document, {
    name: 'Raised text',
    sketchId: created.sketchId,
    distance: 2,
    profiles: [{ all: true, sourceEntityIds: [textObjectId] }]
  }).document;
  return {
    document,
    textObjectId,
    sketch: sketchNode(document, created.sketchId),
    extrude: extrudeData(document)
  };
}

/** Replaces the text object's data, exactly as the inspector edit does. */
function editText(
  scene: TextScene,
  data: SketchObjectData
): { scene: TextScene; document: ProjectDocument } {
  const document = updateSketchObject(scene.document, {
    sketchId: scene.sketch.sketchId,
    objectId: scene.textObjectId,
    data
  });
  return {
    document,
    scene: {
      ...scene,
      document,
      sketch: sketchNode(document, scene.sketch.sketchId),
      extrude: extrudeData(document)
    }
  };
}

function resolve(scene: TextScene, source: SketchProfileSource) {
  return resolveRegionProfiles(
    scene.document,
    scene.sketch,
    scene.extrude,
    {},
    { profileSource: source }
  );
}

// ---------------------------------------------------------------------------

describe('text document model', () => {
  let source: SketchProfileSource;

  beforeAll(async () => {
    const library = new FontLibrary(nodeFontDataSource());
    const fonts = new Map<string, LoadedFont>();
    fonts.set('open-sans|regular', await library.load('open-sans', 'regular'));
    fonts.set('open-sans|bold', await library.load('open-sans', 'bold'));
    source = textProfileSource(fonts);
  });

  it('survives a text edit that changes the number of regions', () => {
    const scene = textScene('HI');
    const before = resolve(scene, source);
    // H and I: two disconnected regions, no counters.
    expect(before).toHaveLength(2);
    expect(before.every((profile) => profile.holes.length === 0)).toBe(true);

    const { scene: edited } = editText(scene, textObject('HELLO'));
    const after = resolve(edited, source);

    // Five letters, and the O contributes the only counter.
    expect(after).toHaveLength(5);
    expect(after.filter((profile) => profile.holes.length === 1)).toHaveLength(
      1
    );
    expect(after.map((profile) => profile.sourceEntityIds)).toEqual(
      Array.from({ length: 5 }, () => [scene.textObjectId])
    );
  });

  it('is the only reference mode that survives that edit', () => {
    // The same document and the same edit, resolved through an ordinary
    // stored region reference. This is what the feature would do without the
    // entity-wide mode, and it must fail — otherwise the test above proves
    // nothing about why the new mode is needed.
    const scene = textScene('HI');
    const before = resolve(scene, source);
    const letterI = [...before].sort((a, b) => a.area - b.area)[0]!;
    const storedReference = {
      featureKind: 'extrude' as const,
      sketchId: scene.sketch.sketchId,
      distance: 2,
      profiles: [
        {
          profileId: letterI.profileId,
          regionFingerprint: letterI.regionFingerprint,
          samplePoint: letterI.samplePoint,
          sourceArea: letterI.area,
          sourceEntityIds: letterI.sourceEntityIds
        }
      ]
    };

    // It resolves before the edit...
    expect(
      resolveRegionProfiles(
        scene.document,
        scene.sketch,
        storedReference,
        {},
        { profileSource: source }
      )
    ).toHaveLength(1);

    // ...and breaks after it, because "HELLO" has no 'I' at that position.
    const { scene: edited } = editText(scene, textObject('HELLO'));
    expect(() =>
      resolveRegionProfiles(
        edited.document,
        edited.sketch,
        storedReference,
        {},
        { profileSource: source }
      )
    ).toThrow(/Broken profile reference/);

    // The entity-wide reference in the same document resolves fine.
    expect(resolve(edited, source)).toHaveLength(5);
  });

  it('resolves after a size-only edit', () => {
    const scene = textScene('HI', 10);
    const before = resolve(scene, source);
    const { scene: edited } = editText(scene, textObject('HI', 25));
    const after = resolve(edited, source);

    expect(after).toHaveLength(before.length);
    // Same glyphs, 2.5x the em size: area scales with the square.
    const beforeArea = before.reduce((sum, p) => sum + p.area, 0);
    const afterArea = after.reduce((sum, p) => sum + p.area, 0);
    expect(afterArea / beforeArea).toBeCloseTo(6.25, 3);
    // And it really is a different region set — the old references would
    // have had nothing to match.
    expect(after[0]!.regionFingerprint).not.toBe(before[0]!.regionFingerprint);
  });

  it('resolves after a font-style edit', () => {
    const scene = textScene('HI');
    const before = resolve(scene, source);
    const { scene: edited } = editText(scene, {
      ...textObject('HI'),
      fontStyle: 'bold'
    });
    const after = resolve(edited, source);

    expect(after).toHaveLength(before.length);
    expect(after.reduce((sum, p) => sum + p.area, 0)).toBeGreaterThan(
      before.reduce((sum, p) => sum + p.area, 0)
    );
  });

  it('shrinking the string still resolves', () => {
    const scene = textScene('HELLO');
    expect(resolve(scene, source)).toHaveLength(5);
    const { scene: edited } = editText(scene, textObject('I'));
    expect(resolve(edited, source)).toHaveLength(1);
  });

  it('covers only the referenced entity in a mixed sketch', () => {
    const created = addSketchFeature(createProjectDocument('Mixed', user()), {
      name: 'Mixed sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [textObject('HI')]
    });
    const textId = sketchNode(created.document, created.sketchId).objectIds[0]!;
    const withRectangle = addSketchObjects(created.document, {
      sketchId: created.sketchId,
      objects: [
        {
          objectKind: 'rectangle',
          width: 200,
          height: 200,
          centerX: 0,
          centerY: -100
        }
      ]
    }).document;
    const document = extrudeSketch(withRectangle, {
      name: 'Raised text',
      sketchId: created.sketchId,
      distance: 2,
      profiles: [{ all: true, sourceEntityIds: [textId] }]
    }).document;

    const sketch = sketchNode(document, created.sketchId);
    const objects = sketch.objectIds.map((id) => {
      const node = document.nodes[id];
      if (node?.kind !== 'sketch-object') {
        throw new Error('object missing');
      }
      return { id: node.id, data: node.data };
    });
    // The rectangle really is producing a profile of its own, so excluding it
    // is a decision the resolver makes rather than an accident.
    expect(
      computeSketchProfileAnalysis(
        objects,
        (value) => resolveParamValue(value, {}, 'sketch dimension'),
        undefined,
        { profileSource: source }
      ).profiles
    ).toHaveLength(3);

    const profiles = resolveRegionProfiles(
      document,
      sketch,
      extrudeData(document),
      {},
      { profileSource: source }
    );

    expect(profiles).toHaveLength(2);
    expect(
      profiles.every((profile) => profile.sourceEntityIds.join() === textId)
    ).toBe(true);
  });

  it('fails closed when the referenced entity bounds nothing', () => {
    const scene = textScene('HI');
    // A space has an advance but no outline, so the entity now bounds no
    // region at all. That is an error, not an extrude of nothing.
    const { scene: edited } = editText(scene, {
      ...textObject('HI'),
      text: ' '
    });
    expect(() => resolve(edited, source)).toThrow(
      /no longer bound any closed region/
    );
  });

  it('resolves the size through the parameter scope, not just literals', () => {
    const created = addSketchFeature(createProjectDocument('Param', user()), {
      name: 'Parametric text',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [{ ...textObject('HI'), size: 'labelSize * 2' }]
    });
    const textId = sketchNode(created.document, created.sketchId).objectIds[0]!;
    const document = extrudeSketch(created.document, {
      name: 'Raised text',
      sketchId: created.sketchId,
      distance: 2,
      profiles: [{ all: true, sourceEntityIds: [textId] }]
    }).document;

    const profiles = resolveRegionProfiles(
      document,
      sketchNode(document, created.sketchId),
      extrudeData(document),
      { labelSize: 5 },
      { profileSource: source }
    );
    const literalScene = textScene('HI', 10);
    const literal = resolve(literalScene, source);

    expect(profiles.reduce((sum, p) => sum + p.area, 0)).toBeCloseTo(
      literal.reduce((sum, p) => sum + p.area, 0),
      6
    );
  });
});

describe('text through the command log', () => {
  it('replays a text object and an edit to it', () => {
    const base = createProjectDocument('Text', user());
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addSketch({
        name: 'Label',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [textObject('HI')]
      })
    );
    const sketchId = getLatestSketchId(manager.document)!;
    const objectId = sketchNode(manager.document, sketchId).objectIds[0]!;
    manager.execute(
      commandFactories.updateSketchObject({
        sketchId,
        objectId,
        data: textObject('HELLO', 25)
      })
    );

    const replayed = replayCommands(base, manager.document.commandLog);
    const replayedNode = replayed.nodes[objectId];
    if (replayedNode?.kind !== 'sketch-object') {
      throw new Error('text object did not survive replay');
    }
    expect(replayedNode.objectKind).toBe('text');
    expect(replayedNode.data).toEqual(textObject('HELLO', 25));
  });

  it('accepts a text object from a reviewed AI patch', () => {
    const manager = new CommandManager(
      createProjectDocument('AI text', user())
    );
    const commands = commandsForCadPatch(manager.document, {
      proposalId: 'proposal_text',
      summary: 'Label the plate.',
      assumptions: [],
      operations: [
        { kind: 'set_parameter', name: 'labelSize', expression: '12' },
        {
          kind: 'add_sketch',
          name: 'Label',
          plane: 'XY',
          offset: 0,
          localId: null,
          objects: [
            {
              objectKind: 'text',
              text: 'OPENZCAD',
              fontFamily: 'open-sans',
              fontStyle: 'regular',
              // The whole point of ParamValue fields: a driven text size.
              size: 'labelSize',
              x: 0,
              y: 0
            }
          ]
        }
      ]
    });
    manager.runTransaction('Apply text patch', commands);

    const sketchId = getLatestSketchId(manager.document)!;
    const node =
      manager.document.nodes[
        sketchNode(manager.document, sketchId).objectIds[0]!
      ];
    if (node?.kind !== 'sketch-object' || node.data.objectKind !== 'text') {
      throw new Error('the patch did not produce a text object');
    }
    expect(node.data.text).toBe('OPENZCAD');
    expect(node.data.size).toBe('labelSize');
  });

  it('rejects an AI text object whose size is not an expression', () => {
    const manager = new CommandManager(
      createProjectDocument('AI text', user())
    );
    expect(() =>
      commandsForCadPatch(manager.document, {
        proposalId: 'proposal_text',
        summary: 'Label the plate.',
        assumptions: [],
        operations: [
          {
            kind: 'add_sketch',
            name: 'Label',
            plane: 'XY',
            offset: 0,
            localId: null,
            objects: [
              {
                objectKind: 'text',
                text: 'OPENZCAD',
                fontFamily: 'open-sans',
                fontStyle: 'regular',
                size: 'noSuchParameter * 2',
                x: 0,
                y: 0
              }
            ]
          }
        ]
      })
    ).toThrow();
  });
});

describe('existing documents are unaffected', () => {
  it('replays a document with no text objects identically', () => {
    const base = createProjectDocument('Legacy', user());
    const manager = new CommandManager(base);
    manager.execute(
      commandFactories.addSketch({
        name: 'Sketch 1',
        planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
        objects: [
          {
            objectKind: 'rectangle',
            width: 20,
            height: 10,
            centerX: 0,
            centerY: 0
          }
        ]
      })
    );
    const replayed = replayCommands(base, manager.document.commandLog);
    expect(replayed.nodes).toEqual(manager.document.nodes);
    expect(replayed.sketchOrder).toEqual(manager.document.sketchOrder);
  });

  it('normalizes a v6 document with no text objects unchanged', () => {
    const created = addSketchFeature(createProjectDocument('Legacy', user()), {
      name: 'Sketch 1',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 20,
          height: 10,
          centerX: 0,
          centerY: 0
        }
      ]
    });
    const current = extrudeSketch(created.document, {
      name: 'Extrude',
      sketchId: created.sketchId,
      distance: 5
    }).document;
    const legacy = structuredClone(current);
    legacy.schemaVersion = 6 as typeof legacy.schemaVersion;

    const migrated = normalizeDocument(legacy);

    expect(migrated.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(PROJECT_DOCUMENT_SCHEMA_VERSION).toBe(7);
    // Nothing but the version stamp moves.
    expect({ ...migrated, schemaVersion: 6 }).toEqual(legacy);
  });

  it('still resolves a stored region reference by fingerprint', () => {
    const created = addSketchFeature(createProjectDocument('Legacy', user()), {
      name: 'Sketch 1',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        {
          objectKind: 'rectangle',
          width: 20,
          height: 10,
          centerX: 0,
          centerY: 0
        },
        { objectKind: 'circle', radius: 3, centerX: 0, centerY: 0 }
      ]
    });
    const sketch = sketchNode(created.document, created.sketchId);
    const objects = sketch.objectIds.map((id) => {
      const node = created.document.nodes[id];
      if (node?.kind !== 'sketch-object') {
        throw new Error('object missing');
      }
      return { id: node.id, data: node.data };
    });
    // The ring between the rectangle and the circle.
    const ring = computeSketchProfileAnalysis(objects, (value) =>
      resolveParamValue(value, {}, 'sketch dimension')
    ).profiles.find((profile) => profile.holes.length === 1)!;
    const document = extrudeSketch(created.document, {
      name: 'Extrude',
      sketchId: created.sketchId,
      distance: 5,
      profiles: [
        {
          profileId: ring.profileId,
          regionFingerprint: ring.regionFingerprint,
          samplePoint: ring.samplePoint,
          sourceArea: ring.area,
          sourceEntityIds: ring.sourceEntityIds
        }
      ]
    }).document;

    const resolved = resolveRegionProfiles(
      document,
      sketchNode(document, created.sketchId),
      extrudeData(document),
      {}
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.profileId).toBe(ring.profileId);
    expect(resolved[0]!.holes).toHaveLength(1);
  });
});
