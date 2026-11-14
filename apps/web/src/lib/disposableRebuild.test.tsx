import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { rebuildInDisposableWorker } from './disposableRebuild';
import {
  OFFLINE_CHUNK_MESSAGE,
  onStaleChunk,
  STALE_CHUNK_MESSAGE
} from './staleChunk';
import {
  useValidatedFeatureCommit,
  type ValidatedFeatureOutcome
} from '../hooks/useValidatedFeatureCommit';

const GONE = () =>
  Promise.reject(
    new Error(
      'Failed to fetch dynamically imported module: https://zcad.example/gone.js'
    )
  );

const document = () =>
  createProjectDocument('Rebuild', toUserId('user_rebuild'));

afterEach(() => vi.unstubAllGlobals());

describe('the disposable rebuild client, loaded on demand', () => {
  it('turns a chunk that did not load into the app’s own refusal', async () => {
    const reported = vi.fn();
    const stop = onStaleChunk(reported);
    try {
      await expect(
        rebuildInDisposableWorker(
          document(),
          new AbortController().signal,
          GONE
        )
      ).rejects.toThrow(STALE_CHUNK_MESSAGE);
      expect(reported).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it('says so when it is offline', async () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    await expect(
      rebuildInDisposableWorker(document(), new AbortController().signal, GONE)
    ).rejects.toThrow(OFFLINE_CHUNK_MESSAGE);
  });

  it('passes any other failure and a loaded client through', async () => {
    const other = new Error('boom');
    await expect(
      rebuildInDisposableWorker(document(), new AbortController().signal, () =>
        Promise.reject(other)
      )
    ).rejects.toBe(other);
    const derived = document().derived;
    const rebuild = vi.fn(async () => derived);
    await expect(
      rebuildInDisposableWorker(document(), new AbortController().signal, () =>
        Promise.resolve({ rebuildImportInDisposableWorker: rebuild })
      )
    ).resolves.toBe(derived);
    expect(rebuild).toHaveBeenCalledOnce();
  });

  it('is refused like any rebuild when a pattern Done cannot load it', async () => {
    // Review of #1501: a rejected import must reach the card as a refusal,
    // never as an unhandled error, and commit nothing.
    const manager = new CommandManager(document());
    const commit = vi.fn(() => true);
    const onFailure = vi.fn();
    const { result } = renderHook(() =>
      useValidatedFeatureCommit({
        manager: () => manager,
        derive: vi.fn(async (candidate: ProjectDocument) => candidate.derived),
        deriveCancellable: (candidate, signal) =>
          rebuildInDisposableWorker(candidate, signal, GONE),
        commit,
        commitTransaction: () => true,
        onBusy: vi.fn(),
        onStatus: vi.fn(),
        onFailure
      })
    );
    const command = commandFactories.addPrimitive({
      name: 'Grid pattern',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 10, depth: 10 }
    });
    let outcome: ValidatedFeatureOutcome | undefined;
    await act(async () => {
      outcome = await result.current.run(command, {
        featureName: 'Grid pattern',
        resultBodyId: command.payload.ids!.bodyId,
        successMessage: command.label,
        signal: new AbortController().signal
      });
    });
    expect(outcome).toBe('rejected');
    expect(onFailure).toHaveBeenLastCalledWith(STALE_CHUNK_MESSAGE);
    expect(commit).not.toHaveBeenCalled();
    expect(listFeaturesInOrder(manager.document)).toHaveLength(0);
  });
});
