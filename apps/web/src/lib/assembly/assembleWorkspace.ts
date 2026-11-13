import { useEffect, useRef } from 'react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  ASSEMBLY_JOINT_DOFS,
  coupledJointLimits,
  createId,
  jointAddError,
  solveAssembly,
  type AssemblyJoint,
  type AssemblySet,
  type ProjectDocument
} from '@openzcad/shared';
import { useAssemblyPlaybackDriver } from './assemblyPlayback';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  registerAssemblyCommitHandlers,
  useAssemblyRuntime,
  type AssemblyJointToolState
} from './assemblyRuntime';
import { jointFromTool, nextJointName } from './assemblyView';
import {
  getAnimatePrefs,
  setAnimatePrefs,
  sweepDof,
  sweepUnavailableReason
} from './assemblyUi';
import {
  motionSetupJoint,
  type MotionSetupContext,
  type MotionSetupDraft
} from './motionSetup';

/**
 * The Assemble workspace's wiring into the app (AS01/AS02/AS06): the
 * runtime's commit handlers, its active flag, the playback driver, and the
 * workspace's keys. Every saved change goes through `execute`, the app's
 * one command path, so undo, permissions and sync treat it like any edit.
 */

/** Runs one command through the app; false when it was refused or failed. */
export type AssemblyExecute = (command: AnyCommand) => boolean;

export interface AssembleWorkspaceApp {
  document: ProjectDocument | null;
  /** Applied only when opening a project, before the user chooses a selection. */
  initialJointId?: string;
  /** Start only on project open, using the normal transient playback engine. */
  initialPlayback?: 'ping-pong';
  execute: AssemblyExecute;
  onStatus(message: string): void;
}

/** The joint the tool's Create makes, or why it cannot. */
export function jointFromToolState(
  set: AssemblySet | undefined,
  tool: AssemblyJointToolState,
  id: string
): { joint: AssemblyJoint } | { error: string } {
  if (!set || !tool.parent || !tool.child)
    return { error: 'Pick the moving part and its target first.' };
  const refusal = jointAddError(
    set,
    tool.parent.componentId,
    tool.child.componentId
  );
  if (refusal) return { error: refusal };
  // Saved values only: a sweep or the tool's own preview is not where the
  // parts are.
  const made = jointFromTool(
    solveAssembly(set),
    tool,
    id,
    nextJointName(set, tool.kind)
  );
  if (!made) return { error: 'Those picks cannot make a joint.' };
  const dofs = ASSEMBLY_JOINT_DOFS[tool.kind];
  return {
    joint: {
      ...made.joint,
      limits: dofs.map((_, index) => tool.limits?.[index] ?? null)
    }
  };
}

/** Runs the joint tool's Create; the new joint ends up selected. */
export function createJointFromTool(
  app: AssembleWorkspaceApp,
  tool: AssemblyJointToolState
): boolean {
  const result = jointFromToolState(
    app.document?.assembly,
    tool,
    createId<'AssemblyJoint'>('joint')
  );
  if ('error' in result) {
    app.onStatus(result.error);
    return false;
  }
  if (!app.execute(commandFactories.addAssemblyJoint({ joint: result.joint })))
    return false;
  assemblyRuntime.selectJoint(result.joint.id);
  return true;
}

/**
 * Set up motion's Create: fixes the base first when nothing places it (its
 * own undo step), adds the as-built joint with the draft's range, and plays
 * it with the draft's cycle and speed. Playback stays transient.
 */
export function createMotionFromSetup(
  app: AssembleWorkspaceApp,
  context: MotionSetupContext,
  draft: MotionSetupDraft,
  options: { play?: boolean } = {}
): string | null {
  const id = createId<'AssemblyJoint'>('joint');
  const result = motionSetupJoint(context, draft, id);
  if ('error' in result) {
    app.onStatus(result.error);
    return null;
  }
  if (
    result.groundBase &&
    draft.baseId &&
    !app.execute(
      commandFactories.updateAssemblyComponent(
        { componentId: draft.baseId, grounded: true },
        'Fix base in place'
      )
    )
  )
    return null;
  if (!app.execute(commandFactories.addAssemblyJoint({ joint: result.joint })))
    return null;
  assemblyRuntime.closeMotionSetup();
  assemblyRuntime.selectJoint(id);
  setAnimatePrefs({ mode: draft.mode, sweepS: draft.sweepS });
  if (options.play !== false)
    assemblyRuntime.startJointSweep(id, 0, draft.mode, draft.sweepS);
  app.onStatus(`${result.joint.name} is ready. Space plays it; Esc stops.`);
  return id;
}

