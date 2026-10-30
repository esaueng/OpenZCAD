import { act, fireEvent, render, screen } from '@testing-library/react';
import { lazy, Suspense, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLoading, WorkspacePending } from './WorkspaceLoading';
import { createLazyPanel } from './LazyPanel';
import { StartupScreen } from './StartupScreen';

describe('coordinated workspace reveal', () => {
  afterEach(() => vi.restoreAllMocks());

  function frames() {
    let next = 0;
    const callbacks = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.set(++next, callback);
      return next;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      callbacks.delete(id);
    });
    return () =>
      act(() => {
        const current = [...callbacks.values()];
        callbacks.clear();
        current.forEach((callback) => callback(0));
      });
  }

  it('keeps live workspace children mounted while a share destination covers them', () => {
    const frame = frames();
    const unmounted = vi.fn();
    function LiveWork() {
      useEffect(() => unmounted, []);
      return <button>Live workspace</button>;
    }
    const view = (covered: boolean) => (
      <WorkspaceLoading ready covered={covered} onBack={vi.fn()}>
        <LiveWork />
      </WorkspaceLoading>
    );
    const { container, rerender } = render(view(false));
    frame();
    frame();
    const original = screen.getByRole('button', { name: 'Live workspace' });
    rerender(view(true));
    expect(screen.queryByRole('button', { name: 'Live workspace' })).toBeNull();
    expect(container.querySelector('.workspace-reveal')).toHaveAttribute(
      'inert'
    );
    expect(unmounted).not.toHaveBeenCalled();
    rerender(view(false));
    expect(screen.getByRole('button', { name: 'Live workspace' })).toBe(
      original
    );
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('waits for the model and every initial lazy surface, then reveals once', async () => {
    const frame = frames();
    let finish!: (module: { default: () => React.JSX.Element }) => void;
    const Panels = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          finish = resolve;
        })
    );
    const view = (ready: boolean) => (
      <WorkspaceLoading ready={ready} onBack={vi.fn()}>
        <button>Model control</button>
        <Suspense fallback={<WorkspacePending />}>
          <Panels />
        </Suspense>
      </WorkspaceLoading>
    );
    const { container, rerender } = render(view(false));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelector('.workspace-reveal')).toHaveAttribute(
      'inert'
    );
    expect(screen.queryByRole('button', { name: 'Model control' })).toBeNull();
    rerender(view(true));
    frame();
    frame();
    expect(
      screen.getByRole('status', { name: 'Restoring workspace' })
    ).toBeVisible();
    await act(async () =>
      finish({ default: () => <p>Objects and history</p> })
    );
    frame();
    frame();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText('Objects and history')).toBeVisible();
    expect(container.querySelector('.workspace-reveal')).not.toHaveAttribute(
      'inert'
    );
    rerender(view(false));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('cancels an imminent reveal if geometry becomes pending again', () => {
    const frame = frames();
    const { rerender } = render(
      <WorkspaceLoading ready onBack={vi.fn()}>
        <p>Model</p>
      </WorkspaceLoading>
    );
    frame();
    rerender(
      <WorkspaceLoading ready={false} onBack={vi.fn()}>
        <p>Model</p>
      </WorkspaceLoading>
    );
    frame();
    frame();
    expect(screen.getByRole('status')).toBeVisible();
  });

  it('keeps an escape and offline guidance available while waiting', () => {
    frames();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const onBack = vi.fn();
    const Pending = lazy(
      () => new Promise<{ default: () => React.JSX.Element }>(() => {})
    );
    render(
      <WorkspaceLoading ready={false} onBack={onBack}>
        <Suspense fallback={<WorkspacePending />}>
          <Pending />
        </Suspense>
      </WorkspaceLoading>
    );
    expect(screen.getByText(/You’re offline/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Back to parts' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('does not require a connection during an offline local boot restore', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(<StartupScreen />);
    expect(
      screen.getByRole('status', { name: 'Restoring workspace' })
    ).toBeVisible();
    expect(screen.getByText('Loading your last part')).toBeVisible();
    expect(screen.queryByText(/Connect to finish/)).toBeNull();
  });

  it('lets an offline cached workspace prepare without a connection notice', () => {
    frames();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    render(
      <WorkspaceLoading ready={false} onBack={vi.fn()}>
        <p>Cached model</p>
      </WorkspaceLoading>
    );
    expect(screen.getByText('Building the model')).toBeVisible();
    expect(screen.queryByText(/Connect to finish/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Back to parts' })).toBeEnabled();
  });

  it('releases a failed panel to its recovery UI instead of keeping the splash', async () => {
    const frame = frames();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const Failed = createLazyPanel<object>('History', () =>
      Promise.reject(new Error('Failed to fetch dynamically imported module'))
    );
    await act(async () => {
      render(
        <WorkspaceLoading ready onBack={vi.fn()}>
          <Failed />
        </WorkspaceLoading>
      );
    });
    frame();
    frame();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'History could not be rendered.'
    );
    expect(
      screen.getByRole('button', { name: 'Reload workspace' })
    ).toBeVisible();
  });
});
