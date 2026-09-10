import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileDropTarget } from './FileDropTarget';

function renderArea(onDrop: (files: File[]) => void) {
  render(
    <div data-testid="area">
      <span data-testid="child">child</span>
      <FileDropTarget onDrop={onDrop} />
    </div>
  );
  return {
    area: screen.getByTestId('area'),
    child: screen.getByTestId('child'),
    overlay: () => document.querySelector('.file-drop-target') as HTMLElement
  };
}

function files(...names: string[]): File[] {
  return names.map((name) => new File(['x'], name, { type: 'model/step' }));
}

const fileTransfer = (list: File[] = files('a.step')) => ({
  dataTransfer: { types: ['Files'], files: list, dropEffect: 'none' }
});

const rowTransfer = () => ({
  dataTransfer: { types: ['text/plain'], files: [], dropEffect: 'none' }
});

describe('FileDropTarget', () => {
  it('lights up while files are dragged over the area and hands them over on drop', () => {
    const onDrop = vi.fn();
    const { area, overlay } = renderArea(onDrop);
    expect(overlay().classList.contains('active')).toBe(false);

    fireEvent.dragEnter(area, fileTransfer());
    expect(overlay().classList.contains('active')).toBe(true);

    const dropped = files('bracket.step');
    fireEvent.drop(area, fileTransfer(dropped));
    expect(overlay().classList.contains('active')).toBe(false);
    expect(onDrop).toHaveBeenCalledWith(dropped);
  });

  /**
   * Crossing into a child fires leave on the parent and enter on the child.
   * A boolean would blink off between the two; the depth counter must not.
   */
  it('stays lit while the pointer crosses children of the area', () => {
    const { area, child, overlay } = renderArea(vi.fn());

    fireEvent.dragEnter(area, fileTransfer());
    fireEvent.dragEnter(child, fileTransfer());
    fireEvent.dragLeave(area, fileTransfer());
    expect(overlay().classList.contains('active')).toBe(true);

    fireEvent.dragLeave(child, fileTransfer());
    expect(overlay().classList.contains('active')).toBe(false);
  });

  /** Reordering a feature row is a drag too, and must not raise the overlay. */
  it('ignores drags that carry no files', () => {
    const onDrop = vi.fn();
    const { area, overlay } = renderArea(onDrop);

    fireEvent.dragEnter(area, rowTransfer());
    expect(overlay().classList.contains('active')).toBe(false);
    fireEvent.drop(area, rowTransfer());
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('accepts the drop rather than letting the browser open the file', () => {
    const { area } = renderArea(vi.fn());
    // fireEvent returns false when preventDefault was called.
    expect(fireEvent.dragOver(area, fileTransfer())).toBe(false);
  });
});
