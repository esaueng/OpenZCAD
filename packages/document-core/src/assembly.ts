import {
  ASSEMBLY_JOINT_DOFS,
  assertAssemblySet,
  clampJointValues,
  coupledJointValues,
  couplingAddError,
  couplingImmovableJoint,
  couplingLimitsConflict,
  couplingOffsetAtPose,
  deepClone,
  emptyAssemblySet,
  isAssemblySetEmpty,
  jointAddError,
  normalizeQuaternion,
  solveAssembly,
  transformToPlacement,
  IDENTITY_PLACEMENT,
  type AssemblyComponent,
  type AssemblyCoupling,
  type AssemblyCouplingEnd,
  type AssemblyDofLimit,
  type AssemblyJoint,
  type AssemblyJointEnd,
  type AssemblyJointKind,
  type AssemblyMotionStudy,
  type AssemblyPlacement,
  type AssemblySet,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  assertAssemblyCouplingSchema,
  assertAssemblySchema
} from './document-content-schema';
import { bodySourceMap } from './object-folders';

/**
 * AS01/AS02/AS06/AS07 assembly commands (schema v54). Each carries explicit
 * ids, names, frames and values, so undo, redo and replay reproduce the same
 * assembly, and none of them changes geometry: a rebuild never reads
 * `assembly`. A structural edit (joints, grounding, components) first writes
 * every component's current solved pose into its placement, so nothing on
 * screen jumps when the joint graph changes.
 *
 * Schema v56 adds couplings. Every command that writes joint values, limits
 * or couplings settles the coupled values before it returns, so the stored
 * values always satisfy every coupling: the joint that was written leads
 * and the joints coupled to it follow.
 */

export interface AssemblyComponentsAddInput {
  components: {
    componentId: string;
    name: string;
    bodyId: BodyId;
    grounded: boolean;
    /** Defaults to the identity: the body where it was modelled. */
    placement?: AssemblyPlacement;
  }[];
}

export interface AssemblyComponentUpdateInput {
  componentId: string;
  name?: string;
  grounded?: boolean;
  placement?: AssemblyPlacement;
}

export interface AssemblyComponentDeleteInput {
  componentId: string;
}

export interface AssemblyJointAddInput {
  joint: AssemblyJoint;
}

export interface AssemblyJointUpdateInput {
  jointId: string;
  name?: string;
  /** A new kind resets the values to zero and clears the limits. */
  kind?: AssemblyJointKind;
  parent?: AssemblyJointEnd;
  child?: AssemblyJointEnd;
  values?: number[];
  limits?: (AssemblyDofLimit | null)[];
}

export interface AssemblyJointDeleteInput {
  jointId: string;
}

/** A drag or a saved position applied: joint values and free placements. */
export interface AssemblyPoseSetInput {
  values?: Record<string, number[]>;
  placements?: Record<string, AssemblyPlacement>;
  /**
   * Schema v56. The motions that were moved, most important first: in a
   * coupled group the first of them leads and the joints coupled to it
   * follow, whatever other values are written beside it. Absent, the first
   * written member of each group (in the group's stored order) leads.
   */
  drivers?: AssemblyCouplingEnd[];
}

export interface AssemblyPositionSaveInput {
  positionId: string;
  name: string;
  values: Record<string, number[]>;
}

export interface AssemblyPositionDeleteInput {
  positionId: string;
}

export interface AssemblyCouplingAddInput {
  coupling: {
    id: string;
    name: string;
    driver: AssemblyCouplingEnd;
    driven: AssemblyCouplingEnd;
    /** Driven units per driver unit; never zero. */
    ratio: number;
    /**
     * Omitted, the coupling holds the pose both joints are in now (a meshed
     * pair keeps its tooth phase). Given, the driven joint moves to it.
     */
    offset?: number;
  };
}

export interface AssemblyCouplingUpdateInput {
  couplingId: string;
  name?: string;
  /** A new ratio keeps the current pose unless `offset` is given too. */
  ratio?: number;
  offset?: number;
}

export interface AssemblyCouplingDeleteInput {
  couplingId: string;
}

