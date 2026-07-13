import {
  PLANE_BASES,
  circleProfile,
  polygonProfile,
  rectangleProfile,
  type PlaneBasis,
  type Vec2
} from '@openzcad/geometry';
import {
  coerceParamValue,
  evaluateExpression
} from '@openzcad/document-core';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import type {
  BodyId,
  BodyRepresentation,
  BooleanOperation,
  PlaneId,
  PrimitiveKind,
  ProjectDocument,
  RevolveAxis,
  SketchId,
  SketchObjectData,
  SketchObjectKind,
  Vector3
} from '@openzcad/shared';

// ---------------------------------------------------------------------------
// Tool sessions
//
// A session is the live state of one in-progress modeling command: armed by a
// tool, adjusted through the HUD or an on-canvas manipulator, then committed
// (one undoable command) or cancelled (no document change at all). Everything
// here is pure data + pure functions so the lifecycle is unit-testable.
// ---------------------------------------------------------------------------

export type ToolSession =
  | { kind: 'primitive'; primitiveKind: PrimitiveKind; values: Record<string, string> }
  | {
      kind: 'sketch';
      plane: PlaneId;
      shape: SketchObjectKind;
      values: Record<string, string>;
    }
  | { kind: 'extrude'; sketchId: SketchId | null; values: Record<string, string> }
  | {
      kind: 'revolve';
      sketchId: SketchId | null;
      axis: RevolveAxis;
      values: Record<string, string>;
    }
  | {
      kind: 'boolean';
      operation: BooleanOperation;
      targetBodyIds: BodyId[];
      values: Record<string, string>;
    }
  | { kind: 'move'; targetBodyId: BodyId | null; values: Record<string, string> };

export interface SessionField {
  key: string;
  label: string;
  /** Optional unit suffix rendered after the input (e.g. "mm", "°"). */
  unit?: string;
}

export interface SessionStartContext {
  doc: ProjectDocument;
  /** Viewport/tree selection, in pick order. */
  selectedBodyIds: BodyId[];
  /** Sketch backing the selected feature, when one is selected. */
  selectedSketchId: SketchId | null;
}

const PRIMITIVE_DEFAULTS: Record<PrimitiveKind, Record<string, string>> = {
  box: { width: '30', height: '18', depth: '24' },
  cylinder: { radius: '14', height: '28' },
  sphere: { radius: '16' },
  cone: { bottomRadius: '16', topRadius: '6', height: '24' },
  torus: { majorRadius: '24', minorRadius: '6' }
};

const PRIMITIVE_FIELDS: Record<PrimitiveKind, SessionField[]> = {
  box: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' },
    { key: 'depth', label: 'Depth' }
  ],
  cylinder: [
    { key: 'radius', label: 'Radius' },
    { key: 'height', label: 'Height' }
  ],
  sphere: [{ key: 'radius', label: 'Radius' }],
  cone: [
    { key: 'bottomRadius', label: 'Bottom R' },
    { key: 'topRadius', label: 'Top R' },
    { key: 'height', label: 'Height' }
  ],
  torus: [
    { key: 'majorRadius', label: 'Ring R' },
    { key: 'minorRadius', label: 'Tube R' }
  ]
};

const SKETCH_SHAPE_FIELDS: Record<SketchObjectKind, SessionField[]> = {
  rectangle: [
    { key: 'width', label: 'Width' },
    { key: 'height', label: 'Height' }
  ],
  circle: [{ key: 'radius', label: 'Radius' }],
  polygon: [
    { key: 'sides', label: 'Sides' },
    { key: 'radius', label: 'Radius' }
  ]
};

function lastLiveBody(doc: ProjectDocument): BodyId | null {
  for (let i = doc.bodyOrder.length - 1; i >= 0; i--) {
    const bodyId = doc.bodyOrder[i]!;
    const representation = doc.derived.bodyRepresentations[bodyId];
    if (!representation?.consumed) {
      return bodyId;
    }
  }
  return null;
}

/**
 * Arms a tool. Sessions seed themselves from the current selection so the
 * common flows (select sketch → E, select body → M) need no extra picking.
 */
