import {
  createId,
  deepClone,
  nowIso,
  toEntityId,
  type BodyId,
  type EntityId,
  type ParamValue,
  type ParametricTransform3D,
  type ProjectDocument,
  type SerializedCommand,
  toSketchConstraintId,
  type SketchId,
  type SketchObjectData,
  type SketchProfileReference
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  addSketchConstraint,
  addSketchFeature,
  addSketchObjects,
  deleteSketchConstraint,
  deleteSketchObject,
  resolveSketchInput,
  updateSketchObject,
  appendRevision,
  attachDerivedState,
  booleanBodies,
  chamferEdges,
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createParameterIds,
  createSketchFeatureIds,
  deleteFeature,
  directEditBody,
  draftBody,
  deleteParameter,
  evaluateExpression,
  extrudeSketch,
  helicalSweepProfile,
  filletEdges,
  findFeature,
  findSketch,
  getParameterScope,
  isValidParameterName,
  importMeshBody,
  importStepBody,
  mirrorBody,
  loftSections,
  offsetSolidBody,
  patternBody,
  renameNode,
  resolveParamValue,
  revolveSketch,
  setNodeMetadata,
  setParameter,
  shellBody,
  sweepProfile,
  thickenFace,
  transformBody,
  updateFeature,
  updateSketch,
  translateSketch,
  type BooleanInput,
  type DirectEditInput,
  type DraftInput,
  type ExtrudeInput,
  type HelicalSweepInput,
  type EdgeModifierInput,
  type FeatureDeleteInput,
  type FeatureUpdateInput,
  type ImportedMeshInput,
  type ImportedStepInput,
  type MirrorInput,
  type LoftInput,
  type NodeMetadataInput,
  type NodeRenameInput,
  type ParameterDeleteInput,
  type ParameterSetInput,
  type PatternInput,
  type PrimitiveInput,
  type RevolveInput,
  type SketchConstraintAddInput,
  type SketchConstraintDeleteInput,
  type SketchInput,
  type SketchObjectAddInput,
  type SketchObjectDeleteInput,
  type SketchObjectUpdateInput,
  type SketchTranslateInput,
  type SketchUpdateInput,
  type ShellInput,
  type SolidOffsetInput,
  type SweepInput,
  type ThickenInput,
  type TransformInput
} from '@openzcad/document-core';
import {
  isSketchDimensionField,
  isLocalBodyRef,
  normalizeLocalId,
  type CadPatchProposal
} from '@openzcad/ai-contracts';
import {
  computeSketchProfileAnalysis,
  computeSketchRegions,
  regionAtPoint,
  type SketchRegion
} from '@openzcad/geometry';

export type CommandKind =
  | 'primitive.add'
  | 'sketch.add'
  | 'sketch.update'
  | 'sketch.translate'
  | 'sketch.object.add'
  | 'sketch.object.update'
  | 'sketch.object.delete'
  | 'sketch.constraint.add'
  | 'sketch.constraint.delete'
  | 'feature.extrude'
  | 'feature.revolve'
  | 'feature.loft'
  | 'feature.sweep'
  | 'feature.helical-sweep'
  | 'feature.boolean'
  | 'feature.transform'
  | 'feature.mirror'
  | 'feature.shell'
  | 'feature.solid-offset'
  | 'feature.draft'
  | 'feature.thicken'
  | 'feature.direct-edit'
  | 'feature.fillet'
  | 'feature.chamfer'
  | 'feature.pattern'
  | 'feature.update'
  | 'feature.delete'
  | 'parameter.set'
  | 'parameter.delete'
  | 'import.mesh'
  | 'import.step'
  | 'node.rename'
  | 'node.metadata.set';

export interface CommandDefinition<TPayload> {
  kind: CommandKind;
  label: string;
  replayVersion: number;
  payload: TPayload;
  validate(document: ProjectDocument): void;
  apply(document: ProjectDocument): ProjectDocument;
  serialize(): SerializedCommand<TPayload>;
}

interface HistoryEntry {
  /** Document state to restore when this entry is popped. */
  snapshot: ProjectDocument;
  command: SerializedCommand;
}

export type AnyCommand =
  | CommandDefinition<PrimitiveInput>
  | CommandDefinition<SketchInput>
  | CommandDefinition<SketchUpdateInput>
  | CommandDefinition<SketchTranslateInput>
  | CommandDefinition<SketchObjectAddInput>
  | CommandDefinition<SketchObjectUpdateInput>
  | CommandDefinition<SketchObjectDeleteInput>
  | CommandDefinition<SketchConstraintAddInput>
  | CommandDefinition<SketchConstraintDeleteInput>
  | CommandDefinition<ExtrudeInput>
  | CommandDefinition<RevolveInput>
  | CommandDefinition<LoftInput>
  | CommandDefinition<SweepInput>
  | CommandDefinition<HelicalSweepInput>
  | CommandDefinition<BooleanInput>
  | CommandDefinition<TransformInput>
  | CommandDefinition<MirrorInput>
  | CommandDefinition<ShellInput>
  | CommandDefinition<SolidOffsetInput>
  | CommandDefinition<DraftInput>
  | CommandDefinition<ThickenInput>
  | CommandDefinition<DirectEditInput>
  | CommandDefinition<EdgeModifierInput>
  | CommandDefinition<PatternInput>
  | CommandDefinition<FeatureUpdateInput>
  | CommandDefinition<FeatureDeleteInput>
  | CommandDefinition<ParameterSetInput>
  | CommandDefinition<ParameterDeleteInput>
  | CommandDefinition<ImportedMeshInput>
  | CommandDefinition<ImportedStepInput>
  | CommandDefinition<NodeRenameInput>
  | CommandDefinition<NodeMetadataInput>;

function makeCommand<TPayload>(
  kind: CommandKind,
  label: string,
  payload: TPayload,
  apply: (document: ProjectDocument) => ProjectDocument,
  validate: (document: ProjectDocument) => void = () => {}
): CommandDefinition<TPayload> {
  return {
    kind,
    label,
    replayVersion: 1,
    payload,
    validate,
    apply,
    serialize() {
      return {
        kind,
        payload,
        replayVersion: 1,
        label,
        timestamp: nowIso()
      };
    }
  };
}

function validateBodyTarget(document: ProjectDocument, bodyId: BodyId): void {
  if (!document.bodyOrder.includes(bodyId)) {
    throw new Error(`Target body ${bodyId} not found.`);
  }
}

function validateExtrudeInput(
  document: ProjectDocument,
  input: ExtrudeInput
): void {
  if (!findSketch(document, input.sketchId)) {
    throw new Error('Extrude requires an existing sketch.');
  }
  const operation = input.operation ?? 'new-body';
  if (operation === 'new-body') {
    if (input.targetBodyId !== undefined) {
      throw new Error('A new-body extrusion cannot store a target body.');
    }
    return;
  }
  if (input.targetBodyId === undefined) {
    throw new Error(`Extrude ${operation} requires a stored target body.`);
  }
  validateBodyTarget(document, input.targetBodyId);
  if (input.ids?.bodyId === input.targetBodyId) {
    throw new Error('An extrusion cannot target its own result body.');
  }
}

function validateDirectEditReference(input: DirectEditInput): void {
  const reference = input.operation.faceReference;
  if (!reference) {
    return;
  }
  if (
    reference.kind !== 'face' ||
    reference.currentHash !== input.operation.faceHash
  ) {
    throw new Error(
      'The direct-edit face reference does not match its legacy face hash.'
    );
  }
}

function validateEdgeReferences(input: EdgeModifierInput): void {
  if (!input.edgeReferences) {
    return;
  }
  const referenceHashes = new Set(
    input.edgeReferences.map((reference) => reference.currentHash)
  );
  const legacyHashes = new Set(input.edgeHashes);
  if (
    input.edgeReferences.some((reference) => reference.kind !== 'edge') ||
    referenceHashes.size !== input.edgeReferences.length ||
    referenceHashes.size !== legacyHashes.size ||
    [...referenceHashes].some((hash) => !legacyHashes.has(hash))
  ) {
    throw new Error(
      'The edge lineage references must uniquely match the legacy edge hashes.'
    );
  }
}

