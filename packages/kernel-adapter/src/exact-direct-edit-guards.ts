/**
 * Structural validation of direct-edit operations before any kernel work:
 * finite numbers, well-formed vectors, and per-kind field checks. Throwing
 * here keeps malformed payloads out of replayable history.
 */
import type { DirectEditOperation } from '@openzcad/shared';

export function assertFiniteDirectEditNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Direct-edit ${label} must be finite.`);
  }
  return value;
}

export function assertDirectEditVector(value: unknown, label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Direct-edit ${label} must be a vector.`);
  }
  const vector = value as Record<string, unknown>;
  assertFiniteDirectEditNumber(vector.x, `${label}.x`);
  assertFiniteDirectEditNumber(vector.y, `${label}.y`);
  assertFiniteDirectEditNumber(vector.z, `${label}.z`);
}

export function assertDirectEditParam(value: unknown, label: string): void {
  if (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' &&
      value.trim().length > 0 &&
      value.length <= 500)
  ) {
    return;
  }
  throw new Error(`Direct-edit ${label} must be a finite value or expression.`);
}

export function assertDirectEditOperation(operation: DirectEditOperation): void {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) {
    throw new Error('Direct-edit operation must be an object.');
  }
  const value = operation as unknown as Record<string, unknown>;
  if (
    typeof value.faceHash !== 'number' ||
    !Number.isSafeInteger(value.faceHash)
  ) {
    throw new Error('Direct-edit face hash must be a safe integer.');
  }
  switch (value.kind) {
    case 'resize-through-hole':
      if (
        assertFiniteDirectEditNumber(value.sourceDiameter, 'source diameter') <=
        0
      ) {
        throw new Error(
          'Direct-edit source diameter must be greater than zero.'
        );
      }
      assertDirectEditVector(value.sourceAxisStart, 'source axis start');
      assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      assertDirectEditParam(value.diameter, 'diameter');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    case 'resize-imported-blind-hole':
      assertDirectEditVector(value.sourceOpeningPoint, 'source opening point');
      assertDirectEditVector(
        value.sourceAxisDirection,
        'source axis direction'
      );
      if (
        assertFiniteDirectEditNumber(value.sourceDiameter, 'source diameter') <=
          0 ||
        assertFiniteDirectEditNumber(value.sourceDepth, 'source depth') <= 0
      ) {
        throw new Error(
          'Direct-edit imported blind-hole source dimensions must be greater than zero.'
        );
      }
      assertDirectEditParam(value.diameter, 'diameter');
      assertDirectEditParam(value.depth, 'depth');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    case 'resize-imported-counterbore':
      assertDirectEditVector(value.sourceOpeningPoint, 'source opening point');
      assertDirectEditVector(
        value.sourceAxisDirection,
        'source axis direction'
      );
      for (const [source, label] of [
        [value.sourceBoreDiameter, 'source bore diameter'],
        [value.sourceCounterboreDiameter, 'source counterbore diameter'],
        [value.sourceCounterboreDepth, 'source counterbore depth'],
        [value.sourceTotalDepth, 'source total depth']
      ] as const) {
        if (assertFiniteDirectEditNumber(source, label) <= 0) {
          throw new Error(`Direct-edit ${label} must be greater than zero.`);
        }
      }
      if (typeof value.sourceEntryChamfered !== 'boolean') {
        throw new Error(
          'Direct-edit source entry-chamfer state must be boolean.'
        );
      }
      assertDirectEditParam(value.boreDiameter, 'bore diameter');
      assertDirectEditParam(value.counterboreDiameter, 'counterbore diameter');
      assertDirectEditParam(value.counterboreDepth, 'counterbore depth');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    case 'resize-imported-countersink':
      assertDirectEditVector(value.sourceOpeningPoint, 'source opening point');
      assertDirectEditVector(
        value.sourceAxisDirection,
        'source axis direction'
      );
      for (const [source, label] of [
        [value.sourceBoreDiameter, 'source bore diameter'],
        [value.sourceSinkDiameter, 'source sink diameter'],
        [value.sourceAngleRadians, 'source included angle'],
        [value.sourceCountersinkDepth, 'source countersink depth'],
        [value.sourceTotalDepth, 'source total depth']
      ] as const) {
        if (assertFiniteDirectEditNumber(source, label) <= 0) {
          throw new Error(`Direct-edit ${label} must be greater than zero.`);
        }
      }
      assertDirectEditParam(value.boreDiameter, 'bore diameter');
      assertDirectEditParam(value.sinkDiameter, 'sink diameter');
      assertDirectEditParam(value.angleRadians, 'included angle');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    case 'remove-face-feature': {
      if (
        typeof value.sourceSurfaceType !== 'string' ||
        !value.sourceSurfaceType
      ) {
        throw new Error('Direct-edit source surface type is invalid.');
      }
      if (assertFiniteDirectEditNumber(value.sourceArea, 'source area') <= 0) {
        throw new Error('Direct-edit source area must be greater than zero.');
      }
      assertDirectEditVector(value.sourceCenter, 'source center');
      const throughHoleSnapshot = [
        value.sourceDiameter,
        value.sourceAxisStart,
        value.sourceAxisEnd
      ];
      if (throughHoleSnapshot.some((entry) => entry !== undefined)) {
        if (throughHoleSnapshot.some((entry) => entry === undefined)) {
          throw new Error('Direct-edit through-hole snapshot is incomplete.');
        }
        if (
          assertFiniteDirectEditNumber(
            value.sourceDiameter,
            'source diameter'
          ) <= 0
        ) {
          throw new Error(
            'Direct-edit source diameter must be greater than zero.'
          );
        }
        assertDirectEditVector(value.sourceAxisStart, 'source axis start');
        assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      }
      return;
    }
    case 'offset-face':
      if (value.sourceSurfaceType !== 'plane') {
        throw new Error('Direct-edit offset source must be planar.');
      }
      if (assertFiniteDirectEditNumber(value.sourceArea, 'source area') <= 0) {
        throw new Error('Direct-edit source area must be greater than zero.');
      }
      assertDirectEditVector(value.sourceCenter, 'source center');
      assertDirectEditVector(value.sourceNormal, 'source normal');
      assertDirectEditParam(value.offset, 'offset');
      return;
    case 'resize-cylindrical-face':
      if (
        assertFiniteDirectEditNumber(value.sourceRadius, 'source radius') <= 0
      ) {
        throw new Error('Direct-edit source radius must be greater than zero.');
      }
      assertDirectEditVector(value.sourceAxisStart, 'source axis start');
      assertDirectEditVector(value.sourceAxisEnd, 'source axis end');
      if (value.concavity !== 'hole' && value.concavity !== 'boss') {
        throw new Error('Direct-edit cylinder concavity is invalid.');
      }
      assertDirectEditParam(value.radius, 'radius');
      return;
    case 'resize-blend':
      if (value.surfaceClass !== 'torus' && value.surfaceClass !== 'cylinder') {
        throw new Error('Direct-edit blend surface class is invalid.');
      }
      if (
        assertFiniteDirectEditNumber(value.recordedRadius, 'recorded radius') <=
        0
      ) {
        throw new Error(
          'Direct-edit recorded radius must be greater than zero.'
        );
      }
      assertDirectEditVector(value.recordedCenter, 'recorded center');
      assertDirectEditVector(value.recordedAxis, 'recorded axis');
      assertDirectEditParam(value.newRadius, 'new radius');
      if (
        value.parameterBinding !== undefined &&
        value.parameterBinding !== true
      ) {
        throw new Error('Direct-edit parameter binding is invalid.');
      }
      return;
    default:
      throw new Error('Direct-edit operation kind is not supported.');
  }
}
