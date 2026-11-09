import { useCallback, useRef, useState } from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachDerivedState,
  createProjectDocument
} from '@openzcad/document-core';
import {
  toUserId,
  type ProjectDocument,
  type SaveProjectDocumentResponse
} from '@openzcad/shared';
import { LocalProjectAutosave } from '../lib/localProjectAutosave';
import {
  CloudProjectAutosave,
  type WorkspaceSaveState
} from '../lib/cloudProjectAutosave';
import { useLocalProjectAutosaveSchedule } from './useLocalProjectAutosaveSchedule';

const base = createProjectDocument(
  'Autosave regression',
  toUserId('user_autosave')
);
const committed = { ...base, version: 2 };
const rebuilt = attachDerivedState(committed, {
  ...committed.derived,
  updatedAt: 'later'
});

function setup({ heldUpload = false, cloudEnabled = true } = {}) {
  const write = vi.fn(async (_document: ProjectDocument) => true);
  let release!: (response: SaveProjectDocumentResponse) => void;
  const saveProjectDocument = vi.fn(
    async ({ document }: { document: ProjectDocument }) => ({
      projectId: document.projectId,
      version: document.version,
      updatedAt: 'later'
    })
  );
  if (heldUpload)
    saveProjectDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
  const statuses: WorkspaceSaveState[] = [];
  let setStatus!: (status: WorkspaceSaveState) => void;
  const cloud = new CloudProjectAutosave({
    api: { saveProjectDocument },
    connectivity: { isOnline: () => true, subscribe: () => () => {} },
    onStatus: ({ state }) => {
      statuses.push(state);
      setStatus?.(state);
    }
  });
  cloud.openProject(base.projectId, 1);
  const local = new LocalProjectAutosave({
    write,
    onSaved(document) {
      if (cloudEnabled) {
        if (!cloud.holdsDocument(document)) cloud.schedule(document);
        else setStatus('synced');
      } else setStatus('local');
    },
    onError: () => setStatus('device-failed'),
    onDirtyChange: vi.fn()
  });
  const hook = renderHook(
    ({
      document,
      preview
    }: {
      document: ProjectDocument | null;
      preview: number | null;
    }) => {
      const [status, updateStatus] = useState<WorkspaceSaveState>('synced');
      setStatus = updateStatus;
      const timeoutRef = useRef<number | null>(null);
      const flush = useCallback(() => {
        if (timeoutRef.current !== null)
          window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        return local.flush();
      }, []);
      useLocalProjectAutosaveSchedule({
        document,
        autosave: local,
        flush,
        timeoutRef,
        onCanonicalChange: () => {
          statuses.push('saving');
          setStatus('saving');
        }
      });
      return { status, preview };
    },
    {
      initialProps: { document: null, preview: null }
    }
  );
  return {
    ...hook,
    local,
    cloud,
    write,
    saveProjectDocument,
    statuses,
    release: () =>
      release({ projectId: base.projectId, version: 2, updatedAt: 'later' })
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('accepted-document autosave scheduling', () => {
  it('writes nothing during preview/cancel and starts a canonical commit without advancing timers', async () => {
    const h = setup();
    h.rerender({ document: base, preview: null });
    await act(async () => h.local.flush());
    h.write.mockClear();
    h.statuses.length = 0;
    for (const preview of [10, -5, null])
      h.rerender({ document: base, preview });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(h.write).not.toHaveBeenCalled();
    expect(h.saveProjectDocument).not.toHaveBeenCalled();
    expect(h.statuses).toEqual([]);
    h.rerender({ document: committed, preview: null });
    expect(h.result.current.status).toBe('saving');
    await act(async () => h.local.flush());
    expect(h.write).toHaveBeenCalledExactlyOnceWith(committed);
    h.unmount();
    h.cloud.dispose();
  });

  it.each([true, false])(
    'refreshes the cache without changing settled storage status (cloud %s)',
    async (cloudEnabled) => {
      const h = setup({ cloudEnabled });
      h.rerender({ document: committed, preview: null });
      await act(async () => {
        await h.local.flush();
        await h.cloud.flushPending();
      });
      const settled = cloudEnabled ? 'synced' : 'local';
      expect(h.result.current.status).toBe(settled);
      h.statuses.length = 0;
      h.rerender({ document: rebuilt, preview: null });
      expect(h.local.dirty).toBe(false);
      expect(h.result.current.status).toBe(settled);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(h.write).toHaveBeenLastCalledWith(rebuilt);
      expect(h.result.current.status).toBe(settled);
      expect(h.statuses).toEqual([]);
      expect(h.saveProjectDocument).toHaveBeenCalledTimes(cloudEnabled ? 1 : 0);
      h.unmount();
      h.cloud.dispose();
    }
  );

  it('keeps Syncing through an in-flight derived refresh and uploads only a genuinely newer edit after it', async () => {
    const h = setup({ heldUpload: true });
    h.rerender({ document: committed, preview: null });
    let first!: Promise<number | null>;
    await act(async () => {
      await h.local.flush();
      first = h.cloud.flush();
      await Promise.resolve();
    });
    expect(h.saveProjectDocument).toHaveBeenCalledTimes(1);
    expect(h.result.current.status).toBe('syncing');
    h.statuses.length = 0;
    h.rerender({ document: rebuilt, preview: null });
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(h.write).toHaveBeenCalledTimes(2);
    expect(h.statuses).toEqual([]);
    expect(h.result.current.status).toBe('syncing');
    expect(h.cloud.hasPendingChanges).toBe(false);
    const newer = { ...committed, version: 3, name: 'New canonical edit' };
    h.rerender({ document: newer, preview: null });
    await act(async () => h.local.flush());
    expect(h.write).toHaveBeenLastCalledWith(newer);
    expect(h.saveProjectDocument).toHaveBeenCalledTimes(1);
    await act(async () => {
      h.release();
      await first;
      await h.cloud.flushPending();
    });
    expect(
      h.saveProjectDocument.mock.calls.map(([input]) => input.document.version)
    ).toEqual([2, 3]);
    expect(h.result.current.status).toBe('synced');
    h.unmount();
    h.cloud.dispose();
  });
});