function resolvedModelingValue(
  document: ProjectDocument,
  label: string,
  value: ParamValue
): number {
  return resolveParamValue(value, getParameterScope(document).scope, label);
}

function validateMirrorInput(
  document: ProjectDocument,
  input: MirrorInput
): void {
  validateBodyTarget(document, input.targetBodyId);
  const origin = input.plane.origin;
  const normal = input.plane.normal;
  for (const [label, value] of Object.entries({
    'mirror origin X': origin.x,
    'mirror origin Y': origin.y,
    'mirror origin Z': origin.z,
    'mirror normal X': normal.x,
    'mirror normal Y': normal.y,
    'mirror normal Z': normal.z
  })) {
    resolvedModelingValue(document, label, value);
  }
  const length = Math.hypot(
    resolvedModelingValue(document, 'mirror normal X', normal.x),
    resolvedModelingValue(document, 'mirror normal Y', normal.y),
    resolvedModelingValue(document, 'mirror normal Z', normal.z)
  );
  if (!Number.isFinite(length) || length <= 1e-12) {
    throw new Error('Mirror plane normal must be finite and non-zero.');
  }
}

function validatePositiveModelingValue(
  document: ProjectDocument,
  label: string,
  value: ParamValue
): void {
  if (resolvedModelingValue(document, label, value) <= 0) {
    throw new Error(`${label} must be greater than zero.`);
  }
}

function validateShellInput(
  document: ProjectDocument,
  input: ShellInput
): void {
  validateBodyTarget(document, input.targetBodyId);
  validatePositiveModelingValue(document, 'Shell thickness', input.thickness);
  const hashes = new Set(input.openingFaceHashes);
  if (hashes.size === 0 || hashes.size !== input.openingFaceHashes.length) {
    throw new Error('Shell opening faces must be a nonempty unique set.');
  }
  if (!input.openingFaceReferences) {
    return;
  }
  const referenceHashes = new Set(
    input.openingFaceReferences.map((reference) => reference.currentHash)
  );
  if (
    referenceHashes.size !== input.openingFaceReferences.length ||
    referenceHashes.size !== hashes.size ||
    [...referenceHashes].some((hash) => !hashes.has(hash))
  ) {
    throw new Error(
      'Shell opening-face references must uniquely match their legacy hashes.'
    );
  }
}

function validateModelingFeatureUpdate(
  document: ProjectDocument,
  input: FeatureUpdateInput
): void {
  const preview = updateFeature(document, input);
  const feature = findFeature(preview, input.featureId)!;
  switch (feature.data.featureKind) {
    case 'extrude':
      validateExtrudeInput(preview, {
        name: feature.name,
        sketchId: feature.data.sketchId,
        distance: feature.data.distance,
        operation: feature.data.operation,
        targetBodyId: feature.data.targetBodyId,
        profile: feature.data.profile,
        profiles: feature.data.profiles
      });
      // The creation-time guard keys off `input.ids`, which an update never
      // carries; the stored feature knows its own result body directly.
      if (
        feature.data.targetBodyId !== undefined &&
        feature.data.targetBodyId === feature.bodyId
      ) {
        throw new Error('An extrusion cannot target its own result body.');
      }
      break;
    case 'revolve':
      if (!findSketch(preview, feature.data.sketchId)) {
        throw new Error('Revolve requires an existing sketch.');
      }
      break;
    case 'loft':
      if (feature.data.sections.length < 2) {
        throw new Error('Loft requires at least two profile sections.');
      }
      for (const section of feature.data.sections) {
        if (!findSketch(preview, section.sketchId)) {
          throw new Error(`Loft sketch ${section.sketchId} not found.`);
        }
      }
      break;
    case 'sweep': {
      if (!findSketch(preview, feature.data.profile.sketchId)) {
        throw new Error('Sweep profile sketch not found.');
      }
      const pathSketch = findSketch(preview, feature.data.path.sketchId);
      if (!pathSketch || feature.data.path.entityIds.length === 0) {
        throw new Error('Sweep path sketch is unavailable or empty.');
      }
      break;
    }
    case 'helical-sweep':
      if (!findSketch(preview, feature.data.profile.sketchId)) {
        throw new Error('Helical sweep profile sketch not found.');
      }
      break;
    case 'boolean': {
      const targetBodyIds = feature.data.targetBodyIds;
      if (targetBodyIds.length < 2) {
        throw new Error('Boolean operations need at least two target bodies.');
      }
      if (new Set(targetBodyIds).size !== targetBodyIds.length) {
        throw new Error(
          'Boolean operations cannot target the same body twice.'
        );
      }
      const known = new Set(preview.bodyOrder);
      for (const bodyId of targetBodyIds) {
        if (!known.has(bodyId)) {
          throw new Error(`Boolean target body ${bodyId} not found.`);
        }
      }
      if (
        feature.bodyId !== undefined &&
        targetBodyIds.includes(feature.bodyId)
      ) {
        throw new Error('A boolean cannot target its own result body.');
      }
      break;
    }
    case 'transform':
      if (!preview.bodyOrder.includes(feature.data.targetBodyId)) {
        throw new Error(
          `Transform target body ${feature.data.targetBodyId} not found.`
        );
      }
      break;
    case 'direct-edit':
      validateBodyTarget(preview, feature.data.targetBodyId);
      validateDirectEditReference({
        name: feature.name,
        targetBodyId: feature.data.targetBodyId,
        operation: feature.data.operation
      });
      break;
    case 'fillet':
      validateBodyTarget(preview, feature.data.targetBodyId);
      validateEdgeReferences({
        name: feature.name,
        targetBodyId: feature.data.targetBodyId,
        edgeHashes: feature.data.edgeHashes,
        edgeReferences: feature.data.edgeReferences,
        size: feature.data.radius
      });
      break;
    case 'chamfer':
      validateBodyTarget(preview, feature.data.targetBodyId);
      validateEdgeReferences({
        name: feature.name,
        targetBodyId: feature.data.targetBodyId,
        edgeHashes: feature.data.edgeHashes,
        edgeReferences: feature.data.edgeReferences,
        size: feature.data.distance
      });
      break;
    case 'pattern':
      validateBodyTarget(preview, feature.data.targetBodyId);
      break;
    case 'mirror':
      validateMirrorInput(preview, {
        name: feature.name,
        targetBodyId: feature.data.targetBodyId,
        plane: feature.data.plane
      });
      break;
    case 'shell':
      validateShellInput(preview, {
        name: feature.name,
        targetBodyId: feature.data.targetBodyId,
        openingFaceHashes: feature.data.openingFaceHashes,
        openingFaceReferences: feature.data.openingFaceReferences,
        thickness: feature.data.thickness
      });
      break;
    case 'solid-offset':
      validateBodyTarget(preview, feature.data.targetBodyId);
      validatePositiveModelingValue(
        preview,
        'Solid offset distance',
        feature.data.distance
      );
      break;
    case 'draft':
      validateBodyTarget(preview, feature.data.targetBodyId);
      if (feature.data.faceHashes.length === 0) {
        throw new Error('Draft requires at least one face.');
      }
      break;
    case 'thicken':
      validateBodyTarget(preview, feature.data.targetBodyId);
      break;
  }
}

