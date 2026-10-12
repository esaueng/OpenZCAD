import { describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  LocalProjectAutosave,
  sameLocalProjectContent
} from './localProjectAutosave';

const baseDocument = createProjectDocument(
  'QA save',
  toUserId('user_local_save')
);

function documentAt(version: number): ProjectDocument {
  return { ...baseDocument, version };
}

function deferred() {
  let resolve!: (saved: boolean) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<boolean>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(write = vi.fn(async (_document: ProjectDocument) => true)) {
  const onSaved =
    vi.fn<(document: ProjectDocument, newerQueued: boolean) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const onDirtyChange = vi.fn<(dirty: boolean) => void>();
  const queue = new LocalProjectAutosave({
    write,
    onSaved,
    onError,
    onDirtyChange
  });
  return { queue, write, onSaved, onError, onDirtyChange };
}

describe('device save classification', () => {
  it('starts the first document immediately and debounces only derived-only replacements', () => {
    const { queue } = harness();
    const document = documentAt(1);
    expect(queue.enqueue(document)).toBe(true);
    expect(
      queue.enqueue({
        ...document,
        derived: { ...document.derived, updatedAt: 'later' }
      })
    ).toBe(false);
    expect(queue.enqueue({ ...document, name: 'Edited name' })).toBe(true);
  });

  it('treats every canonical field as durable work, including same-version save/history metadata', () => {
    const document = documentAt(1);
    // Rebuild content keys intentionally omit many of these fields. A device
    // save must retain every one, rather than only what changes the geometry.
    for (const key of Object.keys(document).filter(
      (key) => key !== 'derived'
    )) {
      const value = document[key as keyof ProjectDocument];
      const changed =
        typeof value === 'number'
          ? value + 1
          : typeof value === 'string'
            ? `${value}-changed`
            : Array.isArray(value)
              ? [...value]
              : { ...(value as object) };
      expect(
        sameLocalProjectContent(document, { ...document, [key]: changed }),
        key
      ).toBe(false);
    }
    expect(
      sameLocalProjectContent(document, {
        ...document,
        extraCanonicalField: true
      } as ProjectDocument)
    ).toBe(false);
  });
});

describe('local save departure safety', () => {
  it('stays dirty throughout an in-flight transaction and clears only after commit', async () => {
    const pending = deferred();
    const { queue, onDirtyChange, onSaved } = harness(
      vi.fn(() => pending.promise)
    );
    const document = documentAt(1);
    queue.enqueue(document);
    const flush = queue.flush();
    await Promise.resolve();
    expect(queue.dirty).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    pending.resolve(true);
    await flush;
    expect(queue.dirty).toBe(false);
    expect(onSaved).toHaveBeenCalledWith(document, false);
    expect(onDirtyChange.mock.calls.map(([dirty]) => dirty)).toEqual([
      true,
      false
    ]);
  });

  it('serializes writes, coalesces waiting edits and makes a concurrent flush await the newest commit', async () => {
    const first = deferred();
    const last = deferred();
    const write = vi
      .fn<(document: ProjectDocument) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(last.promise);
    const { queue, onSaved } = harness(write);
    const documents = [documentAt(1), documentAt(2), documentAt(3)];
    queue.enqueue(documents[0]!);
    const flush = queue.flush();
    await Promise.resolve();
    queue.enqueue(documents[1]!);
    queue.enqueue(documents[2]!);
    const concurrent = queue.flush();
    expect(concurrent).toBe(flush);
    expect(write).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls.map(([document]) => document.version)).toEqual([
      1, 3
    ]);
    expect(onSaved).toHaveBeenCalledWith(documents[0], true);
    expect(queue.dirty).toBe(true);
    last.resolve(true);
    await concurrent;
    expect(onSaved).toHaveBeenLastCalledWith(documents[2], false);
    expect(queue.dirty).toBe(false);
  });

  it('retains failed work for retry and keeps departure protection armed', async () => {
    const error = new DOMException('Full', 'QuotaExceededError');
    const write = vi
      .fn<(document: ProjectDocument) => Promise<boolean>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(true);
    const { queue, onSaved, onError } = harness(write);
    const document = documentAt(1);
    queue.enqueue(document);
    await expect(queue.flush()).rejects.toBe(error);
    expect(queue.dirty).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
    await queue.flush();
    expect(write).toHaveBeenLastCalledWith(document);
    expect(queue.dirty).toBe(false);
  });

  it('never reparks a failed old snapshot over a newer queued edit', async () => {
    const first = deferred();
    const write = vi
      .fn<(document: ProjectDocument) => Promise<boolean>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(true);
    const { queue } = harness(write);
    queue.enqueue(documentAt(1));
    const flush = queue.flush();
    await Promise.resolve();
    const newer = documentAt(2);
    queue.enqueue(newer);
    first.reject(new Error('Device unavailable'));
    await expect(flush).rejects.toThrow('Device unavailable');
    expect(queue.dirty).toBe(true);
    await queue.flush();
    expect(write.mock.calls.map(([document]) => document.version)).toEqual([
      1, 2
    ]);
    expect(queue.dirty).toBe(false);
  });

  it('handles synchronous writer failures and later retry without a stuck in-flight promise', async () => {
    const write = vi
      .fn<(document: ProjectDocument) => Promise<boolean>>()
      .mockImplementationOnce(() => {
        throw new Error('Denied');
      })
      .mockResolvedValueOnce(true);
    const { queue, onError } = harness(write);
    queue.enqueue(documentAt(1));
    await expect(queue.flush()).rejects.toThrow('Denied');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(queue.dirty).toBe(true);
    await queue.flush();
    expect(queue.dirty).toBe(false);
  });

  it('rejects the departure barrier so another project cannot replace failed work', async () => {
    const { queue } = harness(
      vi.fn(async () => {
        throw new Error('Storage full');
      })
    );
    queue.enqueue(documentAt(1));
    const openDifferentProject = vi.fn();
    await queue
      .flush()
      .then(openDifferentProject)
      .catch(() => undefined);
    expect(openDifferentProject).not.toHaveBeenCalled();
    expect(queue.dirty).toBe(true);
  });

  it('does not announce a saved document when ownership refuses the write', async () => {
    const { queue, onSaved } = harness(vi.fn(async () => false));
    queue.enqueue(documentAt(1));
    await queue.flush();
    expect(onSaved).not.toHaveBeenCalled();
    expect(queue.dirty).toBe(false);
  });
});