export function createSession(
  kind: ToolSession['kind'],
  ctx: SessionStartContext,
  options?: { primitiveKind?: PrimitiveKind; operation?: BooleanOperation }
): ToolSession {
  switch (kind) {
    case 'primitive': {
      const primitiveKind = options?.primitiveKind ?? 'box';
      return { kind, primitiveKind, values: { ...PRIMITIVE_DEFAULTS[primitiveKind] } };
    }
    case 'sketch':
      return {
        kind,
        plane: 'XZ',
        shape: 'rectangle',
        values: {
          width: '32',
          height: '18',
          radius: '14',
          sides: '6',
          centerX: '0',
          centerY: '0',
          offset: '0'
        }
      };
    case 'extrude':
      return {
        kind,
        sketchId: ctx.selectedSketchId ?? ctx.doc.sketchOrder.at(-1) ?? null,
        values: { distance: '24' }
      };
    case 'revolve':
      return {
        kind,
        sketchId: ctx.selectedSketchId ?? ctx.doc.sketchOrder.at(-1) ?? null,
        axis: 'vertical',
        values: {}
      };
    case 'boolean':
      return {
        kind,
        operation: options?.operation ?? 'union',
        targetBodyIds: [...ctx.selectedBodyIds],
        values: {}
      };
    case 'move':
      return {
        kind,
        targetBodyId: ctx.selectedBodyIds[0] ?? lastLiveBody(ctx.doc),
        values: { tx: '0', ty: '0', tz: '0', rx: '0', ry: '0', rz: '0' }
      };
  }
}

const BOOLEAN_TITLES: Record<BooleanOperation, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect'
};

const PRIMITIVE_TITLES: Record<PrimitiveKind, string> = {
  box: 'Box',
  cylinder: 'Cylinder',
  sphere: 'Sphere',
  cone: 'Cone',
  torus: 'Torus'
};

export function sessionTitle(session: ToolSession): string {
  switch (session.kind) {
    case 'primitive':
      return PRIMITIVE_TITLES[session.primitiveKind];
    case 'sketch':
      return 'Sketch';
    case 'extrude':
      return 'Extrude';
    case 'revolve':
      return 'Revolve';
    case 'boolean':
      return BOOLEAN_TITLES[session.operation];
    case 'move':
      return 'Move / Rotate';
  }
}

/** One concise line describing the next required action. */
export function sessionInstruction(session: ToolSession): string {
  switch (session.kind) {
    case 'primitive':
      return 'Adjust dimensions, then press Enter to create.';
    case 'sketch':
      return 'Pick a plane and shape, size the profile, then press Enter.';
    case 'extrude':
      return session.sketchId
        ? 'Drag the arrow or type a distance. Enter confirms, Esc cancels.'
        : 'Select a sketch profile to extrude.';
    case 'revolve':
      return session.sketchId
        ? 'Choose the axis, then press Enter to revolve a full turn.'
        : 'Select a sketch profile to revolve.';
    case 'boolean':
      return session.targetBodyIds.length < 2
        ? `Click bodies in the viewport to combine — ${
            session.operation === 'subtract' ? 'first pick is the body to keep. ' : ''
          }${session.targetBodyIds.length}/2 selected.`
        : 'Enter confirms, Esc cancels. Click bodies to add or remove them.';
    case 'move':
      return session.targetBodyId
        ? 'Drag an axis arrow or type offsets. Enter confirms, Esc cancels.'
        : 'Select a body to move.';
  }
}

export function sessionFields(session: ToolSession): SessionField[] {
  switch (session.kind) {
    case 'primitive':
      return PRIMITIVE_FIELDS[session.primitiveKind];
    case 'sketch':
      return [
        ...SKETCH_SHAPE_FIELDS[session.shape],
        { key: 'centerX', label: 'Center X' },
        { key: 'centerY', label: 'Center Y' },
        { key: 'offset', label: 'Offset' }
      ];
    case 'extrude':
      return [{ key: 'distance', label: 'Distance' }];
    case 'revolve':
    case 'boolean':
      return [];
    case 'move':
      return [
        { key: 'tx', label: 'X' },
        { key: 'ty', label: 'Y' },
        { key: 'tz', label: 'Z' },
        { key: 'rx', label: 'Rot X', unit: '°' },
        { key: 'ry', label: 'Rot Y', unit: '°' },
        { key: 'rz', label: 'Rot Z', unit: '°' }
      ];
  }
}

