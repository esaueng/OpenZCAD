import { describe, expect, it } from 'vitest';
import {
  CAD_PATCH_JSON_SCHEMA,
  type CadPatchOperation
} from '@openzcad/ai-contracts';
import { toFeatureId, toSketchId } from '@openzcad/shared';
import { describeOperation, summarizeOperations } from './describe';

type OperationKind = CadPatchOperation['kind'];
type OperationOf<Kind extends OperationKind> = Extract<
  CadPatchOperation,
  { kind: Kind }
>;

/** Nested measurement records the descriptions never read in full. */
function measured<T>(value: NoInfer<Partial<T>>): T {
  return value as T;
}

const zero = { x: 0, y: 0, z: 0 };

/**
 * One operation of every kind the contract's type allows. A complete record
 * over the kind union, so a kind added to the contract fails the typecheck
 * here until it has a sample — and with it a description.
 */
const SAMPLES: { [Kind in OperationKind]: OperationOf<Kind> } = {
  add_raised_feature_control: {
    kind: 'add_raised_feature_control',
    targetBodyId: 'body_1',
    parameter: 'show_details',
    selection: measured({})
  },
  use_edit_candidate: {
    kind: 'use_edit_candidate',
    candidateId: 'candidate_1',
    targetBodyId: '$plate',
    parameterNames: [],
    analysis: null
  },
  set_parameter: { kind: 'set_parameter', name: 'wall', expression: '2.4' },
  rename_parameter: {
    kind: 'rename_parameter',
    name: 'wall',
    newName: 'wall_t'
  },
  delete_parameter: { kind: 'delete_parameter', name: 'wall_t' },
  set_feature_dimension: {
    kind: 'set_feature_dimension',
    featureId: toFeatureId('feat_1'),
    field: 'depth',
    value: 12
  },
  set_sketch_dimension: {
    kind: 'set_sketch_dimension',
    sketchId: toSketchId('sketch_1'),
    objectId: 'circle_1',
    field: 'radius',
    value: 4
  },
  add_primitive: {
    kind: 'add_primitive',
    name: 'Plate',
    localId: 'plate',
    primitiveKind: 'box',
    dimensions: {
      width: 80,
      height: 60,
      depth: 6,
      radius: null,
      bottomRadius: null,
      topRadius: null,
      majorRadius: null,
      minorRadius: null
    }
  },
  delete_feature: { kind: 'delete_feature', featureId: toFeatureId('feat_2') },
  rename_feature: {
    kind: 'rename_feature',
    featureId: toFeatureId('feat_3'),
    name: 'Lid'
  },
  add_sketch: {
    kind: 'add_sketch',
    name: 'Profile',
    localId: 'profile',
    plane: 'XY',
    offset: 0,
    objects: []
  },
  add_extrude: {
    kind: 'add_extrude',
    name: 'Body',
    localId: null,
    sketchId: toSketchId('$profile'),
    distance: 10,
    samplePoint: null
  },
  add_revolve: {
    kind: 'add_revolve',
    name: 'Shaft',
    localId: null,
    sketchId: toSketchId('$profile'),
    axis: 'horizontal'
  },
  add_growing_holder_recipe: {
    kind: 'add_growing_holder_recipe',
    name: 'Grow',
    localId: null,
    targetBodyId: 'body_1',
    parameter: 'opening',
    opening: measured({ sourceOpening: 44, axis: 'x' })
  },
  add_growing_holder_hole_control: {
    kind: 'add_growing_holder_hole_control',
    name: 'Bores',
    targetBodyId: 'body_1',
    parameter: 'bore',
    holes: [measured({ sourceDiameter: 4.5 })]
  },
  add_imported_opening_recipe: {
    kind: 'add_imported_opening_recipe',
    editedWidth: 50,
    name: 'Widen',
    localId: null,
    targetBodyId: 'body_1',
    sourceWidth: 40,
    width: 'slot_w',
    axis: 'y',
    regions: [
      { min: zero, max: zero },
      { min: zero, max: zero }
    ]
  },
  add_boolean: {
    kind: 'add_boolean',
    name: 'Box',
    localId: null,
    operation: 'subtract',
    targetBodyIds: ['$outer', '$cavity']
  },
  add_transform: {
    kind: 'add_transform',
    name: 'Place',
    targetBodyId: '$cavity',
    translation: { x: 0, y: 0, z: 5 },
    rotationDeg: zero
  },
  add_direct_edit: {
    kind: 'add_direct_edit',
    name: 'Resize hole',
    targetBodyId: 'body_1',
    operation: measured({ kind: 'resize-through-hole' })
  },
  add_face_sketch: {
    kind: 'add_face_sketch',
    name: 'Top sketch',
    localId: null,
    planeRef: measured({
      faceReference: measured({ lineageName: 'top cap' })
    }),
    objects: []
  },
  add_multi_profile_extrude: {
    kind: 'add_multi_profile_extrude',
    name: 'Bosses',
    localId: null,
    sketchId: toSketchId('$profile'),
    distance: 3,
    samplePoints: [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]
  },
  add_mirror: {
    kind: 'add_mirror',
    name: 'Mirror',
    localId: null,
    targetBodyId: '$plate',
    plane: { origin: zero, normal: { x: 1, y: 0, z: 0 } }
  },
  add_shell: {
    kind: 'add_shell',
    name: 'Shell',
    localId: null,
    targetBodyId: 'body_1',
    openingFaceHashes: [7],
    openingFaceReferences: [],
    thickness: 2
  },
  add_solid_offset: {
    kind: 'add_solid_offset',
    name: 'Offset',
    localId: null,
    targetBodyId: 'body_1',
    distance: 0.5
  },
  add_edge_modifier: {
    kind: 'add_edge_modifier',
    name: 'Round',
    localId: null,
    modifier: 'fillet',
    targetBodyId: 'body_1',
    edgeSelector: null,
    edgeHashes: [1, 2],
    size: 1
  },
  add_pattern: {
    kind: 'add_pattern',
    name: 'Holes',
    localId: null,
    targetBodyId: 'body_1',
    patternKind: 'linear',
    count: 4,
    axis: 'x',
    spacing: 20,
    angleDeg: 0
  }
};

