import { afterEach, describe, expect, it } from 'vitest';
import { ASK_TOP_MARGIN, latestScrollTop } from './threadScroll';

/** A thread of the given size whose last ask starts `askTop` px down. */
function thread(
  size: { scrollHeight: number; clientHeight: number; scrollTop: number },
  askTop: number | null
) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'scrollHeight', { value: size.scrollHeight });
  Object.defineProperty(element, 'clientHeight', { value: size.clientHeight });
  element.scrollTop = size.scrollTop;
  element.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  if (askTop !== null) {
    const ask = document.createElement('article');
    ask.className = 'assistant-turn user';
    // On screen, relative to the thread's own top edge.
    ask.getBoundingClientRect = () =>
      ({ top: 100 + askTop - size.scrollTop }) as DOMRect;
    element.append(ask);
  }
  document.body.append(element);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('latestScrollTop', () => {
  it('follows to the foot when the reply fits under the ask', () => {
    // Foot at 600; the ask starts at 700, so the foot shows it whole.
    expect(
      latestScrollTop(
        thread({ scrollHeight: 1000, clientHeight: 400, scrollTop: 0 }, 700)
      )
    ).toBe(600);
  });

  it('stops with the ask at the top when the reply is taller than the thread', () => {
    // Foot at 1600 would leave the ask at 900 above the view.
    expect(
      latestScrollTop(
        thread({ scrollHeight: 2000, clientHeight: 400, scrollTop: 300 }, 900)
      )
    ).toBe(900 - ASK_TOP_MARGIN);
  });

  it('follows to the foot of a thread with no ask', () => {
    expect(
      latestScrollTop(
        thread({ scrollHeight: 800, clientHeight: 300, scrollTop: 0 }, null)
      )
    ).toBe(500);
  });
});
