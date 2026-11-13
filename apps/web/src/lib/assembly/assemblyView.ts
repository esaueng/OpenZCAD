import { assemblyComponentBodies } from '@openzcad/document-core';
import {
  ASSEMBLY_JOINT_DOFS,
  asBuiltChildFrame,
  flipFrame,
  frameInWorld,
  framesCoincide,
  jointWorldFrames,
  placementToTransform,
  quarterTurnFrame,
  solveAssembly,
  transformToMatrix4,
  zeroJointValues,
  type AssemblyDofLimit,
  type AssemblyFrame,
  type AssemblyJoint,
  type AssemblyJointKind,
  type AssemblySet,
  type AssemblySolution,
  type AssemblyUnsolvedReason,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';
import type {
  AssemblyJointToolState,
  AssemblyRuntimeState
} from './assemblyRuntime';

/**
 * Everything the viewport and panels draw for an assembly, derived from the
 * saved section plus the runtime's transient values. Pure: same inputs, same
 * picture. Poses are exact rigid motions applied as object matrices, so a
 * moving part never re-tessellates and never rebuilds.
 */

export interface AssemblyJointGlyph {
  jointId: string;
  name: string;
  kind: AssemblyJointKind;
  selected: boolean;
  unsolved: AssemblyUnsolvedReason | null;
  /** The parent end's frame in world coordinates (the joint's axis). */
  frame: AssemblyFrame;
  values: number[];
  limits: (AssemblyDofLimit | null)[];
}

export interface AssemblyViewModel {
  set: AssemblySet;
  solution: AssemblySolution;
  /** Column-major 4×4 per shown component body (three.js `fromArray`). */
  matrices: Map<BodyId, number[]>;
  componentByBody: Map<BodyId, string>;
  /** Null when nothing live descends from the component's body. */
  bodyByComponent: Map<string, BodyId | null>;
  /** Live bodies that are not components: drawn dimmed in Assemble. */
  otherBodyIds: BodyId[];
  glyphs: AssemblyJointGlyph[];
}

type ViewRuntime = Pick<
  AssemblyRuntimeState,
  'overrides' | 'placementOverrides' | 'selectedJointId' | 'jointTool'
> &
  Partial<Pick<AssemblyRuntimeState, 'motionSetup' | 'drivers'>>;

export const TOOL_PREVIEW_JOINT_ID = '__joint_tool_preview__';
/** The joint Set up motion previews before Create. */
export const MOTION_SETUP_PREVIEW_JOINT_ID = '__motion_setup_preview__';

/**
 * The joint the tool would create from its picks. As-built when the two
 * picked frames already coincide in the world (same point, same axis line):
 * the moving part stays put. Otherwise snapped: the moving part's frame is
 * aligned onto the target's, with the tool's flip and quarter turns.
 */
export function jointFromTool(
  solution: AssemblySolution,
  tool: AssemblyJointToolState,
  id: string,
  name: string
): { joint: AssemblyJoint; asBuilt: boolean } | null {
  const { parent, child } = tool;
  if (!parent || !child || parent.componentId === child.componentId)
    return null;
  const parentPose = solution.poses.get(parent.componentId);
  const childPose = solution.poses.get(child.componentId);
  if (!parentPose || !childPose) return null;
  const coincide = framesCoincide(
    frameInWorld(parentPose, parent.frame),
    frameInWorld(childPose, child.frame)
  );
  let childFrame: AssemblyFrame;
  if (coincide) {
    childFrame = asBuiltChildFrame(
      parentPose,
      parent.frame,
      childPose,
      tool.kind
    );
  } else {
    // Picked frames point out of their faces, so mating parts face each
    // other: the moving frame is reversed onto the target's axis by default
    // (a face lands against the face, a pin goes into its hole). Flip undoes it.
    childFrame = tool.flip ? child.frame : flipFrame(child.frame);
    for (let turn = 0; turn < ((tool.quarterTurns % 4) + 4) % 4; turn += 1)
      childFrame = quarterTurnFrame(childFrame);
  }
  const dofs = ASSEMBLY_JOINT_DOFS[tool.kind];
  return {
    asBuilt: coincide !== null,
    joint: {
      id,
      name,
      kind: tool.kind,
      parent: {
        componentId: parent.componentId,
        frame: parent.frame,
        source: parent.source
      },
      child: {
        componentId: child.componentId,
        frame: childFrame,
        source: child.source
      },
      values: zeroJointValues(tool.kind),
      limits: dofs.map(() => null)
    }
  };
}

/** "Revolute 1", "Revolute 2"…: the next unused default joint name. */
export function nextJointName(
  set: AssemblySet | undefined,
  kind: AssemblyJointKind
): string {
  const base = kind.charAt(0).toUpperCase() + kind.slice(1);
  const names = new Set((set?.joints ?? []).map((j) => j.name));
  for (let n = 1; ; n += 1)
    if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function buildAssemblyView(
  document: ProjectDocument,
  runtime: ViewRuntime,
  isLive: (bodyId: BodyId) => boolean = () => true
): AssemblyViewModel | null {
  const saved = document.assembly;
  if (!saved) return null;
  let set: AssemblySet = saved;
  if (runtime.placementOverrides.size > 0) {
    set = {
      ...saved,
      components: saved.components.map((c) => {
        const placement = runtime.placementOverrides.get(c.id);
        return placement ? { ...c, placement } : c;
      })
    };
  }
  const tool = runtime.jointTool;
  if (tool?.step === 'review') {
    const base = solveAssembly(set, runtime.overrides, runtime.drivers);
    const preview = jointFromTool(base, tool, TOOL_PREVIEW_JOINT_ID, 'Preview');
    if (preview) set = { ...set, joints: [...set.joints, preview.joint] };
  }
  const setupPreview = runtime.motionSetup?.preview;
  if (setupPreview) {
    const baseId = setupPreview.parent.componentId;
    // Create fixes a floating base before adding the joint. Preview the
    // same grounding without mutating the saved assembly; otherwise the
    // solver can anchor an earlier-listed moving part and move the base.
    const groundBase = solveAssembly(set).roles.get(baseId) === 'free';
    set = {
      ...set,
      components: groundBase
        ? set.components.map((component) =>
            component.id === baseId
              ? { ...component, grounded: true }
              : component
          )
        : set.components,
      joints: [
        ...set.joints,
        { ...setupPreview, id: MOTION_SETUP_PREVIEW_JOINT_ID }
      ]
    };
  }
  const solution = solveAssembly(set, runtime.overrides, runtime.drivers);
  const bodyByComponent = assemblyComponentBodies(
    { ...document, assembly: set },
    isLive
  );
  const matrices = new Map<BodyId, number[]>();
  const componentByBody = new Map<BodyId, string>();
  for (const component of set.components) {
    const bodyId = bodyByComponent.get(component.id);
    const pose = solution.poses.get(component.id);
    if (!bodyId || !pose) continue;
    matrices.set(bodyId, transformToMatrix4(pose));
    componentByBody.set(bodyId, component.id);
  }
  const otherBodyIds = document.bodyOrder.filter(
    (bodyId) => isLive(bodyId) && !componentByBody.has(bodyId)
  );
  const glyphs: AssemblyJointGlyph[] = [];
  for (const joint of set.joints) {
    const frames = jointWorldFrames(solution, joint);
    if (!frames) continue;
    glyphs.push({
      jointId: joint.id,
      name: joint.name,
      kind: joint.kind,
      selected:
        joint.id === runtime.selectedJointId ||
        joint.id === TOOL_PREVIEW_JOINT_ID ||
        joint.id === MOTION_SETUP_PREVIEW_JOINT_ID,
      unsolved: solution.unsolved.get(joint.id) ?? null,
      frame: frames.parent,
      values: solution.values.get(joint.id) ?? [...joint.values],
      limits: joint.limits
    });
  }
  return {
    set,
    solution,
    matrices,
    componentByBody,
    bodyByComponent,
    otherBodyIds,
    glyphs
  };
}

/** A component's placement as a column-major matrix (identity: as modelled). */
export function placementMatrix(
  set: AssemblySet,
  componentId: string
): number[] | null {
  const component = set.components.find((c) => c.id === componentId);
  return component
    ? transformToMatrix4(placementToTransform(component.placement))
    : null;
}
