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
