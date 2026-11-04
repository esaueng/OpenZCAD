import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ACTIVITY_LOG_ENTRIES,
  clearActivityLog,
  filterActivityLog,
  formatActivityLogJson,
  formatActivityLogText,
  getActivityLogSnapshot,
  installRuntimeErrorCapture,
  recordActivity,
  recordCaughtError,
  resetActivityLogForTests,
  setActivityContext,
  subscribeActivityLog
} from './activityLog';

describe('activity log store', () => {
  beforeEach(() => resetActivityLogForTests());

  it('stamps each entry with where it happened', () => {
    setActivityContext({ workspace: 'Build', project: 'Bracket' });
    recordActivity({ level: 'ready', source: 'status', message: 'Added box.' });
    setActivityContext({ workspace: 'Projects' });
    recordActivity({ level: 'ready', source: 'notice', message: 'Imported.' });

    const [first, second] = getActivityLogSnapshot().entries;
    expect(first).toMatchObject({
      id: 0,
      workspace: 'Build',
      project: 'Bracket'
    });
    expect(second).toMatchObject({ id: 1, workspace: 'Projects' });
    expect(second).not.toHaveProperty('project');
  });

  it('stays bounded and counts what it dropped', () => {
    for (let index = 0; index < MAX_ACTIVITY_LOG_ENTRIES + 5; index += 1) {
      recordActivity({
        level: 'ready',
        source: 'status',
        message: `#${index}`
      });
    }
    const { entries, dropped } = getActivityLogSnapshot();
    expect(entries).toHaveLength(MAX_ACTIVITY_LOG_ENTRIES);
    expect(dropped).toBe(5);
    expect(entries[0]?.message).toBe('#5');
  });

  it('notifies subscribers with a new snapshot, and clears', () => {
    let calls = 0;
    const unsubscribe = subscribeActivityLog(() => {
      calls += 1;
    });
    const before = getActivityLogSnapshot();
    recordActivity({ level: 'ready', source: 'status', message: 'One' });
    expect(getActivityLogSnapshot()).not.toBe(before);
    clearActivityLog();
    unsubscribe();
    recordActivity({ level: 'ready', source: 'status', message: 'Two' });
    expect(calls).toBe(2);
    expect(getActivityLogSnapshot().entries).toHaveLength(1);
  });
});

describe('filterActivityLog', () => {
  const entries = [
    {
      id: 0,
      timestamp: 0,
      level: 'ready',
      source: 'status',
      message: 'Added box.'
    },
    {
      id: 1,
      timestamp: 1,
      level: 'warning',
      source: 'status',
      message: 'Fillet failed.',
      detail: 'kept_face_16_is_not_cylinder_surface'
    },
    {
      id: 2,
      timestamp: 2,
      level: 'error',
      source: 'error',
      message: 'TypeError'
    },
    {
      id: 3,
      timestamp: 3,
      level: 'running',
      source: 'geometry',
      message: 'Rebuilding the model…',
      workspace: 'Tweak'
    }
  ] as const;

  it('keeps everything with no filter', () => {
    expect(filterActivityLog(entries, {})).toHaveLength(4);
  });

  it('matches text in the message, the detail and the workspace', () => {
    expect(
      filterActivityLog(entries, { query: 'CYLINDER' }).map((e) => e.id)
    ).toEqual([1]);
    expect(
      filterActivityLog(entries, { query: 'tweak' }).map((e) => e.id)
    ).toEqual([3]);
  });

  it('narrows by level and source together', () => {
    expect(
      filterActivityLog(entries, {
        levels: new Set(['warning', 'error'] as const),
        sources: new Set(['status'] as const)
      }).map((e) => e.id)
    ).toEqual([1]);
  });
});

describe('formatting', () => {
  const entries = [
    {
      id: 0,
      timestamp: Date.UTC(2026, 10, 3, 16, 42, 15, 120),
      level: 'warning',
      source: 'status',
      message: 'Edit not applied.',
      detail: 'line one\nline two',
      workspace: 'Build',
      project: 'Bouncy Hedgehog'
    }
  ] as const;

  it('writes text with ISO times and indented detail', () => {
    expect(formatActivityLogText(entries)).toBe(
      '2026-11-03T16:42:15.120Z WARNING [Status] (Bouncy Hedgehog · Build) Edit not applied.\n    line one\n    line two'
    );
  });

  it('writes JSON with an ISO time beside the epoch stamp', () => {
    expect(JSON.parse(formatActivityLogJson(entries))).toEqual([
      { ...entries[0], time: '2026-11-03T16:42:15.120Z' }
    ]);
  });
});

describe('installRuntimeErrorCapture', () => {
  let uninstall: (() => void) | null = null;
  const target = new EventTarget();
  beforeEach(() => {
    resetActivityLogForTests();
    uninstall = installRuntimeErrorCapture(target);
  });
  afterEach(() => uninstall?.());

  it('records uncaught errors with where they were thrown', () => {
    const error = new Error('boom');
    target.dispatchEvent(
      new ErrorEvent('error', {
        message: 'Uncaught Error: boom',
        filename: 'https://zcad.app/assets/index.js',
        lineno: 12,
        colno: 7,
        error
      })
    );
    const [entry] = getActivityLogSnapshot().entries;
    expect(entry).toMatchObject({
      level: 'error',
      source: 'error',
      message: 'Uncaught Error: boom'
    });
    expect(entry?.detail).toContain('https://zcad.app/assets/index.js:12:7');
  });

  it('records unhandled rejections and skips ResizeObserver noise', () => {
    target.dispatchEvent(
      new ErrorEvent('error', {
        message: 'ResizeObserver loop completed with undelivered notifications.'
      })
    );
    const rejection = new Event('unhandledrejection') as Event & {
      reason: unknown;
    };
    rejection.reason = new Error('network down');
    target.dispatchEvent(rejection);
    expect(
      getActivityLogSnapshot().entries.map((entry) => entry.message)
    ).toEqual(['Unhandled rejection: network down']);
  });
});

describe('recordCaughtError', () => {
  beforeEach(() => resetActivityLogForTests());

  it('records a boundary-caught crash with its stack and component path', () => {
    const error = new TypeError('Cannot read properties of undefined');
    recordCaughtError(
      '3D viewer',
      error,
      '\n    at Viewport (viewer.js:1:1)\n    at ViewerShell (viewer.js:2:2)\n'
    );
    const [entry] = getActivityLogSnapshot().entries;
    expect(entry).toMatchObject({
      level: 'error',
      source: 'error',
      message: '3D viewer crashed: Cannot read properties of undefined'
    });
    expect(entry!.detail).toContain('TypeError');
    expect(entry!.detail).toContain('at Viewport (viewer.js:1:1)');
    expect(entry!.detail).toContain('at ViewerShell (viewer.js:2:2)');
  });

  it('keeps a crash thrown as a bare value', () => {
    recordCaughtError('Inspector', 'not an error');
    expect(getActivityLogSnapshot().entries[0]).toMatchObject({
      message: 'Inspector crashed: not an error'
    });
  });
});