// Every factory resolves the IDs the operation will create *before* the
// command is serialized, so replaying a command log rebuilds the exact same
// entity graph. Without this, commands that reference earlier results
// (extrude -> sketch, boolean/transform -> bodies) would dangle on replay.
export const commandFactories = {
  addPrimitive(payload: PrimitiveInput): CommandDefinition<PrimitiveInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'primitive.add',
      `Add ${payload.primitiveKind}`,
      withIds,
      (document) => addPrimitiveFeature(document, withIds)
    );
  },
  addSketch(payload: SketchInput): CommandDefinition<SketchInput> {
    const { objects } = resolveSketchInput(payload);
    const withIds = {
      ...payload,
      ids: payload.ids ?? createSketchFeatureIds(Math.max(objects.length, 1))
    };
    const label =
      objects.length === 1
        ? `Add ${objects[0]!.objectKind} sketch`
        : 'Add sketch';
    return makeCommand(
      'sketch.add',
      label,
      withIds,
      (document) => addSketchFeature(document, withIds).document
    );
  },
  addSketchObjects(
    payload: SketchObjectAddInput,
    label = 'Add sketch geometry'
  ): CommandDefinition<SketchObjectAddInput> {
    const withIds = {
      ...payload,
      ids: payload.ids ?? {
        objectNodeIds: payload.objects.map(() => toEntityId(createId('ent')))
      }
    };
    return makeCommand(
      'sketch.object.add',
      label,
      withIds,
      (document) => addSketchObjects(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  updateSketchObject(
    payload: SketchObjectUpdateInput,
    label = 'Edit sketch geometry'
  ): CommandDefinition<SketchObjectUpdateInput> {
    return makeCommand(
      'sketch.object.update',
      label,
      payload,
      (document) => updateSketchObject(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  deleteSketchObject(
    payload: SketchObjectDeleteInput,
    label = 'Delete sketch geometry'
  ): CommandDefinition<SketchObjectDeleteInput> {
    return makeCommand(
      'sketch.object.delete',
      label,
      payload,
      (document) => deleteSketchObject(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  addSketchConstraint(
    payload: SketchConstraintAddInput,
    label = 'Add sketch constraint'
  ): CommandDefinition<SketchConstraintAddInput> {
    const withIds = {
      ...payload,
      ids: payload.ids ?? {
        constraintId: toSketchConstraintId(createId('scon'))
      }
    };
    return makeCommand(
      'sketch.constraint.add',
      label,
      withIds,
      (document) => addSketchConstraint(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  deleteSketchConstraint(
    payload: SketchConstraintDeleteInput,
    label = 'Delete sketch constraint'
  ): CommandDefinition<SketchConstraintDeleteInput> {
    return makeCommand(
      'sketch.constraint.delete',
      label,
      payload,
      (document) => deleteSketchConstraint(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  updateSketch(
    payload: SketchUpdateInput,
    label = 'Edit sketch'
  ): CommandDefinition<SketchUpdateInput> {
    return makeCommand(
      'sketch.update',
      label,
      payload,
      (document) => updateSketch(document, payload),
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
      }
    );
  },
  translateSketch(
    payload: SketchTranslateInput,
    label = 'Move sketch'
  ): CommandDefinition<SketchTranslateInput> {
    return makeCommand(
      'sketch.translate',
      label,
      payload,
      (document) => translateSketch(document, payload),
      (document) => {
        if (![payload.du, payload.dv, payload.dn ?? 0].every(Number.isFinite)) {
          throw new Error('Sketch translation must be finite.');
        }
        const sketch = findSketch(document, payload.sketchId);
        if (!sketch) {
          throw new Error(`Sketch ${payload.sketchId} not found.`);
        }
        if ((payload.dn ?? 0) !== 0 && sketch.planeRef.type !== 'canonical') {
          throw new Error(
            'A face-attached sketch cannot move along its normal.'
          );
        }
      }
    );
  },
  extrudeSketch(payload: ExtrudeInput): CommandDefinition<ExtrudeInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.extrude',
      'Extrude sketch',
      withIds,
      (document) => extrudeSketch(document, withIds).document,
      (document) => validateExtrudeInput(document, withIds)
    );
  },
  revolveSketch(payload: RevolveInput): CommandDefinition<RevolveInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.revolve',
      'Revolve sketch',
      withIds,
      (document) => revolveSketch(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.sketchId)) {
          throw new Error('Revolve requires an existing sketch.');
        }
      }
    );
  },
  loftSections(payload: LoftInput): CommandDefinition<LoftInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.loft',
      'Loft profiles',
      withIds,
      (document) => loftSections(document, withIds).document,
      (document) => {
        if (payload.sections.length < 2) {
          throw new Error('Loft requires at least two profile sections.');
        }
        for (const section of payload.sections) {
          if (!findSketch(document, section.sketchId)) {
            throw new Error(`Loft sketch ${section.sketchId} not found.`);
          }
        }
      }
    );
  },
  sweepProfile(payload: SweepInput): CommandDefinition<SweepInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.sweep',
      'Sweep profile',
      withIds,
      (document) => sweepProfile(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.profile.sketchId)) {
          throw new Error('Sweep profile sketch not found.');
        }
        const pathSketch = findSketch(document, payload.path.sketchId);
        if (!pathSketch) {
          throw new Error('Sweep path sketch not found.');
        }
        if (payload.path.entityIds.length === 0) {
          throw new Error('Sweep requires at least one path entity.');
        }
        const available = new Set(pathSketch.objectIds);
        if (payload.path.entityIds.some((id) => !available.has(id))) {
          throw new Error('Sweep path references a missing sketch entity.');
        }
      }
    );
  },
  helicalSweepProfile(
    payload: HelicalSweepInput
  ): CommandDefinition<HelicalSweepInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.helical-sweep',
      'Helical sweep profile',
      withIds,
      (document) => helicalSweepProfile(document, withIds).document,
      (document) => {
        if (!findSketch(document, payload.profile.sketchId)) {
          throw new Error('Helical sweep profile sketch not found.');
        }
      }
    );
  },
  booleanBodies(payload: BooleanInput): CommandDefinition<BooleanInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.boolean',
      `Boolean ${payload.operation}`,
      withIds,
      (document) => booleanBodies(document, withIds).document,
      (document) => {
        const known = new Set(document.bodyOrder);
        for (const bodyId of payload.targetBodyIds) {
          if (!known.has(bodyId)) {
            throw new Error(`Boolean target body ${bodyId} not found.`);
          }
        }
      }
    );
  },
  transformBody(payload: TransformInput): CommandDefinition<TransformInput> {
    const withIds = { ...payload, ids: payload.ids ?? createFeatureOnlyIds() };
    return makeCommand(
      'feature.transform',
      'Transform body',
      withIds,
      (document) => transformBody(document, withIds).document,
      (document) => {
        if (!document.bodyOrder.includes(payload.targetBodyId)) {
          throw new Error(
            `Transform target body ${payload.targetBodyId} not found.`
          );
        }
      }
    );
  },
  mirrorBody(payload: MirrorInput): CommandDefinition<MirrorInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.mirror',
      'Mirror body',
      withIds,
      (document) => mirrorBody(document, withIds).document,
      (document) => validateMirrorInput(document, withIds)
    );
  },
  shellBody(payload: ShellInput): CommandDefinition<ShellInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.shell',
      'Shell body',
      withIds,
      (document) => shellBody(document, withIds).document,
      (document) => validateShellInput(document, withIds)
    );
  },
  offsetSolidBody(
    payload: SolidOffsetInput
  ): CommandDefinition<SolidOffsetInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.solid-offset',
      'Offset solid',
      withIds,
      (document) => offsetSolidBody(document, withIds).document,
      (document) => {
        validateBodyTarget(document, payload.targetBodyId);
        validatePositiveModelingValue(
          document,
          'Solid offset distance',
          payload.distance
        );
      }
    );
  },
  draftBody(payload: DraftInput): CommandDefinition<DraftInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.draft',
      'Draft faces',
      withIds,
      (document) => draftBody(document, withIds).document,
      (document) => {
        validateBodyTarget(document, payload.targetBodyId);
        if (payload.faceHashes.length === 0) {
          throw new Error('Draft requires at least one face.');
        }
      }
    );
  },
  thickenFace(payload: ThickenInput): CommandDefinition<ThickenInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.thicken',
      'Thicken face',
      withIds,
      (document) => thickenFace(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  directEditBody(payload: DirectEditInput): CommandDefinition<DirectEditInput> {
    const withIds = { ...payload, ids: payload.ids ?? createFeatureOnlyIds() };
    return makeCommand(
      'feature.direct-edit',
      payload.name,
      withIds,
      (document) => directEditBody(document, withIds).document,
      (document) => {
        validateBodyTarget(document, payload.targetBodyId);
        validateDirectEditReference(payload);
      }
    );
  },
  filletEdges(
    payload: EdgeModifierInput
  ): CommandDefinition<EdgeModifierInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.fillet',
      'Fillet edges',
      withIds,
      (document) => filletEdges(document, withIds).document,
      (document) => {
        validateBodyTarget(document, payload.targetBodyId);
        validateEdgeReferences(payload);
      }
    );
  },
  chamferEdges(
    payload: EdgeModifierInput
  ): CommandDefinition<EdgeModifierInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.chamfer',
      'Chamfer edges',
      withIds,
      (document) => chamferEdges(document, withIds).document,
      (document) => {
        validateBodyTarget(document, payload.targetBodyId);
        validateEdgeReferences(payload);
      }
    );
  },
  patternBody(payload: PatternInput): CommandDefinition<PatternInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'feature.pattern',
      `${
        payload.patternKind === 'linear'
          ? 'Linear'
          : payload.patternKind === 'grid'
            ? 'Grid'
            : 'Circular'
      } pattern`,
      withIds,
      (document) => patternBody(document, withIds).document,
      (document) => validateBodyTarget(document, payload.targetBodyId)
    );
  },
  updateFeature(
    payload: FeatureUpdateInput,
    label = 'Edit feature'
  ): CommandDefinition<FeatureUpdateInput> {
    return makeCommand(
      'feature.update',
      label,
      payload,
      (document) => updateFeature(document, payload),
      (document) => validateModelingFeatureUpdate(document, payload)
    );
  },
  deleteFeature(
    payload: FeatureDeleteInput,
    label = 'Delete feature'
  ): CommandDefinition<FeatureDeleteInput> {
    return makeCommand(
      'feature.delete',
      label,
      payload,
      (document) => deleteFeature(document, payload),
      (document) => {
        if (!findFeature(document, payload.featureId)) {
          throw new Error(`Feature ${payload.featureId} not found.`);
        }
      }
    );
  },
  setParameter(
    payload: ParameterSetInput
  ): CommandDefinition<ParameterSetInput> {
    const withIds = { ...payload, ids: payload.ids ?? createParameterIds() };
    return makeCommand(
      'parameter.set',
      `Set parameter ${payload.name}`,
      withIds,
      (document) => setParameter(document, withIds)
    );
  },
  deleteParameter(
    payload: ParameterDeleteInput
  ): CommandDefinition<ParameterDeleteInput> {
    return makeCommand(
      'parameter.delete',
      `Delete parameter ${payload.name}`,
      payload,
      (document) => deleteParameter(document, payload)
    );
  },
  importMesh(payload: ImportedMeshInput): CommandDefinition<ImportedMeshInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'import.mesh',
      'Import STL mesh',
      withIds,
      (document) => importMeshBody(document, withIds).document
    );
  },
  importStep(payload: ImportedStepInput): CommandDefinition<ImportedStepInput> {
    const withIds = { ...payload, ids: payload.ids ?? createBodyFeatureIds() };
    return makeCommand(
      'import.step',
      'Import editable STEP solid',
      withIds,
      (document) => importStepBody(document, withIds).document
    );
  },
  renameNode(payload: NodeRenameInput): CommandDefinition<NodeRenameInput> {
    return makeCommand(
      'node.rename',
      `Rename to ${payload.name}`,
      payload,
      (document) => renameNode(document, payload)
    );
  },
  setNodeMetadata(
    payload: NodeMetadataInput,
    label = 'Edit properties'
  ): CommandDefinition<NodeMetadataInput> {
    return makeCommand('node.metadata.set', label, payload, (document) =>
      setNodeMetadata(document, payload)
    );
  }
};

