import { describe, expect, it } from 'vitest';
import { createCloudConfigurationReads } from './cloudConfigurationReads';

describe('deferred cloud readiness reads', () => {
  it('a retry supersedes auth without discarding an independent health read', () => {
    const reads = createCloudConfigurationReads();
    const firstAuth = reads.begin('auth');
    const health = reads.begin('health');
    const retry = reads.begin('auth');
    expect(firstAuth()).toBe(false);
    expect(retry()).toBe(true);
    expect(health()).toBe(true);
  });

  it('mode changes fence both public reads and account startup, including off then on', () => {
    const reads = createCloudConfigurationReads();
    const startup = reads.captureMode();
    const auth = reads.begin('auth');
    const health = reads.begin('health');
    reads.changeMode();
    reads.changeMode();
    expect([startup(), auth(), health()]).toEqual([false, false, false]);
    expect(reads.begin('auth')()).toBe(true);
    expect(reads.begin('health')()).toBe(true);
  });
});
