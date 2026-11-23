import { describe, expect, it, vi } from 'vitest';
import { StationaryDrawTimer } from './stationaryDrawTimer';

function context() {
  const queries: { ready: boolean; ms: number }[] = [];
  const ext = { TIME_ELAPSED_EXT: 1, GPU_DISJOINT_EXT: 2 };
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 6,
    TIMEOUT_EXPIRED: 7,
    fenceSync: vi.fn(() => ({})),
    clientWaitSync: vi.fn(() => 7),
    deleteSync: vi.fn(),
    CURRENT_QUERY: 3,
    QUERY_RESULT_AVAILABLE: 4,
    QUERY_RESULT: 5,
    getExtension: vi.fn((): typeof ext | null => ext),
    getParameter: vi.fn(() => false),
    getQuery: vi.fn((): object | null => null),
    createQuery: vi.fn(() => {
      const query = { ready: false, ms: 0 };
      queries.push(query);
      return query;
    }),
    getQueryParameter: vi.fn((q: (typeof queries)[number], key: number) => {
      if (key === 4) return q.ready;
      if (!q.ready) throw new Error('blocking GPU read');
      return q.ms * 1e6;
    }),
    beginQuery: vi.fn(),
    endQuery: vi.fn(),
    deleteQuery: vi.fn()
  };
  return {
    gl,
    queries,
    timer: () =>
      new StationaryDrawTimer(gl as unknown as WebGL2RenderingContext)
  };
}

describe('stationary scene GPU measurements', () => {
  it('polls the previous full-size draw without blocking and releases stale fences', () => {
    const { gl, timer } = context();
    const t = timer();
    t.read({});
    expect(t.waitingForFullSize()).toBe(false);
    t.submittedFullSize(10);
    expect(t.waitingForFullSize()).toBe(true);
    expect(gl.clientWaitSync).toHaveBeenCalledWith(expect.anything(), 0, 0);
    gl.clientWaitSync.mockReturnValueOnce(8);
    expect(t.waitingForFullSize()).toBe(false);
    expect(gl.deleteSync).toHaveBeenCalledTimes(1);
    t.submittedFullSize(300);
    expect(t.backlogMs(2400)).toBe(2100);
    t.submittedFullSize(2450);
    expect(gl.fenceSync).toHaveBeenCalledTimes(2);
    gl.clientWaitSync.mockReturnValueOnce(8);
    expect(t.waitingForFullSize()).toBe(false);
    t.submittedFullSize(1500);
    t.submittedFullSize(1600);
    t.reset();
    expect(gl.deleteSync).toHaveBeenCalledTimes(3);
  });

  it('uses the faster of two complete draws from the same model without waiting', () => {
    const { gl, queries, timer } = context();
    const t = timer(),
      model = {},
      draw = vi.fn();
    t.read(model);
    for (let i = 0; i < 5; i++) t.draw(draw);
    expect(draw).toHaveBeenCalledTimes(5);
    expect(gl.beginQuery).toHaveBeenCalledTimes(2);
    Object.assign(queries[0]!, { ready: true, ms: 320 });
    expect(t.read(model)).toBeNull();
    Object.assign(queries[1]!, { ready: true, ms: 140 });
    expect(t.read(model)).toBe(140);
    t.draw(draw);
    expect(gl.beginQuery).toHaveBeenCalledTimes(2);
    expect(t.read({})).toBeNull();
  });

  it('drops pending and completed measurements on disjoint, resize or model change', () => {
    const { gl, queries, timer } = context();
    const t = timer(),
      model = {};
    t.read(model);
    t.draw(() => {});
    t.draw(() => {});
    Object.assign(queries[0]!, { ready: true, ms: 100 });
    expect(t.read(model)).toBeNull();
    gl.getParameter.mockReturnValueOnce(true);
    expect(t.read(model)).toBeNull();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(2);
    t.read(model);
    t.draw(() => {});
    t.reset();
    expect(gl.deleteQuery).toHaveBeenCalledTimes(3);
    t.read(model);
    t.draw(() => {});
    t.read({});
    expect(gl.deleteQuery).toHaveBeenCalledTimes(4);
  });

  it('renders with no extension, no model or an active external timer', () => {
    const { gl, timer } = context();
    const draw = vi.fn(),
      model = {};
    const t = timer();
    t.draw(draw);
    t.read(model);
    gl.getQuery.mockReturnValueOnce({});
    t.draw(draw);
    gl.getExtension.mockReturnValue(null);
    const missing = timer();
    missing.read(model);
    missing.draw(draw);
    expect(draw).toHaveBeenCalledTimes(3);
    expect(gl.createQuery).not.toHaveBeenCalled();
  });

  it('paces cold full-size draws and recognizes a backlog before any result returns', () => {
    const { gl, timer } = context();
    const t = timer(),
      model = {};
    t.read(model);
    t.submittedFullSize(0);
    t.submittedFullSize(20);
    expect(gl.fenceSync).toHaveBeenCalledTimes(1);
    expect(t.backlogMs(30)).toBeNull();
    expect(t.backlogMs(100)).toBe(100);
    gl.clientWaitSync.mockReturnValueOnce(8);
    expect(t.backlogMs(110)).toBeNull();
  });

  it('remeasures zooms across the severe threshold and a projection switch', () => {
    const { queries, timer } = context();
    const t = timer(),
      model = {};
    t.read(model, 100, true);
    t.draw(() => {});
    t.draw(() => {});
    for (const q of queries) Object.assign(q, { ready: true, ms: 200 });
    expect(t.read(model, 100 + 1e-13, true)).toBe(200);
    expect(t.read(model, 120, true)).toBeNull();
    t.draw(() => {});
    t.draw(() => {});
    for (const q of queries) Object.assign(q, { ready: true, ms: 15 });
    expect(t.read(model, 120, true)).toBe(15);
    expect(t.read(model, 120, false)).toBeNull();
  });

  it('ends an open query even if drawing throws', () => {
    const { gl, timer } = context();
    const t = timer();
    t.read({});
    expect(() =>
      t.draw(() => {
        throw new Error('draw failed');
      })
    ).toThrow('draw failed');
    expect(gl.endQuery).toHaveBeenCalledOnce();
    t.reset();
    expect(gl.deleteQuery).toHaveBeenCalledOnce();
  });
});