/** Every operation kind the model's structured-output schema offers. */
function schemaOperationKinds(): string[] {
  return CAD_PATCH_JSON_SCHEMA.properties.operations.items.anyOf.map(
    (variant) => variant.properties.kind.const
  );
}

describe('patch operation descriptions', () => {
  it('describes every operation kind the proposal schema allows', () => {
    const kinds = schemaOperationKinds();
    // The schema must actually be read: a broken walk would pass vacuously.
    expect(kinds.length).toBeGreaterThan(20);
    for (const kind of kinds) {
      const sample = SAMPLES[kind as OperationKind] as
        CadPatchOperation | undefined;
      expect(sample, `no sample operation for ${kind}`).toBeDefined();
      const line = describeOperation(sample!);
      expect(line, kind).not.toBe('Unknown operation');
      expect(line.trim(), kind).not.toBe('');
    }
  });

  it('describes the app-compiled kinds the schema leaves out', () => {
    for (const sample of Object.values(SAMPLES)) {
      expect(describeOperation(sample), sample.kind).not.toBe(
        'Unknown operation'
      );
    }
  });

  it('reads the measured-edit and parameter kinds the way a reviewer would', () => {
    expect(describeOperation(SAMPLES.use_edit_candidate)).toBe(
      'Measured parameter controls on Plate, at their current values'
    );
    expect(describeOperation(SAMPLES.rename_parameter)).toBe(
      'Rename parameter wall to wall_t'
    );
    expect(describeOperation(SAMPLES.delete_parameter)).toBe(
      'Delete parameter wall_t'
    );
    expect(describeOperation(SAMPLES.add_shell)).toBe(
      'Shell — shell body_1 at 2, 1 open face'
    );
    expect(describeOperation(SAMPLES.add_mirror)).toBe(
      'Mirror — mirror Plate across the plane through 0, 0, 0, normal 1, 0, 0'
    );
  });

  it('counts mirrors, shells, offsets and multi-region extrudes as solids', () => {
    expect(
      summarizeOperations([
        SAMPLES.add_mirror,
        SAMPLES.add_shell,
        SAMPLES.add_solid_offset,
        SAMPLES.add_multi_profile_extrude,
        SAMPLES.rename_parameter
      ])
    ).toEqual({ parameters: 0, bodies: 4, edits: 1 });
  });
});
