import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SectionToolbox,
  sectionSliderStep,
  snapSectionOffset
} from './SectionToolbox';

function setup() {
  const onOffset = vi.fn();
  const onCommit = vi.fn();
  const onFlip = vi.fn();
  render(
    <SectionToolbox
      section={{ plane: 'YZ', offset: -2.125 }}
      range={{ min: -10, max: 20 }}
      outline={{ kind: 'clipping' }}
      units="mm"
      onSwitch={vi.fn()}
      onPlane={vi.fn()}
      onOffset={onOffset}
      onCommit={onCommit}
      onFlip={onFlip}
      onExport={vi.fn()}
    />
  );
  return { onOffset, onCommit, onFlip };
}

describe('the section slider steps on round values', () => {
  it('picks a round step for the model', () => {
    // The Mounting Bracket's Z range stepped at 1%: 17.775 mm (I54).
    expect(sectionSliderStep({ min: 0, max: 39.5 })).toBe(0.2);
    expect(sectionSliderStep({ min: -10, max: 20 })).toBe(0.2);
    expect(sectionSliderStep({ min: 0, max: 100 })).toBe(0.5);
    expect(sectionSliderStep({ min: 0, max: 2 })).toBe(0.01);
    expect(sectionSliderStep({ min: 0, max: 500 })).toBe(2.5);
  });

  it('snaps without a float tail and stays inside the model', () => {
    const range = { min: 0, max: 39.5 };
    expect(snapSectionOffset(17.775, range)).toBe(17.8);
    expect(snapSectionOffset(0.2 * 89, range)).toBe(17.8);
    expect(snapSectionOffset(39.6, range)).toBe(39.5);
    expect(snapSectionOffset(-0.1, range)).toBe(0);
  });

  it('moves a key press onto the grid and keeps a typed cut exact', () => {
    // At -2.125 (typed), one step up lands on the grid, not at -1.925.
    const { onOffset, onCommit } = setup();
    const slider = screen.getByRole('slider');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onOffset).toHaveBeenLastCalledWith(-2);
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(-2);
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(onOffset).toHaveBeenLastCalledWith(-4.2);
    fireEvent.keyDown(slider, { key: 'End' });
    expect(onOffset).toHaveBeenLastCalledWith(20);
  });
});

describe('compact section controls', () => {
  it('labels the slider ends with the model bounds', () => {
    setup();
    const ends = document.querySelector('.rail-section-ends');
    expect(ends?.textContent).toBe('-1020');
  });

  it.each(['pointerUp', 'keyUp', 'pointerCancel'] as const)(
    'commits a changed slider once on %s and skips a redundant blur',
    (release) => {
      const { onCommit } = setup();
      const slider = screen.getByRole('slider');
      // Off the 0.2 mm grid a 30 mm model steps on: placed on it (I54).
      fireEvent.change(slider, { target: { value: '3.125' } });
      fireEvent[release](slider);
      fireEvent.blur(slider);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(3.2);
    }
  );

  it('commits on blur only if the changed slider has not been released', () => {
    const { onCommit } = setup();
    const slider = screen.getByRole('slider');
    fireEvent.blur(slider);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '7.6' } });
    fireEvent.blur(slider);
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(7.6);
  });

  it('commits a precise signed position without requesting exact geometry on every keystroke', () => {
    const { onOffset, onCommit } = setup();
    const input = screen.getByLabelText('Cut position');
    fireEvent.change(input, { target: { value: '-3.123456' } });
    expect(onOffset).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onOffset).toHaveBeenCalledWith(-3.123456);
    expect(onCommit).toHaveBeenCalledWith(-3.123456);
  });

  it('clamps a typed position to the model bounds', () => {
    const { onOffset, onCommit } = setup();
    const input = screen.getByLabelText('Cut position');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(onOffset).toHaveBeenCalledWith(20);
    expect(onCommit).toHaveBeenCalledWith(20);
  });

  it('rejects an empty value and leaves an unchanged precise offset alone', () => {
    const { onOffset, onCommit } = setup();
    const input = screen.getByLabelText('Cut position');
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(input).toHaveValue(-2.125);
    expect(onOffset).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('cancels a numeric edit on Escape and commits one on Enter', () => {
    const { onOffset, onCommit } = setup();
    const input = screen.getByLabelText('Cut position');
    input.focus();
    fireEvent.change(input, { target: { value: '8' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue(-2.125);
    expect(onOffset).not.toHaveBeenCalled();
    input.focus();
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onOffset).toHaveBeenCalledWith(9);
    expect(onCommit).toHaveBeenCalledWith(9);
  });

  it('centers between the actual bounds and flips independently', () => {
    const { onOffset, onCommit, onFlip } = setup();
    fireEvent.click(screen.getByLabelText('Center cut'));
    expect(onOffset).toHaveBeenCalledWith(5);
    expect(onCommit).toHaveBeenCalledWith(5);
    fireEvent.click(screen.getByLabelText('Flip cut direction'));
    expect(onFlip).toHaveBeenCalledOnce();
  });

  it('always explains the preview and never exports one', () => {
    setup();
    expect(screen.getByText(/Approximate cut/)).toBeVisible();
    expect(
      screen.getByLabelText('Export the exact section as DXF')
    ).toBeDisabled();
  });
});
