import { describe, expect, it, vi } from 'vitest';
import { DeferredExactEntry } from './deferredExactEntry';

function setup() {
  let owner = 'extrude:first';
  let ready = false;
  let enabled = true;
  const scheduled = new Set<() => void>();
  const seed = vi.fn();
  const open = vi.fn(() => ready);
  const queue = new DeferredExactEntry<string>({
    isCurrent: (candidate) => enabled && candidate === owner,
    sameOwner: (left, right) => left === right,
    open,
    seed,
    schedule: (retry) => {
      scheduled.add(retry);
      return () => {
        scheduled.delete(retry);
      };
    }
  });
  return {
    queue,
    seed,
    open,
    changeOwner: (next: string) => {
      owner = next;
    },
    ready: () => {
      ready = true;
    },
    disable: () => {
      enabled = false;
    },
    frame: () => {
      const next = [...scheduled];
      scheduled.clear();
      for (const retry of next) retry();
    },
    pendingFrames: () => scheduled.size
  };
}

describe('deferred exact entry', () => {
  it('retains all signed digits until the current rig accepts entry', () => {
    const h = setup();
    h.queue.push('extrude:first', '-');
    h.frame();
    h.queue.push('extrude:first', '1');
    h.queue.push('extrude:first', '0');
    expect(h.seed).not.toHaveBeenCalled();
    expect(h.pendingFrames()).toBe(1);
    h.ready();
    h.frame();
    expect(h.seed).toHaveBeenCalledExactlyOnceWith('-10');
    expect(h.pendingFrames()).toBe(0);
    h.frame();
    expect(h.seed).toHaveBeenCalledTimes(1);
  });

  it('drops a queued value if its command, selection or document changes', () => {
    const h = setup();
    h.queue.push('extrude:first', '3');
    h.changeOwner('fillet:second');
    h.ready();
    h.frame();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.seed).not.toHaveBeenCalled();
    expect(h.pendingFrames()).toBe(0);
  });

  it('cancels without leaving a callback that can open a stray keypad', () => {
    const h = setup();
    h.queue.push('extrude:first', '.');
    h.queue.cancel();
    h.ready();
    h.frame();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.seed).not.toHaveBeenCalled();
  });

  it('drops deferred input when a modal or locked workspace takes keyboard ownership', () => {
    const h = setup();
    h.queue.push('extrude:first', '2');
    h.disable();
    h.ready();
    h.frame();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.seed).not.toHaveBeenCalled();
    expect(h.pendingFrames()).toBe(0);
  });

  it('does not carry text into a replacement command and keeps Enter prefills', () => {
    const h = setup();
    h.queue.push('extrude:first', '3');
    h.changeOwner('fillet:second');
    h.queue.push('fillet:second');
    h.ready();
    h.frame();
    expect(h.open).toHaveBeenCalledTimes(3);
    expect(h.seed).not.toHaveBeenCalled();
  });
});