/** Adds the study, or replaces the one with the same id. */
export interface AssemblyStudySetInput {
  study: AssemblyMotionStudy;
}

export interface AssemblyStudyDeleteInput {
  studyId: string;
}

function withAssembly(
  document: ProjectDocument,
  edit: (set: AssemblySet) => AssemblySet
): ProjectDocument {
  assertAssemblySchema(document.schemaVersion);
  const before = document.assembly ?? emptyAssemblySet();
  const after = edit(deepClone(before));
  // An edit that changes nothing returns the same document, which the
  // command manager records as no edit at all.
  if (JSON.stringify(after) === JSON.stringify(before)) return document;
  // Any edit (fixing a part in place, moving a joint's end) that would stop
  // a coupled joint is refused: its mate would go on moving alone.
  const stuck = couplingImmovableJoint(after);
  if (stuck)
    throw new Error(
      `That would leave ${stuck.joint.name} unable to move (it would close a loop or join two fixed parts), and ${stuck.coupling.name} moves it with another joint. Remove ${stuck.coupling.name} first.`
    );
  const assembly = isAssemblySetEmpty(after) ? undefined : after;
  assertAssemblySet(assembly);
  const { assembly: _previous, ...rest } = document;
  return {
    ...rest,
    // Fresh arrays: the command manager appends this command to the log of
    // the document returned here, and a shared array would write it into
    // the previous document too.
    commandLog: [...document.commandLog],
    revisions: [...document.revisions],
    checkpoints: [...document.checkpoints],
    ...(assembly ? { assembly } : {}),
    version: document.version + 1
  };
}

function cleanName(name: string, what: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error(`${what} needs a name.`);
  return trimmed;
}

function component(set: AssemblySet, componentId: string): AssemblyComponent {
  const found = set.components.find((c) => c.id === componentId);
  if (!found) throw new Error(`Component ${componentId} not found.`);
  return found;
}

function joint(set: AssemblySet, jointId: string): AssemblyJoint {
  const found = set.joints.find((j) => j.id === jointId);
  if (!found) throw new Error(`Joint ${jointId} not found.`);
  return found;
}

function placement(value: AssemblyPlacement): AssemblyPlacement {
  return {
    translation: { ...value.translation },
    rotation: normalizeQuaternion(value.rotation)
  };
}

/** Writes every component's solved pose into its placement. */
function freezePlacements(set: AssemblySet): void {
  const solution = solveAssembly(set);
  for (const c of set.components) {
    const pose = solution.poses.get(c.id);
    if (pose) c.placement = transformToPlacement(pose);
  }
}

/**
 * Writes the joint values the limits and couplings allow. `written` are
 * values being written now and `drivers` the motions that lead their
 * coupled groups (else the first written member of each group does).
 */
function settleJointValues(
  set: AssemblySet,
  written: Readonly<Record<string, readonly number[]>> = {},
  drivers?: readonly AssemblyCouplingEnd[]
): void {
  const settled = coupledJointValues(
    set,
    new Map(Object.entries(written)),
    drivers
  );
  for (const j of set.joints) j.values = settled.get(j.id) ?? j.values;
}

function couplingOf(set: AssemblySet, couplingId: string): AssemblyCoupling {
  const found = set.couplings?.find((c) => c.id === couplingId);
  if (!found) throw new Error(`Coupling ${couplingId} not found.`);
  return found;
}

/** Refuses limits that leave a coupled group no position to be in. */
function assertCoupledLimits(set: AssemblySet): void {
  const conflict = couplingLimitsConflict(set);
  if (conflict === null) return;
  const name = set.couplings?.find((c) => c.id === conflict)?.name;
  throw new Error(
    `Those limits leave ${name ?? 'the coupled joints'} no position every joint can reach.`
  );
}

/**
 * Drops tracks, saved values and couplings that name joints or motions no
 * longer present.
 */