/** Ground or unground a component: one undo step. */
export function toggleComponentGrounded(
  app: AssembleWorkspaceApp,
  componentId: string
): boolean {
  const component = app.document?.assembly?.components.find(
    (c) => c.id === componentId
  );
  if (!component) return false;
  return app.execute(
    commandFactories.updateAssemblyComponent({
      componentId,
      grounded: !component.grounded
    })
  );
}

/** "Gear ratio", "Gear ratio and Rack travel", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * The couplings a removal takes with it: those on a joint that goes (the
 * joint itself, or every joint of a removed part), and those placed for a
 * removed part as one of their gears. The last is the one nothing on
 * screen shows: a gear keyed to a shaft is not an end of the coupled
 * joint, so both joints stay while the coupling goes.
 */
export function couplingsRemovedWith(
  set: AssemblySet | undefined,
  removed: { componentId: string } | { jointId: string }
): string[] {
  if (!set?.couplings) return [];
  const goes = (joint: AssemblyJoint) =>
    'jointId' in removed
      ? joint.id === removed.jointId
      : joint.parent.componentId === removed.componentId ||
        joint.child.componentId === removed.componentId;
  const joints = new Set(set.joints.filter(goes).map((j) => j.id));
  return set.couplings
    .filter(
      (c) =>
        joints.has(c.driver.jointId) ||
        joints.has(c.driven.jointId) ||
        ('componentId' in removed &&
          (c.gears?.driver === removed.componentId ||
            c.gears?.driven === removed.componentId))
    )
    .map((c) => c.name);
}

function reportRemovedCouplings(
  app: AssembleWorkspaceApp,
  what: string,
  couplings: readonly string[]
): void {
  if (couplings.length === 0) return;
  const one = couplings.length === 1;
  app.onStatus(
    `Removed ${what}. ${listed(couplings)} ${one ? 'was' : 'were'} removed with it: ${one ? 'it' : 'they'} coupled it to another part, and one undo brings both back.`
  );
}

/**
 * Removes a part from the assembly, and says which couplings went with it
 * (no confirmation: one undo restores everything).
 */
export function removeAssemblyComponent(
  app: AssembleWorkspaceApp,
  componentId: string
): boolean {
  const set = app.document?.assembly;
  const component = set?.components.find((c) => c.id === componentId);
  const couplings = couplingsRemovedWith(set, { componentId });
  if (!app.execute(commandFactories.deleteAssemblyComponent({ componentId })))
    return false;
  reportRemovedCouplings(
    app,
    `${component?.name ?? 'the part'} from the assembly`,
    couplings
  );
  return true;
}

/** Deletes a joint, and says which couplings went with it. */
export function removeAssemblyJoint(
  app: AssembleWorkspaceApp,
  jointId: string
): boolean {
  const set = app.document?.assembly;
  const joint = set?.joints.find((j) => j.id === jointId);
  const couplings = couplingsRemovedWith(set, { jointId });
  if (!app.execute(commandFactories.deleteAssemblyJoint({ jointId })))
    return false;
  reportRemovedCouplings(app, joint?.name ?? 'the joint', couplings);
  return true;
}

/** Plays the selected joint, or pauses it when it is the one playing. */
export function toggleJointPlayback(
  app: AssembleWorkspaceApp,
  jointId: string
): boolean {
  const set = app.document?.assembly;
  const saved = set?.joints.find((j) => j.id === jointId);
  if (!set || !saved) return false;
  const playback = getAssemblyRuntime().playback;
  if (playback?.kind === 'joint' && playback.jointId === jointId) {
    assemblyRuntime.stop();
    return true;
  }
  // The range it can really travel: its own limits and its mates'.
  const joint = { kind: saved.kind, limits: coupledJointLimits(set, saved) };
  const reason = sweepUnavailableReason(joint);
  const dof = sweepDof(joint);
  if (reason || dof === null) {
    app.onStatus(reason ?? 'This joint has nothing to play.');
    return false;
  }
  const prefs = getAnimatePrefs();
  assemblyRuntime.startJointSweep(jointId, dof, prefs.mode, prefs.sweepS);
  return true;
}

export type AssembleKey = 'joint-tool' | 'ground' | 'play' | 'escape' | 'enter';

