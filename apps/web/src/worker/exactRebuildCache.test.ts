import { describe, expect, it, vi } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import {
  ExactRebuildCache,
  LatestBroadcastGate,
  canonicalProjectContentKey,
  geometryContentKey,
  rebindSketchGeometryForContent
} from './exactRebuildCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('canonical exact rebuild keys', () => {
  it('ignores derived output and object insertion order', () => {
    const document = createProjectDocument('Cache key', toUserId('user'));
    const reordered = {
      ...Object.fromEntries(Object.entries(document).reverse()),
      derived: {
        ...document.derived,
        warnings: ['stale projection'],
        updatedAt: '2099-01-01T00:00:00.000Z'
      }
    } as typeof document;

    expect(canonicalProjectContentKey(reordered)).toBe(
      canonicalProjectContentKey(document)
    );
    expect(
      canonicalProjectContentKey({ ...document, name: 'Changed content' })
    ).not.toBe(canonicalProjectContentKey(document));
  });

  it('keys undo/redo restorations identically to the state they restore', () => {
    // Undo/redo advance `version` and append revisions while restoring the
    // modeling content itself, so the key must ignore that bookkeeping — it
    // is the main scenario the rebuild cache exists for.
    const manager = new CommandManager(
      createProjectDocument('Undo cache key', toUserId('user'))
    );
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Base Block',
        primitiveKind: 'box',
        dimensions: { width: 40, height: 20, depth: 8 }
      })
    );
    const afterFirst = canonicalProjectContentKey(manager.document);
    manager.execute(
      commandFactories.addPrimitive({
        name: 'Boss',
        primitiveKind: 'cylinder',
        dimensions: { radius: 5, height: 12 }
      })
    );
    const afterSecond = canonicalProjectContentKey(manager.document);
    expect(afterSecond).not.toBe(afterFirst);

    const versionBeforeUndo = manager.document.version;
    manager.undo();
    expect(manager.document.version).not.toBe(versionBeforeUndo);
    expect(canonicalProjectContentKey(manager.document)).toBe(afterFirst);

    manager.redo();
    expect(canonicalProjectContentKey(manager.document)).toBe(afterSecond);
  });
});