function assertParameterName(name: string): void {
  // document-core also rejects the built-in identifiers (pi, min, round, ...),
  // which setParameter would otherwise throw on mid-transaction.
  if (!isValidParameterName(name)) {
    throw new Error(
      `Parameter name "${name}" is not usable: use letters, digits, and underscores, and avoid the built-in names.`
    );
  }
}

/**
 * Resolves the parameter values this proposal will produce, so the rest of the
 * patch can be checked against real numbers.
 *
 * `setParameter` stores any string verbatim, and a broken expression only
 * surfaces later as a non-fatal build warning whose body silently goes missing.
 * A proposal is machine-authored, so reject it at conversion time instead.
 *
 * Parameters may reference each other in any order, so this mirrors
 * getParameterScope's fixed-point pass over the proposal's own parameters
 * layered on the document's. Anything still unresolved afterwards is a genuine
 * fault — an unknown identifier, a non-finite result, or a reference cycle —
 * and re-evaluating it surfaces the real reason.
 */
function projectedParameterScope(
  document: ProjectDocument,
  proposal: CadPatchProposal
): Record<string, number> {
  const scope: Record<string, number> = {
    ...getParameterScope(document).scope
  };
  const pending = new Map<string, string>();
  for (const operation of proposal.operations) {
    if (operation.kind === 'set_parameter') {
      assertParameterName(operation.name);
      pending.set(operation.name, operation.expression);
    }
  }

  let progressed = true;
  while (progressed && pending.size > 0) {
    progressed = false;
    for (const [name, expression] of [...pending]) {
      try {
        scope[name] = evaluateExpression(expression, scope);
        pending.delete(name);
        progressed = true;
      } catch {
        // May depend on a parameter this proposal has not resolved yet.
      }
    }
  }

  for (const [name, expression] of pending) {
    let reason = 'evaluation failed.';
    try {
      evaluateExpression(expression, scope);
    } catch (error) {
      reason = error instanceof Error ? error.message : reason;
    }
    // An identifier that is unresolved only because it is another stuck
    // parameter means the proposal's parameters reference each other in a loop,
    // which reads very differently from a name that simply does not exist.
    const cyclic = [...pending.keys()].some((other) =>
      reason.includes(`"${other}"`)
    );
    throw new Error(
      cyclic
        ? `Parameter "${name}" cannot be resolved: its expression "${expression}" depends on itself through another parameter.`
        : `Parameter "${name}" has an invalid expression "${expression}": ${reason}`
    );
  }
  return scope;
}

/**
 * Uses the same resolver the kernel uses, so the boundary check accepts exactly
 * what the build will accept — `evaluateExpression` alone would let a non-finite
 * result through and fail later with the body silently missing.
 */
function assertEvaluableExpression(
  scope: Record<string, number>,
  label: string,
  value: ParamValue
): void {
  try {
    resolveParamValue(value, scope, label);
  } catch (error) {
    throw new Error(
      `${label} has an invalid expression "${String(value)}": ${
        error instanceof Error ? error.message : 'evaluation failed.'
      }`,
      { cause: error }
    );
  }
}

/**
 * Every ParamValue an operation carries may be an expression string, and an
 * unreadable one is accepted verbatim by document-core — the body then silently
 * fails to build and leaves only a warning. Check them all up front.
 */
