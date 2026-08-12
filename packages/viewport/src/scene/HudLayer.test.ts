import { describe, expect, it } from 'vitest';
import { HudLayer } from './HudLayer';

/**
 * A DOM stand-in: these tests run in the node environment alongside the rest
 * of the package, and the layer only needs create/append/remove plus a rect.
 */
function makeHost(rect = { left: 40, top: 10, width: 800, height: 600 }) {
  const children: FakeElement[] = [];
  interface FakeElement {
    className: string;
    hidden: boolean;
    style: Record<string, string>;
    attributes: Record<string, string>;
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    getBoundingClientRect(): {
      left: number;
      top: number;
      width: number;
      height: number;
    };
    remove(): void;
  }
  const host = {
    getBoundingClientRect: () => rect,
    appendChild: (child: FakeElement) => children.push(child),
    children
  };
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (): FakeElement => {
      const element: FakeElement = {
        className: '',
        hidden: false,
        style: {},
        attributes: {},
        setAttribute(name, value) {
          element.attributes[name] = value;
        },
        getAttribute(name) {
          return element.attributes[name] ?? null;
        },
        getBoundingClientRect() {
          return { left: 0, top: 0, width: 160, height: 120 };
        },
        remove() {
          const index = children.indexOf(element);
          if (index >= 0) {
            children.splice(index, 1);
          }
        }
      };
      return element;
    }
  } as unknown as Document;
  const restore = () => {
    globalThis.document = originalDocument;
  };
  return { host: host as unknown as HTMLElement, children, restore };
}

describe('creating overlays', () => {
  it('creates them hidden and attached, so nothing flashes on mount', () => {
    const { host, children, restore } = makeHost();
    const layer = new HudLayer(host);

    const chip = layer.create('handle-value-chip');
    expect(chip.className).toBe('handle-value-chip');
    expect(chip.getAttribute('data-viewport-hud')).toBe('');
    expect(chip.hidden).toBe(true);
    expect(children).toHaveLength(1);
    restore();
  });

  it('hides decorative overlays from assistive technology on request', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);

    const marker = layer.create('sketch-snap-marker', { ariaHidden: true });
    expect(marker.getAttribute('aria-hidden')).toBe('true');
    expect(layer.create('drag-hud').getAttribute('aria-hidden')).toBeNull();
    restore();
  });

  it('removes everything it created on dispose', () => {
    const { host, children, restore } = makeHost();
    const layer = new HudLayer(host);
    layer.create('a');
    layer.create('b');
    expect(children).toHaveLength(2);

    layer.dispose();
    expect(children).toHaveLength(0);
    // Disposing twice must not throw or double-remove.
    layer.dispose();
    expect(children).toHaveLength(0);
    restore();
  });
});

describe('positioning against the host', () => {
  it('converts a client point into host-local pixels', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);
    expect(layer.toLocal(140, 110)).toEqual({ x: 100, y: 100 });
    restore();
  });

  it('offsets an overlay clear of the cursor and reveals it', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);
    const label = layer.create('sketch-dim-label');

    expect(layer.showAtPointer(label, { clientX: 140, clientY: 110 }, 16, -28)).toBe(true);
    expect(label.style.left).toBe('116px');
    expect(label.style.top).toBe('72px');
    expect(label.hidden).toBe(false);
    restore();
  });

  it('leaves the overlay hidden when the host cannot be measured', () => {
    // A detached or display:none host reports a zero rect; positioning then
    // would park the overlay at the corner instead of leaving it invisible.
    const { host, restore } = makeHost({ left: 0, top: 0, width: 0, height: 0 });
    const layer = new HudLayer(host);
    const label = layer.create('sketch-dim-label');

    expect(layer.showAtPointer(label, { clientX: 10, clientY: 10 })).toBe(false);
    expect(label.hidden).toBe(true);
    restore();
  });

  it('keeps an interactive popup inside the host at its lower-right edge', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);
    const popup = layer.create('topology-pick-list');

    expect(
      layer.showAtPointerClamped(
        popup,
        { clientX: 830, clientY: 590 },
        12,
        12
      )
    ).toBe(true);
    expect(popup.style.left).toBe('632px');
    expect(popup.style.top).toBe('472px');
    expect(popup.hidden).toBe(false);
    restore();
  });

  it('places an overlay at host pixels directly for world-anchored chips', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);
    const chip = layer.create('handle-value-chip');

    layer.showAt(chip, 12.5, 40);
    expect(chip.style.left).toBe('12.5px');
    expect(chip.hidden).toBe(false);

    layer.hide(chip);
    expect(chip.hidden).toBe(true);
    restore();
  });

  it('tolerates hiding nothing', () => {
    const { host, restore } = makeHost();
    const layer = new HudLayer(host);
    expect(() => layer.hide(null)).not.toThrow();
    restore();
  });
});
