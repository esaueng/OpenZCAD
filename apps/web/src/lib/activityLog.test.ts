import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_PERSISTED_ERRORS,
  PERSISTED_ERROR_MAX_AGE_MS,
  persistActivityErrors,
  restoreActivityLog
} from './activityLogPersistence';
import { APP_BUILD_COMMIT } from './crashEnvironment';
import {
  MAX_ACTIVITY_LOG_ENTRIES,
  PERSISTED_ERRORS_KEY,
  clearActivityLog,
  filterActivityLog,
  formatActivityLogJson,
  formatActivityLogText,
  getActivityLogSnapshot,
  installRuntimeErrorCapture,
  recordActivity,
  readStoredErrors,
  recordCaughtError,
  resetActivityLogForTests,
  setActivityErrorSink,
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

  it('keeps a deep component stack, innermost first', () => {
    // The viewer crash this was written for: #185 inside a deep tree, where
    // the looping component sits well past the old eight-line cut.
    const stack = Array.from(
      { length: 20 },
      (_, index) =>
        `    at C${index} (https://zcad.app/assets/index.js:1:${index})`
    ).join('\n');
    recordCaughtError(
      '3D viewer',
      new Error(
        'Minified React error #185; visit https://react.dev/errors/185 for the full message'
      ),
      `\n${stack}\n`
    );
    const detail = getActivityLogSnapshot().entries[0]!.detail!;
    // React's own link names the code; the crash card reads it out.
    expect(detail).toContain('https://react.dev/errors/185');
    expect(detail).toContain('Component stack:\nat C0 (');
    expect(detail).toContain('at C15 (');
    expect(detail).not.toContain('at C16 (');
  });
});

