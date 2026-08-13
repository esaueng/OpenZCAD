import { GEOMETRY_LINEAR_TOLERANCE } from '@openzcad/geometry';

const VOLUME_DEFLECTION_RATIO = 1e-4;
const NORMAL_TOLERANCE = 1e-9;

export interface BrepKitModelingPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface BrepKitMirrorInput {
  readonly targetSolid: number;
  readonly planePoint: BrepKitModelingPoint;
  readonly planeNormal: BrepKitModelingPoint;
}

export interface BrepKitShellInput {
  readonly targetSolid: number;
  readonly thickness: number;
  readonly openingFaces: readonly number[];
}

export interface BrepKitSolidOffsetInput {
  readonly targetSolid: number;
  readonly distance: number;
}

export interface BrepKitDraftInput {
  readonly targetSolid: number;
  readonly faces: readonly number[];
  readonly pullDirection: BrepKitModelingPoint;
  readonly neutralPoint: BrepKitModelingPoint;
  readonly angleDegrees: number;
}

export interface BrepKitThickenInput {
  readonly sourceSolid: number;
  readonly face: number;
  readonly thickness: number;
}

/** The pinned BrepKit calls and read-only gates used by these helpers. */
export interface BrepKitModelingKernel {
  mirror(
    solid: number,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number
  ): number;
  shell(solid: number, thickness: number, openFaces: Uint32Array): number;
  offsetSolidV2(solid: number, distance: number): number;
  draft(
    solid: number,
    faces: Uint32Array,
    pullX: number,
    pullY: number,
    pullZ: number,
    neutralX: number,
    neutralY: number,
    neutralZ: number,
    angleDegrees: number
  ): number;
  thicken(face: number, thickness: number): number;
  boundingBox(solid: number): Float64Array;
  getSolidFaces(solid: number): Uint32Array;
  getSolidShells(solid: number): Uint32Array;
  validateSolid(solid: number): number;
  volume(solid: number, deflection: number): number;
}

export interface BrepKitModelingOperations {
  mirror(input: BrepKitMirrorInput): number;
  shell(input: BrepKitShellInput): number;
  offsetSolid(input: BrepKitSolidOffsetInput): number;
  draft(input: BrepKitDraftInput): number;
  thicken(input: BrepKitThickenInput): number;
}

interface SolidSnapshot {
  readonly faces: readonly number[];
  readonly shells: readonly number[];
  readonly bounds: readonly [number, number, number, number, number, number];
  readonly volume: number;
  readonly scale: number;
  readonly linearTolerance: number;
  readonly volumeTolerance: number;
  readonly minimumExtent: number;
}

function finitePoint(value: BrepKitModelingPoint, label: string): void {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new Error(`${label} must contain three finite coordinates.`);
  }
}

function validHandle(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function inspectSolid(
  kernel: BrepKitModelingKernel,
  solid: number,
  label: string
): SolidSnapshot {
  if (!validHandle(solid)) {
    throw new Error(`${label} must be a non-negative safe integer handle.`);
  }
  const rawBounds = Array.from(kernel.boundingBox(solid));
  if (
    rawBounds.length !== 6 ||
    rawBounds.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new Error(`${label} has no finite six-coordinate bounding box.`);
  }
  const bounds: SolidSnapshot['bounds'] = [
    rawBounds[0]!,
    rawBounds[1]!,
    rawBounds[2]!,
    rawBounds[3]!,
    rawBounds[4]!,
    rawBounds[5]!
  ];
  const extents = [
    bounds[3] - bounds[0],
    bounds[4] - bounds[1],
    bounds[5] - bounds[2]
  ];
  const scale = Math.max(1, ...extents.map(Math.abs));
  const linearTolerance = Math.max(GEOMETRY_LINEAR_TOLERANCE, scale * 1e-9);
  if (
    extents.some(
      (extent) => !Number.isFinite(extent) || extent <= linearTolerance
    )
  ) {
    throw new Error(`${label} must have three non-degenerate extents.`);
  }
  const faces = Array.from(kernel.getSolidFaces(solid)).sort(
    (left, right) => left - right
  );
  const shells = Array.from(kernel.getSolidShells(solid)).sort(
    (left, right) => left - right
  );
  if (faces.length === 0 || shells.length === 0) {
    throw new Error(`${label} is empty or has no closed shell.`);
  }
  if (kernel.validateSolid(solid) !== 0) {
    throw new Error(`${label} is not a valid closed solid.`);
  }
  const volume = kernel.volume(
    solid,
    Math.max(linearTolerance, scale * VOLUME_DEFLECTION_RATIO)
  );
  const volumeTolerance = Math.max(
    linearTolerance ** 3,
    Math.abs(volume) * 1e-9
  );
  if (!Number.isFinite(volume) || volume <= volumeTolerance) {
    throw new Error(`${label} has no finite positive volume.`);
  }
  return {
    faces,
    shells,
    bounds,
    volume,
    scale,
    linearTolerance,
    volumeTolerance,
    minimumExtent: Math.min(...extents)
  };
}

function sameNumbers(
  left: readonly number[],
  right: readonly number[],
  tolerance = 0
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) =>
      tolerance === 0
        ? value === right[index]
        : Math.abs(value - right[index]!) <= tolerance
    )
  );
}