function assertOperationExpressions(
  operation: CadPatchProposal['operations'][number],
  scope: Record<string, number>
): void {
  const vector = (
    label: string,
    value: { x: ParamValue; y: ParamValue; z: ParamValue }
  ) => {
    assertEvaluableExpression(scope, `${label}.x`, value.x);
    assertEvaluableExpression(scope, `${label}.y`, value.y);
    assertEvaluableExpression(scope, `${label}.z`, value.z);
  };
  // Text carries fields that are text, not dimensions — the string itself, a
  // font family id, a style, an alignment. Feeding those to the expression
  // evaluator would reject every valid text object, so they are named here
  // rather than guessed at from their runtime type.
  const nonDimensionKeys = new Set([
    'objectKind',
    'construction',
    'text',
    'fontFamily',
    'fontStyle',
    'align'
  ]);
  const sketchObjects = (name: string, objects: SketchObjectData[]) => {
    objects.forEach((object, index) => {
      Object.entries(object).forEach(([key, value]) => {
        if (!nonDimensionKeys.has(key) && typeof value !== 'boolean') {
          assertEvaluableExpression(
            scope,
            `${name} objects[${index}].${key}`,
            value
          );
        }
      });
    });
  };

  switch (operation.kind) {
    // set_parameter is already resolved and checked by projectedParameterScope.
    case 'set_feature_dimension':
      assertEvaluableExpression(
        scope,
        `${operation.field} on ${operation.featureId}`,
        operation.value
      );
      break;
    case 'set_sketch_dimension':
      assertEvaluableExpression(
        scope,
        `${operation.field} on ${operation.objectId}`,
        operation.value
      );
      break;
    case 'add_primitive':
      for (const [field, value] of Object.entries(operation.dimensions)) {
        if (value !== null) {
          assertEvaluableExpression(scope, `${operation.name} ${field}`, value);
        }
      }
      break;
    case 'add_sketch':
      assertEvaluableExpression(
        scope,
        `${operation.name} offset`,
        operation.offset
      );
      sketchObjects(operation.name, operation.objects);
      break;
    case 'add_extrude':
      assertEvaluableExpression(
        scope,
        `${operation.name} distance`,
        operation.distance
      );
      break;
    case 'add_revolve':
      // Optional: an omitted (or explicitly null) angle is a full turn.
      if (operation.angleDeg !== undefined && operation.angleDeg !== null) {
        assertEvaluableExpression(
          scope,
          `${operation.name} angleDeg`,
          operation.angleDeg
        );
      }
      break;
    case 'add_transform':
      vector(`${operation.name} translation`, operation.translation);
      vector(`${operation.name} rotationDeg`, operation.rotationDeg);
      break;
    case 'add_direct_edit':
      if (operation.operation.kind === 'resize-through-hole') {
        assertEvaluableExpression(
          scope,
          `${operation.name} diameter`,
          operation.operation.diameter
        );
      } else if (operation.operation.kind === 'offset-face') {
        assertEvaluableExpression(
          scope,
          `${operation.name} offset`,
          operation.operation.offset
        );
      } else if (operation.operation.kind === 'resize-cylindrical-face') {
        assertEvaluableExpression(
          scope,
          `${operation.name} radius`,
          operation.operation.radius
        );
      }
      break;
    case 'add_face_sketch':
      sketchObjects(operation.name, operation.objects);
      break;
    case 'add_multi_profile_extrude':
      assertEvaluableExpression(
        scope,
        `${operation.name} distance`,
        operation.distance
      );
      break;
    case 'add_mirror':
      vector(`${operation.name} plane.origin`, operation.plane.origin);
      vector(`${operation.name} plane.normal`, operation.plane.normal);
      break;
    case 'add_shell':
      assertEvaluableExpression(
        scope,
        `${operation.name} thickness`,
        operation.thickness
      );
      break;
    case 'add_solid_offset':
      assertEvaluableExpression(
        scope,
        `${operation.name} distance`,
        operation.distance
      );
      break;
    case 'add_edge_modifier':
      assertEvaluableExpression(
        scope,
        `${operation.name} size`,
        operation.size
      );
      break;
    case 'add_pattern':
      assertEvaluableExpression(
        scope,
        `${operation.name} count`,
        operation.count
      );
      assertEvaluableExpression(
        scope,
        `${operation.name} spacing`,
        operation.spacing
      );
      assertEvaluableExpression(
        scope,
        `${operation.name} angleDeg`,
        operation.angleDeg
      );
      break;
    default:
      break;
  }
}

/**
 * Resolves the `$localId` aliases an AI proposal uses to reference bodies it
 * creates within that same proposal.
 *
 * Body-creating factories accept pre-assigned ids, so the real `BodyId` is
 * known at command-construction time and can be handed to later operations.
 * Aliases are resolved here and never reach a serialized payload, which keeps
 * the command log, replay, and undo free of AI-only concepts.
 */
class LocalBodyScope {
  private readonly aliases = new Map<string, BodyId>();
  /** Body → phrase describing what consumed it, used in rejection messages. */
  private readonly consumed = new Map<BodyId, string>();

  constructor(private readonly document: ProjectDocument) {
    // Consumption is not limited to this proposal: a body an earlier turn's
    // boolean absorbed is still listed in bodyOrder and would otherwise pass
    // every check here. The canonical feature history is the primary source,
    // because derived state can be absent or stale — a document that was
    // loaded but not rebuilt yet — and this check must fail closed without
    // it. The kinds below mirror exactly which features the exact adapter
    // marks as consuming their target; an extrude whose stored operation the
    // kernel later refuses stays consumed here, which rejects rather than
    // risks targeting it.
    const consumedByHistory = 'feature in the document';
    for (const featureId of document.featureOrder) {
      const feature = findFeature(document, featureId);
      if (!feature) {
        continue;
      }
      const data = feature.data;
      switch (data.featureKind) {
        case 'boolean':
          for (const bodyId of data.targetBodyIds) {
            this.consumed.set(bodyId, consumedByHistory);
          }
          break;
        case 'extrude':
          if (data.targetBodyId) {
            this.consumed.set(data.targetBodyId, consumedByHistory);
          }
          break;
        case 'shell':
        case 'solid-offset':
        case 'draft':
        case 'fillet':
        case 'chamfer':
        case 'pattern':
          this.consumed.set(data.targetBodyId, consumedByHistory);
          break;
        default:
          break;
      }
    }
    for (const [bodyId, body] of Object.entries(
      document.derived.bodyRepresentations
    )) {
      if (body.consumed && !this.consumed.has(bodyId as BodyId)) {
        this.consumed.set(bodyId as BodyId, consumedByHistory);
      }
    }
  }

  declare(localId: string | null | undefined, bodyId: BodyId): void {
    if (typeof localId !== 'string') {
      return;
    }
    const alias = normalizeLocalId(localId);
    // The contract validator rejects duplicates too, but this function is also
    // called directly, and a silent last-writer-wins rebind would retarget an
    // already-resolved reference at the wrong body.
    if (this.aliases.has(alias)) {
      throw new Error(`Duplicate localId "${alias}" in proposal.`);
    }
    this.aliases.set(alias, bodyId);
  }

  /** Accepts an existing digest bodyId or a `$alias` declared earlier. */
  resolve(reference: string): BodyId {
    if (!isLocalBodyRef(reference)) {
      return reference as BodyId;
    }
    const alias = normalizeLocalId(reference);
    const bodyId = this.aliases.get(alias);
    if (!bodyId) {
      throw new Error(
        `Proposal references "${reference}" but no earlier operation creates that body.`
      );
    }
    return bodyId;
  }

  /**
   * Booleans, edge modifiers, and patterns all consume their target: the body
   * is gone from the result, so re-targeting it afterwards silently models the
   * wrong thing. Reject it up front and name the operation that consumed it.
   */
  assertLive(bodyId: BodyId, reference: string): void {
    const consumedBy = this.consumed.get(bodyId);
    if (consumedBy) {
      throw new Error(
        `Body "${reference}" was already consumed by an earlier ${consumedBy}.`
      );
    }
  }

  consume(bodyIds: BodyId[], operationKind: string): void {
    bodyIds.forEach((bodyId) =>
      this.consumed.set(bodyId, `${operationKind} in this proposal`)
    );
  }

  /** Guards against a reference to a body that is not in the document either. */
  assertKnown(bodyId: BodyId, reference: string): void {
    if (isLocalBodyRef(reference)) {
      return;
    }
    if (!this.document.bodyOrder.includes(bodyId)) {
      throw new Error(`Target body ${reference} not found in the document.`);
    }
  }
}

/**
 * Collapses repeated entity-wide references.
 *
 * Two sample points inside two glyphs of the same text object name the same
 * entity, and resolving that entity twice hands the extrude the same profiles
 * twice — which `resolveRegionProfiles` rejects as a duplicate. The
 * same-region guard upstream cannot see this: those are genuinely different
 * regions, they simply resolve through one reference.
 */
