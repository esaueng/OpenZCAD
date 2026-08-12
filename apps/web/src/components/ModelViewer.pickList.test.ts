import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  HudLayer,
  TopologyPickList,
  type PickCandidate
} from '@openzcad/viewport';
import { toBodyId } from '@openzcad/shared';

function candidate(
  topologyId: string,
  distance: number,
  kind: 'face' | 'edge' = 'face'
): PickCandidate {
  return {
    kind,
    distance,
    hit: {
      distance,
      point: new THREE.Vector3(distance, 0, 0),
      object: new THREE.Object3D()
    },
    selection: {
      bodyId: toBodyId('body-1'),
      kind,
      topologyId,
      hash: distance
    }
  };
}

function setup() {
  const host = document.createElement('div');
  host.getBoundingClientRect = () =>
    ({
      left: 20,
      top: 30,
      width: 800,
      height: 600,
      right: 820,
      bottom: 630,
      x: 20,
      y: 30,
      toJSON: () => ({})
    });
  document.body.appendChild(host);
  const onHover = vi.fn();
  const onSelect = vi.fn();
  const list = new TopologyPickList({
    hud: new HudLayer(host),
    onHover,
    onSelect
  });
  return { host, list, onHover, onSelect };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('TopologyPickList', () => {
  it('keeps the ordered stack, hovers through the viewport, and selects a row', () => {
    const { list, onHover, onSelect } = setup();
    const front = candidate('face:front', 1);
    const back = candidate('face:back', 2);

    expect(
      list.show(
        [
          { candidate: front, label: 'Part · Top face' },
          { candidate: back, label: 'Part · Through hole Ø17.4' }
        ],
        { clientX: 200, clientY: 220 }
      )
    ).toBe(true);
    const rows = Array.from(
      list.element.querySelectorAll<HTMLButtonElement>(
        '.topology-pick-list-row'
      )
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      'Part · Top faceface',
      'Part · Through hole Ø17.4face'
    ]);

    rows[1]!.dispatchEvent(new PointerEvent('pointerenter'));
    expect(onHover).toHaveBeenLastCalledWith(back);
    rows[1]!.click();
    expect(onSelect).toHaveBeenCalledWith(back);
    expect(list.visible).toBe(false);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it('focuses and traverses rows without selecting until activation', () => {
    const { list, onHover, onSelect } = setup();
    const first = candidate('edge:first', 1, 'edge');
    const second = candidate('edge:second', 2, 'edge');
    list.show(
      [
        { candidate: first, label: 'Part · Edge R4' },
        { candidate: second, label: 'Part · Edge 2' }
      ],
      { clientX: 200, clientY: 220 },
      true
    );
    const rows = Array.from(
      list.element.querySelectorAll<HTMLButtonElement>(
        '.topology-pick-list-row'
      )
    );
    expect(document.activeElement).toBe(rows[0]);
    rows[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(document.activeElement).toBe(rows[1]);
    expect(onHover).toHaveBeenLastCalledWith(second);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