export function setSessionValue(session: ToolSession, key: string, value: string): ToolSession {
  return { ...session, values: { ...session.values, [key]: value } };
}

/** Toggles a body in a boolean pick set, preserving pick order. */
export function toggleBooleanTarget(
  session: Extract<ToolSession, { kind: 'boolean' }>,
  bodyId: BodyId
): ToolSession {
  const targetBodyIds = session.targetBodyIds.includes(bodyId)
    ? session.targetBodyIds.filter((id) => id !== bodyId)
    : [...session.targetBodyIds, bodyId];
  return { ...session, targetBodyIds };
}

export interface SessionValidation {
  ok: boolean;
  /** Per-field inline errors keyed by field key. */
  fieldErrors: Record<string, string>;
  /** Blocking problem that is not tied to one field. */
  message: string | null;
}

function evaluateField(
  raw: string | undefined,
  scope: Record<string, number>
): { ok: true; value: number } | { ok: false; error: string } {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Required.' };
  }
  try {
    const value = evaluateExpression(trimmed, scope);
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'Not a finite number.' };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid expression.' };
  }
}

export function validateSession(
  session: ToolSession,
  scope: Record<string, number>
): SessionValidation {
  const fieldErrors: Record<string, string> = {};
  let message: string | null = null;

  for (const field of sessionFields(session)) {
    const result = evaluateField(session.values[field.key], scope);
    if (!result.ok) {
      fieldErrors[field.key] = result.error;
      continue;
    }
    // Domain checks mirrored from the kernel so failures surface inline
    // before commit instead of as a rebuild warning afterwards.
    const value = result.value;
    if (session.kind === 'primitive' || (session.kind === 'sketch' && field.key !== 'centerX' && field.key !== 'centerY' && field.key !== 'offset')) {
      if (field.key === 'sides') {
        if (value < 3) {
          fieldErrors[field.key] = 'A polygon needs at least 3 sides.';
        }
      } else if (field.key === 'topRadius') {
        if (value < 0) {
          fieldErrors[field.key] = 'Must be zero or positive.';
        }
      } else if (value <= 0) {
        fieldErrors[field.key] = 'Must be positive.';
      }
    }
    if (session.kind === 'extrude' && field.key === 'distance' && value === 0) {
      fieldErrors[field.key] = 'Distance must be non-zero.';
    }
  }

  if (session.kind === 'primitive') {
    const major = evaluateField(session.values.majorRadius, scope);
    const minor = evaluateField(session.values.minorRadius, scope);
    if (
      session.primitiveKind === 'torus' &&
      major.ok &&
      minor.ok &&
      minor.value >= major.value
    ) {
      fieldErrors.minorRadius = 'Tube radius must be smaller than the ring radius.';
    }
  }
  if (session.kind === 'extrude' && !session.sketchId) {
    message = 'Select a sketch profile to extrude.';
  }
  if (session.kind === 'revolve' && !session.sketchId) {
    message = 'Select a sketch profile to revolve.';
  }
  if (session.kind === 'boolean' && session.targetBodyIds.length < 2) {
    message = 'Pick at least two bodies.';
  }
  if (session.kind === 'move' && !session.targetBodyId) {
    message = 'Select a body to move.';
  }

  return { ok: Object.keys(fieldErrors).length === 0 && message === null, fieldErrors, message };
}

/** Default feature name: "Box 2", "Extrude 1", … numbered per kind. */
export function nextFeatureName(doc: ProjectDocument, base: string): string {
  let max = 0;
  for (const node of Object.values(doc.nodes)) {
    if (node.kind !== 'feature') {
      continue;
    }
    const match = node.name.match(new RegExp(`^${base}(?: (\\d+))?$`));
    if (match) {
      max = Math.max(max, match[1] ? Number(match[1]) : 1);
    }
  }
  return max === 0 ? base : `${base} ${max + 1}`;
}

