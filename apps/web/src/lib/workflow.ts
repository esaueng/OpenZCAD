import { listNodesByKind } from '@openzcad/document-core';
import type { BodyNode, ProjectDocument } from '@openzcad/shared';

/**
 * Generative-design workflow model. Roles, loads, and study settings are
 * stored as document node metadata (see document-core setNodeMetadata), so
 * they persist, replay, and undo like any other edit.
 */

export type WorkflowStepId =
  | 'model'
  | 'preserve'
  | 'constraints'
  | 'loads'
  | 'study'
  | 'generate'
  | 'results';

export const WORKFLOW_STEP_IDS: readonly WorkflowStepId[] = [
  'model',
  'preserve',
  'constraints',
  'loads',
  'study',
  'generate',
  'results'
];

export type BodyRole = 'preserve' | 'fixed' | 'obstacle';

export interface BodyLoad {
  fx: number;
  fy: number;
  fz: number;
}

export interface StudySettings {
  /** Target fraction of the design-space volume to keep (0.05 – 0.9). */
  volumeFraction: number;
  resolution: 'coarse' | 'standard' | 'fine';
  objective: 'stiffness' | 'mass';
  /** True once the user explicitly applied settings for this project. */
  confirmed: boolean;
}

export const DEFAULT_STUDY_SETTINGS: StudySettings = {
  volumeFraction: 0.4,
  resolution: 'standard',
  objective: 'stiffness',
  confirmed: false
};

// Metadata keys (gd = generative design).
const ROLE_KEY = 'gdRole';
const LOAD_FX_KEY = 'gdLoadFx';
const LOAD_FY_KEY = 'gdLoadFy';
const LOAD_FZ_KEY = 'gdLoadFz';
const STUDY_FRACTION_KEY = 'gdVolumeFraction';
const STUDY_RESOLUTION_KEY = 'gdResolution';
const STUDY_OBJECTIVE_KEY = 'gdObjective';
const STUDY_CONFIRMED_KEY = 'gdStudyConfirmed';

export function listBodies(document: ProjectDocument): BodyNode[] {
  return listNodesByKind(document, 'body');
}

export function getBodyRole(body: BodyNode): BodyRole | null {
  const role = body.metadata?.[ROLE_KEY];
  return role === 'preserve' || role === 'fixed' || role === 'obstacle' ? role : null;
}

export function getBodyLoad(body: BodyNode): BodyLoad | null {
  const fx = body.metadata?.[LOAD_FX_KEY];
  const fy = body.metadata?.[LOAD_FY_KEY];
  const fz = body.metadata?.[LOAD_FZ_KEY];
  if (typeof fx !== 'number' && typeof fy !== 'number' && typeof fz !== 'number') {
    return null;
  }
  const load: BodyLoad = {
    fx: typeof fx === 'number' ? fx : 0,
    fy: typeof fy === 'number' ? fy : 0,
    fz: typeof fz === 'number' ? fz : 0
  };
  return loadMagnitude(load) > 0 ? load : null;
}

export function loadMagnitude(load: BodyLoad): number {
  return Math.hypot(load.fx, load.fy, load.fz);
}

/** Metadata patch assigning (or clearing, with null) a body role. */
export function roleMetadataPatch(role: BodyRole | null) {
  return { [ROLE_KEY]: role };
}

/** Metadata patch assigning (or clearing, with null) a body load. */
export function loadMetadataPatch(load: BodyLoad | null) {
  return {
    [LOAD_FX_KEY]: load ? load.fx : null,
    [LOAD_FY_KEY]: load ? load.fy : null,
    [LOAD_FZ_KEY]: load ? load.fz : null
  };
}

export function studyMetadataPatch(settings: StudySettings) {
  return {
    [STUDY_FRACTION_KEY]: settings.volumeFraction,
    [STUDY_RESOLUTION_KEY]: settings.resolution,
    [STUDY_OBJECTIVE_KEY]: settings.objective,
    [STUDY_CONFIRMED_KEY]: true
  };
}

