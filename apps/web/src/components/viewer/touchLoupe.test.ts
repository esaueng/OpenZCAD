import { afterEach, describe, expect, it } from 'vitest';
import { LOUPE_SIZE_PX, loupePlacement, TouchLoupe } from './touchLoupe';

describe('loupePlacement', () => {
  it('sits centred above the finger with room to spare', () => {
    expect(loupePlacement(400, 300, 1000, 800)).toEqual({
      left: 400 - LOUPE_SIZE_PX / 2,
      top: 300 - 36 - LOUPE_SIZE_PX
    });
  });

  it('drops below the finger near the top and stays inside the host', () => {
    const top = loupePlacement(20, 40, 1000, 800);
    expect(top.top).toBe(40 + 36);
    expect(top.left).toBe(0);
    const corner = loupePlacement(995, 790, 1000, 800);
    expect(corner.left).toBe(1000 - LOUPE_SIZE_PX);
    expect(corner.top).toBe(790 - 36 - LOUPE_SIZE_PX);
    // A host shorter than the loupe pins it to the top.
    expect(loupePlacement(50, 30, 100, 60).top).toBe(0);
  });
});

describe('TouchLoupe', () => {
  let host: HTMLElement;
  afterEach(() => host?.remove());

  it('follows a finger in host coordinates and hides on release', () => {
    host = document.createElement('div');
    host.getBoundingClientRect = () =>
      ({ left: 100, top: 50, width: 800, height: 600 }) as DOMRect;
    document.body.append(host);
    const loupe = new TouchLoupe(host);
    expect(loupe.visible).toBe(false);
    // No second canvas in the viewer while nothing is magnified.
    expect(host.contains(loupe.element)).toBe(false);
    loupe.follow(500, 450);
    expect(host.contains(loupe.element)).toBe(true);
    expect(loupe.visible).toBe(true);
    expect(loupe.element.hidden).toBe(false);
    expect(loupe.element.style.left).toBe(`${400 - LOUPE_SIZE_PX / 2}px`);
    expect(loupe.element.style.top).toBe(`${400 - 36 - LOUPE_SIZE_PX}px`);
    loupe.hide();
    expect(loupe.visible).toBe(false);
    expect(host.contains(loupe.element)).toBe(false);
    // Capturing while hidden touches nothing.
    loupe.capture(document.createElement('canvas'), 'Endpoint');
    expect(loupe.element.dataset.snapped).toBeUndefined();
    loupe.dispose();
    expect(host.contains(loupe.element)).toBe(false);
  });
});