function dedupeProfileReferences(
  references: SketchProfileReference[]
): SketchProfileReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    if (reference.all !== true) {
      return true;
    }
    const key = [...reference.sourceEntityIds].sort().join('|');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Converts a reviewed AI proposal into normal undoable document commands. */
export function commandsForCadPatch(
  document: ProjectDocument,
  proposal: CadPatchProposal
): AnyCommand[] {
  const scope = new LocalBodyScope(document);
  const parameterScope = projectedParameterScope(document, proposal);
  proposal.operations.forEach((operation) =>
    assertOperationExpressions(operation, parameterScope)
  );

  const resolveBody = (reference: string): BodyId => {
    const bodyId = scope.resolve(reference);
    scope.assertKnown(bodyId, reference);
    scope.assertLive(bodyId, reference);
    return bodyId;
  };

  /**
   * Sketches created earlier in this proposal, addressable by $alias.
   *
   * The object *ids* are carried alongside the data because a profile
   * reference may have to name them: a text object's regions are referenced by
   * entity id, not by geometry (see `SketchEntityProfileReference`). For a
   * sketch this proposal creates, the ids are the ones the `add_sketch`
   * command was minted with, so they are known before it executes.
   */
  const localSketches = new Map<
    string,
    { sketchId: SketchId; objects: SketchObjectData[]; objectIds: EntityId[] }
  >();
  const resolveSketch = (
    reference: string
  ): {
    sketchId: SketchId;
    objects: SketchObjectData[];
    objectIds: EntityId[];
  } => {
    if (isLocalBodyRef(reference)) {
      const local = localSketches.get(normalizeLocalId(reference));
      if (!local) {
        throw new Error(
          `Sketch alias ${reference} is not declared by an earlier add_sketch.`
        );
      }
      return local;
    }
    const sketch = findSketch(document, reference as SketchId);
    if (!sketch) {
      throw new Error(`Sketch ${reference} not found in the document.`);
    }
    const objects: SketchObjectData[] = [];
    const objectIds: EntityId[] = [];
    for (const objectId of sketch.objectIds) {
      const node = document.nodes[objectId];
      if (node?.kind === 'sketch-object') {
        objects.push(node.data);
        objectIds.push(objectId);
      }
    }
    return { sketchId: sketch.sketchId, objects, objectIds };
  };

  /**
   * The profile reference to persist for one resolved region.
   *
   * A region bounded solely by objects that carry their own outlines — today
   * text — is referenced by entity id. Every geometry-derived field changes at
   * once when the string does, and partially: a letter that did not move keeps
   * resolving while one that vanished does not, which half-updates the model.
   * Everything else keeps the geometry reference it has always had, byte for
   * byte.
   */
  const profileReferenceFor = (
    region: SketchRegion,
    samplePoint: { x: number; y: number },
    objects: SketchObjectData[],
    objectIds: EntityId[]
  ): SketchProfileReference => {
    const kindOf = (entityId: string): SketchObjectData | undefined =>
      objects[objectIds.indexOf(entityId as EntityId)];
    const entityWide =
      region.sourceEntityIds.length > 0 &&
      region.sourceEntityIds.every(
        (entityId) => kindOf(entityId)?.objectKind === 'text'
      );
    if (entityWide) {
      return {
        all: true,
        sourceEntityIds: [...region.sourceEntityIds].sort()
      };
    }
    return {
      regionFingerprint: region.regionFingerprint,
      samplePoint,
      sourceArea: region.area
    };
  };

  // Proposal conversion happens before the transaction runs. Keep the latest
  // sketch-object payload here so two bindings on one object compose instead
  // of the later command restoring fields from the original document.
  const projectedSketchObjects = new Map<string, SketchObjectData>();
  const projectedTransforms = new Map<string, ParametricTransform3D>();

  return proposal.operations.map((operation) => {
    switch (operation.kind) {
      case 'set_parameter':
        return commandFactories.setParameter({
          name: operation.name,
          expression: operation.expression
        });
      case 'set_sketch_dimension': {
        const sketch = findSketch(document, operation.sketchId);
        const objectId = toEntityId(operation.objectId);
        const object = sketch?.objectIds.includes(objectId)
          ? document.nodes[objectId]
          : undefined;
        if (!sketch || !object || object.kind !== 'sketch-object') {
          throw new Error(
            `Sketch object ${operation.objectId} is not available on ${operation.sketchId}.`
          );
        }
        if (!isSketchDimensionField(object.data.objectKind, operation.field)) {
          throw new Error(
            `${object.data.objectKind} sketch object ${operation.objectId} does not expose an editable ${operation.field} dimension.`
          );
        }
        const current =
          projectedSketchObjects.get(operation.objectId) ?? object.data;
        const data = {
          ...current,
          [operation.field]: operation.value
        };
        projectedSketchObjects.set(operation.objectId, data);
        return commandFactories.updateSketchObject({
          sketchId: sketch.sketchId,
          objectId,
          data
        });
      }
      case 'add_primitive': {
        const dimensions = Object.fromEntries(
          Object.entries(operation.dimensions).filter(
            (entry) => entry[1] !== null
          )
        ) as Record<string, string | number>;
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.addPrimitive({
          name: operation.name,
          primitiveKind: operation.primitiveKind,
          dimensions,
          ids
        });
      }
      case 'delete_feature':
        return commandFactories.deleteFeature({
          featureId: operation.featureId
        });
      case 'rename_feature': {
        const feature = findFeature(document, operation.featureId);
        if (!feature) {
          throw new Error(`Feature ${operation.featureId} not found.`);
        }
        return commandFactories.renameNode({
          nodeId: feature.id,
          name: operation.name
        });
      }
      case 'add_sketch': {
        const ids = createSketchFeatureIds(operation.objects.length);
        const analysis = computeSketchProfileAnalysis(
          operation.objects.map((data, index) => ({
            id: ids.objectNodeIds[index] ?? `object_${index}`,
            data
          })),
          (value) =>
            resolveParamValue(value, parameterScope, 'sketch dimension')
        );
        const blockingDiagnostic = analysis.diagnostics.find(
          (diagnostic) =>
            // Text outlines are expanded asynchronously by the browser
            // worker; this synchronous command layer has no font provider.
            diagnostic.code !== 'unresolved-outline' &&
            (diagnostic.severity === 'error' ||
              diagnostic.code === 'open-endpoint' ||
              diagnostic.code === 'gap-within-tolerance')
        );
        if (blockingDiagnostic) {
          throw new Error(
            `add_sketch requires closed, valid profile paths: ${blockingDiagnostic.message}`
          );
        }
        if (operation.localId) {
          localSketches.set(normalizeLocalId(operation.localId), {
            sketchId: ids.sketchId,
            objects: operation.objects,
            objectIds: [...ids.objectNodeIds]
          });
        }
        return commandFactories.addSketch({
          name: operation.name,
          planeRef: {
            type: 'canonical',
            plane: operation.plane,
            offset: operation.offset
          },
          objects: operation.objects,
          ids
        });
      }
      case 'add_extrude': {
        const sketch = resolveSketch(operation.sketchId);
        let profile: ExtrudeInput['profile'];
        if (operation.samplePoint) {
          // Resolve the region reference now so the direct-manipulation and
          // AI paths store byte-identical features.
          const regions = computeSketchRegions(
            sketch.objects.map((data, index) => ({
              id: sketch.objectIds[index] ?? `object_${index}`,
              data
            })),
            (value) =>
              resolveParamValue(value, parameterScope, 'sketch dimension')
          );
          const region = regionAtPoint(regions, operation.samplePoint);
          if (!region) {
            throw new Error(
              `add_extrude samplePoint (${operation.samplePoint.x}, ${operation.samplePoint.y}) is not inside any closed region of the sketch.`
            );
          }
          profile = profileReferenceFor(
            region,
            operation.samplePoint,
            sketch.objects,
            sketch.objectIds
          );
        }
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.extrudeSketch({
          name: operation.name,
          sketchId: sketch.sketchId,
          distance: operation.distance,
          profile,
          ids
        });
      }
      case 'add_revolve': {
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.revolveSketch({
          name: operation.name,
          sketchId: resolveSketch(operation.sketchId).sketchId,
          axis: operation.axis,
          // Null is the schema's way of saying "omitted"; a full turn.
          angleDeg: operation.angleDeg ?? undefined,
          ids
        });
      }
      case 'add_boolean': {
        const targetBodyIds = operation.targetBodyIds.map(resolveBody);
        const ids = createBodyFeatureIds();
        // Operands are resolved before the result is declared, so a boolean can
        // never reference itself, and they are marked consumed afterwards.
        scope.declare(operation.localId, ids.bodyId);
        scope.consume(targetBodyIds, 'boolean');
        return commandFactories.booleanBodies({
          name: operation.name,
          operation: operation.operation,
          targetBodyIds,
          ids
        });
      }
      case 'add_transform':
        // transformBody mutates the target in place and returns the same body,
        // so the alias (if any) keeps pointing at the same BodyId.
        return commandFactories.transformBody({
          name: operation.name,
          targetBodyId: resolveBody(operation.targetBodyId),
          translation: operation.translation,
          rotationDeg: operation.rotationDeg
        });
      case 'add_direct_edit': {
        if (isLocalBodyRef(operation.targetBodyId)) {
          throw new Error(
            'add_direct_edit cannot target same-proposal topology.'
          );
        }
        return commandFactories.directEditBody({
          name: operation.name,
          targetBodyId: resolveBody(operation.targetBodyId),
          operation: operation.operation,
          ids: createFeatureOnlyIds()
        });
      }
      case 'add_face_sketch': {
        if (isLocalBodyRef(operation.planeRef.bodyId)) {
          throw new Error(
            'add_face_sketch cannot target same-proposal topology.'
          );
        }
        const ids = createSketchFeatureIds(operation.objects.length);
        const planeRef = {
          ...operation.planeRef,
          bodyId: resolveBody(operation.planeRef.bodyId)
        };
        if (operation.localId) {
          localSketches.set(normalizeLocalId(operation.localId), {
            sketchId: ids.sketchId,
            objects: operation.objects,
            objectIds: [...ids.objectNodeIds]
          });
        }
        return commandFactories.addSketch({
          name: operation.name,
          planeRef,
          objects: operation.objects,
          ids
        });
      }
      case 'add_multi_profile_extrude': {
        const sketch = resolveSketch(operation.sketchId);
        const regions = computeSketchRegions(
          sketch.objects.map((data, index) => ({
            id: sketch.objectIds[index] ?? `object_${index}`,
            data
          })),
          (value) =>
            resolveParamValue(value, parameterScope, 'sketch dimension')
        );
        const selected = operation.samplePoints.map((samplePoint) => {
          const region = regionAtPoint(regions, samplePoint);
          if (!region) {
            throw new Error(
              `add_multi_profile_extrude samplePoint (${samplePoint.x}, ${samplePoint.y}) is not inside any closed region of the sketch.`
            );
          }
          return { region, samplePoint };
        });
        if (
          new Set(selected.map(({ region }) => region.profileId)).size !==
          selected.length
        ) {
          throw new Error(
            'add_multi_profile_extrude selects the same closed region more than once.'
          );
        }
        const ids = createBodyFeatureIds();
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.extrudeSketch({
          name: operation.name,
          sketchId: sketch.sketchId,
          distance: operation.distance,
          profiles: dedupeProfileReferences(
            selected.map(({ region, samplePoint }) =>
              profileReferenceFor(
                region,
                samplePoint,
                sketch.objects,
                sketch.objectIds
              )
            )
          ),
          ids
        });
      }
      case 'add_mirror': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        return commandFactories.mirrorBody({
          name: operation.name,
          targetBodyId,
          plane: operation.plane,
          ids
        });
      }
      case 'add_shell': {
        if (isLocalBodyRef(operation.targetBodyId)) {
          throw new Error('add_shell cannot target same-proposal topology.');
        }
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], 'shell');
        return commandFactories.shellBody({
          name: operation.name,
          targetBodyId,
          openingFaceHashes: operation.openingFaceHashes,
          openingFaceReferences: operation.openingFaceReferences,
          thickness: operation.thickness,
          ids
        });
      }
      case 'add_solid_offset': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], 'solid-offset');
        return commandFactories.offsetSolidBody({
          name: operation.name,
          targetBodyId,
          distance: operation.distance,
          ids
        });
      }
      case 'add_edge_modifier': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], operation.modifier);
        const payload = {
          name: operation.name,
          targetBodyId,
          edgeHashes: operation.edgeHashes,
          size: operation.size,
          ids
        };
        return operation.modifier === 'fillet'
          ? commandFactories.filletEdges(payload)
          : commandFactories.chamferEdges(payload);
      }
      case 'add_pattern': {
        const ids = createBodyFeatureIds();
        const targetBodyId = resolveBody(operation.targetBodyId);
        scope.declare(operation.localId, ids.bodyId);
        scope.consume([targetBodyId], 'pattern');
        return commandFactories.patternBody({
          name: operation.name,
          targetBodyId,
          patternKind: operation.patternKind,
          count: operation.count,
          axis: operation.axis,
          spacing: operation.spacing,
          angleDeg: operation.angleDeg,
          ids
        });
      }
      case 'set_feature_dimension': {
        const feature = findFeature(document, operation.featureId);
        if (!feature) {
          throw new Error(`Feature ${operation.featureId} not found.`);
        }
        if (feature.data.featureKind === 'primitive') {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { dimensions: { [operation.field]: operation.value } }
          });
        }
        if (
          feature.data.featureKind === 'extrude' &&
          operation.field === 'distance'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { distance: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'revolve' &&
          operation.field === 'angleDeg'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { angleDeg: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'shell' &&
          operation.field === 'thickness'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { thickness: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'solid-offset' &&
          operation.field === 'distance'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { distance: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'fillet' &&
          operation.field === 'radius'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { radius: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'chamfer' &&
          operation.field === 'distance'
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { distance: operation.value }
          });
        }
        if (
          feature.data.featureKind === 'pattern' &&
          ['count', 'spacing', 'angleDeg'].includes(operation.field)
        ) {
          return commandFactories.updateFeature({
            featureId: feature.featureId,
            data: { [operation.field]: operation.value }
          });
        }
        if (feature.data.featureKind === 'transform') {
          const [group, axis] = operation.field.split('.');
          if (
            (group === 'translation' || group === 'rotationDeg') &&
            (axis === 'x' || axis === 'y' || axis === 'z')
          ) {
            const current =
              projectedTransforms.get(String(feature.featureId)) ??
              feature.data.transform;
            const transform = {
              ...current,
              [group]: {
                ...current[group],
                [axis]: operation.value
              }
            };
            projectedTransforms.set(String(feature.featureId), transform);
            return commandFactories.updateFeature({
              featureId: feature.featureId,
              data: { transform }
            });
          }
        }
        if (feature.data.featureKind === 'direct-edit') {
          const edit = feature.data.operation;
          const editable =
            (edit.kind === 'resize-through-hole' &&
              operation.field === 'diameter') ||
            (edit.kind === 'resize-cylindrical-face' &&
              operation.field === 'radius') ||
            (edit.kind === 'resize-blend' && operation.field === 'newRadius') ||
            (edit.kind === 'offset-face' && operation.field === 'offset');
          if (editable) {
            return commandFactories.updateFeature({
              featureId: feature.featureId,
              data: {
                operation: { ...edit, [operation.field]: operation.value }
              }
            });
          }
        }
        throw new Error(
          `Feature ${feature.name} does not expose an editable ${operation.field} dimension.`
        );
      }
    }
  });
}