function pruneJointReferences(set: AssemblySet): void {
  const joints = new Map(set.joints.map((j) => [j.id, j]));
  if (set.couplings) {
    const has = (end: AssemblyCouplingEnd) => {
      const j = joints.get(end.jointId);
      return !!j && end.dof < ASSEMBLY_JOINT_DOFS[j.kind].length;
    };
    set.couplings = set.couplings.filter((c) => has(c.driver) && has(c.driven));
    if (set.couplings.length === 0) delete set.couplings;
  }
  for (const study of set.studies) {
    study.tracks = study.tracks.filter((track) => {
      const j = joints.get(track.jointId);
      return !!j && track.dof < ASSEMBLY_JOINT_DOFS[j.kind].length;
    });
  }
  for (const position of set.positions) {
    for (const jointId of Object.keys(position.values)) {
      const j = joints.get(jointId);
      if (
        !j ||
        position.values[jointId]?.length !== ASSEMBLY_JOINT_DOFS[j.kind].length
      )
        delete position.values[jointId];
    }
  }
}

export function addAssemblyComponents(
  document: ProjectDocument,
  input: AssemblyComponentsAddInput
): ProjectDocument {
  if (input.components.length === 0)
    throw new Error('Choose at least one body.');
  const known = new Set(document.bodyOrder);
  return withAssembly(document, (set) => {
    for (const entry of input.components) {
      if (!known.has(entry.bodyId))
        throw new Error(`Body ${entry.bodyId} is not in this project.`);
      if (set.components.some((c) => c.id === entry.componentId))
        throw new Error(`Component ${entry.componentId} already exists.`);
      if (set.components.some((c) => c.bodyId === entry.bodyId))
        throw new Error('That body is already a component.');
      set.components.push({
        id: entry.componentId,
        name: cleanName(entry.name, 'A component'),
        bodyId: entry.bodyId,
        grounded: entry.grounded,
        placement: placement(entry.placement ?? IDENTITY_PLACEMENT)
      });
    }
    return set;
  });
}

export function updateAssemblyComponent(
  document: ProjectDocument,
  input: AssemblyComponentUpdateInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    if (input.grounded !== undefined) freezePlacements(set);
    const target = component(set, input.componentId);
    if (input.name !== undefined)
      target.name = cleanName(input.name, 'A component');
    if (input.grounded !== undefined) target.grounded = input.grounded;
    if (input.placement !== undefined)
      target.placement = placement(input.placement);
    return set;
  });
}

export function deleteAssemblyComponent(
  document: ProjectDocument,
  input: AssemblyComponentDeleteInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    component(set, input.componentId);
    freezePlacements(set);
    set.components = set.components.filter((c) => c.id !== input.componentId);
    set.joints = set.joints.filter(
      (j) =>
        j.parent.componentId !== input.componentId &&
        j.child.componentId !== input.componentId
    );
    pruneJointReferences(set);
    return set;
  });
}

function jointEnd(end: AssemblyJointEnd): AssemblyJointEnd {
  return deepClone(end);
}

export function addAssemblyJoint(
  document: ProjectDocument,
  input: AssemblyJointAddInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    const incoming = input.joint;
    if (set.joints.some((j) => j.id === incoming.id))
      throw new Error(`Joint ${incoming.id} already exists.`);
    const error = jointAddError(
      set,
      incoming.parent.componentId,
      incoming.child.componentId
    );
    if (error) throw new Error(error);
    freezePlacements(set);
    const dofs = ASSEMBLY_JOINT_DOFS[incoming.kind].length;
    const limits = Array.from(
      { length: dofs },
      (_, i) => incoming.limits[i] ?? null
    );
    set.joints.push({
      id: incoming.id,
      name: cleanName(incoming.name, 'A joint'),
      kind: incoming.kind,
      parent: jointEnd(incoming.parent),
      child: jointEnd(incoming.child),
      limits,
      values: clampJointValues({ kind: incoming.kind, limits }, incoming.values)
    });
    return set;
  });
}

