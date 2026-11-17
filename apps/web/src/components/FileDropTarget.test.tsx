import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useModalFocus } from '../lib/useModalFocus';
import { FileDropTarget } from './FileDropTarget';

function OpenDialog() {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  return (
    <div className="modal-backdrop" data-testid="backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Units" />
    </div>
  );
}

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

  // I68: with the Units dialog open for an STL, a STEP dropped on the stage
  // imported behind it, and the next Escape cancelled the STL.
  it('refuses files while a dialog is open, and says so', () => {
    const onDrop = vi.fn();
    const onRefuse = vi.fn();
    const { unmount } = render(
      <>
        <div data-testid="area">
          <FileDropTarget onDrop={onDrop} onRefuse={onRefuse} />
        </div>
        <OpenDialog />
      </>
    );
    const area = screen.getByTestId('area');
    const overlay = document.querySelector('.file-drop-target')!;

    fireEvent.dragEnter(area, fileTransfer());
    expect(overlay.classList.contains('active')).toBe(false);
    const over = fileTransfer();
    fireEvent.dragOver(area, over);
    expect(over.dataTransfer.dropEffect).toBe('none');
    fireEvent.drop(area, fileTransfer());
    expect(onDrop).not.toHaveBeenCalled();
    expect(onRefuse).toHaveBeenCalledOnce();

    // The backdrop covers the stage: a drop there must not open the file.
    const backdrop = screen.getByTestId('backdrop');
    expect(fireEvent.dragOver(backdrop, fileTransfer())).toBe(false);
    expect(fireEvent.drop(backdrop, fileTransfer())).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onRefuse).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('accepts files again once the dialog has closed', () => {
    const onDrop = vi.fn();
    function Stage({ dialog }: { dialog: boolean }) {
      return (
        <>
          <div data-testid="area">
            <FileDropTarget onDrop={onDrop} />
          </div>
          {dialog ? <OpenDialog /> : null}
        </>
      );
    }
    const { rerender } = render(<Stage dialog />);
    rerender(<Stage dialog={false} />);
    // Outside the stage with no dialog, the browser keeps its default.
    expect(fireEvent.dragOver(document.body, fileTransfer())).toBe(true);
    const dropped = files('bracket.step');
    fireEvent.drop(screen.getByTestId('area'), fileTransfer(dropped));
    expect(onDrop).toHaveBeenCalledWith(dropped);
  });
});