/** Bound on stored undo/redo entries so long sessions cannot exhaust memory. */
const MAX_HISTORY_DEPTH = 100;

/**
 * Owns the current document and its undo/redo history.
 *
 * Documents are immutable values (every document-core operation clones before
 * mutating), so history entries hold plain references instead of deep copies.
 */
export class CommandManager {
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  constructor(public document: ProjectDocument) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  execute(command: AnyCommand): ProjectDocument {
    command.validate(this.document);
    const previous = this.document;
    let next = command.apply(this.document);
    next.commandLog.push(command.serialize());
    next = appendRevision(next, command.label);
    this.pushUndo({ snapshot: previous, command: command.serialize() });
    this.redoStack = [];
    this.document = next;
    return this.document;
  }

  commitDerivedState(derived: ProjectDocument['derived']): ProjectDocument {
    this.document = attachDerivedState(this.document, derived);
    return this.document;
  }

  /**
   * Executes a document normalization — a repair the rebuild proved, not a
   * user edit. It persists like any command (log entry, revision, version
   * bump) but creates no history entry, so undo/redo keep targeting the
   * user's own actions. Interleaving stays consistent because history
   * entries restore whole-document snapshots; a normalization undone as part
   * of a snapshot swap is simply re-proven and reapplied by the next rebuild.
   */
  normalize(command: AnyCommand): ProjectDocument {
    command.validate(this.document);
    let next = command.apply(this.document);
    next.commandLog.push(command.serialize());
    next = appendRevision(next, command.label);
    this.document = next;
    return this.document;
  }