export function updateAssemblyJoint(
  document: ProjectDocument,
  input: AssemblyJointUpdateInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    const structural =
      input.kind !== undefined ||
      input.parent !== undefined ||
      input.child !== undefined;
    if (structural) freezePlacements(set);
    const target = joint(set, input.jointId);
    if (input.name !== undefined)
      target.name = cleanName(input.name, 'A joint');
    if (input.kind !== undefined && input.kind !== target.kind) {
      target.kind = input.kind;
      target.values = ASSEMBLY_JOINT_DOFS[input.kind].map(() => 0);
      target.limits = ASSEMBLY_JOINT_DOFS[input.kind].map(() => null);
      // A ratio between a turn and a slide means nothing for the new kind.
      if (set.couplings)
        set.couplings = set.couplings.filter(
          (c) =>
            c.driver.jointId !== target.id && c.driven.jointId !== target.id
        );
    }
    if (input.parent !== undefined) target.parent = jointEnd(input.parent);
    if (input.child !== undefined) target.child = jointEnd(input.child);
    if (
      target.parent.componentId === target.child.componentId ||
      set.joints.some(
        (j) =>
          j.id !== target.id &&
          [j.parent.componentId, j.child.componentId].sort().join('|') ===
            [target.parent.componentId, target.child.componentId]
              .sort()
              .join('|')
      )
    )
      throw new Error('These components are already joined.');
    if (input.limits !== undefined) {
      const dofs = ASSEMBLY_JOINT_DOFS[target.kind].length;
      target.limits = Array.from({ length: dofs }, (_, i) => {
        const limit = input.limits?.[i] ?? null;
        if (limit && limit.min > limit.max)
          throw new Error('A limit needs its minimum at or below its maximum.');
        return limit ? { min: limit.min, max: limit.max } : null;
      });
    }
    const values = clampJointValues(target, input.values ?? target.values);
    pruneJointReferences(set);
    if (set.couplings) {
      assertCoupledLimits(set);
      settleJointValues(
        set,
        { [target.id]: values },
        values.map((_, dof) => ({ jointId: target.id, dof }))
      );
    } else target.values = values;
    return set;
  });
}

export function deleteAssemblyJoint(
  document: ProjectDocument,
  input: AssemblyJointDeleteInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    joint(set, input.jointId);
    freezePlacements(set);
    set.joints = set.joints.filter((j) => j.id !== input.jointId);
    pruneJointReferences(set);
    return set;
  });
}

export function setAssemblyPose(
  document: ProjectDocument,
  input: AssemblyPoseSetInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    for (const jointId of Object.keys(input.values ?? {})) joint(set, jointId);
    settleJointValues(set, input.values, input.drivers);
    for (const [componentId, value] of Object.entries(input.placements ?? {})) {
      component(set, componentId).placement = placement(value);
    }
    return set;
  });
}

export function addAssemblyCoupling(
  document: ProjectDocument,
  input: AssemblyCouplingAddInput
): ProjectDocument {
  assertAssemblyCouplingSchema(document.schemaVersion);
  return withAssembly(document, (set) => {
    const incoming = input.coupling;
    if (set.couplings?.some((c) => c.id === incoming.id))
      throw new Error(`Coupling ${incoming.id} already exists.`);
    const draft = {
      driver: { jointId: incoming.driver.jointId, dof: incoming.driver.dof },
      driven: { jointId: incoming.driven.jointId, dof: incoming.driven.dof },
      ratio: incoming.ratio,
      ...(incoming.offset === undefined ? {} : { offset: incoming.offset })
    };
    const refusal = couplingAddError(set, draft, solveAssembly(set).unsolved);
    if (refusal) throw new Error(refusal.message);
    (set.couplings ??= []).push({
      id: incoming.id,
      name: cleanName(incoming.name, 'A coupling'),
      driver: draft.driver,
      driven: draft.driven,
      ratio: draft.ratio,
      offset: draft.offset ?? couplingOffsetAtPose(set, draft)
    });
    settleJointValues(set);
    return set;
  });
}

