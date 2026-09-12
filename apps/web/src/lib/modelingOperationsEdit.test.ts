import { describe, expect, it } from 'vitest';
import type { FeatureId, FeatureNode } from '@openzcad/shared';
import { toSketchId, toEntityId } from '@openzcad/shared';
import {
  modelingFeatureIsEditable,
  modelingFeatureEditReferences,
  buildModelingOperationSubmission,
  type ModelingProfileOption,
  type ModelingPathOption,
  type EditableModelingFeatureData,
  modelingFeatureUpdate,
  modelingFormStateFromFeature,
  type ModelingOperationSubmission
} from './modelingOperations';

const hole: Extract<FeatureNode['data'], { featureKind: 'hole' }> = {
  featureKind: 'hole',
  targetBodyId: 'body_plate' as never,
  faceHash: 3697740096,
  style: 'counterbore',
  diameter: 'd',
  depthMode: 'blind',
  depth: 10,
  counterboreDiameter: 11,
  counterboreDepth: 3,
  position: { u: 30, v: -20 }
};

describe('editing a modeling feature through its creation form', () => {
  it('lifts stored hole data into the form, expressions as written', () => {
    expect(modelingFormStateFromFeature('Bolt hole', hole)).toEqual({
      operation: 'hole',
      value: {
        name: 'Bolt hole',
        targetBodyId: 'body_plate',
        faceHash: 3697740096,
        style: 'counterbore',
        diameter: 'd',
        depthMode: 'blind',
        depth: '10',
        counterboreDiameter: '11',
        counterboreDepth: '3',
        countersinkDiameter: '12',
        countersinkAngleDeg: '90',
        position: { u: '30', v: '-20' }
      }
    });
  });

  it('turns a submission into a patch of exactly the stored keys', () => {
    const submission: ModelingOperationSubmission = {
      operation: 'hole',
      input: {
        name: 'Bolt hole',
        targetBodyId: 'body_plate' as never,
        faceHash: 3697740096,
        style: 'simple',
        diameter: 8,
        depthMode: 'through',
        position: { u: 30, v: -20 },
        positionAnchor: 'centroid'
      }
    };
    expect(modelingFeatureUpdate('feat_hole' as FeatureId, submission)).toEqual(
      {
        featureId: 'feat_hole',
        name: 'Bolt hole',
        data: {
          featureKind: 'hole',
          targetBodyId: 'body_plate',
          faceHash: 3697740096,
          style: 'simple',
          diameter: 8,
          depthMode: 'through',
          position: { u: 30, v: -20 }
        }
      }
    );
    expect(modelingFeatureIsEditable('hole')).toBe(true);
    expect(modelingFeatureIsEditable('primitive')).toBe(false);
  });

  it('lifts and patches the plane and face kinds through the same seam', () => {
    expect(
      modelingFormStateFromFeature('Mirror', {
        featureKind: 'mirror',
        targetBodyId: 'body_arm' as never,
        plane: {
          origin: { x: 0, y: 'w / 2', z: 0 },
          normal: { x: 1, y: 0, z: 0 }
        }
      })
    ).toEqual({
      operation: 'mirror',
      value: {
        name: 'Mirror',
        targetBodyId: 'body_arm',
        origin: { x: '0', y: 'w / 2', z: '0' },
        normal: { x: '1', y: '0', z: '0' }
      }
    });
    expect(
      modelingFeatureUpdate('feat_shell' as FeatureId, {
        operation: 'shell',
        input: {
          name: 'Shell',
          targetBodyId: 'body_cup' as never,
          openingFaceHashes: [7, 9],
          thickness: 1.5
        }
      })
    ).toEqual({
      featureId: 'feat_shell',
      name: 'Shell',
      data: {
        featureKind: 'shell',
        targetBodyId: 'body_cup',
        openingFaceHashes: [7, 9],
        thickness: 1.5
      }
    });
    expect(modelingFeatureIsEditable('mirror')).toBe(true);
    expect(modelingFeatureIsEditable('primitive')).toBe(false);
  });
});

const profiles: ModelingProfileOption[] = ['lower', 'upper', 'other'].map(
  (id, i) => ({
    id: `option_${id}`,
    label: id,
    section: {
      sketchId: toSketchId(`sketch_${id}`),
      profile: {
        profileId: `profile_${id}`,
        regionFingerprint: i + 1,
        sourceArea: 4,
        samplePoint: { x: 0, y: 0 },
        sourceEntityIds: [`entity_${id}`]
      }
    }
  })
);
const paths: ModelingPathOption[] = [
  {
    id: 'path',
    label: 'Path',
    path: {
      sketchId: toSketchId('path_sketch'),
      entityIds: ['first', 'second', 'unused'].map(toEntityId)
    }
  }
];
const loft = {
  featureKind: 'loft',
  sections: [profiles[1]!.section, profiles[0]!.section],
  mode: 'smooth'
} satisfies EditableModelingFeatureData;
const sweep = {
  featureKind: 'sweep',
  profile: profiles[1]!.section,
  path: {
    sketchId: paths[0]!.path.sketchId,
    entityIds: ['second', 'first'].map(toEntityId)
  },
  mode: 'smooth'
} satisfies EditableModelingFeatureData;
const helix = {
  featureKind: 'helical-sweep',
  profile: profiles[1]!.section,
  axisOrigin: { x: 'origin / 2', y: 0, z: 'height' },
  axisDirection: { x: 0, y: 'tilt', z: 1 },
  radius: 'r + 2',
  pitch: 'pitch / 2',
  turns: 'n'
} satisfies EditableModelingFeatureData;

