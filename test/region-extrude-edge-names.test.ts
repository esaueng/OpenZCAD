import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import {
  addSketchConstraint,
  addSketchFeature,
  createProjectDocument,
  extrudeSketch,
  filletEdges,
  findSketch,
  holeBody,
  updateFeature
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type DerivedState,
  type EdgeTopology,
  type ProjectDocument,
  type SketchConstraintData,
  type SketchId,
  type SketchObjectData
} from '@openzcad/shared';
import { solvedSketchCommands } from '../apps/web/src/lib/sketch/applySolve';
import { checkSketchEdit } from '../apps/web/src/lib/sketch/editing';

/**
 * Issue #1663: a plate extruded from a rectangle drawn as four lines, with a
 * Fillet on its front top edge and a Hole in its top face, refused every
 * edit of the sketch's driving width: "Fillet can no longer find an edge or
 * face it was applied to".
 *
 * An extrude of selected sketch regions named its faces by the sketch
 * entities that draw them but named none of its edges, so every edge picked
 * on such a body was stored as a bare geometry hash. The width edit moves
 * the edge, its hash stops matching, and the hash carry
 * (`exact-carry-edit-gate.ts`) rightly refuses a re-solve that rewrites
 * line endpoints. The extrude now names each edge that is the only boundary
 * between two of its named faces, so the pick is stored by name and follows
 * the edge like a pick on a primitive does.
 */

const user = toUserId('user_region_extrude_edge_names');
const X0 = -3.212;
const WIDTH = 45;
const DEPTH = 25;
const THICKNESS = 8;
const RADIUS = 7.5;
const HOLE = 8;

const line = (
  x1: number,
  y1: number,
  x2: number,
  y2: number
): SketchObjectData => ({ objectKind: 'line', x1, y1, x2, y2 });

/** Whether every sampled point of the edge satisfies `test`. */
function liesOn(
  edge: EdgeTopology,
  test: (x: number, y: number, z: number) => boolean
) {
  for (let index = 0; index < edge.points.length; index += 3) {
    if (
      !test(
        edge.points[index]!,
        edge.points[index + 1]!,
        edge.points[index + 2]!
      )
    )
      return false;
  }
  return true;
}

/** The plate's top edge along its front (y = 0) side. */
const frontTop = (body: BodyRepresentation) =>
  body.topology!.edges.filter((edge) =>
    liesOn(
      edge,
      (_x, y, z) => Math.abs(y) < 1e-6 && Math.abs(z - THICKNESS) < 1e-6
    )
  );

/** Plate volume with the R7.5 front-top fillet and the Ø8 through hole. */
const expectedVolume = (width: number) =>
  width * DEPTH * THICKNESS -
  RADIUS * RADIUS * (1 - Math.PI / 4) * width -
  Math.PI * (HOLE / 2) ** 2 * THICKNESS;

