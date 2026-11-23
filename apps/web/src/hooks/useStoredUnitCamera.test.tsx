import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UnitSystem } from '@openzcad/shared';
import { scaledCameraPose, useStoredUnitCamera } from './useStoredUnitCamera';

describe('scaledCameraPose', () => {
  it('scales position, target and the orthographic half-height', () => {
    const pose = {
      position: [254, -254, 127] as [number, number, number],
      target: [25.4, 0, 12.7] as [number, number, number],
      orthographicZoom: 2,
      orthographicHalfHeight: 50.8,
      fieldOfView: 35,
      up: [0, 0, 1] as [number, number, number]
    };
    const scaled = scaledCameraPose(pose, 1 / 25.4);
    expect(scaled.position[0]).toBeCloseTo(10, 12);
    expect(scaled.position[1]).toBeCloseTo(-10, 12);
    expect(scaled.position[2]).toBeCloseTo(5, 12);
    expect(scaled.target[0]).toBeCloseTo(1, 12);
    expect(scaled.target[2]).toBeCloseTo(0.5, 12);
    expect(scaled.orthographicHalfHeight).toBeCloseTo(2, 12);
    expect(scaled.orthographicZoom).toBe(2);
    expect(scaled.fieldOfView).toBe(35);
    expect(scaled.up).toEqual([0, 0, 1]);
  });

  it('leaves an absent half-height absent', () => {
    const scaled = scaledCameraPose(
      { position: [10, 0, 0], target: [0, 0, 0], orthographicZoom: 1 },
      2
    );
    expect('orthographicHalfHeight' in scaled).toBe(false);
    expect(scaled.position).toEqual([20, 0, 0]);
  });
});

describe('useStoredUnitCamera', () => {
  function mount(projectId: string | null, units: UnitSystem | null) {
    const onUnitsChanged = vi.fn();
    const hook = renderHook(
      ({ id, unit }: { id: string | null; unit: UnitSystem | null }) =>
        useStoredUnitCamera(id, unit, onUnitsChanged),
      { initialProps: { id: projectId, unit: units } }
    );
    return { ...hook, onUnitsChanged };
  }

  it('scales by k on a conversion, and back on its undo', () => {
    const { rerender, onUnitsChanged } = mount('p1', 'mm');
    expect(onUnitsChanged).not.toHaveBeenCalled();
    rerender({ id: 'p1', unit: 'inch' });
    expect(onUnitsChanged).toHaveBeenCalledTimes(1);
    expect(onUnitsChanged.mock.calls[0]![0]).toBeCloseTo(1 / 25.4, 15);
    // Undo, then redo.
    rerender({ id: 'p1', unit: 'mm' });
    expect(onUnitsChanged.mock.calls[1]![0]).toBeCloseTo(25.4, 12);
    rerender({ id: 'p1', unit: 'inch' });
    expect(onUnitsChanged).toHaveBeenCalledTimes(3);
  });

  it('does nothing for other edits or when another project opens', () => {
    const { rerender, onUnitsChanged } = mount('p1', 'mm');
    rerender({ id: 'p1', unit: 'mm' });
    rerender({ id: 'p2', unit: 'inch' });
    rerender({ id: null, unit: null });
    rerender({ id: 'p1', unit: 'cm' });
    expect(onUnitsChanged).not.toHaveBeenCalled();
  });
});
