import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SectionToolbox } from './SectionToolbox';

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
      fireEvent.change(slider, { target: { value: '3.125' } });
      fireEvent[release](slider);
      fireEvent.blur(slider);
      expect(onCommit).toHaveBeenCalledExactlyOnceWith(3.125);
    }
  );

  it('commits on blur only if the changed slider has not been released', () => {
    const { onCommit } = setup();
    const slider = screen.getByRole('slider');
    fireEvent.blur(slider);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '7.5' } });
    fireEvent.blur(slider);
    fireEvent.pointerUp(slider);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(7.5);
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
