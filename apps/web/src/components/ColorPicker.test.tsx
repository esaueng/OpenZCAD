import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ColorPicker } from './ColorPicker';

function Harness({
  onChange = vi.fn(),
  onCommit = vi.fn(),
  initial = '#4da3ff'
}: {
  onChange?: (color: string) => void;
  onCommit?: (color: string) => void;
  initial?: string;
}) {
  const [color, setColor] = useState(initial);
  return (
    <ColorPicker
      color={color}
      presets={['#e1a948', '#4bb7a7']}
      onChange={(next) => {
        setColor(next);
        onChange(next);
      }}
      onCommit={(next) => {
        setColor(next);
        onCommit(next);
      }}
    />
  );
}

describe('ColorPicker', () => {
  it('commits a preset swatch immediately', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Use color #4bb7a7' }));
    expect(onCommit).toHaveBeenCalledWith('#4bb7a7');
  });

  it('marks the active preset from the current color', () => {
    render(<Harness initial="#e1a948" />);
    expect(
      screen.getByRole('button', { name: 'Use color #e1a948' }).className
    ).toContain('active');
  });

  it('streams valid hex edits and commits on Enter', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<Harness onChange={onChange} onCommit={onCommit} />);
    const input = screen.getByDisplayValue('#4da3ff');
    fireEvent.change(input, { target: { value: 'ff7452' } });
    expect(onChange).toHaveBeenCalledWith('#ff7452');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onCommit).toHaveBeenCalledWith('#ff7452');
  });

  it('reverts an invalid hex draft on blur without committing', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const input = screen.getByDisplayValue('#4da3ff');
    fireEvent.change(input, { target: { value: 'not-a-color' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('#4da3ff')).toBeTruthy();
  });
});

describe('ColorPicker from the keyboard', () => {
  /*
    Both pads were role="slider" with no tab stop and no key handling, so a
    keyboard user could reach only the hex field; the pad also lacked the
    aria-valuenow a slider must have.
  */
  it('steps the hue with arrows, previews each step, and commits once on release', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <Harness onChange={onChange} onCommit={onCommit} initial="#ff0000" />
    );
    const hue = screen.getByRole('slider', { name: 'Hue' });
    expect(hue).toHaveAttribute('tabindex', '0');
    expect(hue).toHaveAttribute('aria-valuenow', '0');
    expect(fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true })).toBe(
      false
    );
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true });
    expect(hue).toHaveAttribute('aria-valuenow', '20');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(hue, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('moves saturation and brightness on the pad and reports both', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial="#ff0000" />);
    const pad = screen.getByRole('slider', {
      name: 'Saturation and brightness'
    });
    expect(pad).toHaveAttribute('tabindex', '0');
    expect(pad).toHaveAttribute('aria-valuenow', '100');
    fireEvent.keyDown(pad, { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(pad, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyUp(pad, { key: 'ArrowDown' });
    expect(pad).toHaveAttribute('aria-valuenow', '90');
    expect(pad).toHaveAttribute(
      'aria-valuetext',
      '90% saturation, 90% brightness'
    );
    // ArrowLeft is still down: one step, one commit, once it is released.
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(pad, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenCalledOnce();
  });

  it('commits a held Shift+arrow step once, not when Shift is released', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial="#ff0000" />);
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyUp(hue, { key: 'Shift' });
    fireEvent.keyDown(hue, { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyUp(hue, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledOnce();
    expect(hue).toHaveAttribute('aria-valuenow', '11');
  });

  it('commits a step when focus leaves before the arrow is released', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} initial="#ff0000" />);
    const hue = screen.getByRole('slider', { name: 'Hue' });
    fireEvent.keyDown(hue, { key: 'ArrowRight' });
    fireEvent.blur(hue);
    expect(onCommit).toHaveBeenCalledOnce();
    fireEvent.keyDown(hue, { key: 'ArrowRight' });
    fireEvent.keyUp(hue, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
