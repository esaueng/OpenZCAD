import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRovingToolbar } from './useRovingToolbar';

afterEach(cleanup);

function Rail({
  onWorkspaceKey,
  hideFit = false
}: {
  onWorkspaceKey?: (key: string) => void;
  hideFit?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [extra, setExtra] = useState(false);
  useRovingToolbar(ref, {
    items: 'button.stop',
    except: '.flyout'
  });
  return (
    // The workspace's own key handler, above the rail.
    <div onKeyDown={(event) => onWorkspaceKey?.(event.key)}>
      <button type="button">Before</button>
      <div ref={ref} role="toolbar" aria-label="Rail">
        <button type="button" className="stop" aria-disabled="true">
          Extrude
        </button>
        <button type="button" className="stop">
          Box
        </button>
        <button type="button" className="stop" disabled>
          Undo
        </button>
        <button
          type="button"
          className="stop"
          style={hideFit ? { display: 'none' } : undefined}
        >
          Fit
        </button>
        <button type="button" className="stop" onClick={() => setExtra(true)}>
          More
        </button>
        {extra && (
          <button type="button" className="stop">
            Late
          </button>
        )}
        <div className="flyout">
          <input aria-label="Find" />
          <button type="button" className="stop">
            Row
          </button>
        </div>
      </div>
    </div>
  );
}

const button = (name: string) => screen.getByRole('button', { name });
const tabStops = () =>
  screen
    .getAllByRole('button')
    .filter((element) => element.getAttribute('tabindex') === '0')
    .map((element) => element.textContent);

describe('useRovingToolbar', () => {
  it('leaves the rail one tab stop, on the first tool that acts', () => {
    render(<Rail />);
    // Not the greyed Extrude: a rail is entered on something that works.
    expect(tabStops()).toEqual(['Box']);
    for (const name of ['Extrude', 'Fit', 'More']) {
      expect(button(name)).toHaveAttribute('tabindex', '-1');
    }
  });

  it('keeps a flyout the rail mounts in the tab order', () => {
    render(<Rail />);
    expect(button('Row')).not.toHaveAttribute('tabindex');
    expect(button('Before')).not.toHaveAttribute('tabindex');
  });

  it('moves with the arrow keys and wraps at the ends', () => {
    render(<Rail />);
    button('Box').focus();
    // Past the natively disabled Undo, which cannot take focus.
    fireEvent.keyDown(button('Box'), { key: 'ArrowDown' });
    expect(button('Fit')).toHaveFocus();
    expect(tabStops()).toEqual(['Fit']);
    fireEvent.keyDown(button('Fit'), { key: 'ArrowRight' });
    expect(button('More')).toHaveFocus();
    fireEvent.keyDown(button('More'), { key: 'ArrowDown' });
    expect(button('Extrude')).toHaveFocus();
    fireEvent.keyDown(button('Extrude'), { key: 'ArrowUp' });
    expect(button('More')).toHaveFocus();
    fireEvent.keyDown(button('More'), { key: 'ArrowLeft' });
    expect(button('Fit')).toHaveFocus();
  });

  it('reaches a tool greyed by aria-disabled, so its reason can be read', () => {
    render(<Rail />);
    button('Box').focus();
    fireEvent.keyDown(button('Box'), { key: 'ArrowUp' });
    expect(button('Extrude')).toHaveFocus();
    expect(tabStops()).toEqual(['Extrude']);
  });

  it('goes to the ends with Home and End', () => {
    render(<Rail />);
    button('Box').focus();
    fireEvent.keyDown(button('Box'), { key: 'End' });
    expect(button('More')).toHaveFocus();
    fireEvent.keyDown(button('More'), { key: 'Home' });
    expect(button('Extrude')).toHaveFocus();
  });

  it('keeps the arrows from the workspace, and leaves it every other key', () => {
    const onWorkspaceKey = vi.fn();
    render(<Rail onWorkspaceKey={onWorkspaceKey} />);
    button('Box').focus();
    fireEvent.keyDown(button('Box'), { key: 'ArrowDown' });
    expect(onWorkspaceKey).not.toHaveBeenCalled();
    fireEvent.keyDown(button('Fit'), { key: 'Escape' });
    expect(onWorkspaceKey).toHaveBeenCalledWith('Escape');
    // Alt+arrow reorders a pin: the rail leaves it alone.
    onWorkspaceKey.mockClear();
    fireEvent.keyDown(button('Fit'), { key: 'ArrowDown', altKey: true });
    expect(onWorkspaceKey).toHaveBeenCalledWith('ArrowDown');
    expect(button('Fit')).toHaveFocus();
  });

  it('leaves the arrow keys to a field inside a flyout', () => {
    const onWorkspaceKey = vi.fn();
    render(<Rail onWorkspaceKey={onWorkspaceKey} />);
    const field = screen.getByLabelText('Find');
    field.focus();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field).toHaveFocus();
    expect(onWorkspaceKey).toHaveBeenCalledWith('ArrowDown');
  });

  it('remembers the stop a click left the keyboard on', () => {
    render(<Rail />);
    fireEvent.focusIn(button('Fit'));
    expect(tabStops()).toEqual(['Fit']);
  });

  it('takes in a stop that arrives later, without a second tab stop', () => {
    render(<Rail />);
    fireEvent.click(button('More'));
    expect(button('Late')).toHaveAttribute('tabindex', '-1');
    expect(tabStops()).toHaveLength(1);
  });

  it('re-reads its stops when one is greyed out natively under it', async () => {
    render(<Rail />);
    expect(tabStops()).toEqual(['Box']);
    // Not through React: a child component of the host re-rendering alone.
    (button('Box') as HTMLButtonElement).disabled = true;
    await waitFor(() => expect(tabStops()).toEqual(['Fit']));
    // And when it comes back it is a stop again, not a second tab stop.
    (button('Box') as HTMLButtonElement).disabled = false;
    await waitFor(() =>
      expect(button('Box')).toHaveAttribute('tabindex', '-1')
    );
    expect(tabStops()).toEqual(['Fit']);
  });

  it('finds its stops once a rail that mounted undisplayed is shown', () => {
    // The Build rail mounts while its project is still opening. Read then,
    // it has no stop to give; it must not stay that way once it is drawn,
    // though nothing about its buttons has changed.
    let drawn = false;
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'checkVisibility'
    );
    Object.defineProperty(Element.prototype, 'checkVisibility', {
      configurable: true,
      value: () => drawn
    });
    try {
      const { rerender } = render(<Rail />);
      expect(tabStops()).toEqual([]);
      drawn = true;
      rerender(<Rail />);
      expect(tabStops()).toEqual(['Box']);
    } finally {
      if (original) {
        Object.defineProperty(Element.prototype, 'checkVisibility', original);
      } else {
        Reflect.deleteProperty(Element.prototype, 'checkVisibility');
      }
    }
  });

  it('never rests on a stop that is hidden', () => {
    const { rerender } = render(<Rail />);
    fireEvent.focusIn(button('Fit'));
    expect(tabStops()).toEqual(['Fit']);
    rerender(<Rail hideFit />);
    // The hidden Fit is no stop; the rail falls back to one that shows.
    expect(tabStops()).toEqual(['Box']);
  });
});
