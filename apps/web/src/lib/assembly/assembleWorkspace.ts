import { useEffect, useRef } from 'react';
import { commandFactories, type AnyCommand } from '@openzcad/command-system';
import {
  ASSEMBLY_JOINT_DOFS,
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
  sweepDof,
  sweepUnavailableReason
} from './assemblyUi';

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

/** Plays the selected joint, or pauses it when it is the one playing. */
export function toggleJointPlayback(
  app: AssembleWorkspaceApp,
  jointId: string
): boolean {
  const joint = app.document?.assembly?.joints.find((j) => j.id === jointId);
  if (!joint) return false;
  const playback = getAssemblyRuntime().playback;
  if (playback?.kind === 'joint' && playback.jointId === jointId) {
    assemblyRuntime.stop();
    return true;
  }
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
  }, [projectId]);
  useEffect(() => {
    registerAssemblyCommitHandlers({
      commitPose(values, placements) {
        latest.current.execute(
          commandFactories.setAssemblyPose({
            values,
            ...(placements ? { placements } : {})
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