function assertInputUnchanged(
  before: SolidSnapshot,
  after: SolidSnapshot,
  operation: string
): void {
  if (
    !sameNumbers(before.faces, after.faces) ||
    !sameNumbers(before.shells, after.shells) ||
    !sameNumbers(before.bounds, after.bounds, before.linearTolerance) ||
    Math.abs(before.volume - after.volume) > before.volumeTolerance
  ) {
    throw new Error(`${operation} mutated its input solid.`);
  }
}

function assertNewOutputHandle(
  input: number,
  output: number,
  operation: string
): void {
  if (!validHandle(output) || output === input) {
    throw new Error(`${operation} did not return a new solid handle.`);
  }
}

function operationFailure(operation: string, error: unknown): Error {
  const detail =
    error instanceof Error ? error.message : 'unknown kernel error';
  return new Error(`BrepKit ${operation} refused: ${detail}`, { cause: error });
}

function runOperation(
  kernel: BrepKitModelingKernel,
  operation: string,
  inputSolid: number,
  invoke: () => number,
  validateOutput: (input: SolidSnapshot, output: SolidSnapshot) => void
): number {
  const input = inspectSolid(kernel, inputSolid, 'Target solid');
  let outputSolid: number;
  try {
    outputSolid = invoke();
  } catch (error) {
    const afterFailure = inspectSolid(kernel, inputSolid, 'Target solid');
    assertInputUnchanged(input, afterFailure, operation);
    throw operationFailure(operation, error);
  }
  const unchangedInput = inspectSolid(kernel, inputSolid, 'Target solid');
  assertInputUnchanged(input, unchangedInput, operation);
  assertNewOutputHandle(inputSolid, outputSolid, operation);
  const output = inspectSolid(kernel, outputSolid, `${operation} output`);
  validateOutput(input, output);
  return outputSolid;
}

function assertScaleAppropriateDistance(
  value: number,
  input: SolidSnapshot,
  label: string
): void {
  if (!Number.isFinite(value) || value <= input.linearTolerance) {
    throw new Error(
      `${label} must be finite and positive at the solid's scale.`
    );
  }
  if (value * 2 >= input.minimumExtent - input.linearTolerance) {
    throw new Error(
      `${label} is oversized for the target solid's minimum extent.`
    );
  }
}

function boundsContain(
  outer: SolidSnapshot,
  inner: SolidSnapshot,
  tolerance: number
): boolean {
  return (
    outer.bounds[0] <= inner.bounds[0] + tolerance &&
    outer.bounds[1] <= inner.bounds[1] + tolerance &&
    outer.bounds[2] <= inner.bounds[2] + tolerance &&
    outer.bounds[3] >= inner.bounds[3] - tolerance &&
    outer.bounds[4] >= inner.bounds[4] - tolerance &&
    outer.bounds[5] >= inner.bounds[5] - tolerance
  );
}

function mirrorSolid(
  kernel: BrepKitModelingKernel,
  input: BrepKitMirrorInput
): number {
  finitePoint(input.planePoint, 'Mirror plane point');
  finitePoint(input.planeNormal, 'Mirror plane normal');
  const normalLength = Math.hypot(
    input.planeNormal.x,
    input.planeNormal.y,
    input.planeNormal.z
  );
  if (
    !Number.isFinite(normalLength) ||
    Math.abs(normalLength - 1) > NORMAL_TOLERANCE
  ) {
    throw new Error(
      'Mirror plane normal must be finite, non-zero, and normalized.'
    );
  }
  return runOperation(
    kernel,
    'mirror',
    input.targetSolid,
    () =>
      kernel.mirror(
        input.targetSolid,
        input.planePoint.x,
        input.planePoint.y,
        input.planePoint.z,
        input.planeNormal.x,
        input.planeNormal.y,
        input.planeNormal.z
      ),
    (source, output) => {
      if (Math.abs(source.volume - output.volume) > source.volumeTolerance) {
        throw new Error(
          `Mirror output did not preserve exact solid volume (source ${source.volume}, output ${output.volume}, tolerance ${source.volumeTolerance}).`
        );
      }
    }
  );
}