describe('bounded exact rebuild cache', () => {
  it('executes identical concurrent requests once and clones every result', async () => {
    const pending = deferred<{ values: number[] }>();
    const load = vi.fn(() => pending.promise);
    const cache = new ExactRebuildCache<{ values: number[] }>({
      maxEntries: 2,
      maxBytes: 1024,
      maxInFlight: 2
    });

    const left = cache.get('same', load);
    const right = cache.get('same', load);
    expect(load).toHaveBeenCalledOnce();
    expect(cache.inFlightCount).toBe(1);
    pending.resolve({ values: [1] });

    const [leftResult, rightResult] = await Promise.all([left, right]);
    leftResult.values.push(2);
    expect(rightResult.values).toEqual([1]);
    const cached = await cache.get('same', load);
    expect(cached.values).toEqual([1]);
    expect(cached).not.toBe(rightResult);
    expect(load).toHaveBeenCalledOnce();
  });

  it('evicts least-recently-used results within entry and byte limits', async () => {
    const loads = new Map<string, number>();
    const cache = new ExactRebuildCache<{ value: string }>({
      maxEntries: 2,
      maxBytes: 80,
      maxInFlight: 1,
      sizeOf: () => 20
    });
    const get = (key: string) =>
      cache.get(key, async () => {
        loads.set(key, (loads.get(key) ?? 0) + 1);
        return { value: key };
      });

    await get('a');
    await get('b');
    await get('a');
    await get('c');
    expect(cache.entryCount).toBe(2);
    expect(cache.bytes).toBeLessThanOrEqual(80);
    await get('b');
    expect(loads.get('a')).toBe(1);
    expect(loads.get('b')).toBe(2);
  });

  it('bounds in-flight work and rejects callers on termination', async () => {
    const first = deferred<number>();
    const overflowLoad = vi.fn(async () => 2);
    const cache = new ExactRebuildCache<number>({
      maxEntries: 1,
      maxBytes: 64,
      maxInFlight: 1
    });
    const left = cache.get('left', () => first.promise);
    expect(cache.inFlightCount).toBe(1);
    await expect(cache.get('right', overflowLoad)).rejects.toThrow(
      'in-flight limit'
    );
    expect(overflowLoad).not.toHaveBeenCalled();

    cache.terminate(new Error('Worker closed.'));
    await expect(left).rejects.toThrow('Worker closed');
    await expect(cache.get('later', async () => 3)).rejects.toThrow(
      'Worker closed'
    );
    first.resolve(1);
  });

  it('hands back but never retains a result its owner marks uncacheable', async () => {
    const transient = new WeakSet<object>();
    const cache = new ExactRebuildCache<{ bodies: number }>({
      maxEntries: 2,
      maxBytes: 1024,
      maxInFlight: 1,
      cacheable: (value) => !transient.has(value)
    });
    let fontLoaded = false;
    const load = vi.fn(async () => {
      // Text built before its face arrived: same content key, no body.
      const result = { bodies: fontLoaded ? 1 : 0 };
      if (!fontLoaded) transient.add(result);
      return result;
    });

    await expect(cache.get('text', load)).resolves.toEqual({ bodies: 0 });
    expect(cache.entryCount).toBe(0);
    fontLoaded = true;
    await expect(cache.get('text', load)).resolves.toEqual({ bodies: 1 });
    await expect(cache.get('text', load)).resolves.toEqual({ bodies: 1 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('newest broadcast publication', () => {
  it('suppresses a running result after a newer broadcast is issued', () => {
    const gate = new LatestBroadcastGate();
    const running = gate.issue(true);
    expect(gate.isCurrent(running)).toBe(true);
    const newest = gate.issue(true);
    expect(gate.isCurrent(running)).toBe(false);
    expect(gate.isCurrent(newest)).toBe(true);
    expect(gate.isCurrent(gate.issue(false))).toBe(true);
  });
});

describe('content-proven cached sketch geometry', () => {
  it('requalifies a cached solve across bookkeeping versions without changing its stored proof', async () => {
    const document = createProjectDocument('Cached solve', toUserId('user'));
    const derived: ProjectDocument['derived'] = {
      ...document.derived,
      sketchGeometry: {
        projectId: document.projectId,
        documentVersion: document.version,
        objects: {
          ent_line: { objectKind: 'line', x1: 0, y1: 0, x2: 32, y2: 0 }
        }
      }
    };
    const key = geometryContentKey(document);
    const cache = new ExactRebuildCache<ProjectDocument['derived']>({
      maxEntries: 2,
      maxBytes: 100000,
      maxInFlight: 2
    });
    const load = vi.fn(async () => derived);
    await cache.get(key, load);
    const target = {
      ...document,
      version: document.version + 8,
      drawings: { sheets: [] },
      referenceImages: { images: [] }
    };
    expect(geometryContentKey(target)).toBe(key);
    const cached = await cache.get(geometryContentKey(target), load);
    const rebound = rebindSketchGeometryForContent(target, cached, key);
    expect(rebound.sketchGeometry?.documentVersion).toBe(target.version);
    expect(rebound.sketchGeometry?.objects).toEqual(
      derived.sketchGeometry?.objects
    );
    expect(structuredClone(rebound).sketchGeometry).toBeDefined();
    expect(cached.sketchGeometry?.documentVersion).toBe(document.version);
    expect((await cache.get(key, load)).sketchGeometry?.documentVersion).toBe(
      document.version
    );
    expect(load).toHaveBeenCalledOnce();
  });
  it('drops overlays when the cached source key or project does not prove the target geometry', () => {
    const document = createProjectDocument('Cached solve', toUserId('user'));
    const derived: ProjectDocument['derived'] = {
      ...document.derived,
      sketchGeometry: {
        projectId: document.projectId,
        documentVersion: document.version,
        objects: {}
      }
    };
    const key = geometryContentKey(document);
    const changed = {
      ...document,
      version: document.version + 1,
      units: 'cm' as const
    };
    expect(
      rebindSketchGeometryForContent(changed, derived, key).sketchGeometry
    ).toBeUndefined();
    const foreign = {
      ...document,
      projectId: `${document.projectId}_foreign` as typeof document.projectId
    };
    expect(
      rebindSketchGeometryForContent(
        foreign,
        derived,
        geometryContentKey(foreign)
      ).sketchGeometry
    ).toBeUndefined();
    expect(derived.sketchGeometry?.documentVersion).toBe(document.version);
  });
});
