import { describe, expect, it } from 'vitest';
import { parseWorkspaceResumeState } from '@openzcad/shared';

const state = {
  camera: {
    position: [40, 30, 20],
    target: [0, 0, 0],
    orthographicZoom: 1,
    fieldOfView: 60
  },
  projection: 'perspective',
  settings: { showGrid: true, displayMode: 'shaded-edges' },
  hiddenBodyIds: [],
  selectedBodyIds: [],
  workspaceMode: 'build',
  panels: {
    sidebarSections: {},
    assistantCollapsed: false,
    viewModeRailOpen: false
  }
};

describe('workspace resume field of view', () => {
  it('carries the field of view a pose was framed at to the other device', () => {
    expect(parseWorkspaceResumeState(state)?.camera.fieldOfView).toBe(60);
  });

  it('drops an unusable field of view and keeps the pose', () => {
    const parsed = parseWorkspaceResumeState({
      ...state,
      camera: { ...state.camera, fieldOfView: 'wide' }
    });
    expect(parsed?.camera.position).toEqual([40, 30, 20]);
    expect(parsed?.camera).not.toHaveProperty('fieldOfView');
  });
});

describe('workspace resume X-ray', () => {
  it('carries X-ray to the other device', () => {
    const on = { ...state, settings: { ...state.settings, xray: true } };
    expect(parseWorkspaceResumeState(on)?.settings.xray).toBe(true);
    const off = { ...state, settings: { ...state.settings, xray: false } };
    expect(parseWorkspaceResumeState(off)?.settings.xray).toBe(false);
  });

  it('drops an unusable X-ray flag and keeps the state', () => {
    const parsed = parseWorkspaceResumeState({
      ...state,
      settings: { ...state.settings, xray: 'on' }
    });
    expect(parsed?.settings.displayMode).toBe('shaded-edges');
    expect(parsed?.settings).not.toHaveProperty('xray');
  });
});