function shellSolid(
  kernel: BrepKitModelingKernel,
  input: BrepKitShellInput
): number {
  const source = inspectSolid(kernel, input.targetSolid, 'Target solid');
  assertScaleAppropriateDistance(input.thickness, source, 'Shell thickness');
  if (input.openingFaces.length === 0) {
    throw new Error('Shell requires at least one opening face.');
  }
  if (input.openingFaces.some((handle) => !validHandle(handle))) {
    throw new Error('Shell opening faces must be safe integer handles.');
  }
  const uniqueOpenings = new Set(input.openingFaces);
  if (uniqueOpenings.size !== input.openingFaces.length) {
    throw new Error('Shell opening faces must be unique.');
  }
  const sourceFaces = new Set(source.faces);
  if ([...uniqueOpenings].some((handle) => !sourceFaces.has(handle))) {
    throw new Error('Shell opening face does not belong to the target solid.');
  }
  return runOperation(
    kernel,
    'shell',
    input.targetSolid,
    () =>
      kernel.shell(
        input.targetSolid,
        input.thickness,
        Uint32Array.from(input.openingFaces)
      ),
    (original, output) => {
      if (!boundsContain(original, output, original.linearTolerance)) {
        throw new Error(
          'Shell output escaped the input bounds, indicating an oversized or self-intersecting wall.'
        );
      }
      if (output.volume >= original.volume - original.volumeTolerance) {
        throw new Error(
          'Shell output did not remove a finite interior volume.'
        );
      }
    }
  );
}

function offsetSolid(
  kernel: BrepKitModelingKernel,
  input: BrepKitSolidOffsetInput
): number {
  const source = inspectSolid(kernel, input.targetSolid, 'Target solid');
  assertScaleAppropriateDistance(input.distance, source, 'Solid offset');
  return runOperation(
    kernel,
    'solid offset',
    input.targetSolid,
    () => kernel.offsetSolidV2(input.targetSolid, input.distance),
    (original, output) => {
      if (!boundsContain(output, original, original.linearTolerance)) {
        throw new Error(
          'Positive solid offset did not contain the input bounds.'
        );
      }
      if (output.volume <= original.volume + original.volumeTolerance) {
        throw new Error(
          'Positive solid offset did not add a finite outward volume.'
        );
      }
    }
  );
}

function draftSolid(
  kernel: BrepKitModelingKernel,
  input: BrepKitDraftInput
): number {
  finitePoint(input.pullDirection, 'Draft pull direction');
  finitePoint(input.neutralPoint, 'Draft neutral point');
  const length = Math.hypot(
    input.pullDirection.x,
    input.pullDirection.y,
    input.pullDirection.z
  );
  if (!Number.isFinite(length) || length <= NORMAL_TOLERANCE) {
    throw new Error('Draft pull direction must be finite and non-zero.');
  }
  if (
    input.faces.length === 0 ||
    input.faces.some((face) => !validHandle(face)) ||
    new Set(input.faces).size !== input.faces.length
  ) {
    throw new Error('Draft faces must be a non-empty unique handle set.');
  }
  const source = inspectSolid(kernel, input.targetSolid, 'Target solid');
  const sourceFaces = new Set(source.faces);
  if (input.faces.some((face) => !sourceFaces.has(face))) {
    throw new Error('Draft face does not belong to the target solid.');
  }
  if (!Number.isFinite(input.angleDegrees) || input.angleDegrees === 0) {
    throw new Error('Draft angle must be finite and non-zero.');
  }
  return runOperation(
    kernel,
    'draft',
    input.targetSolid,
    () =>
      kernel.draft(
        input.targetSolid,
        Uint32Array.from(input.faces),
        input.pullDirection.x / length,
        input.pullDirection.y / length,
        input.pullDirection.z / length,
        input.neutralPoint.x,
        input.neutralPoint.y,
        input.neutralPoint.z,
        input.angleDegrees
      ),
    () => {}
  );
}

function thickenFace(
  kernel: BrepKitModelingKernel,
  input: BrepKitThickenInput
): number {
  const source = inspectSolid(kernel, input.sourceSolid, 'Source solid');
  if (!validHandle(input.face) || !source.faces.includes(input.face)) {
    throw new Error('Thicken face must belong to the source solid.');
  }
  if (
    !Number.isFinite(input.thickness) ||
    Math.abs(input.thickness) <= source.linearTolerance
  ) {
    throw new Error('Thicken distance must be finite and non-zero.');
  }
  return runOperation(
    kernel,
    'thicken',
    input.sourceSolid,
    () => kernel.thicken(input.face, input.thickness),
    () => {}
  );
}

/**
 * Creates the narrow, side-effect-free operation surface consumed by the
 * exact adapter. Document/history integration and original+copy semantics stay
 * outside this module.
 */
export function createBrepKitModelingOperations(
  kernel: BrepKitModelingKernel
): BrepKitModelingOperations {
  return {
    mirror: (input) => mirrorSolid(kernel, input),
    shell: (input) => shellSolid(kernel, input),
    offsetSolid: (input) => offsetSolid(kernel, input),
    draft: (input) => draftSolid(kernel, input),
    thicken: (input) => thickenFace(kernel, input)
  };
}