describe('#1663 edges of an extruded sketch region are named', () => {
  let adapter: ExactKernelAdapter;
  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  }, 120_000);
  afterAll(() => adapter.dispose());

  const validate = (document: ProjectDocument) =>
    adapter.syncDocument(document, undefined, undefined, undefined, {
      proposeCarry: true
    });

  /**
   * The issue's sketch: four lines closed by coincident corners, held
   * horizontal and vertical, with a driving 45 width and 25 height and no
   * relation to the origin (two positional degrees of freedom left).
   */
  function plate() {
    const x1 = X0 + WIDTH;
    const sketched = addSketchFeature(createProjectDocument('Plate', user), {
      name: 'Sketch',
      planeRef: { type: 'canonical', plane: 'XY', offset: 0 },
      objects: [
        line(X0, 0, x1, 0),
        line(x1, 0, x1, DEPTH),
        line(x1, DEPTH, X0, DEPTH),
        line(X0, DEPTH, X0, 0)
      ]
    });
    let document = sketched.document;
    const sketchId = sketched.sketchId;
    const ids = findSketch(document, sketchId)!.objectIds;
    const constraints: SketchConstraintData[] = [
      ...ids.map((id, index): SketchConstraintData => ({
        constraintKind: 'coincident',
        a: { objectId: id, point: 'end' },
        b: { objectId: ids[(index + 1) % ids.length]!, point: 'start' }
      })),
      { constraintKind: 'horizontal', objectId: ids[0]! },
      { constraintKind: 'vertical', objectId: ids[1]! },
      { constraintKind: 'horizontal', objectId: ids[2]! },
      { constraintKind: 'vertical', objectId: ids[3]! },
      {
        constraintKind: 'distance',
        a: { objectId: ids[2]!, point: 'start' },
        b: { objectId: ids[2]!, point: 'end' },
        value: WIDTH
      },
      {
        constraintKind: 'distance',
        a: { objectId: ids[1]!, point: 'start' },
        b: { objectId: ids[1]!, point: 'end' },
        value: DEPTH
      }
    ];
    for (const constraint of constraints) {
      document = addSketchConstraint(document, {
        sketchId,
        constraint
      }).document;
    }
    const extruded = extrudeSketch(document, {
      name: 'Extrude',
      sketchId,
      distance: THICKNESS,
      profiles: [{ all: true, sourceEntityIds: [...ids] }]
    });
    return {
      document: extruded.document,
      sketchId,
      plateId: extruded.bodyId
    };
  }

  /**
   * Plate → Fillet R7.5 on the front top edge → Ø8 through Hole in the top.
   * `named` stores the pick as the viewport does (hashes, and names when
   * the edge has one); otherwise as bare hashes, the way documents saved
   * before the edges had names hold it.
   */
  async function part(named: boolean) {
    const base = plate();
    let derived = await adapter.syncDocument(base.document);
    expect(derived.warnings).toEqual([]);
    const picked = frontTop(derived.bodyRepresentations[base.plateId]!);
    expect(picked).toHaveLength(1);
    const filleted = filletEdges(base.document, {
      name: 'Fillet',
      targetBodyId: base.plateId,
      edgeHashes: [picked[0]!.hash],
      ...(named && picked[0]!.reference
        ? { edgeReferences: [picked[0]!.reference] }
        : {}),
      size: RADIUS
    });
    derived = await adapter.syncDocument(filleted.document);
    const body = derived.bodyRepresentations[filleted.bodyId]!;
    const top = body.topology!.faces.find(
      (face) =>
        face.geometry?.surfaceType === 'plane' &&
        (face.geometry.normal?.z ?? 0) > 0.999
    )!;
    const drilled = holeBody(filleted.document, {
      name: 'Hole',
      targetBodyId: filleted.bodyId,
      faceHash: top.hash,
      ...(top.reference ? { faceReference: top.reference } : {}),
      style: 'simple',
      diameter: HOLE,
      depthMode: 'through',
      position: { u: 0, v: 0 },
      positionAnchor: 'centroid'
    });
    return {
      document: drilled.document,
      sketchId: base.sketchId,
      bodyId: drilled.bodyId
    };
  }

  /**
   * Types `width` into the sketch's existing driving width, as the sketch
   * editor does: the dimension is replaced under its own id, the sketch is
   * re-solved, the solved line ends are written back, and the whole edit is
   * checked against every feature built on the sketch before it is saved.
   */
  async function editWidth(
    base: ProjectDocument,
    sketchId: SketchId,
    from: number,
    width: number
  ): Promise<{ document: ProjectDocument; derived: DerivedState }> {
    const existing = findSketch(base, sketchId)!.constraints!.find(
      (constraint) =>
        constraint.data.constraintKind === 'distance' &&
        constraint.data.value === from
    )!;
    const replace = [
      commandFactories.deleteSketchConstraint({
        sketchId,
        constraintId: existing.constraintId
      }),
      commandFactories.addSketchConstraint({
        sketchId,
        constraint: { ...existing.data, value: width } as SketchConstraintData,
        ids: { constraintId: existing.constraintId }
      })
    ];
    let prospective = base;
    for (const command of replace) prospective = command.apply(prospective);
    const outcome = await adapter.solveSketch(prospective, sketchId);
    expect(outcome.converged).toBe(true);
    const commands = [
      ...replace,
      ...solvedSketchCommands(prospective, sketchId, outcome)
    ];
    const derived = await checkSketchEdit(base, sketchId, commands, validate);
    let document = base;
    for (const command of commands) document = command.apply(document);
    return { document, derived: derived! };
  }

  function expectPart(derived: DerivedState, bodyId: BodyId, width: number) {
    expect(derived.warnings).toEqual([]);
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body.bbox.max.x - body.bbox.min.x).toBeCloseTo(width, 6);
    expect(body.bbox.max.y - body.bbox.min.y).toBeCloseTo(DEPTH, 6);
    expect(body.bbox.max.z - body.bbox.min.z).toBeCloseTo(THICKNESS, 6);
    // The fillet still rounds the whole front top edge at R7.5 and the hole
    // still runs through: both are in the volume.
    expect(body.volume).toBeCloseTo(expectedVolume(width), 3);
  }

  it('names every edge of a plate extruded from four lines, each once', async () => {
    const { document, plateId } = plate();
    const derived = await adapter.syncDocument(document);
    expect(derived.warnings).toEqual([]);
    const edges = derived.bodyRepresentations[plateId]!.topology!.edges;
    expect(edges).toHaveLength(12);
    const names = edges.map((edge) => edge.reference?.lineageName);
    expect(names.every((name) => typeof name === 'string')).toBe(true);
    expect(new Set(names).size).toBe(12);
  });

  it('keeps the same names when the plate is rebuilt wider', async () => {
    const { document, sketchId, plateId } = plate();
    const before = await adapter.syncDocument(document);
    const name = frontTop(before.bodyRepresentations[plateId]!)[0]!.reference!
      .lineageName;
    let wider = document;
    const ids = findSketch(document, sketchId)!.objectIds;
    for (const [index, data] of [
      line(X0, 0, X0 + 50, 0),
      line(X0 + 50, 0, X0 + 50, DEPTH),
      line(X0 + 50, DEPTH, X0, DEPTH)
    ].entries()) {
      wider = commandFactories
        .updateSketchObject({ sketchId, objectId: ids[index]!, data })
        .apply(wider);
    }
    const after = await adapter.syncDocument(wider);
    const moved = frontTop(after.bodyRepresentations[plateId]!);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.reference!.lineageName).toBe(name);
    expect(moved[0]!.hash).not.toBe(
      frontTop(before.bodyRepresentations[plateId]!)[0]!.hash
    );
  });

  it('accepts the driving width edits of the issue: 45 → 46 → 50 → 45', async () => {
    const built = await part(true);
    let document = built.document;
    expectPart(await validate(document), built.bodyId, WIDTH);
    let from = WIDTH;
    for (const width of [46, 50, 45]) {
      const edited = await editWidth(document, built.sketchId, from, width);
      expectPart(edited.derived, built.bodyId, width);
      // What was checked is what a plain build of the saved document gives.
      expectPart(
        await adapter.syncDocument(edited.document),
        built.bodyId,
        width
      );
      document = edited.document;
      from = width;
    }
  }, 240_000);

  it('repairs a fillet saved before the edges had names, and then accepts the edit', async () => {
    const built = await part(false);
    // At rest the stored hash still resolves, so the build proves the
    // edge's name and offers it as a repair.
    const derived = await adapter.syncDocument(built.document);
    expect(derived.warnings).toEqual([]);
    expect(derived.referenceRepairs).toHaveLength(1);
    const repair = derived.referenceRepairs![0]!;
    expect(repair.edgeReferences).toHaveLength(1);
    // The app's normalization: persist the names, leave the hashes alone.
    const repaired = updateFeature(built.document, {
      featureId: repair.featureId,
      data: { edgeReferences: repair.edgeReferences }
    });
    const edited = await editWidth(repaired, built.sketchId, WIDTH, 50);
    expectPart(edited.derived, built.bodyId, 50);
  }, 240_000);
});