function roundTrip(data: EditableModelingFeatureData, live = profiles) {
  const initial = modelingFormStateFromFeature('Authored', data, live, paths);
  const options = modelingFeatureEditReferences(data, live, paths);
  return modelingFeatureUpdate(
    'feature_authored' as FeatureId,
    buildModelingOperationSubmission(
      initial,
      [],
      options.profiles,
      options.paths
    )
  );
}

describe('profile feature editing', () => {
  it.each([loft, sweep, helix])(
    'round trips $featureKind without losing authored fields or references',
    (data) => {
      expect(modelingFeatureIsEditable(data.featureKind)).toBe(true);
      expect(roundTrip(data)).toEqual({
        featureId: 'feature_authored',
        name: 'Authored',
        data
      });
    }
  );

  it('preserves loft section order and sweep mode and path selection', () => {
    expect(
      modelingFormStateFromFeature('Loft', loft, [...profiles].reverse())
    ).toEqual({
      operation: 'loft',
      value: {
        name: 'Loft',
        sectionIds: ['option_upper', 'option_lower'],
        mode: 'smooth'
      }
    });
    expect(
      modelingFormStateFromFeature('Sweep', sweep, profiles, paths)
    ).toEqual({
      operation: 'sweep',
      value: {
        name: 'Sweep',
        profileId: 'option_upper',
        pathId: 'path',
        mode: 'smooth'
      }
    });
  });

  it('recovers changed geometry only through a unique entity set and retains the saved reference', () => {
    const live = profiles.map((option) => ({
      ...option,
      section: {
        ...option.section,
        profile: {
          ...option.section.profile,
          profileId: 'changed',
          regionFingerprint: 99,
          sourceArea: 16,
          samplePoint: { x: 1, y: 1 }
        }
      }
    }));
    expect(roundTrip(loft, live)?.data).toEqual(loft);
  });

  it('resolves a legacy reference without promoting it to a new profile id', () => {
    const legacy = structuredClone(helix);
    if (
      legacy.featureKind !== 'helical-sweep' ||
      legacy.profile.profile.all === true
    )
      throw new Error('fixture');
    delete legacy.profile.profile.profileId;
    delete legacy.profile.profile.sourceEntityIds;
    expect(roundTrip(legacy)?.data).toEqual(legacy);
  });

  it('uses live references when the user explicitly selects another profile', () => {
    const state = modelingFormStateFromFeature('Sweep', sweep, profiles, paths);
    if (state.operation !== 'sweep') throw new Error('fixture');
    state.value.profileId = profiles[2]!.id;
    const options = modelingFeatureEditReferences(sweep, profiles, paths);
    expect(
      buildModelingOperationSubmission(
        state,
        [],
        options.profiles,
        options.paths
      ).input
    ).toMatchObject({ profile: profiles[2]!.section, path: sweep.path });
  });

  it('refuses missing, cross-sketch and ambiguous identities instead of choosing a default', () => {
    expect(() => roundTrip(helix, [profiles[0]!])).toThrow(
      /no longer resolves uniquely/
    );
    const foreign = {
      ...profiles[1]!,
      section: { ...profiles[1]!.section, sketchId: toSketchId('foreign') }
    };
    expect(() => roundTrip(helix, [foreign])).toThrow(
      /no longer resolves uniquely/
    );
    expect(() =>
      roundTrip(helix, [...profiles, { ...profiles[1]!, id: 'duplicate' }])
    ).toThrow(/no longer resolves uniquely/);
    const changed = {
      ...profiles[1]!,
      section: {
        ...profiles[1]!.section,
        profile: { ...profiles[1]!.section.profile, profileId: 'changed' }
      }
    };
    expect(() =>
      roundTrip(helix, [changed, { ...changed, id: 'duplicate' }])
    ).toThrow(/no longer resolves uniquely/);
  });

  it('refuses entity-wide and duplicate resolved loft sections', () => {
    expect(() =>
      roundTrip({
        ...helix,
        profile: {
          sketchId: profiles[1]!.section.sketchId,
          profile: { all: true, sourceEntityIds: ['entity_upper'] }
        }
      })
    ).toThrow(/Entity-wide/);
    expect(() =>
      roundTrip({
        ...loft,
        sections: [profiles[1]!.section, profiles[1]!.section]
      })
    ).toThrow(/same profile/);
  });

  it('refuses missing or duplicate path entities and ambiguous path options', () => {
    for (const livePaths of [
      [],
      [
        {
          ...paths[0]!,
          path: { ...paths[0]!.path, entityIds: [toEntityId('first')] }
        }
      ],
      [...paths, paths[0]!]
    ]) {
      expect(() =>
        modelingFeatureEditReferences(sweep, profiles, livePaths)
      ).toThrow(/Saved path entities/);
    }
    expect(() =>
      modelingFeatureEditReferences(
        {
          ...sweep,
          path: {
            ...sweep.path,
            entityIds: [toEntityId('first'), toEntityId('first')]
          }
        },
        profiles,
        paths
      )
    ).toThrow(/Saved path entities/);
  });
});
