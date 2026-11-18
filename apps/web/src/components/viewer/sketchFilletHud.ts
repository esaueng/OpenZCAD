import { Vector4, type Camera } from 'three';
import type { PlaneBasis } from '@openzcad/geometry';
import type {
  SketchFilletBatchPlan,
  SketchFilletCorner
} from '../../lib/sketch/filletBatch';

export interface SketchFilletHudState {
  corners: readonly SketchFilletCorner[];
  selectedIds: readonly string[];
  firstLine?: string;
  labels: ReadonlyMap<string, string>;
  plan: SketchFilletBatchPlan | null;
  disabled: boolean;
  onToggle(id: string): void;
}

/** Maximum hit radius, in CSS pixels, kept clear of relation glyphs. */
export const FILLET_CORNER_REACH = 22;

export function buildSketchFilletHud(host: HTMLElement) {
  const layer = document.createElement('div');
  layer.className = 'sketch-fillet-hud';
  host.append(layer);

  const markers = new Map<
    string,
    { button: HTMLButtonElement; anchor: Vector4; x: number; y: number }
  >();
  const clip = new Vector4();
  const targets: { x: number; y: number }[] = [];
  let current: SketchFilletHudState | null = null;

  const stopPointer = (event: Event) => event.stopPropagation();
  const stopActivationKey = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation();
      if (event.repeat) event.preventDefault();
    }
  };

  return {
    update(state: SketchFilletHudState, basis: PlaneBasis) {
      current = state;
      const selected = new Set(state.selectedIds);
      const conflicts = new Set(
        state.plan?.status === 'refuse' ? state.plan.cornerIds : []
      );
      const ids = new Set(state.corners.map((corner) => corner.id));
      for (const [id, marker] of markers) {
        if (!ids.has(id)) {
          marker.button.remove();
          markers.delete(id);
        }
      }
      for (const [index, corner] of state.corners.entries()) {
        const { id, point } = corner;
        let marker = markers.get(id);
        if (!marker) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'sketch-fillet-corner';
          button.dataset.testid = 'sketch-fillet-corner';
          button.setAttribute('data-viewport-hud', '');
          button.hidden = true;
          button.addEventListener('pointerdown', stopPointer);
          button.addEventListener('pointerup', stopPointer);
          button.addEventListener('dblclick', stopPointer);
          button.addEventListener('keydown', stopActivationKey);
          button.addEventListener('keyup', stopActivationKey);
          button.addEventListener('click', (event) => {
            event.stopPropagation();
            if (current && !current.disabled) current.onToggle(id);
          });
          marker = { button, anchor: new Vector4(), x: NaN, y: NaN };
          markers.set(id, marker);
          layer.append(button);
        }
        const { button, anchor } = marker;
        anchor.set(
          basis.origin.x + basis.u.x * point.x + basis.v.x * point.y,
          basis.origin.y + basis.u.y * point.x + basis.v.y * point.y,
          basis.origin.z + basis.u.z * point.x + basis.v.z * point.y,
          1
        );
        const a = state.labels.get(corner.a.objectId);
        const b = state.labels.get(corner.b.objectId);
        const label =
          a && b ? `Fillet corner ${a} and ${b}` : `Fillet corner ${index + 1}`;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(selected.has(id)));
        button.dataset.conflicted = String(conflicts.has(id));
        button.disabled = state.disabled;
      }
    },
    layout(camera: Camera, width: number, height: number) {
      targets.length = 0;
      for (const marker of markers.values()) {
        clip
          .copy(marker.anchor)
          .applyMatrix4(camera.matrixWorldInverse)
          .applyMatrix4(camera.projectionMatrix);
        const visible =
          width > 0 &&
          height > 0 &&
          clip.w > 0 &&
          Math.abs(clip.x) <= clip.w &&
          Math.abs(clip.y) <= clip.w &&
          Math.abs(clip.z) <= clip.w;
        const { button } = marker;
        if (button.hidden === visible) button.hidden = !visible;
        if (!visible) continue;
        const x = ((clip.x / clip.w + 1) * width) / 2;
        const y = ((1 - clip.y / clip.w) * height) / 2;
        if (x !== marker.x || y !== marker.y) {
          button.style.left = `${x}px`;
          button.style.top = `${y}px`;
          marker.x = x;
          marker.y = y;
        }
        targets.push(marker);
      }
      return targets;
    },
    dispose() {
      layer.remove();
    }
  };
}
