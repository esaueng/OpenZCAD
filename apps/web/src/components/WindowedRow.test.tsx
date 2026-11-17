import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowedRow } from './WindowedRow';

const instances: Observer[] = [];
class Observer {
  readonly root;
  readonly rootMargin;
  readonly scrollMargin = '0px';
  readonly thresholds = [0];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = () => [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit
  ) {
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '';
    instances.push(this);
  }
  emit(target: Element, isIntersecting: boolean) {
    act(() =>
      this.callback(
        [{ target, isIntersecting } as IntersectionObserverEntry],
        this
      )
    );
  }
}

afterEach(() => {
  cleanup();
  instances.length = 0;
  vi.unstubAllGlobals();
});

function row(name = 'Step', pinned = false, enabled = true) {
  return (
    <WindowedRow enabled={enabled} pinned={pinned} data-testid={name}>
      {(expanded) => (
        <>
          <button>{name}</button>
          {expanded && <button aria-haspopup="menu">Actions for {name}</button>}
        </>
      )}
    </WindowedRow>
  );
}

describe('long panel row controls', () => {
  it('enables native dragging only while the row is expanded', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    render(
      <WindowedRow enabled draggable data-testid="drag-row">
        {() => <button>Part</button>}
      </WindowedRow>
    );
    const target = screen.getByTestId('drag-row');
    expect(target).toHaveAttribute('draggable', 'false');
    fireEvent.focus(screen.getByRole('button', { name: 'Part' }));
    expect(target).toHaveAttribute('draggable', 'true');
    fireEvent.dragStart(target);
    fireEvent.blur(target);
    instances[0]!.emit(target, false);
    expect(target).toHaveAttribute('draggable', 'true');
    fireEvent.dragEnd(target);
    expect(target).toHaveAttribute('draggable', 'false');
  });

  it('keeps primary targets and shares one observer within a scrollport', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    render(
      <div className="model-panel-body" data-testid="scroller">
        {row('First')}
        {row('Last')}
      </div>
    );
    expect(screen.getByRole('button', { name: 'First' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Last' })).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Actions for Last' })
    ).toBeNull();
    expect(instances).toHaveLength(1);
    expect(instances[0]!.root).toBe(screen.getByTestId('scroller'));
    expect(instances[0]!.rootMargin).toBe('120px 0px');
    expect(instances[0]!.observe).toHaveBeenCalledTimes(2);
    instances[0]!.emit(screen.getByTestId('Last'), true);
    expect(
      screen.getByRole('button', { name: 'Actions for Last' })
    ).toBeVisible();
    instances[0]!.emit(screen.getByTestId('Last'), false);
    expect(
      screen.queryByRole('button', { name: 'Actions for Last' })
    ).toBeNull();
  });

  it('expands on keyboard focus and retains the actual primary element', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    render(
      <>
        {row()}
        <button>Outside</button>
      </>
    );
    const primary = screen.getByRole('button', { name: 'Step' });
    fireEvent.focus(primary);
    const action = screen.getByRole('button', { name: 'Actions for Step' });
    expect(screen.getByRole('button', { name: 'Step' })).toBe(primary);
    instances[0]!.emit(screen.getByTestId('Step'), false);
    fireEvent.blur(primary, { relatedTarget: action });
    expect(action).toBeVisible();
    fireEvent.blur(action, {
      relatedTarget: screen.getByRole('button', { name: 'Outside' })
    });
    expect(
      screen.queryByRole('button', { name: 'Actions for Step' })
    ).toBeNull();
  });

  it('keeps selected/editor rows expanded outside the scrollport', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    const { rerender } = render(row('Step', true));
    instances[0]!.emit(screen.getByTestId('Step'), false);
    expect(
      screen.getByRole('button', { name: 'Actions for Step' })
    ).toBeVisible();
    rerender(row('Step', false));
    expect(
      screen.queryByRole('button', { name: 'Actions for Step' })
    ).toBeNull();
  });

  it('retains a portaled menu trigger until focus returns or leaves the menu', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    render(
      <>
        {row()}
        <div role="menu" tabIndex={-1} data-testid="menu">
          <button>Menu item</button>
        </div>
        <button>Outside</button>
      </>
    );
    fireEvent.focus(screen.getByRole('button', { name: 'Step' }));
    const trigger = screen.getByRole('button', { name: 'Actions for Step' });
    fireEvent.blur(trigger, { relatedTarget: screen.getByTestId('menu') });
    instances[0]!.emit(screen.getByTestId('Step'), false);
    expect(trigger).toBeVisible();
    fireEvent.focusIn(screen.getByRole('button', { name: 'Menu item' }));
    expect(trigger).toBeVisible();
    fireEvent.focusIn(screen.getByRole('button', { name: 'Outside' }));
    expect(
      screen.queryByRole('button', { name: 'Actions for Step' })
    ).toBeNull();
  });

  it('retains controls throughout dragging even if the row leaves the scrollport', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    render(row());
    const target = screen.getByTestId('Step');
    fireEvent.dragStart(target);
    instances[0]!.emit(target, false);
    expect(
      screen.getByRole('button', { name: 'Actions for Step' })
    ).toBeVisible();
    fireEvent.dragEnd(target);
    expect(
      screen.queryByRole('button', { name: 'Actions for Step' })
    ).toBeNull();
  });

  it('disconnects after the final row unmounts and ignores queued entries', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    const { unmount } = render(row());
    const target = screen.getByTestId('Step');
    const observer = instances[0]!;
    unmount();
    expect(observer.unobserve).toHaveBeenCalledWith(target);
    expect(observer.disconnect).toHaveBeenCalledOnce();
    observer.emit(target, true);
    render(row());
    expect(instances).toHaveLength(2);
  });

  it('leaves short lists and browsers without an observer fully rendered', () => {
    vi.stubGlobal('IntersectionObserver', Observer);
    const { unmount } = render(row('Short', false, false));
    expect(
      screen.getByRole('button', { name: 'Actions for Short' })
    ).toBeVisible();
    expect(instances).toHaveLength(0);
    unmount();
    vi.stubGlobal('IntersectionObserver', undefined);
    render(row('Fallback'));
    expect(
      screen.getByRole('button', { name: 'Actions for Fallback' })
    ).toBeVisible();
  });
});
