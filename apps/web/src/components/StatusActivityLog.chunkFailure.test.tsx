import { createRef, lazy } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as StaleChunk from '../lib/staleChunk';
import { StatusActivityLog } from './StatusActivityLog';

type PanelLoad = 'missing' | 'pending' | 'real';

/**
 * How the next lazy load of the panel goes: the chunk is gone (a tab left
 * open across a deploy), still on its way, or there.
 */
const load = vi.hoisted((): { next: PanelLoad } => ({ next: 'real' }));

vi.mock('../lib/staleChunk', async (importOriginal) => {
  const actual = await importOriginal<typeof StaleChunk>();
  const lazyWithStaleChunkNotice: typeof actual.lazyWithStaleChunkNotice = (
    factory
  ) =>
    lazy(() =>
      load.next === 'missing'
        ? Promise.reject(
            new Error(
              'Failed to fetch dynamically imported module: /assets/StatusActivityLogPanel-old.js'
            )
          )
        : load.next === 'pending'
          ? new Promise<never>(() => {})
          : factory()
    );
  return { ...actual, lazyWithStaleChunkNotice };
});

afterEach(() => {
  load.next = 'real';
  vi.restoreAllMocks();
});

function logAt(open: boolean, onClose = vi.fn()) {
  return (
    <main>
      <p>Workspace</p>
      <StatusActivityLog
        id="test-activity-log"
        open={open}
        status="Added box."
        tone="ready"
        triggerRef={createRef<HTMLButtonElement>()}
        onClose={onClose}
      />
    </main>
  );
}

// One file, one module: the first test must see the panel before it ever
// loaded, so the order of these matters.
describe('StatusActivityLog while its panel loads', () => {
  it('closes on Escape before the chunk arrives, and the workspace never sees the key', () => {
    load.next = 'pending';
    const onClose = vi.fn();
    const workspaceEscape = vi.fn();
    window.addEventListener('keydown', workspaceEscape);
    try {
      render(logAt(true, onClose));
      expect(screen.queryByRole('region', { name: 'Activity log' })).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledWith(true);
      expect(workspaceEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', workspaceEscape);
    }
  });

  it('closes on a press in the workspace before the chunk arrives', () => {
    load.next = 'pending';
    const onClose = vi.fn();
    render(logAt(true, onClose));
    expect(screen.queryByRole('region', { name: 'Activity log' })).toBeNull();
    // Otherwise the click acts on the workspace and the log, still open,
    // pops up over that action once the chunk lands.
    fireEvent.pointerDown(screen.getByText('Workspace'));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('fails inside the log, then loads when the log is opened again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    load.next = 'missing';
    const onClose = vi.fn();
    const { rerender } = render(logAt(true, onClose));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Activity log could not be rendered.');
    const reload = within(alert).getByRole('button', {
      name: 'Reload workspace'
    });
    // Pressing the alert's own Reload is inside the log, not a press away.
    fireEvent.pointerDown(reload);
    expect(onClose).not.toHaveBeenCalled();
    // Nothing above the log was replaced by an error page.
    expect(screen.getByText('Workspace')).toBeInTheDocument();

    // The chunk is reachable again: closing and reopening retries the import
    // instead of replaying the rejection React.lazy kept.
    load.next = 'real';
    rerender(logAt(false, onClose));
    rerender(logAt(true, onClose));
    const log = await screen.findByRole('region', { name: 'Activity log' });
    expect(log).toHaveTextContent('Added box.');
    expect(screen.queryByRole('alert')).toBeNull();
    // A press on the loaded panel (portalled out of this tree) stays in it;
    // one in the workspace closes it, from the one handler there is.
    fireEvent.pointerDown(log);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByText('Workspace'));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith(false);
  });
});