export function updateAssemblyCoupling(
  document: ProjectDocument,
  input: AssemblyCouplingUpdateInput
): ProjectDocument {
  assertAssemblyCouplingSchema(document.schemaVersion);
  return withAssembly(document, (set) => {
    const target = couplingOf(set, input.couplingId);
    if (input.name !== undefined)
      target.name = cleanName(input.name, 'A coupling');
    if (input.ratio !== undefined || input.offset !== undefined) {
      const ratio = input.ratio ?? target.ratio;
      const draft = {
        driver: target.driver,
        driven: target.driven,
        ratio,
        // A new ratio alone turns about the current pose: nothing jumps.
        ...(input.offset !== undefined
          ? { offset: input.offset }
          : input.ratio !== undefined
            ? {}
            : { offset: target.offset })
      };
      const others = {
        joints: set.joints,
        couplings: (set.couplings ?? []).filter((c) => c.id !== target.id)
      };
      const refusal = couplingAddError(others, draft);
      if (refusal) throw new Error(refusal.message);
      target.ratio = ratio;
      target.offset = draft.offset ?? couplingOffsetAtPose(set, draft);
      settleJointValues(set);
    }
    return set;
  });
}

export function deleteAssemblyCoupling(
  document: ProjectDocument,
  input: AssemblyCouplingDeleteInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    couplingOf(set, input.couplingId);
    set.couplings = (set.couplings ?? []).filter(
      (c) => c.id !== input.couplingId
    );
    if (set.couplings.length === 0) delete set.couplings;
    return set;
  });
}

export function saveAssemblyPosition(
  document: ProjectDocument,
  input: AssemblyPositionSaveInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    const entry = {
      id: input.positionId,
      name: cleanName(input.name, 'A position'),
      values: deepClone(input.values)
    };
    const index = set.positions.findIndex((p) => p.id === input.positionId);
    if (index >= 0) set.positions[index] = entry;
    else set.positions.push(entry);
    return set;
  });
}

export function deleteAssemblyPosition(
  document: ProjectDocument,
  input: AssemblyPositionDeleteInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    if (!set.positions.some((p) => p.id === input.positionId))
      throw new Error(`Position ${input.positionId} not found.`);
    set.positions = set.positions.filter((p) => p.id !== input.positionId);
    return set;
  });
}

export function setAssemblyStudy(
  document: ProjectDocument,
  input: AssemblyStudySetInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    const study = deepClone(input.study);
    study.name = cleanName(study.name, 'A motion study');
    const index = set.studies.findIndex((s) => s.id === study.id);
    if (index >= 0) set.studies[index] = study;
    else set.studies.push(study);
    return set;
  });
}

export function deleteAssemblyStudy(
  document: ProjectDocument,
  input: AssemblyStudyDeleteInput
): ProjectDocument {
  return withAssembly(document, (set) => {
    if (!set.studies.some((s) => s.id === input.studyId))
      throw new Error(`Motion study ${input.studyId} not found.`);
    set.studies = set.studies.filter((s) => s.id !== input.studyId);
    return set;
  });
}

/**
 * The body each component shows now. A component keeps its body while that
 * body is live; when a later feature remade or consumed it, the component
 * follows to the newest live body made from it. Null when nothing live
 * descends from it (the body was deleted). `isLive` says whether a body is
 * shown (not consumed); without it every listed body counts as live.
 */
export function assemblyComponentBodies(
  document: ProjectDocument,
  isLive: (bodyId: BodyId) => boolean = () => true
): Map<string, BodyId | null> {
  const result = new Map<string, BodyId | null>();
  const set = document.assembly;
  if (!set) return result;
  const order = new Map(document.bodyOrder.map((id, index) => [id, index]));
  const children = new Map<BodyId, BodyId[]>();
  for (const [bodyId, source] of bodySourceMap(document)) {
    if (!source) continue;
    const list = children.get(source) ?? [];
    list.push(bodyId);
    children.set(source, list);
  }
  const resolve = (bodyId: BodyId): BodyId | null => {
    if (order.has(bodyId) && isLive(bodyId)) return bodyId;
    let best: BodyId | null = null;
    const seen = new Set<BodyId>([bodyId]);
    const queue = [...(children.get(bodyId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift() as BodyId;
      if (seen.has(next)) continue;
      seen.add(next);
      if (
        order.has(next) &&
        isLive(next) &&
        (best === null || (order.get(next) ?? -1) > (order.get(best) ?? -1))
      )
        best = next;
      queue.push(...(children.get(next) ?? []));
    }
    return best;
  };
  for (const c of set.components) result.set(c.id, resolve(c.bodyId));
  return result;
}
