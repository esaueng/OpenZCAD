import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createParameterIds,
  createProjectDocument,
  createSketchFeatureIds
} from '@openzcad/document-core';
import type { DerivedState, ProjectDocument, UserId } from '@openzcad/shared';

/**
 * The Pipe Flange demo as it was seeded before the phone review moved its
 * chamfer ahead of the bolt circle: the rim chamfer comes last, on the
 * drilled flange, and stores its three edges by hash alone, since the
 * drill (a patterned, multi-solid tool) publishes no lineage to name them
 * by. Saved copies of that demo still exist, and tests of how a legacy
 * hash-only selection behaves keep using it.
 */
export async function legacyFlange(
  ownerUserId: UserId,
  sync: (document: ProjectDocument) => Promise<DerivedState>
): Promise<ProjectDocument> {
  const manager = new CommandManager(
    createProjectDocument('Demo · Pipe Flange', ownerUserId, 'mm')
  );
  const parameters = {
    rim_r: 45,
    hub_r: 24,
    bore_r: 12,
    rim_t: 10,
    hub_h: 26,
    bolt_r: 3,
    bolt_circle: 34,
    bolt_count: 6,
    chamfer_d: 1.5
  };
  const rimSketch = createSketchFeatureIds();
  const rim = createBodyFeatureIds();
  const hubSketch = createSketchFeatureIds();
  const hub = createBodyFeatureIds();
  const blank = createBodyFeatureIds();
  const bolt = createBodyFeatureIds();
  const boltCircle = createBodyFeatureIds();
  const drilled = createBodyFeatureIds();
  manager.runTransaction('Rev A and B', [
    ...Object.entries(parameters).map(([name, value]) =>
      commandFactories.setParameter({
        name,
        expression: String(value),
        ids: createParameterIds()
      })
    ),
    commandFactories.addSketch({
      name: 'Rim profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 'rim_r - hub_r',
        height: 'rim_t',
        centerX: '(rim_r + hub_r) / 2',
        centerY: 'rim_t / -2'
      },
      ids: rimSketch
    }),
    commandFactories.revolveSketch({
      name: 'Revolve rim',
      sketchId: rimSketch.sketchId,
      axis: 'vertical',
      ids: rim
    }),
    commandFactories.addSketch({
      name: 'Hub profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 'hub_r - bore_r',
        height: 'hub_h',
        centerX: '(hub_r + bore_r) / 2',
        centerY: 'hub_h / -2'
      },
      ids: hubSketch
    }),
    commandFactories.revolveSketch({
      name: 'Revolve hub',
      sketchId: hubSketch.sketchId,
      axis: 'vertical',
      ids: hub
    }),
    commandFactories.booleanBodies({
      name: 'Union flange blank',
      operation: 'union',
      targetBodyIds: [rim.bodyId, hub.bodyId],
      ids: blank
    }),
    commandFactories.addPrimitive({
      name: 'Bolt hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'bolt_r', height: 'rim_t + 6' },
      ids: bolt
    }),
    commandFactories.transformBody({
      name: 'Place bolt hole',
      targetBodyId: bolt.bodyId,
      translation: { x: 'bolt_circle', y: 0, z: -3 }
    }),
    commandFactories.patternBody({
      name: 'Bolt circle',
      targetBodyId: bolt.bodyId,
      patternKind: 'circular',
      count: 'bolt_count',
      axis: 'z',
      angleDeg: 360,
      ids: boltCircle
    }),
    commandFactories.booleanBodies({
      name: 'Drill bolt circle',
      operation: 'subtract',
      targetBodyIds: [blank.bodyId, boltCircle.bodyId],
      ids: drilled
    })
  ]);

  // The rims (r=45, top and bottom) and the hub lip (r=24 at z=26): flat
  // circles, which keeps the r=45 cylinder's vertical seam out.
  const near = (value: number, target: number) =>
    Math.abs(value - target) < 0.05;
  const drilledEdges =
    (await sync(manager.document)).bodyRepresentations[drilled.bodyId]?.topology
      ?.edges ?? [];
  const rimHashes = drilledEdges
    .filter((edge) => {
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let index = 0; index < edge.points.length; index += 3) {
        const x = edge.points[index]!;
        const y = edge.points[index + 1]!;
        const z = edge.points[index + 2]!;
        const radial = Math.hypot(x, y);
        if (!(near(radial, 45) || (near(radial, 24) && z >= 25.5))) {
          return false;
        }
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
      }
      return maxZ - minZ <= 0.5;
    })
    .map((edge) => edge.hash);
  if (rimHashes.length !== 3) {
    throw new Error(
      `Expected the legacy flange's 3 rim edges, got ${rimHashes.length}.`
    );
  }

  const chamfer = createBodyFeatureIds();
  manager.runTransaction('Rev C — Rim chamfer', [
    commandFactories.chamferEdges({
      name: 'Rim chamfer',
      targetBodyId: drilled.bodyId,
      edgeHashes: rimHashes,
      size: 'chamfer_d',
      ids: chamfer
    })
  ]);
  return attachDerivedState(manager.document, await sync(manager.document));
}
