import { describe, expect, it } from 'vitest';
import { SELECTION_SEMANTICS } from './semantics';
import {
  EDGE_HOVER_COLOR,
  EDGE_IDLE_COLOR,
  EDGE_SELECTED_COLOR,
  EDGE_SELECTED_WIDTH
} from '../pick/edges';
import { HANDLE_COLOR } from '../gizmo/DragRig';

describe('selection semantics', () => {
  it('is the one source the state constants read from', () => {
    // Not a redesign: these are the values that shipped, now named once
    // instead of declared in four modules across two layers.
    expect(EDGE_IDLE_COLOR).toBe(SELECTION_SEMANTICS.idle.edge);
    expect(EDGE_HOVER_COLOR).toBe(SELECTION_SEMANTICS.hover.edge);
    expect(EDGE_SELECTED_COLOR).toBe(SELECTION_SEMANTICS.selected.edge);
    expect(EDGE_SELECTED_WIDTH).toBe(SELECTION_SEMANTICS.selected.edgeWidth);
    expect(HANDLE_COLOR).toBe(SELECTION_SEMANTICS.handle.idle);
  });

  it('keeps every state distinguishable from the others', () => {
    const { idle, hover, selected, handle } = SELECTION_SEMANTICS;
    const edgeColors = [idle.edge, hover.edge, selected.edge];
    expect(new Set(edgeColors).size).toBe(edgeColors.length);
    expect(hover.face).not.toBe(selected.face);
    // The invalid handle must not be mistaken for a live one.
    expect(handle.invalid).not.toBe(handle.idle);
    expect(handle.invalid).not.toBe(handle.hot);
  });

  it('carries a non-colour signal for each edge state', () => {
    // Colour alone cannot be the difference: a colour-vision deficiency reads
    // the width, and the widths must therefore be ordered and distinct.
    const { idle, hover, selected } = SELECTION_SEMANTICS;
    expect(idle.edgeWidth).toBeLessThan(hover.edgeWidth);
    expect(hover.edgeWidth).toBeLessThan(selected.edgeWidth);
  });

  it('lets a selected face be seen through', () => {
    // The recorded review: a large selected fill hid the edges and holes it
    // covered. The rim carries selection instead, and is the wider mark.
    const { selected, hover } = SELECTION_SEMANTICS;
    expect(selected.faceOpacity).toBeLessThan(0.5);
    expect(selected.faceOpacity).toBeGreaterThan(hover.faceOpacity);
    expect(selected.boundaryWidth).toBeGreaterThan(selected.edgeWidth);
  });

  it('keeps hidden portions dimmer than visible ones', () => {
    const { hover, selected } = SELECTION_SEMANTICS;
    expect(hover.hiddenFaceOpacity).toBeLessThan(hover.faceOpacity);
    expect(selected.hiddenFaceOpacity).toBeLessThan(selected.faceOpacity);
  });
});
