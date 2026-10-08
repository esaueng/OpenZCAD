/**
 * One-line summaries of patch operations, so a proposal can be reviewed before
 * it is applied rather than trusted on the strength of its summary sentence.
 */
import {
  isLocalBodyRef,
  normalizeLocalId,
  type CadPatchOperation
} from '@openzcad/ai-contracts';
import type { ParamValue } from '@openzcad/shared';

/** Renders a body reference for a human: `$box_outer` reads as "Box Outer". */
export function describeBodyRef(reference: string): string {
  if (!isLocalBodyRef(reference)) {
    return reference;
  }
  return normalizeLocalId(reference)
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function value(input: ParamValue | null): string {
  return input === null || input === undefined ? '—' : String(input);
}

function dimensionList(
  dimensions: Extract<
    CadPatchOperation,
    { kind: 'add_primitive' }
  >['dimensions']
): string {
  const parts = Object.entries(dimensions).flatMap(([key, entry]) =>
    entry === null || entry === undefined ? [] : [`${key} ${String(entry)}`]
  );
  return parts.length > 0 ? parts.join(' · ') : 'no dimensions';
}

function vector(input: {
  x: ParamValue;
  y: ParamValue;
  z: ParamValue;
}): string {
  return `${value(input.x)}, ${value(input.y)}, ${value(input.z)}`;
}

function isZeroVector(input: {
  x: ParamValue;
  y: ParamValue;
  z: ParamValue;
}): boolean {
  return [input.x, input.y, input.z].every(
    (component) => Number(component) === 0
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function describeOperation(operation: CadPatchOperation): string {
  switch (operation.kind) {
    case 'add_raised_feature_control':
      return `Separate the measured raised profiles of ${describeBodyRef(operation.targetBodyId)}, shown by ${operation.parameter}`;
    case 'use_edit_candidate':
      return `Measured parameter controls on ${describeBodyRef(operation.targetBodyId)}, at their current values`;
    case 'set_parameter':
      return `Set ${operation.name} = ${operation.expression}`;
    case 'rename_parameter':
      return `Rename parameter ${operation.name} to ${operation.newName}`;
    case 'delete_parameter':
      return `Delete parameter ${operation.name}`;
    case 'set_feature_dimension':
      return `Set ${operation.field} = ${value(operation.value)} on ${operation.featureId}`;
    case 'set_sketch_dimension':
      return `Set ${operation.field} = ${value(operation.value)} on sketch object ${operation.objectId}`;
    case 'add_primitive':
      return `${operation.name} — ${operation.primitiveKind}, ${dimensionList(operation.dimensions)}`;
    case 'delete_feature':
      return `Delete ${operation.featureId}`;
    case 'rename_feature':
      return `Rename ${operation.featureId} to ${operation.name}`;
    case 'add_sketch':
      return `${operation.name} — sketch on ${operation.plane}, ${operation.objects.length} object${operation.objects.length === 1 ? '' : 's'}`;
    case 'add_extrude':
      return `${operation.name} — extrude ${describeBodyRef(operation.sketchId)} by ${value(operation.distance)}${operation.samplePoint ? ' (one region)' : ''}`;
    case 'add_revolve':
      return `${operation.name} — revolve ${describeBodyRef(operation.sketchId)} about its ${operation.axis} axis`;
    case 'add_boolean':
      return `${operation.name} — ${operation.operation} ${operation.targetBodyIds.map(describeBodyRef).join(operation.operation === 'subtract' ? ' minus ' : ' + ')}`;
    case 'add_transform': {
      const moves = [
        isZeroVector(operation.translation)
          ? null
          : `move to ${vector(operation.translation)}`,
        isZeroVector(operation.rotationDeg)
          ? null
          : `rotate ${vector(operation.rotationDeg)}°`
      ].filter(Boolean);
      return `${operation.name} — ${describeBodyRef(operation.targetBodyId)}: ${moves.length > 0 ? moves.join(', ') : 'no change'}`;
    }
    case 'add_growing_holder_hole_control':
      return `${operation.name} — drive both ${value(operation.holes[0]?.sourceDiameter ?? 0)} mounting bores of ${describeBodyRef(operation.targetBodyId)} by ${operation.parameter}`;
    case 'add_growing_holder_recipe':
      return `${operation.name} — grow the measured ${value(operation.opening.sourceOpening)} opening of ${describeBodyRef(operation.targetBodyId)} along ${operation.opening.axis}, driven by ${operation.parameter}${operation.opening.lettering ? '; keep the complete lettering together with a show_text toggle' : ''}`;
    case 'add_imported_opening_recipe':
      return `${operation.name} — resize the measured ${value(operation.sourceWidth)} opening of ${describeBodyRef(operation.targetBodyId)} to ${value(operation.width)} along ${operation.axis}`;
    case 'add_direct_edit':
      return `${operation.name} — ${operation.operation.kind.replaceAll('-', ' ')} on ${describeBodyRef(operation.targetBodyId)}`;
    case 'add_edge_modifier':
      return `${operation.name} — ${operation.modifier} ${
        operation.edgeSelector === 'all-feature-edges'
          ? 'all feature edges'
          : operation.edgeSelector === 'circular-rims'
            ? 'all circular rims'
            : `${operation.edgeHashes.length} edge${operation.edgeHashes.length === 1 ? '' : 's'}`
      } at ${value(operation.size)} on ${describeBodyRef(operation.targetBodyId)}`;
    case 'add_pattern':
      return `${operation.name} — ${operation.patternKind} pattern of ${describeBodyRef(operation.targetBodyId)}, ${value(operation.count)} along ${operation.axis}`;
    case 'add_face_sketch':
      return `${operation.name} — sketch on face ${operation.planeRef.faceReference.lineageName}, ${plural(operation.objects.length, 'object')}`;
    case 'add_multi_profile_extrude':
      return `${operation.name} — extrude ${plural(operation.samplePoints.length, 'region')} of ${describeBodyRef(operation.sketchId)} by ${value(operation.distance)}`;
    case 'add_mirror':
      return `${operation.name} — mirror ${describeBodyRef(operation.targetBodyId)} across the plane through ${vector(operation.plane.origin)}, normal ${vector(operation.plane.normal)}`;
    case 'add_shell':
      return `${operation.name} — shell ${describeBodyRef(operation.targetBodyId)} at ${value(operation.thickness)}, ${plural(operation.openingFaceHashes.length, 'open face')}`;
    case 'add_solid_offset':
      return `${operation.name} — offset ${describeBodyRef(operation.targetBodyId)} by ${value(operation.distance)}`;
    default: {
      // Every kind the contract allows has a line above; a new kind fails the
      // typecheck here instead of reaching a reviewer as "Unknown operation".
      const unhandled: never = operation;
      void unhandled;
      return 'Unknown operation';
    }
  }
}

/**
 * True when the operation leaves a live body behind — the ones a reviewer reads
 * as "and then the part is…" rather than as bookkeeping.
 */
export function operationCreatesBody(operation: CadPatchOperation): boolean {
  return (
    operation.kind === 'add_primitive' ||
    operation.kind === 'add_extrude' ||
    operation.kind === 'add_revolve' ||
    operation.kind === 'add_boolean' ||
    operation.kind === 'add_edge_modifier' ||
    operation.kind === 'add_pattern' ||
    operation.kind === 'add_multi_profile_extrude' ||
    operation.kind === 'add_mirror' ||
    operation.kind === 'add_shell' ||
    operation.kind === 'add_solid_offset'
  );
}

export interface ProposalOperationSummary {
  parameters: number;
  bodies: number;
  edits: number;
}

/** Counts for the collapsed proposal header. */
export function summarizeOperations(
  operations: readonly CadPatchOperation[]
): ProposalOperationSummary {
  return operations.reduce<ProposalOperationSummary>(
    (totals, operation) => ({
      parameters:
        totals.parameters + (operation.kind === 'set_parameter' ? 1 : 0),
      bodies: totals.bodies + (operationCreatesBody(operation) ? 1 : 0),
      edits:
        totals.edits +
        (operation.kind === 'set_parameter' || operationCreatesBody(operation)
          ? 0
          : 1)
    }),
    { parameters: 0, bodies: 0, edits: 0 }
  );
}
