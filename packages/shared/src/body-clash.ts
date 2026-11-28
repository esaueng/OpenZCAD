import type { Vector3 } from './index';

/**
 * M09 body clash and AS04 assembly interference: the answer the exact kernel
 * gives for one pair of bodies, as data. One implementation
 * (`exact-body-clash.ts` in the kernel adapter) produces it for any two
 * bodies, and the assembly check is that query run pairwise on posed
 * components. There is no second engine and no mesh fallback.
 *
 * Every number is in model units (the document's length unit; volumes in
 * its cube), in world coordinates.
 */

/** An axis-aligned box. */
export interface BodyClashBounds {
  min: Vector3;
  max: Vector3;
}

/**
 * The bodies share material. `volume` is the exact kernel measure of the
 * shared region; `proof` names which exact boolean produced it: the
 * intersection itself, or the kernel's exact difference of one body by the
 * other (`volume(b) − volume(b − a)`), used where the kernel declines an
 * intersection whose result it cannot build.
 *
 * `point` is a witness strictly inside both bodies, classified by the exact
 * B-rep classifier; null only where no probe point cleared both walls (a very
 * thin overlap), never invented. `bounds` is the box of the shared region
 * when the kernel built it, otherwise null.
 *
 * Where the kernel built neither boolean but a point classified strictly
 * inside both bodies still proves shared material, `volume` is null and
 * `proof` is `'point'`. `complete` is false when some solid pairs of a
 * multi-solid body could not be measured, so `volume` is then a lower bound.
 */
export interface BodyClashInterference {
  kind: 'interference';
  volume: number | null;
  proof: 'intersect' | 'difference' | 'point';
  point: Vector3 | null;
  bounds: BodyClashBounds | null;
  complete: boolean;
}

/**
 * No shared volume, proven: by disjoint bounding boxes, by an exact
 * intersection or difference that removed nothing, or by a certified
 * positive distance.
 *
 * `distance` is the kernel's certified minimum distance and `closest` its
 * two witness points (one on each body), present only where the kernel
 * certifies distance (planar faces with straight edges, sphere pairs). Zero
 * distance with no shared volume is contact (`touching: true`). Where the
 * boxes alone separate the bodies, `atLeast` is that gap: a proven lower
 * bound on the clearance. `touching` is null when contact is unknown.
 */
export interface BodyClashClear {
  kind: 'clear';
  touching: boolean | null;
  distance: number | null;
  closest: [Vector3, Vector3] | null;
  atLeast: number | null;
}

/**
 * The kernel answered neither way. `reason` is the typed refusal code (or
 * `failed` for an unexpected kernel error) and `message` the plain reason;
 * an unknown is never reported as clear.
 */
export interface BodyClashUnknown {
  kind: 'unknown';
  reason: string;
  message: string;
}

export type BodyClashVerdict =
  BodyClashInterference | BodyClashClear | BodyClashUnknown;

/**
 * One assembly component, posed, as the interference check reads it.
 * `bodyId` is the model's live body the part stands for. A part whose own
 * Configuration names another row than the model's active one is checked as
 * that row builds it (what Assemble draws), whatever `bodyId` says; the
 * report's `configurations` names each such part's row.
 */
export interface AssemblyInterferenceOperand {
  componentId: string;
  bodyId: string;
  /**
   * The component's solved pose (not its exploded offset) as a column-major
   * 4×4, the matrix the viewport draws the body with.
   */
  matrix: number[];
}

export interface AssemblyInterferencePair {
  a: string;
  b: string;
  verdict: BodyClashVerdict;
}

/**
 * Every unordered pair of components, in display order (a before b).
 * `missing` lists components with no exact geometry to check (a deleted or
 * hidden body), which are reported, never silently treated as clear.
 */
export interface AssemblyInterferenceReport {
  pairs: AssemblyInterferencePair[];
  missing: string[];
  /**
   * The parts checked as their own configuration row builds them, not as
   * the model's active row does, by component id. A part whose row could
   * not be built is listed too: its pairs are unknown, never clear.
   */
  configurations?: Record<string, AssemblyCheckedConfiguration>;
}

/** The configuration row a part's checked geometry came from. */
export interface AssemblyCheckedConfiguration {
  rowId: string;
  rowName: string;
}

/** AS04 through motion: a component the sweep may pose, with its body. */
export interface AssemblySweepComponent {
  componentId: string;
  bodyId: string;
}

/** One position of a sweep, as the geometry worker checks it. */
export interface AssemblySweepPosition {
  /** Where along the motion: the joint's value, or seconds into a study. */
  at: number;
  /** Column-major 4×4 pose per component checked here. */
  matrices: Record<string, number[]>;
  /** The pairs checked here, each a before b in display order. */
  pairs: [string, string][];
}

export interface AssemblySweepPositionResult {
  at: number;
  pairs: AssemblyInterferencePair[];
}

/**
 * The worker's answer to a sweep: each position's verdicts, and the
 * components with no exact geometry, whose pairs were left out.
 */
export interface AssemblySweepWorkerReport {
  positions: AssemblySweepPositionResult[];
  missing: string[];
  /** As `AssemblyInterferenceReport.configurations`. */
  configurations?: Record<string, AssemblyCheckedConfiguration>;
}