/** The keymap command (or fixed key) a workspace key press means here. */
export function assembleKeyFor(
  commandId: string | undefined,
  key: string
): AssembleKey | null {
  if (key === 'Escape') return 'escape';
  if (key === 'Enter') return 'enter';
  switch (commandId) {
    case 'assembly-joint':
      return 'joint-tool';
    case 'assembly-ground':
      return 'ground';
    case 'assembly-play':
      return 'play';
    default:
      return null;
  }
}

/**
 * Acts on one of the Assemble workspace's keys. True when it was handled
 * (the event should go no further); false leaves it to the workspace.
 */
export function runAssembleKey(
  app: AssembleWorkspaceApp,
  key: AssembleKey
): boolean {
  const runtime = getAssemblyRuntime();
  const set = app.document?.assembly;
  switch (key) {
    case 'joint-tool':
      if ((set?.components.length ?? 0) < 2) {
        app.onStatus('Add at least two components before adding a joint.');
        return true;
      }
      assemblyRuntime.openJointTool();
      app.onStatus('Joint · pick the part that moves.');
      return true;
    case 'ground':
      if (!runtime.selectedComponentId) {
        app.onStatus('Select a component to ground it.');
        return true;
      }
      toggleComponentGrounded(app, runtime.selectedComponentId);
      return true;
    case 'play':
      if (!runtime.selectedJointId) return false;
      toggleJointPlayback(app, runtime.selectedJointId);
      return true;
    case 'escape':
      if (runtime.jointTool) {
        assemblyRuntime.closeJointTool();
        return true;
      }
      if (runtime.motionSetup) {
        assemblyRuntime.closeMotionSetup();
        return true;
      }
      if (runtime.gearMesh) {
        assemblyRuntime.closeGearMesh();
        return true;
      }
      if (runtime.playback) {
        assemblyRuntime.stop();
        return true;
      }
      if (runtime.selectedJointId || runtime.selectedComponentId) {
        assemblyRuntime.selectComponent(null);
        assemblyRuntime.selectJoint(null);
        return true;
      }
      return false;
    case 'enter': {
      const tool = runtime.jointTool;
      if (!tool || tool.step !== 'review') return false;
      const result = jointFromToolState(set, tool, 'probe');
      if ('error' in result) {
        app.onStatus(result.error);
        return true;
      }
      assemblyRuntime.createJoint();
      return true;
    }
  }
}

/**
 * Mount once in the app: keeps the runtime's active flag on the Assemble
 * workspace, resets it per project, registers the commit handlers and runs
 * the playback driver while the assembly is shown.
 */
export function useAssembleWorkspace(
  active: boolean,
  app: AssembleWorkspaceApp
): void {
  const latest = useRef(app);
  latest.current = app;
  const projectId = app.document?.projectId ?? null;
  useEffect(() => {
    assemblyRuntime.setActive(active);
  }, [active]);
  useEffect(() => {
    assemblyRuntime.reset();
    const { document, initialJointId, initialPlayback } = latest.current;
    if (
      initialJointId &&
      document?.assembly?.joints.some((joint) => joint.id === initialJointId)
    ) {
      assemblyRuntime.selectJoint(initialJointId);
      if (
        initialPlayback &&
        getAssemblyRuntime().active &&
        !solveAssembly(document.assembly).unsolved.has(initialJointId)
      ) {
        setAnimatePrefs({ mode: initialPlayback });
        toggleJointPlayback(latest.current, initialJointId);
      }
    }
  }, [projectId]);
  useEffect(() => {
    registerAssemblyCommitHandlers({
      commitPose(values, placements, drivers) {
        // Which motion was moved only matters where joints are coupled.
        const coupled =
          (latest.current.document?.assembly?.couplings?.length ?? 0) > 0;
        latest.current.execute(
          commandFactories.setAssemblyPose({
            values,
            ...(placements ? { placements } : {}),
            ...(coupled && drivers && drivers.length > 0
              ? { drivers: drivers.map((d) => ({ ...d })) }
              : {})
          })
        );
      },
      createJoint(tool) {
        createJointFromTool(latest.current, tool);
      }
    });
    return () => registerAssemblyCommitHandlers(null);
  }, []);
  const shown = useAssemblyRuntime((s) => s.active);
  useAssemblyPlaybackDriver(shown ? app.document?.assembly : undefined);
}
