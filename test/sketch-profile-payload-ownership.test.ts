import { describe, expect, it } from 'vitest';
import {
  CommandManager,
  commandFactories,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder,
  updateFeature
} from '@openzcad/document-core';
import { computeSketchRegions } from '@openzcad/geometry';
import {
  isBoundaryProvenance,
  toUserId,
  type SketchRegionProfileReference
} from '@openzcad/shared';

function fixture() {
  const first = addSketchFeature(
    createProjectDocument('Profile snapshots', toUserId('user_test')),
    {
      name: 'First section',
      plane: 'XY',
      objects: [
        { objectKind: 'rectangle', width: 4, height: 3, centerX: 0, centerY: 0 }
      ]
    }
  );
  const second = addSketchFeature(first.document, {
    name: 'Second section',
    plane: 'XY',
    offset: 5,
    objects: [
      { objectKind: 'rectangle', width: 4, height: 3, centerX: 0, centerY: 0 }
    ]
  });
  const path = addSketchFeature(second.document, {
    name: 'Path',
    plane: 'XZ',
    objects: [{ objectKind: 'line', x1: 0, y1: 0, x2: 0, y2: 10 }]
  });
  const profile = (
    sketchId: typeof first.sketchId
  ): SketchRegionProfileReference => {
    const sketch = findSketch(path.document, sketchId)!;
    const objects = sketch.objectIds.flatMap((id) => {
      const node = path.document.nodes[id];
      return node?.kind === 'sketch-object' ? [{ id, data: node.data }] : [];
    });
    const region = computeSketchRegions(objects, Number)[0]!;
    return {
      profileId: region.profileId,
      regionFingerprint: region.regionFingerprint,
      sourceArea: region.area,
      samplePoint: region.samplePoint,
      sourceEntityIds: region.sourceEntityIds,
      sourceBoundaryLoops: region.sourceBoundaryLoops
    };
  };
  return {
    document: path.document,
    firstId: first.sketchId,
    secondId: second.sketchId,
    path: {
      sketchId: path.sketchId,
      entityIds: findSketch(path.document, path.sketchId)!.objectIds
    },
    first: profile(first.sketchId),
    second: profile(second.sketchId)
  };
}

/** Simulate a caller editing the nested data it still owns. */
function changeBoundary(value: unknown): void {
  if (!value || typeof value !== 'object')
    throw new Error('Expected profile payload');
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (!next || typeof next !== 'object') continue;
    if (isBoundaryProvenance(next)) {
      next.outer[0] = 'p1/ent_caller_changed/line';
      return;
    }
    for (const child of Object.values(next)) pending.push(child);
  }
  throw new Error('Expected nested boundary provenance');
}

function creation(kind: string, f: ReturnType<typeof fixture>): AnyCommand {
  const profile = { sketchId: f.firstId, profile: f.first };
  if (kind === 'extrude')
    return commandFactories.extrudeSketch({
      name: 'Solid',
      sketchId: f.firstId,
      distance: 5,
      profile: f.first
    });
  if (kind === 'loft')
    return commandFactories.loftSections({
      name: 'Solid',
      mode: 'ruled',
      sections: [profile, { sketchId: f.secondId, profile: f.second }]
    });
  if (kind === 'sweep')
    return commandFactories.sweepProfile({
      name: 'Solid',
      profile,
      path: f.path,
      mode: 'standard'
    });
  return commandFactories.helicalSweepProfile({
    name: 'Solid',
    profile,
    axisOrigin: { x: 10, y: 0, z: 0 },
    axisDirection: { x: 0, y: 0, z: 1 },
    radius: 10,
    pitch: 3,
    turns: 2
  });
}

describe('S04 authored profile snapshot ownership', () => {
  it.each(['extrude', 'loft', 'sweep', 'helical'])(
    '%s captures caller, serialized log and stored profile independently',
    (kind) => {
      const f = fixture();
      const command = creation(kind, f);
      const captured = structuredClone(command.payload);
      changeBoundary(f.first);
      expect(command.payload).toEqual(captured);
      changeBoundary(command.serialize().payload);
      expect(command.payload).toEqual(captured);
      const manager = new CommandManager(f.document);
      manager.execute(command);
      const stored = structuredClone(manager.document);
      changeBoundary(command.payload);
      expect(manager.document).toEqual(stored);
      expect(
        listFeaturesInOrder(
          replayCommands(f.document, manager.document.commandLog)
        )
      ).toEqual(listFeaturesInOrder(stored));
    }
  );

  it('captures an update command before the caller changes its profile and keeps the recorded replay independent', () => {
    const f = fixture();
    const manager = new CommandManager(f.document);
    manager.execute(creation('extrude', f));
    const featureId = listFeaturesInOrder(manager.document).at(-1)!.featureId;
    const data = { profile: structuredClone(f.first) };
    const command = commandFactories.updateFeature({ featureId, data });
    const captured = structuredClone(command.payload);
    changeBoundary(data);
    expect(command.payload).toEqual(captured);
    changeBoundary(command.serialize().payload);
    expect(command.payload).toEqual(captured);
    manager.execute(command);
    const stored = structuredClone(manager.document);
    changeBoundary(command.payload);
    expect(manager.document).toEqual(stored);
    expect(
      listFeaturesInOrder(
        replayCommands(f.document, manager.document.commandLog)
      )
    ).toEqual(listFeaturesInOrder(stored));
  });

  it.each(['profile', 'profiles', 'sections'] as const)(
    'direct feature updates own nested %s values',
    (field) => {
      const f = fixture();
      const manager = new CommandManager(f.document);
      manager.execute(creation(field === 'sections' ? 'loft' : 'extrude', f));
      const featureId = listFeaturesInOrder(manager.document).at(-1)!.featureId;
      const data =
        field === 'profile'
          ? { profile: structuredClone(f.first) }
          : field === 'profiles'
            ? { profiles: [structuredClone(f.first)] }
            : {
                sections: [
                  { sketchId: f.firstId, profile: structuredClone(f.first) },
                  { sketchId: f.secondId, profile: structuredClone(f.second) }
                ]
              };
      const updated = updateFeature(manager.document, { featureId, data });
      const stored = structuredClone(updated);
      changeBoundary(data);
      expect(updated).toEqual(stored);
    }
  );
});