  undo(): ProjectDocument {
    const entry = this.undoStack.pop();
    if (!entry) {
      return this.document;
    }
    const current = this.document;
    this.redoStack.push({ snapshot: current, command: entry.command });
    this.document = restoreHistorySnapshot(
      current,
      entry.snapshot,
      `Undo ${entry.command.label}`
    );
    return this.document;
  }

  redo(): ProjectDocument {
    const entry = this.redoStack.pop();
    if (!entry) {
      return this.document;
    }
    const current = this.document;
    this.undoStack.push({ snapshot: current, command: entry.command });
    this.document = restoreHistorySnapshot(
      current,
      entry.snapshot,
      `Redo ${entry.command.label}`
    );
    return this.document;
  }

  runTransaction(label: string, commands: AnyCommand[]): ProjectDocument {
    const previous = this.document;
    let next = this.document;
    const serialized: SerializedCommand[] = [];
    for (const command of commands) {
      command.validate(next);
      next = command.apply(next);
      serialized.push(command.serialize());
    }
    if (next === this.document) {
      return this.document;
    }
    next.commandLog.push(...serialized);
    next = appendRevision(next, label);
    this.pushUndo({
      snapshot: previous,
      command: {
        kind: 'transaction',
        label,
        payload: serialized,
        replayVersion: 1,
        timestamp: nowIso()
      }
    });
    this.redoStack = [];
    this.document = next;
    return this.document;
  }

  private pushUndo(entry: HistoryEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_HISTORY_DEPTH) {
      this.undoStack.shift();
    }
  }
}

/**
 * Restores a model snapshot without rewinding the document's durable timeline.
 * Collaboration treats `version` as a monotonic room clock, while checkpoints
 * are save points rather than undoable model state. Preserve both collections
 * and record Undo/Redo as new forward revisions.
 */
function restoreHistorySnapshot(
  current: ProjectDocument,
  snapshot: ProjectDocument,
  reason: string
): ProjectDocument {
  return appendRevision(
    {
      ...snapshot,
      version: current.version,
      revisions: current.revisions,
      checkpoints: current.checkpoints
    },
    reason
  );
}

export function replayCommands(
  initialDocument: ProjectDocument,
  serializedCommands: SerializedCommand[]
): ProjectDocument {
  let next = deepClone(initialDocument);
  next.commandLog = [];
  next.revisions = initialDocument.revisions.slice(0, 1);

  for (const command of serializedCommands) {
    switch (command.kind) {
      case 'primitive.add':
        next = addPrimitiveFeature(next, command.payload as PrimitiveInput);
        break;
      case 'sketch.add':
        next = addSketchFeature(next, command.payload as SketchInput).document;
        break;
      case 'sketch.translate':
        next = translateSketch(next, command.payload as SketchTranslateInput);
        break;
      case 'sketch.update':
        next = updateSketch(next, command.payload as SketchUpdateInput);
        break;
      case 'sketch.object.add':
        next = addSketchObjects(
          next,
          command.payload as SketchObjectAddInput
        ).document;
        break;
      case 'sketch.object.update':
        next = updateSketchObject(
          next,
          command.payload as SketchObjectUpdateInput
        );
        break;
      case 'sketch.object.delete':
        next = deleteSketchObject(
          next,
          command.payload as SketchObjectDeleteInput
        );
        break;
      case 'sketch.constraint.add':
        next = addSketchConstraint(
          next,
          command.payload as SketchConstraintAddInput
        ).document;
        break;
      case 'sketch.constraint.delete':
        next = deleteSketchConstraint(
          next,
          command.payload as SketchConstraintDeleteInput
        );
        break;
      case 'feature.extrude':
        next = extrudeSketch(next, command.payload as ExtrudeInput).document;
        break;
      case 'feature.revolve':
        next = revolveSketch(next, command.payload as RevolveInput).document;
        break;
      case 'feature.loft':
        next = loftSections(next, command.payload as LoftInput).document;
        break;
      case 'feature.sweep':
        next = sweepProfile(next, command.payload as SweepInput).document;
        break;
      case 'feature.helical-sweep':
        next = helicalSweepProfile(
          next,
          command.payload as HelicalSweepInput
        ).document;
        break;
      case 'feature.boolean':
        next = booleanBodies(next, command.payload as BooleanInput).document;
        break;
      case 'feature.transform':
        next = transformBody(next, command.payload as TransformInput).document;
        break;
      case 'feature.mirror':
        next = mirrorBody(next, command.payload as MirrorInput).document;
        break;
      case 'feature.shell':
        next = shellBody(next, command.payload as ShellInput).document;
        break;
      case 'feature.solid-offset':
        next = offsetSolidBody(
          next,
          command.payload as SolidOffsetInput
        ).document;
        break;
      case 'feature.draft':
        next = draftBody(next, command.payload as DraftInput).document;
        break;
      case 'feature.thicken':
        next = thickenFace(next, command.payload as ThickenInput).document;
        break;
      case 'feature.direct-edit':
        next = directEditBody(
          next,
          command.payload as DirectEditInput
        ).document;
        break;
      case 'feature.fillet':
        next = filletEdges(next, command.payload as EdgeModifierInput).document;
        break;
      case 'feature.chamfer':
        next = chamferEdges(
          next,
          command.payload as EdgeModifierInput
        ).document;
        break;
      case 'feature.pattern':
        next = patternBody(next, command.payload as PatternInput).document;
        break;
      case 'feature.update':
        next = updateFeature(next, command.payload as FeatureUpdateInput);
        break;
      case 'feature.delete':
        next = deleteFeature(next, command.payload as FeatureDeleteInput);
        break;
      case 'parameter.set':
        next = setParameter(next, command.payload as ParameterSetInput);
        break;
      case 'parameter.delete':
        next = deleteParameter(next, command.payload as ParameterDeleteInput);
        break;
      case 'import.mesh':
        next = importMeshBody(
          next,
          command.payload as ImportedMeshInput
        ).document;
        break;
      case 'import.step':
        next = importStepBody(
          next,
          command.payload as ImportedStepInput
        ).document;
        break;
      case 'node.rename':
        next = renameNode(next, command.payload as NodeRenameInput);
        break;
      case 'node.metadata.set':
        next = setNodeMetadata(next, command.payload as NodeMetadataInput);
        break;
      default:
        // Unknown kinds are skipped (not fatal) so documents written by newer
        // clients still load; the skip is surfaced for debuggability.
        console.warn(
          `replayCommands: skipping unknown command kind "${command.kind}".`
        );
        continue;
    }

    next.commandLog.push(command);
  }

  return appendRevision(next, 'Replay');
}
