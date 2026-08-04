import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PanelResizer } from './PanelResizer';

/**
 * happy-dom has no pointer capture, and the splitter relies on it to keep
 * receiving moves once the pointer leaves the 11px handle. A recording stub
 * lets the drag be exercised as it runs in a browser.
 */
const capturedPointers = new WeakMap<HTMLElement, Set<number>>();
const originalCapture = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'setPointerCapture'
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
    configurable: true,
    value(this: HTMLElement, pointerId: number) {
      const captured = capturedPointers.get(this) ?? new Set<number>();
      captured.add(pointerId);
      capturedPointers.set(this, captured);
    }
  });
});

afterAll(() => {
  if (originalCapture) {
    Object.defineProperty(
      HTMLElement.prototype,
      'setPointerCapture',
      originalCapture
    );
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
  }
});

function renderResizer(edge: 'left' | 'right' = 'left', width = 252) {
  const callbacks = {
    onPreview: vi.fn(),
    onCommit: vi.fn(),
    onReset: vi.fn()
  };
  render(
    <PanelResizer
      label="Resize the sidebar"
      edge={edge}
      width={width}
      min={180}
      max={560}
      {...callbacks}
    />
  );
  return { handle: screen.getByRole('separator'), ...callbacks };
}

function drag(handle: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: from });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX: to });
}

/** The splitter batches previews into a frame; this is that frame. */
async function nextFrame(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

describe('panel splitter', () => {
  it('previews the width under the pointer and keeps it on release', async () => {
    const { handle, onPreview, onCommit } = renderResizer();

    drag(handle, 300, 380);
    await nextFrame();
    expect(onPreview).toHaveBeenLastCalledWith(332);
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 380 });
    expect(onCommit).toHaveBeenCalledWith(332);
  });

  it('grows a right-docked panel as the pointer moves left', async () => {
    const { handle, onPreview } = renderResizer('right', 360);

    drag(handle, 900, 820);
    await nextFrame();
    expect(onPreview).toHaveBeenLastCalledWith(440);
  });

  it('coalesces a burst of moves into one preview per frame', async () => {
    const { handle, onPreview } = renderResizer();

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300 });
    for (const x of [310, 320, 330, 340]) {
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: x });
    }
    await nextFrame();
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith(292);
  });

  it('stays inside the limits however far the pointer travels', async () => {
    const { handle, onPreview, onCommit } = renderResizer();

    drag(handle, 300, 2_000);
    await nextFrame();
    expect(onPreview).toHaveBeenLastCalledWith(560);

    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -2_000 });
    await nextFrame();
    expect(onPreview).toHaveBeenLastCalledWith(180);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: -2_000 });
    expect(onCommit).toHaveBeenCalledWith(180);
  });

  it('rewinds an abandoned drag without saving it', async () => {
    const { handle, onPreview, onCommit } = renderResizer();

    drag(handle, 300, 420);
    await nextFrame();
    fireEvent.keyDown(globalThis.document, { key: 'Escape' });

    expect(onPreview).toHaveBeenLastCalledWith(252);
    expect(onCommit).not.toHaveBeenCalled();
    expect(
      globalThis.document.documentElement.dataset.panelResizing
    ).toBeUndefined();
  });

  it('leaves the document alone once a drag ends', async () => {
    const { handle } = renderResizer();

    drag(handle, 300, 420);
    expect(globalThis.document.documentElement.dataset.panelResizing).toBe(
      'true'
    );
    await nextFrame();
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 420 });
    expect(
      globalThis.document.documentElement.dataset.panelResizing
    ).toBeUndefined();
  });

  it('is movable from the keyboard, in fine and coarse steps', () => {
    const { handle, onCommit } = renderResizer();

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onCommit).toHaveBeenLastCalledWith(260);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(220);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onCommit).toHaveBeenLastCalledWith(180);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(onCommit).toHaveBeenLastCalledWith(560);
  });

  it('reverses the arrow keys for a right-docked panel', () => {
    const { handle, onCommit } = renderResizer('right', 360);

    // The dock grows leftward, so the key that widens it has to as well.
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(368);
  });

  it('does not save a key press that changes nothing', () => {
    const { handle, onCommit } = renderResizer('left', 180);

    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('restores the shipped width on a double-click', () => {
    const { handle, onReset } = renderResizer();

    fireEvent.doubleClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('publishes its width to assistive technology', () => {
    const { handle } = renderResizer('left', 300);

    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '300');
    expect(handle).toHaveAttribute('aria-valuemin', '180');
    expect(handle).toHaveAttribute('aria-valuemax', '560');
    expect(handle).toHaveAccessibleName('Resize the sidebar');
  });

  it('ignores a secondary button', () => {
    const { handle, onPreview, onCommit } = renderResizer();

    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 300 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 400 });
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