describe('errors kept across reloads', () => {
  /** The kept errors as stored. */
  const keptRecords = () =>
    JSON.parse(localStorage.getItem(PERSISTED_ERRORS_KEY) ?? '[]') as {
      timestamp: number;
      message: string;
    }[];
  const keptMessages = () => keptRecords().map((entry) => entry.message);
  beforeEach(() => {
    resetActivityLogForTests();
    localStorage.removeItem(PERSISTED_ERRORS_KEY);
    persistActivityErrors();
  });
  afterEach(() => {
    setActivityErrorSink(null);
    vi.unstubAllGlobals();
    localStorage.removeItem(PERSISTED_ERRORS_KEY);
  });

  /** A page load: a fresh in-memory log over the same storage. */
  function reload(now = Date.now()) {
    resetActivityLogForTests();
    return restoreActivityLog({
      stored: readStoredErrors(),
      loadedAt: getActivityLogSnapshot().startedAt,
      now,
      environment: []
    });
  }

  it('brings a crash back after a reload, marked and with its build', () => {
    setActivityContext({ workspace: 'Build', project: 'Jazzy Hedgehog' });
    recordActivity({ level: 'ready', source: 'status', message: 'Saved.' });
    recordCaughtError(
      '3D viewer',
      new Error('Minified React error #185'),
      '\n    at SectionPanel (index.js:1:2)\n'
    );
    // Only the error is kept.
    const kept = keptRecords();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      message: '3D viewer crashed: Minified React error #185',
      workspace: 'Build',
      project: 'Jazzy Hedgehog',
      build: APP_BUILD_COMMIT
    });

    expect(reload()).toBe(1);
    const [restored, loaded] = getActivityLogSnapshot().entries;
    expect(restored).toMatchObject({
      level: 'error',
      source: 'error',
      message:
        'Earlier page load: 3D viewer crashed: Minified React error #185',
      workspace: 'Build',
      project: 'Jazzy Hedgehog',
      timestamp: kept[0]!.timestamp
    });
    expect(restored!.detail).toContain('at SectionPanel (index.js:1:2)');
    expect(restored!.detail).toContain(
      `Build ${APP_BUILD_COMMIT.slice(0, 12)}`
    );
    expect(loaded!.message).toMatch(/^Page loaded · /);
    // Still kept: a second reload does not lose it.
    expect(reload()).toBe(1);
  });

  it('heads the log even when this load recorded first', () => {
    recordActivity({ level: 'error', source: 'error', message: 'before' });
    resetActivityLogForTests();
    // Startup reads storage first; then this load raises its own error
    // before the persistence module has loaded.
    const stored = readStoredErrors();
    setActivityErrorSink(null);
    recordActivity({ level: 'ready', source: 'status', message: 'Opening…' });
    recordActivity({ level: 'error', source: 'error', message: 'during' });
    const { startedAt } = getActivityLogSnapshot();
    expect(
      restoreActivityLog({ stored, loadedAt: startedAt, environment: [] })
    ).toBe(1);
    expect(
      getActivityLogSnapshot().entries.map((entry) => entry.message)
    ).toEqual([
      'Earlier page load: before',
      expect.stringMatching(/^Page loaded · /),
      'Opening…',
      'during'
    ]);
    // The error that waited for the module is kept once it arrives.
    expect(keptMessages()).toEqual(['before', 'during']);
  });

  it('keeps the newest ten, and a repeating error only once', () => {
    for (let index = 0; index < MAX_PERSISTED_ERRORS + 3; index += 1) {
      recordActivity({
        level: 'error',
        source: 'error',
        message: `failure ${index}`,
        timestamp: 1_000 + index
      });
    }
    // An error raised every frame for a minute, after the distinct ones:
    // kept once, so it never pushes them out.
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      recordActivity({
        level: 'error',
        source: 'error',
        message: 'every frame',
        timestamp: 2_000 + frame * 16
      });
    }
    expect(keptMessages()).toEqual([
      ...Array.from(
        { length: MAX_PERSISTED_ERRORS - 1 },
        (_, index) => `failure ${index + 4}`
      ),
      'every frame'
    ]);
  });

  it('leaves out week-old and malformed errors, and storage it cannot read', () => {
    const now = Date.UTC(2026, 10, 16);
    localStorage.setItem(
      PERSISTED_ERRORS_KEY,
      JSON.stringify([
        {
          timestamp: now - PERSISTED_ERROR_MAX_AGE_MS - 1,
          message: 'old',
          build: 'abc'
        },
        { timestamp: now - 1_000, message: 'recent', build: 'abc' },
        { timestamp: 'yesterday', message: 'malformed', build: 'abc' },
        { timestamp: now - 500, message: 'no build' }
      ])
    );
    expect(reload(now)).toBe(1);
    expect(getActivityLogSnapshot().entries[0]!.message).toBe(
      'Earlier page load: recent'
    );
    // The next kept error drops the old and malformed ones from storage.
    recordActivity({
      level: 'error',
      source: 'error',
      message: 'new',
      timestamp: now
    });
    expect(keptMessages()).toEqual(['recent', 'new']);

    localStorage.setItem(PERSISTED_ERRORS_KEY, '{not json');
    expect(reload(now)).toBe(0);
    expect(getActivityLogSnapshot().entries).toHaveLength(1);
  });

  it('keeps what this load raises after a Clear, the same error included', () => {
    recordActivity({ level: 'error', source: 'error', message: 'boom' });
    clearActivityLog();
    // Raised again at once: storage no longer has it, so it is kept again.
    recordActivity({ level: 'error', source: 'error', message: 'boom' });
    expect(keptMessages()).toEqual(['boom']);
  });

  it('leaves a Clear made before it loaded cleared', () => {
    recordActivity({ level: 'error', source: 'error', message: 'old' });
    resetActivityLogForTests();
    setActivityErrorSink(null);
    const stored = readStoredErrors();
    const { startedAt } = getActivityLogSnapshot();
    vi.useFakeTimers({ now: startedAt + 1_000 });
    try {
      // The user clears the log while the module is still on its way.
      clearActivityLog();
      recordActivity({ level: 'error', source: 'error', message: 'new' });
      expect(
        restoreActivityLog({ stored, loadedAt: startedAt, environment: [] })
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(
      getActivityLogSnapshot().entries.map((entry) => entry.message)
    ).toEqual(['new']);
    // What came after the Clear is still kept.
    expect(keptMessages()).toEqual(['new']);
  });

  it('forgets kept errors when the log is cleared', () => {
    recordActivity({ level: 'error', source: 'error', message: 'boom' });
    expect(keptMessages()).toEqual(['boom']);
    clearActivityLog();
    expect(localStorage.getItem(PERSISTED_ERRORS_KEY)).toBeNull();
    expect(reload()).toBe(0);
  });

  it('still logs when storage throws', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    // A store whose every call throws, as a full or locked-down one does.
    vi.stubGlobal('localStorage', {
      getItem: blocked,
      setItem: blocked,
      removeItem: blocked
    });
    recordActivity({ level: 'error', source: 'error', message: 'boom' });
    expect(getActivityLogSnapshot().entries[0]!.message).toBe('boom');
    expect(reload()).toBe(0);
    expect(() => clearActivityLog()).not.toThrow();
  });
});

describe('the page-load line', () => {
  beforeEach(() => resetActivityLogForTests());
  afterEach(() => setActivityErrorSink(null));

  it('opens the log with the build and the browser it runs on', () => {
    const { startedAt } = getActivityLogSnapshot();
    restoreActivityLog({
      stored: null,
      loadedAt: startedAt,
      environment: ['Browser Firefox/140', 'Window 1990×1480 @2x']
    });
    const [entry] = getActivityLogSnapshot().entries;
    expect(entry).toMatchObject({
      level: 'ready',
      source: 'status',
      timestamp: startedAt
    });
    expect(entry!.message).toMatch(/^Page loaded · OpenZCAD .+ · Remus /);
    expect(entry!.detail).toBe('Browser Firefox/140\nWindow 1990×1480 @2x');
  });
});
