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
  shown.push(list);
  return { host, list, onHover, onSelect };
}

const shown: TopologyPickList[] = [];

afterEach(() => {
  // A list left open keeps its window listeners; close every one.
  for (const list of shown.splice(0)) list.hide();
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

  /**
   * The list is opened from the keyboard with Alt+ArrowDown, and it takes
   * focus onto its first row. Closing it hides that row — and hiding the
   * element that holds focus drops focus on the document body, which for a
   * keyboard user means losing their place in the app. The canvas behind it
   * is not focusable, so there is nothing for focus to fall back to.
   */
  it('gives focus back to whatever had it when a keyboard open closes', () => {
    const { list } = setup();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const first = candidate('edge-1', 4, 'edge');
    const second = candidate('edge-2', 9, 'edge');
    list.show(
      [
        { candidate: first, label: 'Part · Edge R4' },
        { candidate: second, label: 'Part · Edge 2' }
      ],
      { clientX: 200, clientY: 220 },
      true
    );
    expect(document.activeElement).not.toBe(opener);

    list.hide();
    expect(document.activeElement).toBe(opener);
  });

  it('leaves focus alone when it has already moved elsewhere', () => {
    // Closing on an outside click while the user has tabbed away must not
    // haul focus back out of wherever they went.
    const { list } = setup();
    const opener = document.createElement('button');
    const elsewhere = document.createElement('button');
    document.body.append(opener, elsewhere);
    opener.focus();

    list.show(
      [{ candidate: candidate('edge-1', 4, 'edge'), label: 'Part · Edge R4' }],
      { clientX: 200, clientY: 220 },
      true
    );
    elsewhere.focus();
    list.hide();

    expect(document.activeElement).toBe(elsewhere);
  });

  it('moves focus nowhere when the list was opened by pointer', () => {
    // A pointer open never took focus, so closing must not move it either.
    const { list } = setup();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    list.show(
      [{ candidate: candidate('edge-1', 4, 'edge'), label: 'Part · Edge R4' }],
      { clientX: 200, clientY: 220 }
    );
    expect(document.activeElement).toBe(opener);
    list.hide();
    expect(document.activeElement).toBe(opener);
  });

  /**
   * U11: Enter on a focused row acted on the pick made before the list
   * opened. The workspace's window keydown read Enter as "open the value
   * entry" and its preventDefault cancelled the row's own activation, so
   * the list closed on the old pick. The list now owns Enter on its rows.
   */
  it('confirms the focused row on Enter and keeps the key from the workspace', () => {
    const { list, onSelect } = setup();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const rim = candidate('edge:rim', 1, 'edge');
    const top = candidate('face:top', 2);
    list.show(
      [
        { candidate: rim, label: 'Part · Hole edge' },
        { candidate: top, label: 'Part · Top face' }
      ],
      { clientX: 200, clientY: 220 },
      true
    );
    const rows = Array.from(
      list.element.querySelectorAll<HTMLButtonElement>(
        '.topology-pick-list-row'
      )
    );
    rows[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
    );
    expect(document.activeElement).toBe(rows[1]);

    const workspace = vi.fn();
    window.addEventListener('keydown', workspace);
    try {
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      });
      rows[1]!.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
      expect(workspace).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', workspace);
    }
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(top);
    expect(list.visible).toBe(false);
    // Focus goes back to where it was before the list took it.
    expect(document.activeElement).toBe(opener);
  });

  it('leaves a modified Enter and Enter with no row focused alone', () => {
    const { list, onSelect } = setup();
    list.show(
      [{ candidate: candidate('edge-1', 4, 'edge'), label: 'Part · Edge R4' }],
      { clientX: 200, clientY: 220 },
      true
    );
    const row = list.element.querySelector<HTMLButtonElement>(
      '.topology-pick-list-row'
    )!;
    const ctrlEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    row.dispatchEvent(ctrlEnter);
    expect(ctrlEnter.defaultPrevented).toBe(false);
    // Enter on the title, outside any row.
    const title = list.element.querySelector('.topology-pick-list-title')!;
    const bare = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true
    });
    row.blur();
    title.dispatchEvent(bare);
    expect(bare.defaultPrevented).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    expect(list.visible).toBe(true);
  });

  /**
   * U11 review: confirming hands focus back to the viewport, so a held
   * Enter's auto-repeat landed there and opened the new pick's value entry,
   * then committed it. The rest of the press that confirmed the row stays
   * with the list until Enter is released.
   */
  it('keeps a held Enter that confirmed a row from acting again', () => {
    const { list, onSelect } = setup();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const top = candidate('face:top', 2);
    list.show(
      [{ candidate: top, label: 'Part · Top face' }],
      { clientX: 200, clientY: 220 },
      true
    );
    const row = list.element.querySelector<HTMLButtonElement>(
      '.topology-pick-list-row'
    )!;
    const workspace = vi.fn();
    window.addEventListener('keydown', workspace);
    try {
      row.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true
        })
      );
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(top);
      expect(document.activeElement).toBe(opener);

      // Auto-repeat, now at the element focus went back to.
      for (let i = 0; i < 3; i += 1) {
        const repeat = new KeyboardEvent('keydown', {
          key: 'Enter',
          repeat: true,
          bubbles: true,
          cancelable: true
        });
        opener.dispatchEvent(repeat);
        expect(repeat.defaultPrevented).toBe(true);
      }
      expect(workspace).not.toHaveBeenCalled();

      // Released: the next press is the workspace's again.
      opener.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })
      );
      const fresh = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true
      });
      opener.dispatchEvent(fresh);
      expect(fresh.defaultPrevented).toBe(false);
      expect(workspace).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', workspace);
    }
  });
});