function sketchObjectFromSession(
  session: Extract<ToolSession, { kind: 'sketch' }>
): SketchObjectData {
  const v = (key: string, fallback: string) =>
    coerceParamValue((session.values[key] ?? fallback).trim() || fallback);
  const centerX = v('centerX', '0');
  const centerY = v('centerY', '0');
  if (session.shape === 'rectangle') {
    return {
      objectKind: 'rectangle',
      width: v('width', '32'),
      height: v('height', '18'),
      centerX,
      centerY
    };
  }
  if (session.shape === 'circle') {
    return { objectKind: 'circle', radius: v('radius', '14'), centerX, centerY };
  }
  return {
    objectKind: 'polygon',
    sides: v('sides', '6'),
    radius: v('radius', '14'),
    centerX,
    centerY
  };
}

/**
 * Builds the single undoable command a valid session commits. Returns null
 * when the session cannot produce a command (validation should gate first).
 */
export function buildSessionCommand(
  session: ToolSession,
  doc: ProjectDocument
): AnyCommand | null {
  switch (session.kind) {
    case 'primitive': {
      const fields = PRIMITIVE_FIELDS[session.primitiveKind];
      return commandFactories.addPrimitive({
        name: nextFeatureName(doc, PRIMITIVE_TITLES[session.primitiveKind]),
        primitiveKind: session.primitiveKind,
        dimensions: Object.fromEntries(
          fields.map((field) => [field.key, coerceParamValue(session.values[field.key] ?? '')])
        )
      });
    }
    case 'sketch':
      return commandFactories.addSketch({
        name: nextFeatureName(doc, 'Sketch'),
        plane: session.plane,
        offset: coerceParamValue((session.values.offset ?? '0').trim() || '0'),
        object: sketchObjectFromSession(session)
      });
    case 'extrude':
      if (!session.sketchId) {
        return null;
      }
      return commandFactories.extrudeSketch({
        name: nextFeatureName(doc, 'Extrude'),
        sketchId: session.sketchId,
        distance: coerceParamValue(session.values.distance ?? '24')
      });
    case 'revolve':
      if (!session.sketchId) {
        return null;
      }
      return commandFactories.revolveSketch({
        name: nextFeatureName(doc, 'Revolve'),
        sketchId: session.sketchId,
        axis: session.axis
      });
    case 'boolean':
      if (session.targetBodyIds.length < 2) {
        return null;
      }
      return commandFactories.booleanBodies({
        name: nextFeatureName(doc, BOOLEAN_TITLES[session.operation]),
        operation: session.operation,
        targetBodyIds: session.targetBodyIds
      });
    case 'move': {
      if (!session.targetBodyId) {
        return null;
      }
      const v = (key: string) => coerceParamValue((session.values[key] ?? '0').trim() || '0');
      return commandFactories.transformBody({
        name: nextFeatureName(doc, 'Move'),
        targetBodyId: session.targetBodyId,
        translation: { x: v('tx'), y: v('ty'), z: v('tz') },
        rotationDeg: { x: v('rx'), y: v('ry'), z: v('rz') }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Previews & manipulators
//
// Previews are lightweight, serializable specs the viewport turns into ghost
// three.js geometry. They intentionally reuse the kernel's plane bases and
// profile builders so the preview always matches what commit will produce.
// ---------------------------------------------------------------------------

export type PreviewSpec =
  | { kind: 'primitive'; primitiveKind: PrimitiveKind; dims: Record<string, number> }
  | { kind: 'profile'; points: Vector3[] }
  | { kind: 'extrude'; points: Vector3[]; normal: Vector3; distance: number }
  | {
      kind: 'revolve';
      points: Vector3[];
      axisOrigin: Vector3;
      axisDirection: Vector3;
    }
  | { kind: 'move'; bodyId: BodyId; translation: Vector3; rotationDeg: Vector3 };

export type ManipulatorSpec =
  | {
      kind: 'linear-arrow';
      valueKey: string;
      origin: Vector3;
      direction: Vector3;
      value: number;
    }
  | {
      kind: 'triad';
      origin: Vector3;
      axes: { direction: Vector3; valueKey: string }[];
      values: number[];
    };

function toVector3(basis: PlaneBasis, point: Vec2, offset: number): Vector3 {
  return {
    x: basis.origin.x + basis.u.x * point.x + basis.v.x * point.y + basis.normal.x * offset,
    y: basis.origin.y + basis.u.y * point.x + basis.v.y * point.y + basis.normal.y * offset,
    z: basis.origin.z + basis.u.z * point.x + basis.v.z * point.y + basis.normal.z * offset
  };
}

function evalOr(
  raw: string | undefined,
  scope: Record<string, number>,
  fallback: number | null = null
): number | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  try {
    const value = evaluateExpression(trimmed, scope);
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function profilePoints(
  object: SketchObjectData,
  scope: Record<string, number>
): Vec2[] | null {
  try {
    const num = (value: number | string) =>
      typeof value === 'number' ? value : evaluateExpression(value, scope);
    if (object.objectKind === 'rectangle') {
      return rectangleProfile(
        num(object.width),
        num(object.height),
        num(object.centerX),
        num(object.centerY)
      );
    }
    if (object.objectKind === 'circle') {
      return circleProfile(num(object.radius), num(object.centerX), num(object.centerY));
    }
    return polygonProfile(
      num(object.sides),
      num(object.radius),
      num(object.centerX),
      num(object.centerY)
    );
  } catch {
    return null;
  }
}

interface SketchGeometryInfo {
  points3d: Vector3[];
  basis: PlaneBasis;
  offset: number;
  centroid: Vector3;
}

function resolveSketchGeometry(
  doc: ProjectDocument,
  sketchId: SketchId,
  scope: Record<string, number>
): SketchGeometryInfo | null {
  const sketchNode = Object.values(doc.nodes).find(
    (node) => node.kind === 'sketch' && node.sketchId === sketchId
  );
  if (!sketchNode || sketchNode.kind !== 'sketch') {
    return null;
  }
  const objectNode = sketchNode.objectIds[0] ? doc.nodes[sketchNode.objectIds[0]] : undefined;
  if (!objectNode || objectNode.kind !== 'sketch-object') {
    return null;
  }
  const points2d = profilePoints(objectNode.data, scope);
  if (!points2d || points2d.length < 3) {
    return null;
  }
  const basis = PLANE_BASES[sketchNode.plane];
  const offset = evalOr(
    typeof sketchNode.offset === 'number' ? String(sketchNode.offset) : sketchNode.offset,
    scope,
    0
  )!;
  const points3d = points2d.map((point) => toVector3(basis, point, offset));
  const centroid2d = points2d.reduce(
    (acc, point) => ({ x: acc.x + point.x / points2d.length, y: acc.y + point.y / points2d.length }),
    { x: 0, y: 0 }
  );
  return { points3d, basis, offset, centroid: toVector3(basis, centroid2d, offset) };
}

/** Live geometry preview for the active session, or null when unresolvable. */
export function sessionPreview(
  session: ToolSession,
  doc: ProjectDocument,
  scope: Record<string, number>
): PreviewSpec | null {
  switch (session.kind) {
    case 'primitive': {
      const dims: Record<string, number> = {};
      for (const field of PRIMITIVE_FIELDS[session.primitiveKind]) {
        const value = evalOr(session.values[field.key], scope);
        if (value === null || value <= 0) {
          return null;
        }
        dims[field.key] = value;
      }
      return { kind: 'primitive', primitiveKind: session.primitiveKind, dims };
    }
    case 'sketch': {
      const offset = evalOr(session.values.offset, scope, 0)!;
      const points2d = profilePoints(sketchObjectFromSession(session), scope);
      if (!points2d) {
        return null;
      }
      const basis = PLANE_BASES[session.plane];
      return { kind: 'profile', points: points2d.map((p) => toVector3(basis, p, offset)) };
    }
    case 'extrude': {
      if (!session.sketchId) {
        return null;
      }
      const info = resolveSketchGeometry(doc, session.sketchId, scope);
      const distance = evalOr(session.values.distance, scope);
      if (!info || distance === null || distance === 0) {
        return null;
      }
      return {
        kind: 'extrude',
        points: info.points3d,
        normal: info.basis.normal,
        distance
      };
    }
    case 'revolve': {
      if (!session.sketchId) {
        return null;
      }
      const info = resolveSketchGeometry(doc, session.sketchId, scope);
      if (!info) {
        return null;
      }
      const axisDirection = session.axis === 'vertical' ? info.basis.v : info.basis.u;
      const axisOrigin = {
        x: info.basis.origin.x + info.basis.normal.x * info.offset,
        y: info.basis.origin.y + info.basis.normal.y * info.offset,
        z: info.basis.origin.z + info.basis.normal.z * info.offset
      };
      return { kind: 'revolve', points: info.points3d, axisOrigin, axisDirection };
    }
    case 'move': {
      if (!session.targetBodyId) {
        return null;
      }
      const translation = {
        x: evalOr(session.values.tx, scope, 0)!,
        y: evalOr(session.values.ty, scope, 0)!,
        z: evalOr(session.values.tz, scope, 0)!
      };
      const rotationDeg = {
        x: evalOr(session.values.rx, scope, 0)!,
        y: evalOr(session.values.ry, scope, 0)!,
        z: evalOr(session.values.rz, scope, 0)!
      };
      return { kind: 'move', bodyId: session.targetBodyId, translation, rotationDeg };
    }
    case 'boolean':
      return null;
  }
}

/** On-canvas drag handle for the active session, when one applies. */
export function sessionManipulator(
  session: ToolSession,
  doc: ProjectDocument,
  scope: Record<string, number>,
  representations: Record<string, BodyRepresentation>
): ManipulatorSpec | null {
  if (session.kind === 'extrude' && session.sketchId) {
    const info = resolveSketchGeometry(doc, session.sketchId, scope);
    if (!info) {
      return null;
    }
    return {
      kind: 'linear-arrow',
      valueKey: 'distance',
      origin: info.centroid,
      direction: info.basis.normal,
      value: evalOr(session.values.distance, scope, 0)!
    };
  }
  if (session.kind === 'move' && session.targetBodyId) {
    const representation = representations[session.targetBodyId];
    if (!representation) {
      return null;
    }
    const { min, max } = representation.bbox;
    const tx = evalOr(session.values.tx, scope, 0)!;
    const ty = evalOr(session.values.ty, scope, 0)!;
    const tz = evalOr(session.values.tz, scope, 0)!;
    // The triad rides along with the previewed translation.
    const origin = {
      x: (min.x + max.x) / 2 + tx,
      y: (min.y + max.y) / 2 + ty,
      z: (min.z + max.z) / 2 + tz
    };
    return {
      kind: 'triad',
      origin,
      axes: [
        { direction: { x: 1, y: 0, z: 0 }, valueKey: 'tx' },
        { direction: { x: 0, y: 1, z: 0 }, valueKey: 'ty' },
        { direction: { x: 0, y: 0, z: 1 }, valueKey: 'tz' }
      ],
      values: [
        evalOr(session.values.tx, scope, 0)!,
        evalOr(session.values.ty, scope, 0)!,
        evalOr(session.values.tz, scope, 0)!
      ]
    };
  }
  return null;
}

/** Formats a dragged numeric value for a session text field. */
export function formatDragValue(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export interface SketchOverlay {
  sketchId: SketchId;
  points: Vector3[];
}

/**
 * World-space profile outlines for every sketch, so sketches stay visible and
 * pickable in the viewport (the select-profile → extrude flow).
 */
export function sketchOverlays(
  doc: ProjectDocument,
  scope: Record<string, number>
): SketchOverlay[] {
  return doc.sketchOrder.flatMap((sketchId) => {
    const info = resolveSketchGeometry(doc, sketchId, scope);
    return info ? [{ sketchId, points: info.points3d }] : [];
  });
}
