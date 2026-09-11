import { describe, expect, it, vi } from 'vitest';
import { fetchBuildCommit, watchBuildVersion } from './buildVersionWatch';

function manualSchedule() {
  let tick: (() => void) | null = null;
  const stop = vi.fn();
  return {
    schedule: (next: () => void) => {
      tick = next;
      return stop;
    },
    fire: () => tick?.(),
    stop
  };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('build version watch', () => {
  it('reads the commit from build-meta.json and treats a missing file as unknown', async () => {
    const ok = vi.fn(async () => ({
      ok: true,
      json: async () => ({ commit: 'abc123' })
    }));
    expect(await fetchBuildCommit(ok as unknown as typeof fetch)).toBe(
      'abc123'
    );
    const missing = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    expect(await fetchBuildCommit(missing as unknown as typeof fetch)).toBe(
      null
    );
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await fetchBuildCommit(offline as unknown as typeof fetch)).toBe(
      null
    );
  });

  it('notifies once when a later read names a different commit', async () => {
    const commits = ['one', 'one', 'two', 'three'];
    const fetchMeta = vi.fn(async () => commits.shift() ?? 'three');
    const onNewVersion = vi.fn();
    const clock = manualSchedule();
    const stop = watchBuildVersion({
      onNewVersion,
      fetchMeta,
      schedule: clock.schedule
    });
    await settle();
    expect(onNewVersion).not.toHaveBeenCalled();
    clock.fire();
    await settle();
    expect(onNewVersion).not.toHaveBeenCalled();
    clock.fire();
    await settle();
    expect(onNewVersion).toHaveBeenCalledWith('two');
    clock.fire();
    await settle();
    expect(onNewVersion).toHaveBeenCalledTimes(1);
    stop();
    expect(clock.stop).toHaveBeenCalled();
  });

  it('stays silent where there is no metadata, as on a dev server', async () => {
    const fetchMeta = vi.fn(async () => null);
    const onNewVersion = vi.fn();
    const clock = manualSchedule();
    watchBuildVersion({ onNewVersion, fetchMeta, schedule: clock.schedule });
    await settle();
    clock.fire();
    await settle();
    expect(onNewVersion).not.toHaveBeenCalled();
  });
});
