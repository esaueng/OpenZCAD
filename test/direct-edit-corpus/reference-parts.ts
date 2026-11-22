import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createProjectDocument,
  filletEdges,
  listFeaturesInOrder,
  transformBody
} from '@openzcad/document-core';
import type { ExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import {
  toUserId,
  type BodyId,
  type BodyRepresentation,
  type EdgeTopology,
  type FaceTopology,
  type ProjectDocument
} from '@openzcad/shared';
import { expect } from 'vitest';

import { buildOffsetFaces } from '../../apps/web/src/lib/faceSetOffset';
import { planFaceOffset } from '../../apps/web/src/lib/interaction/faceOffsetPlan';
import { importedBlendSnapshot } from '../../apps/web/src/lib/interaction/filletFaceEdit';
import { refusal } from '../support/combination-matrix';
import { faceSelector, resolveFixtureFace } from './resolve';

export const PARTS = ['A', 'B', 'C', 'D'] as const;
export type Part = (typeof PARTS)[number];
const WIDTH = 40;
const HEIGHT = 32;
const PLATE_DEPTH = 12;
const POST_HEIGHT = 30;
const POST_RADIUS = 8;
const TAPER_BASE = 10;
const TAPER_END = 7;
const ROUND = 1.5;
const CHAMFER = 1;
const LENGTH_TOLERANCE = 1e-6;

export interface ReferencePart {
  document: ProjectDocument;
  bodyId: BodyId;
  body: BodyRepresentation;
  span: number;
}

function only<T>(items: readonly T[], label: string): T {
  expect(items, label).toHaveLength(1);
  return items[0]!;
}

function face(body: BodyRepresentation, select: (f: FaceTopology) => boolean) {
  return resolveFixtureFace(
    body,
    faceSelector(
      only(body.topology!.faces.filter(select), 'authored face query')
    )
  );
}

function plane(
  body: BodyRepresentation,
  axis: 'x' | 'y' | 'z',
  sign: number,
  position: number
) {
  return face(
    body,
    ({ geometry: g }) =>
      g?.surfaceType === 'plane' &&
      Math.abs(g.normal![axis] - sign) < LENGTH_TOLERANCE &&
      Math.abs(g.center[axis] - position) < LENGTH_TOLERANCE
  );
}

function neighbours(body: BodyRepresentation, edge: EdgeTopology) {
  return edge.adjacentFaceHashes!.map(
    (hash) =>
      body.topology!.faces.find((candidate) => candidate.hash === hash)!
        .geometry!
  );
}

function edgesOf(body: BodyRepresentation) {
  return body.topology!.edges.filter((edge) => edge.displayRole !== 'seam');
}

function roundEdges(
  document: ProjectDocument,
  bodyId: BodyId,
  edges: readonly EdgeTopology[],
  name: string,
  kind: 'fillet' | 'chamfer' = 'fillet'
) {
  return (kind === 'fillet' ? filletEdges : chamferEdges)(document, {
    name,
    targetBodyId: bodyId,
    edgeHashes: edges.map((edge) => edge.hash),
    ...(edges.every(
      (edge) =>
        edge.reference &&
        !edge.reference.lineageName.startsWith('boolean.edge.')
    )
      ? { edgeReferences: edges.map((edge) => edge.reference!) }
      : {}),
    size: kind === 'fillet' ? ROUND : CHAMFER
  });
}

export async function referencePart(
  adapter: ExactKernelAdapter,
  part: Part,
  dimensions: { depth?: number; height?: number; radius?: number } = {}
): Promise<ReferencePart> {
  let document = createProjectDocument(
    `QA reference part ${part}`,
    toUserId('user_cad_part_qa')
  );
  if (part !== 'D') {
    document = addPrimitiveFeature(document, {
      name: 'Plate',
      primitiveKind: 'box',
      dimensions: {
        width: WIDTH,
        height: HEIGHT,
        depth: dimensions.depth ?? PLATE_DEPTH
      }
    });
  }
  if (part !== 'B') {
    // A uses a cone primitive with two positive radii, hence a frustum with
    // an analytic conical carrier. The box's edge rounds supply its cylinders.
    document =
      part === 'A'
        ? addPrimitiveFeature(document, {
            name: 'Taper',
            primitiveKind: 'cone',
            dimensions: {
              bottomRadius: TAPER_BASE,
              topRadius: TAPER_END,
              height: POST_HEIGHT
            }
          })
        : addPrimitiveFeature(document, {
            name: 'Post',
            primitiveKind: 'cylinder',
            dimensions: {
              radius: dimensions.radius ?? POST_RADIUS,
              height: dimensions.height ?? POST_HEIGHT
            }
          });
  }
  let bodyId = document.bodyOrder.at(-1)!;
  const readBody = async () => {
    const derived = await adapter.syncDocument(document);
    expect(refusal(derived, `build part ${part}`)).toBeNull();
    document = { ...document, derived };
    const body = derived.bodyRepresentations[bodyId]!;
    expect(body.exportableStep).toBe(true);
    return body;
  };

  if (part === 'A' || part === 'C') {
    const placed = transformBody(document, {
      name: 'Center the post',
      targetBodyId: bodyId,
      translation: { x: WIDTH / 2, y: HEIGHT / 2, z: 0 }
    });
    ({ document, bodyId } = booleanBodies(placed.document, {
      name: 'Union',
      operation: 'union',
      targetBodyIds: [document.bodyOrder[0]!, placed.bodyId]
    }));
    const united = await readBody();
    const root = only(
      edgesOf(united).filter((edge) => {
        const adjacent = neighbours(united, edge);
        return (
          adjacent.some(
            (g) => g.surfaceType === (part === 'A' ? 'cone' : 'cylinder')
          ) &&
          adjacent.some((g) => g.normal?.z === 1 && g.center.z === PLATE_DEPTH)
        );
      }),
      'post-to-plate junction'
    );
    ({ document, bodyId } = roundEdges(
      document,
      bodyId,
      [root],
      'Blend the junction'
    ));
  }

  if (part === 'A') {
    const junction = await readBody();
    // The only edges left sharp are the twelve box edges and the cone rim.
    // The two boundaries of the already-rounded junction are tangent.
    const sharp = edgesOf(junction).filter((edge) =>
      neighbours(junction, edge).every((g) => g.surfaceType !== 'torus')
    );
    expect(sharp).toHaveLength(13);
    ({ document, bodyId } = roundEdges(
      document,
      bodyId,
      sharp,
      'Blend remaining edges'
    ));
  } else if (part !== 'C') {
    const original = await readBody();
    const edges = edgesOf(original);
    expect(edges).toHaveLength(part === 'B' ? 12 : 2);
    ({ document, bodyId } = roundEdges(
      document,
      bodyId,
      edges,
      part === 'B' ? 'Blend all edges' : 'Chamfer both caps',
      part === 'B' ? 'fillet' : 'chamfer'
    ));
  }

  const body = await readBody();
  return { document, bodyId, body, span: part === 'D' ? POST_HEIGHT : WIDTH };
}

export interface Target {
  name: string;
  inward: number | null;
  outward: number | null;
  command: (delta: number) => EditCommand;
  movedPlanes?: readonly FaceTopology[];
  /** Cross-section of a prismatic move with a rigid end group. */
  section?: number;
  /** Independently rebuild the part with its source dimension changed. */
  rebuildSource?: (
    adapter: ExactKernelAdapter,
    delta: number
  ) => Promise<ReferencePart>;
  assertShape?: (body: BodyRepresentation, delta: number) => void;
  sourceCommand?: (delta: number) => EditCommand;
}

export function targets(part: Part, base: ReferencePart): Target[] {
  const { document, bodyId, body } = base;
  const targets: Target[] = [];
  function offset(
    name: string,
    pick: FaceTopology,
    inward: number,
    outward: number | null = null,
    section?: number,
    rebuildSource?: Target['rebuildSource']
  ) {
    const plan = (offset: number) => {
      const edit = planFaceOffset({
        document,
        bodyId,
        face: pick,
        faceHash: pick.hash,
        offset,
        exact: offset,
        localOnly: true
      });
      if (!edit) throw new Error(`Cannot plan ${name} at ${offset} mm`);
      return edit;
    };
    targets.push({
      name,
      inward,
      outward,
      command: (delta) => plan(delta).command,
      movedPlanes: [pick],
      ...(section === undefined ? {} : { section }),
      ...(rebuildSource ? { rebuildSource } : {})
    });
  }
  function blend(name: string, pick: FaceTopology, outward: number | null) {
    const carrier = importedBlendSnapshot(pick);
    if (!carrier) throw new Error(`Missing blend carrier for ${name}`);
    targets.push({
      name,
      inward: carrier.radius,
      outward,
      assertShape: (after, delta) => {
        if (carrier.radius + delta === 0) {
          expect(after.topology!.faces.length).toBeLessThan(
            body.topology!.faces.length
          );
        } else {
          expect(
            after.topology!.faces.some(
              (f) =>
                Math.abs(
                  (importedBlendSnapshot(f)?.radius ?? 0) -
                    carrier.radius -
                    delta
                ) < LENGTH_TOLERANCE
            )
          ).toBe(true);
        }
      },
      command: (delta) =>
        commandFactories.directEditBody({
          name: 'Resize Blend',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-blend',
            faceHash: pick.hash,
            faceReference: pick.reference,
            surfaceClass: carrier.surfaceClass,
            recordedRadius: carrier.radius,
            recordedCenter: carrier.center,
            recordedAxis: carrier.axis,
            newRadius: carrier.radius + delta
          }
        })
    });
  }

  if (part === 'A') {
    const cone = face(body, (f) => f.geometry?.surfaceType === 'cone');
    const apex = cone.geometry!.apex!;
    const top = plane(body, 'z', 1, POST_HEIGHT);
    offset(
      'top',
      top,
      POST_HEIGHT - PLATE_DEPTH - 2 * ROUND,
      apex.z - POST_HEIGHT
    );
    offset('bottom', plane(body, 'z', -1, 0), PLATE_DEPTH - 2 * ROUND);
    const right = plane(body, 'x', 1, WIDTH);
    const back = plane(body, 'y', 1, HEIGHT);
    const root = face(
      body,
      (f) =>
        f.geometry?.surfaceType === 'torus' &&
        f.geometry.center.z < POST_HEIGHT / 2
    );
    const junctionExtent = root.geometry!.majorRadius! + ROUND;
    const rightClearance = WIDTH / 2 - junctionExtent;
    const backClearance = HEIGHT / 2 - junctionExtent;
    offset('right', right, rightClearance);
    offset('back', back, backClearance);
    targets.push({
      name: 'right-and-back',
      inward: Math.min(rightClearance, backClearance),
      outward: null,
      movedPlanes: [right, back],
      command: (delta) => {
        const command = buildOffsetFaces({
          document,
          bodyId,
          face: right,
          offset: delta,
          exact: delta,
          members: [{ hash: back.hash, topologyId: back.topologyId }]
        });
        if (!command) throw new Error('Cannot plan right-and-back');
        return command;
      }
    });
    blend('junction-blend', root, HEIGHT / 2 - junctionExtent - ROUND);
    const rim = face(
      body,
      (f) =>
        f.geometry?.surfaceType === 'torus' &&
        f.geometry.center.z > POST_HEIGHT / 2
    );
    blend('rim-blend', rim, TAPER_END - ROUND);
  }
  if (part === 'B') {
    const section = WIDTH * HEIGHT - (4 - Math.PI) * ROUND ** 2;
    offset(
      'top',
      plane(body, 'z', 1, PLATE_DEPTH),
      PLATE_DEPTH - 2 * ROUND,
      null,
      section,
      (adapter, delta) =>
        referencePart(adapter, 'B', { depth: PLATE_DEPTH + delta })
    );
    blend(
      'edge-blend',
      face(
        body,
        (f) =>
          f.geometry?.surfaceType === 'cylinder' &&
          f.geometry.center.z > PLATE_DEPTH - ROUND &&
          f.geometry.center.y < ROUND
      ),
      PLATE_DEPTH - 2 * ROUND
    );
    // A spherical corner is driven by the shared Fillet feature's size.
    const corner = face(
      body,
      (f) =>
        f.geometry?.surfaceType === 'sphere' &&
        f.geometry.center.x < ROUND &&
        f.geometry.center.y < ROUND &&
        f.geometry.center.z > PLATE_DEPTH - ROUND
    );
    const fillet = listFeaturesInOrder(document).at(-1)!;
    const radius = corner.geometry!.radius!;
    targets.push({
      name: 'corner-fillet',
      inward: radius,
      outward: PLATE_DEPTH / 2 - radius,
      command: (delta) =>
        commandFactories.updateFeature({
          featureId: fillet.featureId,
          data: { radius: radius + delta }
        }),
      assertShape: (after, delta) => {
        const r = radius + delta;
        expect(
          after.topology!.faces.filter(
            (f) =>
              f.geometry?.surfaceType === 'sphere' &&
              Math.abs(f.geometry.radius! - r) < LENGTH_TOLERANCE
          )
        ).toHaveLength(8);
        // Rounded cuboid as a box core, six slabs, twelve quarter-cylinders
        // and eight octants. This is independent of the fillet operation.
        const [x, y, z] = [WIDTH - 2 * r, HEIGHT - 2 * r, PLATE_DEPTH - 2 * r];
        const expected =
          x * y * z +
          2 * r * (x * y + x * z + y * z) +
          Math.PI * r ** 2 * (x + y + z) +
          (4 / 3) * Math.PI * r ** 3;
        expect(Math.abs(after.volume - expected)).toBeLessThanOrEqual(
          Math.max(0.05, 1e-6 * expected)
        );
      }
    });
  }
  if (part === 'C') {
    offset(
      'shoulder',
      plane(body, 'z', 1, PLATE_DEPTH),
      PLATE_DEPTH,
      POST_HEIGHT - PLATE_DEPTH - ROUND
    );
    offset(
      'boss-cap',
      plane(body, 'z', 1, POST_HEIGHT),
      POST_HEIGHT - PLATE_DEPTH - ROUND,
      null,
      Math.PI * POST_RADIUS ** 2,
      (adapter, delta) =>
        referencePart(adapter, 'C', { height: POST_HEIGHT + delta })
    );
    const post = listFeaturesInOrder(document).find((f) => f.name === 'Post')!;
    const wall = face(body, (f) => f.geometry?.surfaceType === 'cylinder');
    const g = wall.geometry!;
    const sourceResize = (dimension: 'radius' | 'height', value: number) =>
      commandFactories.updateFeature({
        featureId: post.featureId,
        data: {
          dimensions: {
            radius: POST_RADIUS,
            height: POST_HEIGHT,
            [dimension]: value
          }
        }
      });
    targets.push({
      name: 'cylinder-radius',
      inward: g.radius!,
      outward: HEIGHT / 2 - g.radius! - ROUND,
      command: (delta) =>
        commandFactories.directEditBody({
          name: 'Resize Cylinder',
          targetBodyId: bodyId,
          operation: {
            kind: 'resize-cylindrical-face',
            faceHash: wall.hash,
            faceReference: wall.reference,
            sourceRadius: g.radius!,
            sourceAxisStart: g.axisStart!,
            sourceAxisEnd: g.axisEnd!,
            concavity: 'boss',
            radius: g.radius! + delta
          }
        }),
      sourceCommand: (delta) => sourceResize('radius', POST_RADIUS + delta),
      rebuildSource: (adapter, delta) =>
        referencePart(adapter, 'C', { radius: POST_RADIUS + delta }),
      assertShape: (after, delta) => {
        const cylinder = face(
          after,
          (f) => f.geometry?.surfaceType === 'cylinder'
        );
        expect(
          Math.abs(cylinder.geometry!.radius! - POST_RADIUS - delta)
        ).toBeLessThan(LENGTH_TOLERANCE);
      }
    });
    targets.push({
      name: 'cylinder-height',
      inward: POST_HEIGHT - PLATE_DEPTH - ROUND,
      outward: null,
      command: (delta) => sourceResize('height', POST_HEIGHT + delta),
      movedPlanes: [plane(body, 'z', 1, POST_HEIGHT)]
    });
  }
  if (part === 'D') {
    const wall = face(
      body,
      (f) => f.geometry?.surfaceType === 'cylinder'
    ).geometry!;
    const section = Math.PI * wall.radius! ** 2;
    offset(
      'top',
      plane(body, 'z', 1, POST_HEIGHT),
      wall.axialLength!,
      null,
      section,
      (adapter, delta) =>
        referencePart(adapter, 'D', { height: POST_HEIGHT + delta })
    );
    offset('bottom', plane(body, 'z', -1, 0), wall.axialLength!, null, section);
  }
  return targets;
}
