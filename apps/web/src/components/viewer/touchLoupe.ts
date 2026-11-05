/**
 * The magnifier a finger sketches with (L02 slice 5,
 * docs/plans/ipad-touch-plan-2026-11-05.md).
 *
 * A fingertip hides the point it is placing, and the snap marker under it.
 * While a finger draws or moves sketch geometry, a round loupe above it shows
 * the canvas under the finger at twice the size with a crosshair on the exact
 * point, and names the snap that point has taken. It copies from the WebGL
 * canvas straight after each render (`capture`), while the frame is still
 * the drawing buffer's, so it costs no extra render and needs no
 * `preserveDrawingBuffer`.
 */

/** Drawn diameter of the loupe, in CSS pixels. */
export const LOUPE_SIZE_PX = 112;
/** Canvas pixels the loupe magnifies by. */
export const LOUPE_ZOOM = 2;
/** Gap between the finger's point and the loupe's nearer edge. */
const LOUPE_GAP_PX = 36;

export interface LoupePlacement {
  /** Top-left of the loupe, host-relative CSS pixels. */
  left: number;
  top: number;
}

/**
 * Where the loupe sits for a finger at host point (x, y): centred above it,
 * or below when there is no room above, and always inside the host.
 */
export function loupePlacement(
  x: number,
  y: number,
  hostWidth: number,
  hostHeight: number
): LoupePlacement {
  const size = LOUPE_SIZE_PX;
  const left = Math.min(
    Math.max(x - size / 2, 0),
    Math.max(hostWidth - size, 0)
  );
  const above = y - LOUPE_GAP_PX - size;
  const top =
    above >= 0
      ? above
      : Math.min(y + LOUPE_GAP_PX, Math.max(hostHeight - size, 0));
  return { left, top };
}

export class TouchLoupe {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly label: HTMLSpanElement;
  /** The finger's point, host-relative CSS pixels; null while hidden. */
  private point: { x: number; y: number } | null = null;

  constructor(private readonly host: HTMLElement) {
    const doc = host.ownerDocument;
    this.element = doc.createElement('div');
    this.element.className = 'touch-loupe';
    this.element.hidden = true;
    this.element.setAttribute('aria-hidden', 'true');
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'touch-loupe-view';
    this.label = doc.createElement('span');
    this.label.className = 'touch-loupe-label';
    this.element.append(this.canvas, this.label);
    // Attached only while shown: the viewer's own canvas stays the only one
    // in the host the rest of the time, which selectors and specs rely on.
  }

  get visible(): boolean {
    return this.point !== null;
  }

  /** Follows a finger at client coordinates. */
  follow(clientX: number, clientY: number) {
    const rect = this.host.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    this.point = { x, y };
    const place = loupePlacement(x, y, rect.width, rect.height);
    this.element.style.left = `${place.left}px`;
    this.element.style.top = `${place.top}px`;
    this.element.hidden = false;
    if (!this.element.isConnected) this.host.append(this.element);
  }

  hide() {
    this.point = null;
    this.element.hidden = true;
    this.element.remove();
  }

  /**
   * Copies the region under the finger from the just-rendered `source`
   * (which must fill the host) and names the active snap, if any.
   */
  capture(source: HTMLCanvasElement, snapLabel: string | null) {
    const point = this.point;
    if (!point) return;
    const ratio =
      source.clientWidth > 0 ? source.width / source.clientWidth : 1;
    const device = Math.max(1, Math.round(LOUPE_SIZE_PX * ratio));
    if (this.canvas.width !== device) {
      this.canvas.width = device;
      this.canvas.height = device;
    }
    const context = this.canvas.getContext('2d');
    if (!context) return;
    // The source square, in the WebGL canvas's device pixels.
    const span = (LOUPE_SIZE_PX / LOUPE_ZOOM) * ratio;
    context.clearRect(0, 0, device, device);
    context.drawImage(
      source,
      point.x * ratio - span / 2,
      point.y * ratio - span / 2,
      span,
      span,
      0,
      0,
      device,
      device
    );
    const mid = device / 2;
    const arm = 8 * ratio;
    context.lineWidth = Math.max(1, ratio);
    // The theme's own colours: the accent for a taken snap, text otherwise.
    const style = getComputedStyle(this.element);
    context.strokeStyle =
      (snapLabel
        ? style.getPropertyValue('--color-accent')
        : style.getPropertyValue('--color-text')
      ).trim() || style.color;
    context.beginPath();
    context.moveTo(mid - arm, mid);
    context.lineTo(mid + arm, mid);
    context.moveTo(mid, mid - arm);
    context.lineTo(mid, mid + arm);
    context.stroke();
    this.element.dataset.snapped = snapLabel ? 'true' : 'false';
    this.label.textContent = snapLabel ?? '';
  }

  dispose() {
    this.element.remove();
  }
}
