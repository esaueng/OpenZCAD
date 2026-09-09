export interface WorkspaceResumeState {
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    orthographicZoom: number;
    orthographicHalfHeight?: number;
  };
  projection: 'perspective' | 'orthographic';
  settings: {
    showGrid: boolean;
    displayMode: 'shaded-edges' | 'shaded' | 'wireframe';
  };
  hiddenBodyIds: string[];
  selectedBodyIds: string[];
  workspaceMode: 'view' | 'tweak' | 'build';
  panels: {
    sidebarSections: Record<string, boolean>;
    assistantCollapsed: boolean;
    viewModeRailOpen: boolean;
  };
}

export interface ProjectWorkspaceSession {
  schemaVersion: 1;
  projectId: string;
  deviceId: string;
  sessionId: string;
  deviceLabel: 'Desktop' | 'Mobile';
  sequence: number;
  documentVersion: number;
  updatedAt: string;
  state: WorkspaceResumeState;
}

export const MAX_WORKSPACE_SESSION_BYTES = 32_768;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function vector(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}
function ids(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1000 &&
    value.every((v) => typeof v === 'string' && v.length <= 200)
  );
}

/** Both boundaries pick known fields; session state never becomes model input. */
export function parseWorkspaceResumeState(
  value: unknown
): WorkspaceResumeState | null {
  if (
    !record(value) ||
    !record(value.camera) ||
    !record(value.settings) ||
    !record(value.panels)
  )
    return null;
  const { camera, settings, panels } = value;
  if (
    !vector(camera.position) ||
    !vector(camera.target) ||
    typeof camera.orthographicZoom !== 'number' ||
    !Number.isFinite(camera.orthographicZoom) ||
    camera.orthographicZoom <= 0 ||
    (camera.orthographicHalfHeight !== undefined &&
      (typeof camera.orthographicHalfHeight !== 'number' ||
        !Number.isFinite(camera.orthographicHalfHeight) ||
        camera.orthographicHalfHeight <= 0)) ||
    !['perspective', 'orthographic'].includes(String(value.projection)) ||
    typeof settings.showGrid !== 'boolean' ||
    !['shaded-edges', 'shaded', 'wireframe'].includes(
      String(settings.displayMode)
    ) ||
    !ids(value.hiddenBodyIds) ||
    !ids(value.selectedBodyIds) ||
    !['view', 'tweak', 'build'].includes(String(value.workspaceMode)) ||
    !record(panels.sidebarSections) ||
    typeof panels.assistantCollapsed !== 'boolean' ||
    typeof panels.viewModeRailOpen !== 'boolean'
  )
    return null;
  const sections: Record<string, boolean> = {};
  for (const key of [
    'parameters',
    'bodies',
    'history',
    'revisions',
    'diagnostics'
  ]) {
    if (typeof panels.sidebarSections[key] === 'boolean')
      sections[key] = panels.sidebarSections[key];
  }
  return {
    camera: {
      position: [...camera.position],
      target: [...camera.target],
      orthographicZoom: camera.orthographicZoom,
      ...(typeof camera.orthographicHalfHeight === 'number'
        ? { orthographicHalfHeight: camera.orthographicHalfHeight }
        : {})
    },
    projection: value.projection as WorkspaceResumeState['projection'],
    settings: {
      showGrid: settings.showGrid,
      displayMode:
        settings.displayMode as WorkspaceResumeState['settings']['displayMode']
    },
    hiddenBodyIds: [...value.hiddenBodyIds],
    selectedBodyIds: [...value.selectedBodyIds],
    workspaceMode: value.workspaceMode as WorkspaceResumeState['workspaceMode'],
    panels: {
      sidebarSections: sections,
      assistantCollapsed: panels.assistantCollapsed,
      viewModeRailOpen: panels.viewModeRailOpen
    }
  };
}