export function getStudySettings(document: ProjectDocument): StudySettings {
  const project = document.nodes[document.rootNodeId];
  const metadata = project?.metadata ?? {};
  const fraction = metadata[STUDY_FRACTION_KEY];
  const resolution = metadata[STUDY_RESOLUTION_KEY];
  const objective = metadata[STUDY_OBJECTIVE_KEY];
  return {
    volumeFraction:
      typeof fraction === 'number'
        ? Math.min(0.9, Math.max(0.05, fraction))
        : DEFAULT_STUDY_SETTINGS.volumeFraction,
    resolution:
      resolution === 'coarse' || resolution === 'standard' || resolution === 'fine'
        ? resolution
        : DEFAULT_STUDY_SETTINGS.resolution,
    objective:
      objective === 'stiffness' || objective === 'mass'
        ? objective
        : DEFAULT_STUDY_SETTINGS.objective,
    confirmed: metadata[STUDY_CONFIRMED_KEY] === true
  };
}

export interface WorkflowCounts {
  bodies: number;
  designBodies: number;
  preserved: number;
  fixed: number;
  obstacles: number;
  loaded: number;
}

export function getWorkflowCounts(document: ProjectDocument): WorkflowCounts {
  const bodies = listBodies(document);
  let preserved = 0;
  let fixed = 0;
  let obstacles = 0;
  let loaded = 0;
  for (const body of bodies) {
    const role = getBodyRole(body);
    if (role === 'preserve') preserved += 1;
    else if (role === 'fixed') fixed += 1;
    else if (role === 'obstacle') obstacles += 1;
    if (getBodyLoad(body)) loaded += 1;
  }
  return {
    bodies: bodies.length,
    designBodies: bodies.length - preserved - fixed - obstacles,
    preserved,
    fixed,
    obstacles,
    loaded
  };
}

export interface ReadinessItem {
  id: 'model' | 'preserve' | 'constraints' | 'loads' | 'study';
  label: string;
  done: boolean;
}

/** Checklist the Generate step is gated on. */
export function getGenerateReadiness(document: ProjectDocument): ReadinessItem[] {
  const counts = getWorkflowCounts(document);
  const study = getStudySettings(document);
  return [
    { id: 'model', label: 'Model has at least one body', done: counts.bodies > 0 },
    { id: 'preserve', label: 'Preserved geometry marked', done: counts.preserved > 0 },
    { id: 'constraints', label: 'Fixed support assigned', done: counts.fixed > 0 },
    { id: 'loads', label: 'At least one load applied', done: counts.loaded > 0 },
    { id: 'study', label: 'Study settings confirmed', done: study.confirmed }
  ];
}

export function isReadyToGenerate(document: ProjectDocument): boolean {
  return getGenerateReadiness(document).every((item) => item.done);
}

export type StepState = 'complete' | 'attention' | 'idle';

/**
 * Per-step completion used by the StepBar indicators. `hasOutcomes` reflects
 * the current session's generated outcomes.
 */
export function getStepStates(
  document: ProjectDocument | null,
  hasOutcomes: boolean
): Record<WorkflowStepId, StepState> {
  if (!document) {
    return {
      model: 'idle',
      preserve: 'idle',
      constraints: 'idle',
      loads: 'idle',
      study: 'idle',
      generate: 'idle',
      results: 'idle'
    };
  }
  const counts = getWorkflowCounts(document);
  const study = getStudySettings(document);
  return {
    model: counts.bodies > 0 ? 'complete' : 'attention',
    preserve: counts.preserved > 0 ? 'complete' : 'idle',
    constraints: counts.fixed > 0 ? 'complete' : 'idle',
    loads: counts.loaded > 0 ? 'complete' : 'idle',
    study: study.confirmed ? 'complete' : 'idle',
    generate: hasOutcomes ? 'complete' : 'idle',
    results: hasOutcomes ? 'complete' : 'idle'
  };
}

export function canNavigateToStep(
  step: WorkflowStepId,
  document: ProjectDocument | null,
  hasOutcomes: boolean
): boolean {
  if (!document) {
    return false;
  }
  if (step === 'results') {
    return hasOutcomes;
  }
  return true;
}
