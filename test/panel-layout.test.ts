import { describe, expect, it } from 'vitest';
import {
  applyPreset,
  beginDrag,
  clampFloatRect,
  clampFloatsToStage,
  closePanel,
  commitPreview,
  computePanelGeometry,
  DEFAULT_PANEL_INSETS,
  DROP_SUPPRESSED,
  defaultPanelLayout,
  dockFootprint,
  ESSENTIALS_RIGHT_PRESET,
  findPanel,
  finishDrag,
  FLOAT_GROWTH,
  FLOAT_MAX_WIDTH,
  FLOAT_MIN_HEIGHT,
  FLOAT_MIN_WIDTH,
  grownFloatRect,
  hitTest,
  isDragStart,
  isFloatCovered,
  loadPanelLayout,
  matchingPreset,
  migratePanelState,
  moveFloat,
  movePanelInStack,
  normalizePanelLayout,
  notePanelUsed,
  openPanel,
  PANEL_COLUMN_GAP,
  PANEL_COLUMN_WIDTHS,
  PANEL_DOCK_CAP,
  PANEL_DRAG_THRESHOLD,
  PANEL_IDS,
  PANEL_LAYOUT_STORAGE_KEY,
  PANEL_MAX_COLUMNS,
  PANEL_MIN_HEIGHT,
  PANEL_PHONE_MAX_WIDTH,
  PANEL_PRESET_IDS,
  PANEL_RAIL_DRAG_CLEARANCE,
  PANEL_RAIL_WIDTH,
  PANEL_SLOT,
  PANEL_STACK_GAP,
  panelStatus,
  panelStatuses,
  pinPanel,
  placePanel,
  popOutPanel,
  popOutRect,
  presentPanel,
  previewLayout,
  raiseFloat,
  resizeFloat,
  resizeGap,
  savePanelLayout,
  setOption,
  splitGapEvenly,
  togglePanel,
  unpinPanel,
  unpinnedSlotReserves,
  wouldExceedCap,
  type PanelId,
  type PanelLayout,
  type PanelLayoutStorage,
  type PanelStage,
  type PanelTarget
} from '../apps/web/src/lib/panelLayout';
import {
  defaultPanelState,
  PANEL_STATE_STORAGE_KEY,
  type PanelState
} from '../apps/web/src/lib/panelState';

const STAGE: PanelStage = { width: 1440, height: 900 };
const CW = PANEL_COLUMN_WIDTHS.regular;
const GAP = PANEL_COLUMN_GAP;
/** The dock gap: between a dock's columns, and between a dock and its rail. */
const BETWEEN = PANEL_STACK_GAP;
const RAIL = PANEL_RAIL_WIDTH;
/** Each side's `gap + rail + gap`, columns or not. */
const SIDE_COST = GAP + RAIL + GAP;
/** The narrowest stage whose footprint cap fits `columns` columns. */
function stageFitting(columns: number): number {
  return (SIDE_COST * 2 + columns * (CW + BETWEEN)) / PANEL_DOCK_CAP;
}

function essentials(): PanelLayout {
  return applyPreset(defaultPanelLayout(), 'essentials');
}

function modelOnly(): PanelLayout {
  return applyPreset(defaultPanelLayout(), 'model-only');
}

function layoutWith(parts: Partial<PanelLayout>): PanelLayout {
  return { ...modelOnly(), ...parts };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

interface MemoryStorage extends PanelLayoutStorage {
  entries: Map<string, string>;
  writes: string[];
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const entries = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    entries,
    writes,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      writes.push(key);
      entries.set(key, value);
    }
  };
}

function v1(parts: Partial<PanelState>): string {
  return JSON.stringify({ ...defaultPanelState(), ...parts });
}

describe('panel layout presets', () => {
  it('lists the menu presets and keeps the right-only Essentials out of it', () => {
    expect(PANEL_PRESET_IDS).toEqual([
      'essentials',
      'full',
      'modeling',
      'review',
      'model-only'
    ]);
    expect(PANEL_PRESET_IDS).not.toContain(ESSENTIALS_RIGHT_PRESET);
  });

  it('builds every preset', () => {
    const base = modelOnly();
    const essentialsLayout = applyPreset(base, 'essentials');
    expect(essentialsLayout.left).toEqual([['bodies']]);
    expect(essentialsLayout.right).toEqual([['parameters']]);

    const full = applyPreset(base, 'full');
    expect(full.left).toEqual([['bodies', 'history']]);
    expect(full.right).toEqual([['parameters', 'revisions']]);
    // Revisions about a quarter of the column.
    const share =
      full.weights.revisions /
      (full.weights.revisions + full.weights.parameters);
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.3);

    const modeling = applyPreset(base, 'modeling');
    expect(modeling.left).toEqual([['bodies', 'history']]);
    expect(modeling.right).toEqual([['parameters']]);
    expect(modeling.weights.history).toBeGreaterThan(modeling.weights.bodies);

    const review = applyPreset(base, 'review');
    expect(review.left).toEqual([]);
    expect(review.right).toEqual([['history', 'revisions']]);
    expect(review.weights.history).toBeGreaterThan(review.weights.revisions);

    const clear = applyPreset(essentialsLayout, 'model-only');
    expect(clear.left).toEqual([]);
    expect(clear.right).toEqual([]);
    expect(clear.floats).toEqual([]);
    for (const id of PANEL_IDS) {
      expect(panelStatus(clear, id)).toBe('closed');
    }

    const right = applyPreset(base, ESSENTIALS_RIGHT_PRESET);
    expect(right.left).toEqual([]);
    expect(right.right).toEqual([['bodies', 'parameters']]);
  });

  it('keeps the settings and turns Hide off', () => {
    // Unlocked: a locked layout refuses presets (see 'a locked layout').
    let layout = setOption(essentials(), 'hidden', true);
    layout = setOption(layout, 'compact', true);
    layout = setOption(layout, 'width', 'wide');
    layout = openPanel(layout, 'history');
    layout = setOption(layout, 'hidden', true);
    layout = closePanel(
      placePanel(layout, 'history', { kind: 'newColumn', side: 'right' }),
      'history'
    );
    for (const name of PANEL_PRESET_IDS) {
      const picked = applyPreset(layout, name);
      expect(picked.options).toEqual({
        hidden: false,
        locked: false,
        compact: true,
        fit: true,
        width: 'wide'
      });
      // A preset is a fresh arrangement: no homes, nothing unpinned.
      expect(picked.homes).toEqual({});
      expect(picked.unpinned).toBeNull();
    }
  });

  it('names the preset a layout is arranged as, until it is rearranged', () => {
    for (const name of PANEL_PRESET_IDS) {
      expect(matchingPreset(applyPreset(modelOnly(), name))).toBe(name);
    }
    // The settings, the unpinned panel and the homes are not arrangement.
    let layout = setOption(applyPreset(modelOnly(), 'full'), 'width', 'wide');
    layout = setOption(layout, 'compact', true);
    layout = openPanel(layout, 'diagnostics');
    expect(layout.unpinned).toBe('diagnostics');
    expect(matchingPreset(layout)).toBe('full');
    // Each column's split counts by proportion, not by stored scale.
    const scaled = layoutWith({
      ...layout,
      weights: {
        ...layout.weights,
        bodies: 3,
        history: 3,
        parameters: 2,
        revisions: 0.64
      }
    });
    expect(matchingPreset(scaled)).toBe('full');
    // A gap resize, a move or a window is no preset any more.
    const geometry = computePanelGeometry(layout, STAGE);
    const gap = geometry.gaps.find((entry) => entry.above === 'bodies')!;
    expect(
      matchingPreset(
        resizeGap(layout, 'bodies', 'history', 40, gap.pxPerWeight)
      )
    ).toBeNull();
    expect(matchingPreset(movePanelInStack(layout, 'history', -1))).toBeNull();
    expect(
      matchingPreset(
        popOutPanel(layout, 'revisions', { x: 400, y: 200, w: 300, h: 300 })
      )
    ).toBeNull();
    // The right-only Essentials is not a menu preset.
    expect(matchingPreset(defaultPanelLayout())).toBeNull();
    expect(matchingPreset(defaultPanelLayout({ leftDock: true }))).toBe(
      'essentials'
    );
  });

  it('defaults a new device to the right-only Essentials until the left dock ships', () => {
    expect(defaultPanelLayout().right).toEqual([['bodies', 'parameters']]);
    expect(defaultPanelLayout({ leftDock: false }).left).toEqual([]);
    const twoSided = defaultPanelLayout({ leftDock: true });
    expect(twoSided.left).toEqual([['bodies']]);
    expect(twoSided.right).toEqual([['parameters']]);
  });
});

describe('panel states', () => {
  it('reports each panel as closed, unpinned, docked or floating', () => {
    let layout = essentials();
    layout = openPanel(layout, 'history');
    layout = popOutPanel(layout, 'revisions', {
      x: 500,
      y: 200,
      w: 300,
      h: 300
    });
    expect(panelStatuses(layout)).toEqual({
      parameters: 'docked',
      bodies: 'docked',
      history: 'unpinned',
      revisions: 'floating',
      diagnostics: 'closed'
    });
  });

  it('never mutates its input', () => {
    const layout = deepFreeze(
      placePanel(
        popOutPanel(openPanel(essentials(), 'history'), 'revisions', {
          x: 500,
          y: 200,
          w: 300,
          h: 300
        }),
        'diagnostics',
        { kind: 'newColumn', side: 'right' }
      )
    );
    const before = structuredClone(layout);
    const groupId = layout.floats[0]!.id;
    const targets: PanelTarget[] = [
      { kind: 'column', side: 'right', column: 0, index: 0 },
      { kind: 'column', side: 'left', column: 0 },
      { kind: 'newColumn', side: 'left' },
      { kind: 'float', rect: { x: 100, y: 100, w: 300, h: 300 } },
      { kind: 'group', groupId, index: 0 }
    ];
    for (const target of targets) {
      placePanel(layout, 'parameters', target, STAGE);
      previewLayout(layout, 'parameters', target, STAGE);
    }
    closePanel(layout, 'parameters');
    togglePanel(layout, 'diagnostics');
    pinPanel(layout, 'history');
    unpinPanel(layout, 'bodies');
    beginDrag(layout, 'bodies');
    resizeGap(layout, 'parameters', 'diagnostics', 40, 1);
    splitGapEvenly(layout, 'parameters', 'diagnostics');
    moveFloat(layout, groupId, { x: 0, y: 0 }, STAGE);
    resizeFloat(layout, groupId, { w: 9999, h: 9999 }, STAGE);
    raiseFloat(layout, groupId);
    applyPreset(layout, 'full');
    setOption(layout, 'compact', true);
    computePanelGeometry(layout, { width: 800, height: 390 });
    expect(layout).toEqual(before);
  });
});

describe('placing panels', () => {
  it('stacks into an existing column at the slot, on both sides', () => {
    for (const side of ['left', 'right'] as const) {
      const layout = layoutWith({ [side]: [['bodies', 'history']] });
      const top = placePanel(layout, 'parameters', {
        kind: 'column',
        side,
        column: 0,
        index: 0
      });
      expect(top[side]).toEqual([['parameters', 'bodies', 'history']]);
      const middle = placePanel(layout, 'parameters', {
        kind: 'column',
        side,
        column: 0,
        index: 1
      });
      expect(middle[side]).toEqual([['bodies', 'parameters', 'history']]);
      const end = placePanel(layout, 'parameters', {
        kind: 'column',
        side,
        column: 0
      });
      expect(end[side]).toEqual([['bodies', 'history', 'parameters']]);
      // A slot past the end is the end.
      expect(
        placePanel(layout, 'parameters', {
          kind: 'column',
          side,
          column: 0,
          index: 9
        })[side]
      ).toEqual(end[side]);
    }
  });

  it('opens a new column next to either rail', () => {
    const right = placePanel(essentials(), 'history', {
      kind: 'newColumn',
      side: 'right'
    });
    expect(right.right).toEqual([['parameters'], ['history']]);
    const left = placePanel(essentials(), 'history', {
      kind: 'newColumn',
      side: 'left'
    });
    expect(left.left).toEqual([['bodies'], ['history']]);
    // A column index past the dock's columns is a new column too.
    expect(
      placePanel(essentials(), 'history', {
        kind: 'column',
        side: 'left',
        column: 5
      }).left
    ).toEqual(left.left);
  });

  it('moves a panel between sides and drops the column it emptied', () => {
    const moved = placePanel(essentials(), 'bodies', {
      kind: 'column',
      side: 'right',
      column: 0
    });
    expect(moved.left).toEqual([]);
    expect(moved.right).toEqual([['parameters', 'bodies']]);
  });

  it('floats a panel in a new window', () => {
    const layout = placePanel(essentials(), 'bodies', {
      kind: 'float',
      rect: { x: 400, y: 120, w: 320, h: 360 }
    });
    expect(layout.left).toEqual([]);
    expect(layout.floats).toEqual([
      { id: 'float-1', x: 400, y: 120, w: 320, h: 360, panels: ['bodies'] }
    ]);
    expect(panelStatus(layout, 'bodies')).toBe('floating');
    // A second window gets its own id and goes on top.
    const second = placePanel(layout, 'history', {
      kind: 'float',
      rect: { x: 100, y: 100, w: 300, h: 300 }
    });
    expect(second.floats.map((group) => group.id)).toEqual([
      'float-1',
      'float-2'
    ]);
  });

  it('stacks into a floating window, which grows and comes to the front', () => {
    let layout = popOutPanel(essentials(), 'bodies', {
      x: 400,
      y: 120,
      w: 300,
      h: 300
    });
    layout = popOutPanel(layout, 'history', { x: 700, y: 120, w: 300, h: 300 });
    const target = layout.floats[0]!;
    const stacked = placePanel(layout, 'parameters', {
      kind: 'group',
      groupId: target.id,
      index: 0
    });
    const group = stacked.floats.at(-1)!;
    expect(group.id).toBe(target.id);
    expect(group.panels).toEqual(['parameters', 'bodies']);
    expect(group.h).toBe(target.h + FLOAT_GROWTH);
    expect(stacked.right).toEqual([]);
  });

  it('shrinks a window by the panel taken out of it', () => {
    let layout = popOutPanel(modelOnly(), 'bodies', {
      x: 400,
      y: 120,
      w: 300,
      h: 300
    });
    layout = placePanel(layout, 'history', {
      kind: 'group',
      groupId: 'float-1'
    });
    expect(layout.floats[0]!.h).toBe(300 + FLOAT_GROWTH);
    const out = closePanel(layout, 'history');
    // Two equal panels share 540 less one gap; taking one out leaves the other.
    const share = (300 + FLOAT_GROWTH - PANEL_STACK_GAP) / 2;
    expect(out.floats[0]!.h).toBeCloseTo(
      300 + FLOAT_GROWTH - share - PANEL_STACK_GAP
    );
    expect(out.floats[0]!.panels).toEqual(['bodies']);
    // The last panel out takes the window with it.
    expect(closePanel(out, 'bodies').floats).toEqual([]);
  });

  it('caps the right dock at three columns and the left at two', () => {
    expect(PANEL_MAX_COLUMNS).toEqual({ right: 3, left: 2 });
    let right = modelOnly();
    for (const id of [
      'parameters',
      'bodies',
      'history',
      'revisions'
    ] as const) {
      right = placePanel(right, id, { kind: 'newColumn', side: 'right' });
    }
    // Past the limit the panel stacks in the outermost column.
    expect(right.right).toEqual([
      ['parameters'],
      ['bodies'],
      ['history', 'revisions']
    ]);
    expect(
      placePanel(right, 'diagnostics', {
        kind: 'column',
        side: 'right',
        column: 3
      }).right
    ).toEqual([
      ['parameters'],
      ['bodies'],
      ['history', 'revisions', 'diagnostics']
    ]);

    let left = modelOnly();
    for (const id of ['parameters', 'bodies', 'history'] as const) {
      left = placePanel(left, id, { kind: 'newColumn', side: 'left' });
    }
    expect(left.left).toEqual([['parameters'], ['bodies', 'history']]);
  });

  it.each(['left', 'right'] as const)(
    'keeps resized weights and preview heights when reordering a %s column',
    (side) => {
      let layout = layoutWith({
        [side]: [['parameters', 'bodies', 'history']]
      });
      const gap = computePanelGeometry(layout, STAGE).gaps[0]!;
      layout = resizeGap(layout, 'parameters', 'bodies', 60, gap.pxPerWeight);
      const before = computePanelGeometry(layout, STAGE);
      const target: PanelTarget = { kind: 'column', side, column: 0, index: 2 };
      const placed = placePanel(layout, 'parameters', target, STAGE);
      expect(placed[side]).toEqual([['bodies', 'history', 'parameters']]);
      expect(placed.weights).toEqual(layout.weights);
      const after = computePanelGeometry(placed, STAGE);
      for (const id of ['parameters', 'bodies', 'history'] as const) {
        expect(after.panels[id]!.h).toBeCloseTo(before.panels[id]!.h);
      }
      const preview = previewLayout(layout, 'parameters', target, STAGE)!;
      expect(
        computePanelGeometry(preview, STAGE).panels[PANEL_SLOT]!.h
      ).toBeCloseTo(after.panels.parameters!.h);
      expect(commitPreview(preview, 'parameters')).toEqual(placed);
    }
  );

  it('keeps resized weights and preview heights within a floating stack', () => {
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    const groupId = layout.floats[0]!.id;
    layout = placePanel(layout, 'revisions', { kind: 'group', groupId });
    const gap = computePanelGeometry(layout, STAGE).gaps[0]!;
    layout = resizeGap(layout, 'history', 'revisions', 50, gap.pxPerWeight);
    const before = computePanelGeometry(layout, STAGE);
    const target: PanelTarget = { kind: 'group', groupId, index: 1 };
    const placed = placePanel(layout, 'history', target, STAGE);
    expect(placed.weights).toEqual(layout.weights);
    const after = computePanelGeometry(placed, STAGE);
    expect(after.panels.history!.h).toBeCloseTo(before.panels.history!.h);
    expect(after.panels.revisions!.h).toBeCloseTo(before.panels.revisions!.h);
    const preview = previewLayout(layout, 'history', target, STAGE)!;
    expect(
      computePanelGeometry(preview, STAGE).panels[PANEL_SLOT]!.h
    ).toBeCloseTo(after.panels.history!.h);
    expect(commitPreview(preview, 'history')).toEqual(placed);
  });

  it('gives a placed panel a fresh weight and forgets its home', () => {
    let layout = applyPreset(modelOnly(), 'review');
    layout = closePanel(layout, 'history');
    expect(layout.homes.history).toBeDefined();
    layout = placePanel(layout, 'history', { kind: 'newColumn', side: 'left' });
    expect(layout.weights.history).toBe(1);
    expect(layout.homes.history).toBeUndefined();
  });
});

describe('moving a panel within its stack', () => {
  it('moves one place up or down in a column, stopping at the ends', () => {
    const layout = layoutWith({
      right: [['parameters', 'bodies', 'history']]
    });
    expect(movePanelInStack(layout, 'parameters', 1).right).toEqual([
      ['bodies', 'parameters', 'history']
    ]);
    expect(movePanelInStack(layout, 'history', -1).right).toEqual([
      ['parameters', 'history', 'bodies']
    ]);
    expect(movePanelInStack(layout, 'parameters', -1)).toBe(layout);
    expect(movePanelInStack(layout, 'history', 1)).toBe(layout);
    // A reorder keeps the panel's height.
    const weighted = { ...layout, weights: { ...layout.weights, bodies: 2 } };
    expect(movePanelInStack(weighted, 'bodies', 1).weights.bodies).toBe(2);
  });

  it('moves within a floating window, which keeps its rectangle', () => {
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 400
    });
    layout = placePanel(layout, 'revisions', {
      kind: 'group',
      groupId: layout.floats[0]!.id
    });
    const moved = movePanelInStack(layout, 'revisions', -1, STAGE);
    expect(moved.floats[0]!.panels).toEqual(['revisions', 'history']);
    expect(moved.floats[0]).toMatchObject({
      x: layout.floats[0]!.x,
      y: layout.floats[0]!.y,
      w: layout.floats[0]!.w,
      h: layout.floats[0]!.h
    });
  });

  it('leaves closed and unpinned panels, and a locked layout, alone', () => {
    const layout = layoutWith({ right: [['parameters', 'bodies']] });
    expect(movePanelInStack(layout, 'history', 1)).toBe(layout);
    const unpinned = openPanel(layout, 'history');
    expect(movePanelInStack(unpinned, 'history', -1)).toBe(unpinned);
    const locked = setOption(layout, 'locked', true);
    expect(movePanelInStack(locked, 'parameters', 1)).toBe(locked);
  });
});

describe('drag preview', () => {
  it('keeps an emptied column in place until the drop', () => {
    const dragging = beginDrag(essentials(), 'bodies');
    expect(dragging.left).toEqual([[]]);
    expect(panelStatus(dragging, 'bodies')).toBe('closed');
    expect(finishDrag(dragging).left).toEqual([]);
    const preview = previewLayout(essentials(), 'bodies', {
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0
    })!;
    expect(preview.left).toEqual([[]]);
    expect(preview.right).toEqual([[PANEL_SLOT, 'parameters']]);
  });

  it('commits exactly the layout the preview showed', () => {
    let layout = applyPreset(modelOnly(), 'full');
    layout = popOutPanel(layout, 'diagnostics', {
      x: 500,
      y: 200,
      w: 300,
      h: 300
    });
    layout = openPanel(layout, 'history' as const);
    const groupId = layout.floats[0]!.id;
    const targets: PanelTarget[] = [
      { kind: 'column', side: 'right', column: 0, index: 1 },
      { kind: 'column', side: 'left', column: 0, index: 0 },
      { kind: 'column', side: 'left', column: 4 },
      { kind: 'newColumn', side: 'right' },
      { kind: 'newColumn', side: 'left' },
      { kind: 'float', rect: { x: 300, y: 200, w: 320, h: 400 } },
      { kind: 'group', groupId, index: 0 },
      { kind: 'group', groupId, index: 1 },
      { kind: 'group', groupId: 'gone', index: 0 }
    ];
    for (const id of PANEL_IDS) {
      for (const target of targets) {
        for (const stage of [undefined, STAGE, { width: 1000, height: 600 }]) {
          const preview = previewLayout(layout, id, target, stage);
          const placed = placePanel(layout, id, target, stage);
          if (!preview) {
            // Refused past the cap: no preview, and the drop changes nothing.
            expect(stage).toBeDefined();
            expect(wouldExceedCap(layout, id, target, stage!)).toBe(true);
            expect(placed).toBe(layout);
            continue;
          }
          const slots = [
            ...preview.left.flat(),
            ...preview.right.flat(),
            ...preview.floats.flatMap((group) => group.panels)
          ].filter((entry) => entry === PANEL_SLOT);
          expect(slots).toHaveLength(1);
          expect(commitPreview(preview, id)).toEqual(placed);
          // From the drag's own layout too, except a reorder within the
          // panel's own stack: the lifted layout no longer says where the
          // panel came from, which is why previews take the pre-drag layout.
          const from = findPanel(layout, id);
          const ownStack =
            (from?.kind === 'column' &&
              target.kind === 'column' &&
              from.side === target.side &&
              from.column === target.column) ||
            (from?.kind === 'float' &&
              target.kind === 'group' &&
              from.groupId === target.groupId);
          if (ownStack) {
            continue;
          }
          expect(
            commitPreview(
              previewLayout(beginDrag(layout, id), id, target, stage)!,
              id
            )
          ).toEqual(placed);
        }
      }
    }
  });

  it("keeps a panel's height when reordered in its stack", () => {
    let layout = applyPreset(modelOnly(), 'full');
    const column = layout.right[0]!;
    expect(column.length).toBeGreaterThan(1);
    const [first, second] = column as [PanelId, PanelId];
    layout = resizeGap(layout, first, second, 60, 600);
    const weights = { ...layout.weights };
    expect(weights[first]).not.toBe(1);
    const reordered = placePanel(layout, first, {
      kind: 'column',
      side: 'right',
      column: 0,
      index: column.length
    });
    expect(reordered.right[0]!.at(-1)).toBe(first);
    expect(reordered.weights).toEqual(weights);
    // Into another stack it starts at an even share.
    const moved = placePanel(layout, first, {
      kind: 'newColumn',
      side: 'right'
    });
    expect(moved.weights[first]).toBe(1);
  });

  it('renders the slot where the panel will land', () => {
    const preview = previewLayout(essentials(), 'history', {
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0
    })!;
    const shown = computePanelGeometry(preview, STAGE);
    const placed = computePanelGeometry(
      placePanel(essentials(), 'history', {
        kind: 'column',
        side: 'right',
        column: 0,
        index: 0
      }),
      STAGE
    );
    expect(shown.panels[PANEL_SLOT]).toMatchObject({
      x: placed.panels.history!.x,
      y: placed.panels.history!.y,
      w: placed.panels.history!.w
    });
    expect(shown.panels[PANEL_SLOT]!.h).toBeCloseTo(placed.panels.history!.h);
    // No gap handle beside the slot.
    expect(shown.gaps).toEqual([]);
  });
});

describe('opening, closing and pinning', () => {
  it('closes a docked panel and reopens it where it was', () => {
    let layout = placePanel(essentials(), 'history', {
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0
    });
    layout = closePanel(layout, 'history');
    expect(panelStatus(layout, 'history')).toBe('closed');
    expect(layout.homes.history).toEqual({
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0,
      peers: ['history', 'parameters']
    });
    const reopened = togglePanel(layout, 'history');
    expect(reopened.right).toEqual([['history', 'parameters']]);
    expect(reopened.homes.history).toBeUndefined();
  });

  it('reopens a closed left-dock panel on the left', () => {
    const closed = closePanel(applyPreset(modelOnly(), 'modeling'), 'history');
    expect(closed.left).toEqual([['bodies']]);
    expect(openPanel(closed, 'history').left).toEqual([['bodies', 'history']]);
  });

  it.each(['left', 'right'] as const)(
    'restores a closed singleton %s column before its former neighbour, including after reload',
    (side) => {
      const layout = layoutWith({ [side]: [['bodies'], ['history']] });
      const closed = closePanel(layout, 'bodies');
      expect(closed[side]).toEqual([['history']]);
      for (const input of [
        closed,
        normalizePanelLayout(JSON.parse(JSON.stringify(closed)))
      ]) {
        const opened = openPanel(input, 'bodies', STAGE);
        expect(opened[side]).toEqual(layout[side]);
        expect(opened.unpinned).toBeNull();
      }
    }
  );

  it.each([
    ['bodies', 'history', 'revisions'],
    ['revisions', 'bodies', 'history'],
    ['history', 'revisions', 'bodies']
  ] as const)(
    'restores separately closed columns in their original order: %s, %s, %s',
    (...order) => {
      const layout = layoutWith({
        right: [['bodies'], ['history'], ['revisions']]
      });
      let closed = layout;
      for (const id of ['bodies', 'revisions', 'history'] as const)
        closed = closePanel(closed, id);
      const storage = memoryStorage();
      savePanelLayout(closed, storage);
      let opened = loadPanelLayout(storage);
      for (const id of order) opened = openPanel(opened, id);
      expect(opened.right).toEqual(layout.right);
    }
  );

  it('returns separately closed stack peers to the same column and original order', () => {
    const layout = layoutWith({ right: [['bodies', 'history', 'revisions']] });
    let closed = layout;
    for (const id of ['bodies', 'revisions', 'history'] as const)
      closed = closePanel(closed, id);
    const storage = memoryStorage();
    savePanelLayout(closed, storage);
    let opened = loadPanelLayout(storage);
    for (const id of ['revisions', 'bodies', 'history'] as const)
      opened = openPanel(opened, id);
    expect(opened.right).toEqual(layout.right);
  });

  it.each(['left', 'right'] as const)(
    'restores original %s stacks through every close/reopen order',
    (side) => {
      const orders = <T>(items: readonly T[]): T[][] =>
        items.length === 0
          ? [[]]
          : items.flatMap((item, k) =>
              orders(items.filter((_, index) => index !== k)).map((rest) => [
                item,
                ...rest
              ])
            );
      const ids = ['bodies', 'history', 'revisions'] as const;
      const arrangements: PanelId[][][] = [
        [['bodies', 'history', 'revisions']],
        [['bodies', 'history'], ['revisions']],
        [['bodies'], ['history', 'revisions']]
      ];
      if (side === 'right')
        arrangements.push([['bodies'], ['history'], ['revisions']]);
      for (const columns of arrangements) {
        const layout = layoutWith({ [side]: columns });
        for (const closeOrder of orders(ids)) {
          let closed = layout;
          for (const id of closeOrder) closed = closePanel(closed, id);
          const storage = memoryStorage();
          savePanelLayout(closed, storage);
          for (const openOrder of orders(ids)) {
            let opened = loadPanelLayout(storage);
            for (const id of openOrder) opened = openPanel(opened, id);
            expect(
              opened[side],
              JSON.stringify({ columns, closeOrder, openOrder })
            ).toEqual(columns);
          }
        }
      }
    }
  );

  it.each(['left', 'right'] as const)(
    'retains resized height weights when reopening a closed %s panel',
    (side) => {
      let layout = layoutWith({ [side]: [['bodies', 'history']] });
      const gap = computePanelGeometry(layout, STAGE).gaps[0]!;
      layout = resizeGap(layout, 'bodies', 'history', 80, gap.pxPerWeight);
      const before = computePanelGeometry(layout, STAGE);
      const storage = memoryStorage();
      savePanelLayout(closePanel(layout, 'bodies'), storage);
      const opened = openPanel(loadPanelLayout(storage), 'bodies', STAGE);
      expect(opened.weights).toEqual(layout.weights);
      const after = computePanelGeometry(opened, STAGE);
      expect(after.panels.bodies!.h).toBeCloseTo(before.panels.bodies!.h);
      expect(after.panels.history!.h).toBeCloseTo(before.panels.history!.h);
    }
  );

  it('closes a floating panel and reopens it in its window’s place', () => {
    let layout = popOutPanel(essentials(), 'history', {
      x: 420,
      y: 140,
      w: 320,
      h: 380
    });
    layout = closePanel(layout, 'history');
    expect(layout.floats).toEqual([]);
    expect(layout.homes.history).toEqual({
      kind: 'float',
      rect: { x: 420, y: 140, w: 320, h: 380 }
    });
    const reopened = openPanel(layout, 'history');
    expect(reopened.floats).toEqual([
      { id: 'float-1', x: 420, y: 140, w: 320, h: 380, panels: ['history'] }
    ]);
  });

  it('opens a panel with no home unpinned, one at a time', () => {
    let layout = openPanel(essentials(), 'history');
    expect(layout.unpinned).toBe('history');
    layout = openPanel(layout, 'revisions');
    expect(layout.unpinned).toBe('revisions');
    expect(panelStatus(layout, 'history')).toBe('closed');
    // An open panel stays where it is.
    // An open panel stays where it is; opening it only counts as a use.
    const reopened = openPanel(layout, 'parameters');
    expect(reopened.right).toEqual(layout.right);
    expect(reopened.unpinned).toBe('revisions');
    expect(reopened.recent[0]).toBe('parameters');
    // Closing the unpinned panel leaves it no home: it reopens unpinned.
    layout = closePanel(layout, 'revisions');
    expect(layout.unpinned).toBeNull();
    expect(layout.homes.revisions).toBeUndefined();
    expect(togglePanel(layout, 'revisions').unpinned).toBe('revisions');
  });

  it('toggles from the rail, and only shows the panels while they are hidden', () => {
    const layout = essentials();
    expect(panelStatus(togglePanel(layout, 'parameters'), 'parameters')).toBe(
      'closed'
    );
    const hidden = setOption(layout, 'hidden', true);
    const shown = togglePanel(hidden, 'parameters');
    expect(shown.options.hidden).toBe(false);
    expect(panelStatus(shown, 'parameters')).toBe('docked');
    const opened = togglePanel(hidden, 'history');
    expect(opened.options.hidden).toBe(false);
    expect(opened.unpinned).toBe('history');
  });

  it('pins at the end of the first right column', () => {
    const unpinned = openPanel(essentials(), 'history');
    const pinned = pinPanel(unpinned, 'history');
    expect(pinned.unpinned).toBeNull();
    expect(pinned.right).toEqual([['parameters', 'history']]);
    const floating = popOutPanel(essentials(), 'bodies', {
      x: 400,
      y: 100,
      w: 300,
      h: 300
    });
    expect(pinPanel(floating, 'bodies').right).toEqual([
      ['parameters', 'bodies']
    ]);
    expect(pinPanel(floating, 'bodies').floats).toEqual([]);
    // With no right column, pinning makes one.
    expect(
      pinPanel(openPanel(modelOnly(), 'history'), 'history').right
    ).toEqual([['history']]);
    // A docked panel is already pinned.
    const docked = essentials();
    expect(pinPanel(docked, 'bodies')).toBe(docked);
  });

  it('unpins a docked or floating panel, replacing the unpinned one', () => {
    let layout = openPanel(essentials(), 'history');
    layout = unpinPanel(layout, 'bodies');
    expect(layout.unpinned).toBe('bodies');
    expect(layout.left).toEqual([]);
    expect(panelStatus(layout, 'history')).toBe('closed');
    const floating = popOutPanel(layout, 'parameters', {
      x: 400,
      y: 100,
      w: 300,
      h: 300
    });
    const unpinned = unpinPanel(floating, 'parameters');
    expect(unpinned.unpinned).toBe('parameters');
    expect(unpinned.floats).toEqual([]);
  });

  it('pops a panel out across from where it shows', () => {
    const geometry = computePanelGeometry(essentials(), STAGE);
    const rect = popOutRect(geometry, 'parameters');
    // The right column is past the middle, so the window lands to its left.
    expect(rect.x).toBeLessThan(geometry.panels.parameters!.x);
    const left = popOutRect(geometry, 'bodies');
    expect(left.x).toBeGreaterThan(geometry.panels.bodies!.x);
    const popped = popOutPanel(essentials(), 'parameters', rect, STAGE);
    expect(panelStatus(popped, 'parameters')).toBe('floating');
    expect(popped.right).toEqual([]);
  });
});

describe('closing a closed panel', () => {
  it('changes nothing and keeps its home', () => {
    const closed = closePanel(essentials(), 'parameters');
    expect(closed.homes.parameters).toBeDefined();
    expect(closePanel(closed, 'parameters')).toBe(closed);
    expect(
      openPanel(closePanel(closed, 'parameters'), 'parameters').right
    ).toEqual(essentials().right);
  });
});

describe('reopening a panel that had a column to itself', () => {
  it('recreates the column where it was', () => {
    let layout = placePanel(modelOnly(), 'history', {
      kind: 'newColumn',
      side: 'right'
    });
    layout = placePanel(layout, 'revisions', {
      kind: 'newColumn',
      side: 'right'
    });
    expect(layout.right).toEqual([['history'], ['revisions']]);
    const closed = closePanel(layout, 'history');
    expect(closed.right).toEqual([['revisions']]);
    expect(closed.homes.history).toMatchObject({ column: 0, alone: true });
    expect(openPanel(closed, 'history', STAGE).right).toEqual([
      ['history'],
      ['revisions']
    ]);
    // The flag survives a save and load.
    const restored = normalizePanelLayout(JSON.parse(JSON.stringify(closed)));
    expect(openPanel(restored, 'history', STAGE).right).toEqual([
      ['history'],
      ['revisions']
    ]);
    // A panel that shared its column stacks back into it.
    const shared = placePanel(layout, 'diagnostics', {
      kind: 'column',
      side: 'right',
      column: 1
    });
    const reopened = openPanel(
      closePanel(shared, 'diagnostics'),
      'diagnostics'
    );
    expect(reopened.right).toEqual([['history'], ['revisions', 'diagnostics']]);
  });
});

describe('floating windows', () => {
  const stage: PanelStage = { width: 1200, height: 800 };
  const { top } = DEFAULT_PANEL_INSETS;

  it('grows by 240px within the stage', () => {
    expect(grownFloatRect({ x: 100, y: 100, w: 300, h: 200 }, stage)).toEqual({
      x: 100,
      y: 100,
      w: 300,
      h: 200 + FLOAT_GROWTH
    });
    // Near the bottom it moves up to grow.
    const low = grownFloatRect({ x: 100, y: 500, w: 300, h: 200 }, stage);
    expect(low.h).toBe(200 + FLOAT_GROWTH);
    expect(low.y + low.h).toBe(stage.height);
    // Never taller than the stage, less the stack's grip above its frame.
    const tall = grownFloatRect({ x: 100, y: 100, w: 300, h: 900 }, stage);
    expect(tall.h).toBe(stage.height - 20);
    expect(tall.y).toBe(20);
  });

  it('is clamped to the stage when shown, the stored window untouched', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 1100,
      y: 700,
      w: 400,
      h: 600
    });
    const small: PanelStage = { width: 900, height: 390 };
    const geometry = computePanelGeometry(layout, small);
    const shown = geometry.floats[0]!;
    expect(shown.x).toBeGreaterThanOrEqual(0);
    expect(shown.x + shown.w).toBeLessThanOrEqual(small.width);
    expect(shown.y).toBeGreaterThanOrEqual(0);
    expect(shown.y + shown.h).toBeLessThanOrEqual(small.height);
    expect(layout.floats[0]).toMatchObject({ x: 1100, y: 700, w: 400, h: 600 });
    expect(clampFloatRect({ x: -50, y: -50, w: 300, h: 400 }, small)).toEqual({
      x: 0,
      y: 0,
      w: 300,
      h: small.height
    });
  });

  it('keeps a stacked window’s grip bar on screen at the top edge', () => {
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 0,
      w: 300,
      h: 300
    });
    // One panel draws no grip: the window may stand at the very top.
    expect(computePanelGeometry(layout, stage).floats[0]!.y).toBe(0);
    const groupId = layout.floats[0]!.id;
    layout = placePanel(layout, 'revisions', { kind: 'group', groupId }, stage);
    // A stack's grip stands 20px above its frame and is the only handle
    // that moves it, so the frame stops 20px down.
    expect(computePanelGeometry(layout, stage).floats[0]!.y).toBe(20);
    expect(
      moveFloat(layout, groupId, { x: 100, y: -50 }, stage).floats.at(-1)!.y
    ).toBe(20);
    expect(grownFloatRect({ x: 0, y: 0, w: 300, h: 200 }, stage).y).toBe(20);
  });

  it('may stand anywhere on the stage, over the top islands too', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 0,
      y: 0,
      w: 300,
      h: 300
    });
    const shown = computePanelGeometry(layout, stage).floats[0]!;
    // Above the docks' top inset (the top bar) and against the stage edge.
    expect(shown).toMatchObject({ x: 0, y: 0, w: 300, h: 300 });
    expect(shown.y).toBeLessThan(top);
    const corner = moveFloat(layout, 'float-1', { x: 900, y: 500 }, stage);
    expect(corner.floats[0]).toMatchObject({ x: 900, y: 500 });
  });

  it('resizes between 260 and 600px wide and from 160px tall', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    const id = layout.floats[0]!.id;
    const small = resizeFloat(layout, id, { w: 10, h: 10 }, stage).floats[0]!;
    expect(small.w).toBe(FLOAT_MIN_WIDTH);
    expect(small.h).toBe(FLOAT_MIN_HEIGHT);
    const big = resizeFloat(layout, id, { w: 5000, h: 5000 }, stage).floats[0]!;
    expect(big.w).toBe(FLOAT_MAX_WIDTH);
    expect(big.h).toBe(stage.height - 100);
    // Against the right edge the stage wins over the maximum.
    const edge = moveFloat(layout, id, { x: 800, y: 100 }, stage);
    expect(resizeFloat(edge, id, { w: 600, h: 300 }, stage).floats[0]!.w).toBe(
      stage.width - 800
    );
    expect(resizeFloat(layout, 'missing', { w: 400, h: 400 }, stage)).toBe(
      layout
    );
  });

  it('resizes from where a window shows when the stage clamps it', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 1100,
      y: 100,
      w: 400,
      h: 300
    });
    const id = layout.floats[0]!.id;
    const small: PanelStage = { width: 800, height: 800 };
    const shown = computePanelGeometry(layout, small).floats[0]!;
    const resized = resizeFloat(layout, id, { w: 300, h: 300 }, small)
      .floats[0]!;
    expect(resized).toMatchObject({ x: shown.x, y: shown.y, w: 300, h: 300 });
  });

  it('keeps its size when a panel is reordered within it', () => {
    // (Weights too: see 'keeps a panel's height when reordered in its stack'.)
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    const groupId = layout.floats[0]!.id;
    layout = placePanel(layout, 'revisions', { kind: 'group', groupId }, stage);
    const before = layout.floats[0]!;
    expect(before.panels).toEqual(['history', 'revisions']);
    for (const index of [0, 2, 0]) {
      layout = placePanel(
        layout,
        'revisions',
        { kind: 'group', groupId, index },
        stage
      );
      expect(layout.floats[0]).toMatchObject({
        x: before.x,
        y: before.y,
        w: before.w,
        h: before.h
      });
    }
    expect(layout.floats[0]!.panels).toEqual(['revisions', 'history']);
  });

  it('keeps a window of one when its panel is placed back into it', () => {
    const rect = { x: 400, y: 200, w: 320, h: 360 };
    const layout = popOutPanel(modelOnly(), 'history', rect);
    const groupId = layout.floats[0]!.id;
    const placed = placePanel(layout, 'history', {
      kind: 'group',
      groupId,
      index: 0
    });
    expect(placed.floats).toEqual([
      { id: groupId, ...rect, panels: ['history'] }
    ]);
  });

  it('leaves stored windows alone on a phone-width stage', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 1100,
      y: 600,
      w: 500,
      h: 400
    });
    expect(clampFloatsToStage(layout, { width: 390, height: 844 })).toBe(
      layout
    );
  });

  it('moves within the stage and comes to the front', () => {
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    layout = popOutPanel(layout, 'revisions', {
      x: 500,
      y: 100,
      w: 300,
      h: 300
    });
    const moved = moveFloat(layout, 'float-1', { x: -400, y: 5000 }, stage);
    expect(moved.floats.at(-1)).toMatchObject({
      id: 'float-1',
      x: 0,
      y: stage.height - 300
    });
  });
});

describe('floating window z-order', () => {
  function threeWindows(): PanelLayout {
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    layout = popOutPanel(layout, 'revisions', {
      x: 150,
      y: 150,
      w: 300,
      h: 300
    });
    return popOutPanel(layout, 'diagnostics', {
      x: 200,
      y: 200,
      w: 300,
      h: 300
    });
  }
  const order = (layout: PanelLayout) =>
    layout.floats.map((group) => group.panels[0]);

  it('keeps the windows in z-order, the newest on top', () => {
    expect(order(threeWindows())).toEqual([
      'history',
      'revisions',
      'diagnostics'
    ]);
  });

  it('raises a window when one of its panels is opened or activated', () => {
    const layout = threeWindows();
    expect(order(openPanel(layout, 'history'))).toEqual([
      'revisions',
      'diagnostics',
      'history'
    ]);
    expect(order(notePanelUsed(layout, 'revisions'))).toEqual([
      'history',
      'diagnostics',
      'revisions'
    ]);
    // Raised even when the panel was already the most recent.
    const recent = notePanelUsed(layout, 'history');
    const lowered = raiseFloat(recent, recent.floats[0]!.id);
    expect(order(notePanelUsed(lowered, 'history')).at(-1)).toBe('history');
    expect(order(raiseFloat(layout, layout.floats[0]!.id))).toEqual([
      'revisions',
      'diagnostics',
      'history'
    ]);
    // Already on top, or no such window: unchanged.
    expect(raiseFloat(layout, layout.floats[2]!.id)).toBe(layout);
    expect(raiseFloat(layout, 'missing')).toBe(layout);
  });

  it('raises a window a panel is placed into, and one being moved', () => {
    const layout = threeWindows();
    const bottom = layout.floats[0]!.id;
    const stacked = placePanel(layout, 'parameters', {
      kind: 'group',
      groupId: bottom
    });
    expect(stacked.floats.at(-1)!.panels).toEqual(['history', 'parameters']);
    expect(
      moveFloat(layout, bottom, { x: 300, y: 300 }, STAGE).floats.at(-1)!.id
    ).toBe(bottom);
    expect(
      resizeFloat(layout, bottom, { w: 400, h: 400 }, STAGE).floats.at(-1)!.id
    ).toBe(bottom);
  });

  it('brings a covered window to the front from the rail instead of closing it', () => {
    const layout = threeWindows();
    expect(isFloatCovered(layout, 'history', STAGE)).toBe(true);
    expect(isFloatCovered(layout, 'diagnostics', STAGE)).toBe(false);
    const raised = togglePanel(layout, 'history', STAGE);
    expect(panelStatus(raised, 'history')).toBe('floating');
    expect(order(raised).at(-1)).toBe('history');
    expect(raised.recent[0]).toBe('history');
    // On top now, the next press closes it.
    expect(panelStatus(togglePanel(raised, 'history', STAGE), 'history')).toBe(
      'closed'
    );
    // A lower window nothing overlaps closes on the first press.
    const apart = moveFloat(
      layout,
      layout.floats[0]!.id,
      { x: 900, y: 100 },
      STAGE
    );
    const lowered = raiseFloat(
      raiseFloat(apart, apart.floats[0]!.id),
      apart.floats[1]!.id
    );
    expect(order(lowered)[0]).toBe('history');
    expect(isFloatCovered(lowered, 'history', STAGE)).toBe(false);
    expect(panelStatus(togglePanel(lowered, 'history', STAGE), 'history')).toBe(
      'closed'
    );
    // Only floating panels can be covered.
    expect(isFloatCovered(essentials(), 'parameters', STAGE)).toBe(false);
  });

  it('closes the phone lane panel on a press even when its stored window is covered', () => {
    // A window's move or resize raises it without counting as a use, so the
    // lane can show a panel whose stored window sits under another one.
    const layout = threeWindows();
    const shown: PanelLayout = {
      ...layout,
      recent: ['history', ...layout.recent.filter((id) => id !== 'history')]
    };
    const phone = { width: 390, height: 844 };
    expect(isFloatCovered(shown, 'history', STAGE)).toBe(true);
    expect(computePanelGeometry(shown, phone).phonePanel).toBe('history');
    expect(panelStatus(togglePanel(shown, 'history', phone), 'history')).toBe(
      'closed'
    );
  });

  it('hit-tests the raised window first', () => {
    const layout = threeWindows();
    const point = { x: 250, y: 250 };
    const top = computePanelGeometry(layout, STAGE);
    expect(hitTest(top, point)).toMatchObject({
      groupId: layout.floats[2]!.id
    });
    const raised = notePanelUsed(layout, 'history');
    expect(hitTest(computePanelGeometry(raised, STAGE), point)).toMatchObject({
      groupId: layout.floats[0]!.id
    });
  });
});

describe('a locked layout', () => {
  function locked(): PanelLayout {
    let layout = applyPreset(modelOnly(), 'full');
    layout = popOutPanel(layout, 'diagnostics', {
      x: 400,
      y: 200,
      w: 300,
      h: 300
    });
    return setOption(layout, 'locked', true);
  }

  it('refuses placing, dragging and resizing', () => {
    const layout = locked();
    const groupId = layout.floats[0]!.id;
    const targets: PanelTarget[] = [
      { kind: 'column', side: 'right', column: 0, index: 0 },
      { kind: 'newColumn', side: 'left' },
      { kind: 'float', rect: { x: 100, y: 100, w: 300, h: 300 } },
      { kind: 'group', groupId }
    ];
    for (const target of targets) {
      expect(placePanel(layout, 'bodies', target)).toBe(layout);
      expect(placePanel(layout, 'bodies', target, STAGE)).toBe(layout);
      expect(previewLayout(layout, 'bodies', target, STAGE)).toBeNull();
    }
    expect(beginDrag(layout, 'bodies')).toBe(layout);
    expect(resizeGap(layout, 'bodies', 'history', 40, 1)).toBe(layout);
    expect(splitGapEvenly(layout, 'bodies', 'history')).toBe(layout);
    expect(moveFloat(layout, groupId, { x: 10, y: 10 }, STAGE)).toBe(layout);
    expect(resizeFloat(layout, groupId, { w: 500, h: 500 }, STAGE)).toBe(
      layout
    );
    expect(clampFloatsToStage(layout, { width: 600, height: 300 })).toBe(
      layout
    );
    // Presets and the width rearrange or resize every panel.
    for (const preset of PANEL_PRESET_IDS) {
      expect(applyPreset(layout, preset)).toBe(layout);
    }
    expect(applyPreset(layout, ESSENTIALS_RIGHT_PRESET)).toBe(layout);
    expect(setOption(layout, 'width', 'wide')).toBe(layout);
  });

  it('still pins, unpins, pops out, opens, closes and changes settings', () => {
    const layout = locked();
    const closed = closePanel(layout, 'history');
    expect(panelStatus(closed, 'history')).toBe('closed');
    // Reopening at its home is not a rearrangement the lock refuses.
    expect(openPanel(closed, 'history').left).toEqual([['bodies', 'history']]);
    expect(togglePanel(closed, 'history').left).toEqual([
      ['bodies', 'history']
    ]);
    expect(panelStatus(togglePanel(layout, 'history'), 'history')).toBe(
      'closed'
    );
    const opened = openPanel(layout, 'revisions');
    expect(panelStatus(opened, 'revisions')).toBe('docked');
    const popped = popOutPanel(layout, 'parameters', {
      x: 500,
      y: 100,
      w: 300,
      h: 300
    });
    expect(panelStatus(popped, 'parameters')).toBe('floating');
    expect(pinPanel(popped, 'parameters').right).toEqual([
      ['revisions', 'parameters']
    ]);
    expect(panelStatus(unpinPanel(layout, 'bodies'), 'bodies')).toBe(
      'unpinned'
    );
    expect(setOption(layout, 'compact', true).options.compact).toBe(true);
    const unlocked = setOption(layout, 'locked', false);
    expect(
      placePanel(unlocked, 'bodies', { kind: 'newColumn', side: 'right' }).right
    ).toEqual([['parameters', 'revisions'], ['bodies']]);
  });
});

describe('gap resizing with a held panel', () => {
  it('moves a held panel’s edge with the drag, and not before', () => {
    const layout = layoutWith({
      right: [['parameters', 'revisions']],
      weights: { ...modelOnly().weights, parameters: 0.1, revisions: 3 }
    });
    const before = computePanelGeometry(layout, STAGE);
    // Parameters' share is under 90px, so it is held there.
    expect(before.panels.parameters!.h).toBeCloseTo(PANEL_MIN_HEIGHT, 9);
    const gap = before.gaps.find(
      (candidate) => candidate.above === 'parameters'
    )!;
    expect(gap.enabled).toBe(true);
    expect(
      resizeGap(layout, 'parameters', 'revisions', 0, gap.pxPerWeight)
    ).toBe(layout);
    for (const delta of [1, 10, 200]) {
      const after = computePanelGeometry(
        resizeGap(layout, 'parameters', 'revisions', delta, gap.pxPerWeight),
        STAGE
      );
      expect(after.panels.parameters!.h).toBeCloseTo(
        before.panels.parameters!.h + delta,
        6
      );
      expect(after.panels.revisions!.h).toBeCloseTo(
        before.panels.revisions!.h - delta,
        6
      );
    }
  });

  it('keeps a closed panel’s height when it reopens at home', () => {
    let layout = applyPreset(modelOnly(), 'full');
    layout = resizeGap(layout, 'parameters', 'revisions', 60, 600);
    const weights = { ...layout.weights };
    const reopened = openPanel(closePanel(layout, 'parameters'), 'parameters');
    expect(reopened.right).toEqual(layout.right);
    expect(reopened.weights).toEqual(weights);
  });
});

describe('docked panels hugging their content', () => {
  const column = (): PanelLayout =>
    layoutWith({ right: [['parameters', 'bodies', 'history']] });

  it('draws a panel no taller than its natural height', () => {
    const stage: PanelStage = { ...STAGE, naturals: { bodies: 120 } };
    const plain = computePanelGeometry(column(), STAGE);
    const hugged = computePanelGeometry(column(), stage);
    expect(hugged.panels.bodies!.h).toBe(120);
    // The others share what it leaves, and the column still fills.
    const freed = plain.panels.bodies!.h - 120;
    expect(hugged.panels.parameters!.h).toBeCloseTo(
      plain.panels.parameters!.h + freed / 2,
      6
    );
    expect(hugged.panels.history!.h).toBeCloseTo(
      plain.panels.history!.h + freed / 2,
      6
    );
    expect(hugged.columns[0]!.contentHeight).toBe(hugged.columns[0]!.h);
  });

  it('ends a column short when every panel hugs, giving the model the rest', () => {
    const stage: PanelStage = {
      ...STAGE,
      naturals: { parameters: 200, bodies: 60, history: 150 }
    };
    const geometry = computePanelGeometry(column(), stage);
    // Under 90px is that panel's minimum too.
    expect(geometry.panels.bodies!.h).toBe(60);
    expect(geometry.panels.history!.y).toBe(
      geometry.dock.top + 200 + 60 + PANEL_STACK_GAP * 2
    );
    expect(geometry.columns[0]!.contentHeight).toBe(
      200 + 60 + 150 + PANEL_STACK_GAP * 2
    );
    // Nothing to trade between two hugging panels.
    expect(geometry.gaps.every((gap) => !gap.enabled)).toBe(true);
  });

  it('fills every share with Fit panels to content off', () => {
    const plain = computePanelGeometry(column(), STAGE);
    const unfit = computePanelGeometry(setOption(column(), 'fit', false), {
      ...STAGE,
      naturals: { parameters: 100, bodies: 60, history: 150 }
    });
    expect(unfit.panels).toEqual(plain.panels);
    // A stored layout without the option fits, as a new one does.
    expect(normalizePanelLayout({ right: [['history']] }).options.fit).toBe(
      true
    );
    expect(
      normalizePanelLayout({ right: [['history']], options: { fit: false } })
        .options.fit
    ).toBe(false);
  });

  it('gives a light panel the room a heavy neighbour’s cap frees', () => {
    // Weighted 1:100, History's share is under 90px; Parameters hugs 100px
    // of content, so History takes the rest of the column, not 90px.
    const layout = layoutWith({
      right: [['history', 'parameters']],
      weights: { ...modelOnly().weights, history: 1, parameters: 100 }
    });
    const stage: PanelStage = { ...STAGE, naturals: { parameters: 100 } };
    const geometry = computePanelGeometry(layout, stage);
    const dock = geometry.dock.bottom - geometry.dock.top;
    expect(geometry.panels.parameters!.h).toBe(100);
    expect(geometry.panels.history!.h).toBeCloseTo(
      dock - 100 - PANEL_STACK_GAP,
      6
    );
    expect(geometry.columns[0]!.contentHeight).toBe(dock);
    expect(geometry.gaps[0]!.enabled).toBe(true);
  });

  it('turns off a gap whose two panels both hug while a third fills', () => {
    const stage: PanelStage = {
      ...STAGE,
      naturals: { parameters: 120, bodies: 100 }
    };
    const geometry = computePanelGeometry(column(), stage);
    const capped = geometry.gaps.find((gap) => gap.above === 'parameters')!;
    const flexible = geometry.gaps.find((gap) => gap.above === 'bodies')!;
    // The stack still has a flexible panel, so its scale is not zero, but
    // neither hugging neighbour can move: every drag would be a no-op.
    expect(capped.pxPerWeight).toBeGreaterThan(0);
    expect(capped.enabled).toBe(false);
    expect(flexible.enabled).toBe(true);
  });

  it('never hugs a window: its panels fill the height it was given', () => {
    const layout = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 400
    });
    const geometry = computePanelGeometry(layout, {
      ...STAGE,
      naturals: { history: 120 }
    });
    expect(geometry.panels.history!.h).toBe(400);
  });

  it('drags a gap from the drawn heights, never past a panel’s content', () => {
    const stage: PanelStage = { ...STAGE, naturals: { bodies: 150 } };
    const layout = column();
    const before = computePanelGeometry(layout, stage);
    const gap = before.gaps.find((candidate) => candidate.above === 'bodies')!;
    expect(gap.shown).toMatchObject({ above: 150, aboveMax: 150 });
    // Growing the hugging panel is refused; shrinking it follows the pointer.
    expect(
      resizeGap(layout, 'bodies', 'history', 40, gap.pxPerWeight, gap.shown)
    ).toBe(layout);
    const after = computePanelGeometry(
      resizeGap(layout, 'bodies', 'history', -40, gap.pxPerWeight, gap.shown),
      stage
    );
    expect(after.panels.bodies!.h).toBeCloseTo(110, 6);
    expect(after.panels.history!.h).toBeCloseTo(
      before.panels.history!.h + 40,
      6
    );
    expect(after.panels.parameters!.h).toBeCloseTo(
      before.panels.parameters!.h,
      6
    );
  });
});

describe('gaps between panels', () => {
  const layout = layoutWith({ right: [['parameters', 'bodies', 'history']] });

  it('resizes two neighbours and keeps the rest', () => {
    const geometry = computePanelGeometry(layout, STAGE);
    const gapGeometry = geometry.gaps.find((g) => g.above === 'parameters')!;
    expect(gapGeometry.below).toBe('bodies');
    expect(gapGeometry.enabled).toBe(true);
    const resized = resizeGap(
      layout,
      'parameters',
      'bodies',
      60,
      gapGeometry.pxPerWeight
    );
    const after = computePanelGeometry(resized, STAGE);
    expect(after.panels.parameters!.h).toBeCloseTo(
      geometry.panels.parameters!.h + 60
    );
    expect(after.panels.bodies!.h).toBeCloseTo(geometry.panels.bodies!.h - 60);
    expect(after.panels.history!.h).toBeCloseTo(geometry.panels.history!.h);
    expect(resized.weights.history).toBe(layout.weights.history);
  });

  it('holds each neighbour at 90px', () => {
    const geometry = computePanelGeometry(layout, STAGE);
    const px = geometry.gaps[0]!.pxPerWeight;
    for (const delta of [10000, -10000]) {
      const after = computePanelGeometry(
        resizeGap(layout, 'parameters', 'bodies', delta, px),
        STAGE
      );
      const smaller = Math.min(
        after.panels.parameters!.h,
        after.panels.bodies!.h
      );
      expect(smaller).toBeCloseTo(PANEL_MIN_HEIGHT);
    }
  });

  it('ignores panels that are not neighbours and bad scales', () => {
    expect(resizeGap(layout, 'parameters', 'history', 40, 1)).toBe(layout);
    expect(resizeGap(layout, 'bodies', 'parameters', 40, 1)).toBe(layout);
    expect(resizeGap(layout, 'parameters', 'bodies', 40, 0)).toBe(layout);
    expect(resizeGap(layout, 'parameters', 'bodies', Number.NaN, 1)).toBe(
      layout
    );
    expect(splitGapEvenly(layout, 'parameters', 'history')).toBe(layout);
  });

  it('keeps held-at-minimum weights on a zero or clamped gap drag', () => {
    const weighted = layoutWith({
      right: [['parameters', 'history']],
      weights: { ...modelOnly().weights, parameters: 0.1, history: 3 }
    });
    const small = { width: 1440, height: 390 };
    const shown = computePanelGeometry(weighted, small);
    expect(shown.panels.parameters!.h).toBe(PANEL_MIN_HEIGHT);
    for (const delta of [0, -30]) {
      const resized = resizeGap(
        weighted,
        'parameters',
        'history',
        delta,
        shown.gaps[0]!.pxPerWeight
      );
      expect(resized).toBe(weighted);
      expect(computePanelGeometry(resized, STAGE)).toEqual(
        computePanelGeometry(weighted, STAGE)
      );
    }
  });

  it('resizes from held minimum heights without changing a third panel', () => {
    const weighted = layoutWith({
      right: [['parameters', 'bodies', 'history']],
      weights: {
        ...modelOnly().weights,
        parameters: 0.1,
        bodies: 3,
        history: 3
      }
    });
    const small = { width: 1440, height: 500 };
    const before = computePanelGeometry(weighted, small);
    const resized = resizeGap(
      weighted,
      'parameters',
      'bodies',
      30,
      before.gaps[0]!.pxPerWeight
    );
    const after = computePanelGeometry(resized, small);
    expect(after.panels.parameters!.h).toBeCloseTo(
      before.panels.parameters!.h + 30
    );
    expect(after.panels.bodies!.h).toBeCloseTo(before.panels.bodies!.h - 30);
    expect(after.panels.history!.h).toBeCloseTo(before.panels.history!.h);
  });

  it('splits two neighbours evenly, the rest keeping its share', () => {
    const skewed: PanelLayout = {
      ...layout,
      weights: { ...layout.weights, parameters: 1.6, bodies: 0.4, history: 2 }
    };
    const even = splitGapEvenly(skewed, 'parameters', 'bodies');
    expect(even.weights.parameters).toBeCloseTo(1);
    expect(even.weights.bodies).toBeCloseTo(1);
    expect(even.weights.history).toBe(2);
  });

  it('splits shown neighbours evenly when one is held at its minimum', () => {
    const weighted = layoutWith({
      right: [['parameters', 'bodies', 'history']],
      weights: {
        ...modelOnly().weights,
        parameters: 0.1,
        bodies: 3,
        history: 3
      }
    });
    const small = { width: 1440, height: 500 };
    const before = computePanelGeometry(weighted, small);
    const even = splitGapEvenly(
      weighted,
      'parameters',
      'bodies',
      before.gaps[0]!.pxPerWeight
    );
    const after = computePanelGeometry(even, small);
    expect(after.panels.parameters!.h).toBeCloseTo(after.panels.bodies!.h);
    expect(after.panels.parameters!.h).toBeCloseTo(
      (before.panels.parameters!.h + before.panels.bodies!.h) / 2
    );
    expect(after.panels.history!.h).toBeCloseTo(before.panels.history!.h);
  });

  it('resizes the gaps inside a floating window too', () => {
    let floating = popOutPanel(modelOnly(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    floating = placePanel(floating, 'revisions', {
      kind: 'group',
      groupId: 'float-1'
    });
    const geometry = computePanelGeometry(floating, STAGE);
    const gapGeometry = geometry.gaps[0]!;
    expect(gapGeometry.container).toEqual({
      kind: 'float',
      groupId: 'float-1'
    });
    const resized = resizeGap(
      floating,
      'history',
      'revisions',
      30,
      gapGeometry.pxPerWeight
    );
    expect(computePanelGeometry(resized, STAGE).panels.history!.h).toBeCloseTo(
      geometry.panels.history!.h + 30
    );
  });
});

describe('the dock footprint cap', () => {
  it('counts both rails and every gap', () => {
    // 60px a side, a column and the 4px dock gap 300px, Essentials 720px.
    expect(SIDE_COST).toBe(60);
    expect(CW + BETWEEN).toBe(300);
    expect(dockFootprint({ left: 1, right: 1 }, CW)).toBe(720);
    expect(dockFootprint({ left: 0, right: 1 }, CW)).toBe(420);
    expect(stageFitting(2)).toBeCloseTo(1200);
    // Rail and gaps are parameters, not built into the boundary.
    expect(
      dockFootprint({ left: 1, right: 1 }, CW, {
        gap: 12,
        between: 6,
        rail: 44
      })
    ).toBe((12 + 44 + 12) * 2 + 2 * (CW + 6));
  });

  it('docks Essentials fully from 1200px and parks Objects at 1199px', () => {
    const layout = essentials();
    const fits = Math.ceil(stageFitting(2));
    const wide = computePanelGeometry(layout, { width: fits, height: 900 });
    expect(wide.columns).toHaveLength(2);
    expect(wide.floats).toEqual([]);

    const before = structuredClone(layout);
    const narrow = computePanelGeometry(layout, {
      width: fits - 1,
      height: 900
    });
    // The left column gives way; Parameters stays docked on the right.
    expect(
      narrow.columns.map((column) => [column.side, column.panels])
    ).toEqual([['right', ['parameters']]]);
    expect(narrow.panels.parameters!.mode).toBe('docked');
    expect(narrow.parked.parameters).toBe(false);
    // Parked, not floated: no window and no rectangle for Objects.
    expect(narrow.parked.bodies).toBe(true);
    expect(narrow.parkedPanels).toEqual(['bodies']);
    expect(narrow.parkedColumns).toEqual([{ side: 'left', column: 0 }]);
    expect(narrow.panels.bodies).toBeUndefined();
    expect(narrow.floats).toEqual([]);
    // A projection only: the stored layout is unchanged.
    expect(layout).toEqual(before);
    expect(narrow.dockWidth).toEqual({ left: 0, right: CW + BETWEEN });
  });

  it('re-runs the cap for the panel width: Large parks Essentials’ left column at 1280px', () => {
    const stage = { width: 1280, height: 720 };
    for (const width of ['narrow', 'regular'] as const) {
      const geometry = computePanelGeometry(
        setOption(essentials(), 'width', width),
        stage
      );
      expect(geometry.columns, width).toHaveLength(2);
      expect(geometry.columnWidth).toBe(PANEL_COLUMN_WIDTHS[width]);
    }
    const wide = setOption(essentials(), 'width', 'wide');
    // 60px a side and 364px a column: 848px, past 60% of 1280px (768px).
    expect(dockFootprint({ left: 1, right: 1 }, 360)).toBe(848);
    const geometry = computePanelGeometry(wide, stage);
    expect(geometry.parkedColumns).toEqual([{ side: 'left', column: 0 }]);
    expect(geometry.parked.bodies).toBe(true);
    expect(geometry.panels.parameters).toMatchObject({
      mode: 'docked',
      w: 360
    });
    // A projection: the stored layout keeps Objects docked.
    expect(wide.left).toEqual([['bodies']]);
    expect(
      computePanelGeometry(setOption(wide, 'width', 'regular'), stage).parked
        .bodies
    ).toBe(false);
  });

  it('docks one column at 721px', () => {
    expect(stageFitting(1)).toBeLessThanOrEqual(PANEL_PHONE_MAX_WIDTH + 1);
    const geometry = computePanelGeometry(essentials(), {
      width: PANEL_PHONE_MAX_WIDTH + 1,
      height: 900
    });
    expect(geometry.phone).toBe(false);
    expect(geometry.columns.map((column) => column.panels)).toEqual([
      ['parameters']
    ]);
  });

  it('parks every left column before any right one, outermost first', () => {
    const layout = layoutWith({
      left: [['bodies'], ['history']],
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    const dockedAt = (columns: number) =>
      computePanelGeometry(layout, {
        // One column fits under 721px, where the phone rule takes over.
        width: Math.max(
          Math.ceil(stageFitting(columns)),
          PANEL_PHONE_MAX_WIDTH + 1
        ),
        height: 900
      });
    const docked = (columns: number) =>
      dockedAt(columns).columns.map(
        (column) => `${column.side}${column.column}`
      );
    expect(docked(5)).toEqual(['right0', 'right1', 'right2', 'left0', 'left1']);
    expect(docked(4)).toEqual(['right0', 'right1', 'right2', 'left0']);
    expect(docked(3)).toEqual(['right0', 'right1', 'right2']);
    expect(docked(2)).toEqual(['right0', 'right1']);
    expect(docked(1)).toEqual(['right0']);
    expect(dockedAt(2).parkedPanels).toEqual([
      'diagnostics',
      'bodies',
      'history'
    ]);
    expect(dockedAt(2).parkedColumns).toEqual([
      { side: 'right', column: 2 },
      { side: 'left', column: 0 },
      { side: 'left', column: 1 }
    ]);
  });

  it('gives back the columns when the stage widens again', () => {
    const layout = essentials();
    computePanelGeometry(layout, { width: 900, height: 600 });
    expect(computePanelGeometry(layout, STAGE).columns).toHaveLength(2);
  });

  it('refuses a pin or drop that would go past the cap', () => {
    const fits = Math.ceil(stageFitting(2));
    const layout = layoutWith({ left: [['bodies']] });
    const unpinned = openPanel(layout, 'parameters');
    const narrow: PanelStage = { width: fits - 1, height: 900 };
    const pin: PanelTarget = { kind: 'column', side: 'right', column: 0 };
    expect(wouldExceedCap(unpinned, 'parameters', pin, narrow)).toBe(true);
    // Refused: the same layout back, the panel still unpinned, no window.
    const refused = pinPanel(unpinned, 'parameters', narrow);
    expect(refused).toBe(unpinned);
    expect(panelStatus(refused, 'parameters')).toBe('unpinned');
    expect(refused.floats).toEqual([]);
    expect(previewLayout(unpinned, 'parameters', pin, narrow)).toBeNull();
    // Where it fits it docks.
    const docked = pinPanel(unpinned, 'parameters', {
      width: fits,
      height: 900
    });
    expect(docked.right).toEqual([['parameters']]);
    // A new column past the cap is refused; stacking in an existing column
    // adds nothing and still docks.
    const essentialsLayout = essentials();
    const newColumn: PanelTarget = { kind: 'newColumn', side: 'right' };
    expect(placePanel(essentialsLayout, 'history', newColumn, narrow)).toBe(
      essentialsLayout
    );
    const stacked = placePanel(
      essentialsLayout,
      'history',
      { kind: 'column', side: 'right', column: 0 },
      narrow
    );
    expect(stacked.right).toEqual([['parameters', 'history']]);
    // Moving a lone column's panel to a new column elsewhere counts the
    // column it leaves: the footprint does not grow.
    expect(wouldExceedCap(layout, 'bodies', newColumn, narrow)).toBe(false);
    expect(wouldExceedCap(essentialsLayout, 'bodies', newColumn, narrow)).toBe(
      true
    );
    // Without a stage there is no cap to check.
    expect(pinPanel(unpinned, 'parameters').right).toEqual([['parameters']]);
  });

  it('opens a panel unpinned when its home is past the cap', () => {
    const fits = Math.ceil(stageFitting(2));
    const closed = closePanel(essentials(), 'parameters');
    const narrow: PanelStage = { width: fits - 1, height: 900 };
    const opened = openPanel(closed, 'parameters', narrow);
    expect(opened.unpinned).toBe('parameters');
    expect(opened.right).toEqual([]);
    expect(openPanel(closed, 'parameters', STAGE).right).toEqual([
      ['parameters']
    ]);
  });

  it('never makes a window on its own', () => {
    const layout = layoutWith({
      left: [['bodies'], ['history']],
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    for (const width of [3000, 1440, 1219, 900, 721, 720, 390]) {
      expect(
        computePanelGeometry(layout, { width, height: 900 }).floats
      ).toEqual([]);
    }
  });
});

describe('parked panels in the unpinned slot', () => {
  const narrow: PanelStage = {
    width: Math.ceil(stageFitting(2)) - 1,
    height: 900
  };

  it('shows a parked panel in the slot from the rail and hides it again', () => {
    const layout = openPanel(essentials(), 'history');
    // Objects is parked at this width; a press shows it in the slot, which
    // the unpinned History gives up.
    const shown = togglePanel(layout, 'bodies', narrow);
    expect(shown.revealed).toBe('bodies');
    expect(shown.unpinned).toBeNull();
    expect(shown.left).toEqual([['bodies']]);
    expect(panelStatus(shown, 'bodies')).toBe('docked');
    const geometry = computePanelGeometry(shown, narrow);
    expect(geometry.panels.bodies!.mode).toBe('revealed');
    expect(geometry.panels.history).toBeUndefined();
    // A second press hides it; it is still docked.
    const hidden = togglePanel(shown, 'bodies', narrow);
    expect(hidden.revealed).toBeNull();
    expect(hidden.left).toEqual([['bodies']]);
    expect(computePanelGeometry(hidden, narrow).panels.bodies).toBeUndefined();
    // Opening it (⌘K, say) shows it the same way.
    expect(openPanel(essentials(), 'bodies', narrow).revealed).toBe('bodies');
  });

  it('never places a panel into a parked column', () => {
    // Objects and History share the left column; at this width it parks.
    const shared = placePanel(essentials(), 'history', {
      kind: 'column',
      side: 'left',
      column: 0
    });
    expect(shared.left).toEqual([['bodies', 'history']]);
    const closed = closePanel(shared, 'history');
    const target: PanelTarget = { kind: 'column', side: 'left', column: 0 };
    expect(wouldExceedCap(closed, 'history', target, narrow)).toBe(true);
    expect(placePanel(closed, 'history', target, narrow)).toBe(closed);
    // Its home is in the parked column, so the rail opens it unpinned.
    const opened = openPanel(closed, 'history', narrow);
    expect(opened.unpinned).toBe('history');
    expect(opened.left).toEqual([['bodies']]);
    expect(computePanelGeometry(opened, narrow).panels.history!.mode).toBe(
      'unpinned'
    );
    // On a stage where the column docks, the home is used.
    expect(openPanel(closed, 'history', STAGE).left).toEqual([
      ['bodies', 'history']
    ]);
  });

  it('refuses a new column on a full dock whose outermost column is parked', () => {
    const layout = layoutWith({
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    expect(layout.right).toHaveLength(PANEL_MAX_COLUMNS.right);
    const geometry = computePanelGeometry(layout, STAGE);
    expect(geometry.parked.diagnostics).toBe(true);
    const target: PanelTarget = { kind: 'newColumn', side: 'right' };
    const unpinned = openPanel(layout, 'history');
    expect(wouldExceedCap(unpinned, 'history', target, STAGE)).toBe(true);
    expect(placePanel(unpinned, 'history', target, STAGE)).toBe(unpinned);
    // Wide enough for all three, the same drop stacks in the outermost one.
    const wide: PanelStage = { width: 2400, height: 900 };
    expect(placePanel(unpinned, 'history', target, wide).right).toEqual([
      ['parameters'],
      ['revisions'],
      ['diagnostics', 'history']
    ]);
  });

  it('shows the slot of a new-column drop that the emptied column makes room for', () => {
    const layout = layoutWith({ right: [['parameters'], ['revisions']] });
    const stage: PanelStage = {
      width: Math.ceil(stageFitting(2)),
      height: 900
    };
    const target: PanelTarget = { kind: 'newColumn', side: 'right' };
    const preview = previewLayout(layout, 'parameters', target, stage)!;
    expect(preview.right).toEqual([[], ['revisions'], [PANEL_SLOT]]);
    const geometry = computePanelGeometry(preview, stage);
    expect(geometry.panels[PANEL_SLOT]).toBeDefined();
    expect(geometry.parkedPanels).toEqual([]);
    expect(commitPreview(preview, 'parameters').right).toEqual([
      ['revisions'],
      ['parameters']
    ]);
  });

  it('does not widen the dock when a parked column is emptied by a drag', () => {
    const layout = layoutWith({
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    const stage: PanelStage = {
      width: Math.ceil(stageFitting(2)),
      height: 900
    };
    const before = computePanelGeometry(layout, stage);
    expect(before.parked.diagnostics).toBe(true);
    const lifted = computePanelGeometry(
      beginDrag(layout, 'diagnostics'),
      stage
    );
    expect(lifted.dockWidth).toEqual(before.dockWidth);
    expect(lifted.rails.right.x).toBe(before.rails.right.x);
    // With room for it, an emptied outer column keeps its place.
    const wide: PanelStage = { width: 2400, height: 900 };
    const roomy = computePanelGeometry(beginDrag(layout, 'diagnostics'), wide);
    expect(roomy.dockWidth.right).toBe(
      computePanelGeometry(layout, wide).dockWidth.right
    );
  });

  it('keeps a later parked column parked when a drag empties an earlier one', () => {
    const layout = layoutWith({
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    const stage: PanelStage = {
      width: Math.ceil(stageFitting(2)),
      height: 900
    };
    const before = computePanelGeometry(layout, stage);
    expect(before.parked.diagnostics).toBe(true);
    const lifted = computePanelGeometry(beginDrag(layout, 'parameters'), stage);
    expect(lifted.parked.diagnostics).toBe(true);
    expect(lifted.dockWidth).toEqual(before.dockWidth);
    expect(lifted.rails.right.x).toBe(before.rails.right.x);
  });

  it('lets a layout past the cap consolidate columns', () => {
    const layout = layoutWith({
      left: [['bodies']],
      right: [['parameters'], ['revisions']]
    });
    const stage: PanelStage = {
      width: Math.ceil(stageFitting(2)),
      height: 900
    };
    // Three columns do not fit here, so the left one is parked.
    expect(computePanelGeometry(layout, stage).parked.bodies).toBe(true);
    const target: PanelTarget = { kind: 'column', side: 'right', column: 1 };
    expect(wouldExceedCap(layout, 'parameters', target, stage)).toBe(false);
    const merged = placePanel(layout, 'parameters', target, stage);
    expect(merged.right).toEqual([['revisions', 'parameters']]);
    expect(merged.left).toEqual([['bodies']]);
    // Two columns now fit, so nothing is parked any more.
    expect(computePanelGeometry(merged, stage).parkedPanels).toEqual([]);
  });

  it('draws a panel in one place only as the width changes', () => {
    const shown = togglePanel(essentials(), 'bodies', narrow);
    for (const width of [narrow.width, 1440, narrow.width, 1600]) {
      const geometry = computePanelGeometry(shown, { width, height: 900 });
      const parked = geometry.parked.bodies;
      // Parked: in the slot. Fits again: docked, and the slot is closed.
      expect(geometry.panels.bodies!.mode).toBe(parked ? 'revealed' : 'docked');
      const unpinnedSlot = Object.values(geometry.panels).filter(
        (rect) => rect.mode === 'revealed' || rect.mode === 'unpinned'
      );
      expect(unpinnedSlot).toHaveLength(parked ? 1 : 0);
      expect(
        geometry.columns.some((column) => column.panels.includes('bodies'))
      ).toBe(!parked);
    }
  });

  it('never stores a revealed panel', () => {
    const storage = memoryStorage();
    savePanelLayout(togglePanel(essentials(), 'bodies', narrow), storage);
    expect(loadPanelLayout(storage).revealed).toBeNull();
    expect(normalizePanelLayout({ revealed: 'bodies' }).revealed).toBeNull();
  });

  it('closes a revealed panel like any docked one', () => {
    const shown = togglePanel(essentials(), 'bodies', narrow);
    const closed = closePanel(shown, 'bodies');
    expect(closed.revealed).toBeNull();
    expect(closed.homes.bodies).toEqual({
      kind: 'column',
      side: 'left',
      column: 0,
      index: 0,
      alone: true,
      peers: ['bodies']
    });
    // Opening another panel unpinned takes the slot back.
    expect(openPanel(shown, 'history').revealed).toBeNull();
  });
});

describe('Hide all', () => {
  it('projects no panels and reserves no dock width', () => {
    let layout = popOutPanel(essentials(), 'history', {
      x: 400,
      y: 200,
      w: 300,
      h: 300
    });
    layout = openPanel(layout, 'revisions');
    const shown = computePanelGeometry(layout, STAGE);
    const hidden = setOption(layout, 'hidden', true);
    const geometry = computePanelGeometry(hidden, STAGE);
    expect(geometry.panels).toEqual({});
    expect(geometry.columns).toEqual([]);
    expect(geometry.floats).toEqual([]);
    expect(geometry.gaps).toEqual([]);
    expect(geometry.dockWidth).toEqual({ left: 0, right: 0 });
    expect(geometry.rails.right.x + geometry.rails.right.w).toBe(
      STAGE.width - GAP
    );
    expect(
      computePanelGeometry(hidden, { width: 600, height: 844 }).phonePanel
    ).toBeNull();
    // The arrangement is kept, and unhiding draws it as before.
    expect(
      computePanelGeometry(setOption(hidden, 'hidden', false), STAGE)
    ).toEqual(shown);
  });

  it('judges parking against the arrangement, not the hidden projection', () => {
    const narrow: PanelStage = {
      width: Math.ceil(stageFitting(2)) - 1,
      height: 900
    };
    const hidden = setOption(essentials(), 'hidden', true);
    // Objects is parked at this width; opening it while hidden reveals it.
    const opened = openPanel(hidden, 'bodies', narrow);
    expect(opened.options.hidden).toBe(false);
    expect(opened.revealed).toBe('bodies');
  });
});

describe('phone-width stages', () => {
  it('docks nothing at 720px and below', () => {
    for (const width of [PANEL_PHONE_MAX_WIDTH, 600, 390]) {
      const geometry = computePanelGeometry(essentials(), {
        width,
        height: 844
      });
      expect(geometry.phone).toBe(true);
      expect(geometry.columns).toEqual([]);
      expect(geometry.dockWidth).toEqual({ left: 0, right: 0 });
      expect(geometry.phonePanels).toEqual(['parameters', 'bodies']);
      expect(geometry.phonePanel).toBe('parameters');
      expect(geometry.panels.parameters).toBeUndefined();
      // Nothing to drop into either.
      const target = hitTest(geometry, { x: width - 100, y: 300 });
      expect(target).toBeNull();
    }
    expect(
      computePanelGeometry(essentials(), { width: 721, height: 844 }).phone
    ).toBe(false);
  });

  it('refuses every placement and keeps homes', () => {
    const phoneStage: PanelStage = {
      width: PANEL_PHONE_MAX_WIDTH,
      height: 844
    };
    const layout = openPanel(essentials(), 'history');
    expect(layout.unpinned).toBe('history');
    for (const target of [
      { kind: 'column', side: 'right', column: 0 },
      { kind: 'newColumn', side: 'right' },
      { kind: 'column', side: 'left', column: 0, index: 0 }
    ] satisfies PanelTarget[]) {
      expect(wouldExceedCap(layout, 'history', target, phoneStage)).toBe(true);
      expect(placePanel(layout, 'history', target, phoneStage)).toBe(layout);
    }
    expect(pinPanel(layout, 'history', phoneStage)).toBe(layout);
    // No windows either: a drop on the stage or a pop-out leaves it alone.
    const rect = { x: 100, y: 100, w: 300, h: 300 };
    expect(
      placePanel(layout, 'history', { kind: 'float', rect }, phoneStage)
    ).toBe(layout);
    expect(popOutPanel(layout, 'history', rect, phoneStage)).toBe(layout);
    const windowed = popOutPanel(layout, 'revisions', rect);
    const groupId = windowed.floats[0]!.id;
    expect(
      placePanel(windowed, 'history', { kind: 'group', groupId }, phoneStage)
    ).toBe(windowed);
    // One pixel wider, the pin docks.
    expect(
      pinPanel(layout, 'history', { width: 721, height: 844 }).right
    ).toEqual([['parameters', 'history']]);
    // A closed panel reopens at its home, shown in the phone lane.
    const closed = closePanel(essentials(), 'parameters');
    const reopened = openPanel(closed, 'parameters', phoneStage);
    expect(reopened.right).toEqual([['parameters']]);
    expect(computePanelGeometry(reopened, phoneStage).phonePanel).toBe(
      'parameters'
    );
  });

  it('brings an open panel to the lane from the rail, closing only the shown one', () => {
    const phoneStage: PanelStage = { width: 600, height: 844 };
    let layout = notePanelUsed(essentials(), 'parameters');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe(
      'parameters'
    );
    // Objects is open but not shown: the press shows it.
    layout = togglePanel(layout, 'bodies', phoneStage);
    expect(panelStatus(layout, 'bodies')).toBe('docked');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe('bodies');
    // Pressed again while shown, it closes.
    layout = togglePanel(layout, 'bodies', phoneStage);
    expect(panelStatus(layout, 'bodies')).toBe('closed');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe(
      'parameters'
    );
  });

  it('shows no windows and no unpinned panel, only the phone lane', () => {
    let layout = popOutPanel(essentials(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    layout = openPanel(layout, 'revisions');
    const phone = computePanelGeometry(layout, { width: 600, height: 844 });
    expect(phone.floats).toEqual([]);
    expect(phone.panels).toEqual({});
    expect(phone.gaps).toEqual([]);
    expect(phone.phonePanel).toBe('revisions');
  });

  it('draws from every open panel, the unpinned one included', () => {
    const phoneStage: PanelStage = { width: 600, height: 844 };
    let layout = popOutPanel(essentials(), 'history', {
      x: 100,
      y: 100,
      w: 300,
      h: 300
    });
    layout = openPanel(layout, 'revisions');
    layout = notePanelUsed(layout, 'history');
    const before = structuredClone(layout);
    const phone = computePanelGeometry(layout, phoneStage);
    expect(phone.phonePanels).toEqual([
      'history',
      'revisions',
      'parameters',
      'bodies'
    ]);
    expect(phone.phonePanel).toBe('history');
    layout = notePanelUsed(layout, 'revisions');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe(
      'revisions'
    );
    // The stored layout is kept, the unpinned panel included, so a wider
    // stage draws everything where it was.
    expect(before.unpinned).toBe('revisions');
    const wide = computePanelGeometry(layout, STAGE);
    expect(wide.panels.revisions!.mode).toBe('unpinned');
    expect(wide.panels.history!.mode).toBe('floating');
    expect(wide.columns).toHaveLength(2);
  });

  it('shows the most recently used open panel', () => {
    const phoneStage: PanelStage = { width: 390, height: 844 };
    let layout = essentials();
    layout = notePanelUsed(layout, 'bodies');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe('bodies');
    // A rail press, an open and a focus all count as a use.
    layout = togglePanel(layout, 'history');
    expect(layout.recent).toEqual(['history', 'bodies']);
    expect(computePanelGeometry(layout, phoneStage).phonePanels).toEqual([
      'history',
      'bodies',
      'parameters'
    ]);
    layout = notePanelUsed(layout, 'parameters');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe(
      'parameters'
    );
    // Closing the most recent falls back to the next open one.
    layout = togglePanel(layout, 'parameters');
    expect(layout.recent[0]).toBe('parameters');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe('history');
    // Nothing open, nothing to show.
    expect(computePanelGeometry(modelOnly(), phoneStage).phonePanel).toBeNull();
    // Noting the panel already at the head changes nothing.
    expect(notePanelUsed(layout, 'parameters')).toBe(layout);
  });

  it('brings an open panel the lane is not showing into it instead of closing it', () => {
    const phoneStage: PanelStage = { width: 600, height: 800 };
    const layout = notePanelUsed(essentials(), 'parameters');
    expect(computePanelGeometry(layout, phoneStage).phonePanel).toBe(
      'parameters'
    );
    // Objects is docked but not shown: the press shows it, docked as before.
    const shown = togglePanel(layout, 'bodies', phoneStage);
    expect(computePanelGeometry(shown, phoneStage).phonePanel).toBe('bodies');
    expect(shown.right).toEqual(layout.right);
    expect(shown.left).toEqual(layout.left);
    // A second press on the panel the lane shows closes it, remembering its
    // place, and the lane falls back to the next open panel.
    const closed = togglePanel(shown, 'bodies', phoneStage);
    expect(panelStatus(closed, 'bodies')).toBe('closed');
    expect(closed.homes.bodies).toMatchObject({
      kind: 'column',
      side: 'left',
      column: 0,
      index: 0
    });
    expect(computePanelGeometry(closed, phoneStage).phonePanel).toBe(
      'parameters'
    );
    // Wider than the phone limit, the same press closes the docked panel.
    expect(panelStatus(togglePanel(layout, 'bodies', STAGE), 'bodies')).toBe(
      'closed'
    );
  });
});

describe('search hand-off', () => {
  it('opens a closed panel unpinned, not at its home', () => {
    const closed = closePanel(essentials(), 'parameters');
    expect(closed.homes.parameters).toBeDefined();
    const shown = presentPanel(closed, 'parameters', STAGE);
    expect(panelStatus(shown, 'parameters')).toBe('unpinned');
    expect(shown.recent[0]).toBe('parameters');
    // A rail press would have gone home instead.
    expect(
      panelStatus(openPanel(closed, 'parameters', STAGE), 'parameters')
    ).toBe('docked');
  });

  it('leaves an open panel where it is and makes it the most recent', () => {
    const layout = essentials();
    const shown = presentPanel(layout, 'bodies', STAGE);
    expect(shown.left).toEqual(layout.left);
    expect(shown.right).toEqual(layout.right);
    expect(shown.recent[0]).toBe('bodies');
    // So the phone lane shows it.
    expect(
      computePanelGeometry(shown, { width: 600, height: 800 }).phonePanel
    ).toBe('bodies');
    // Already the most recent and showing: nothing changes.
    expect(presentPanel(shown, 'bodies', STAGE)).toBe(shown);
  });

  it('replaces the unpinned panel, turns Hide all off and reveals a parked one', () => {
    const peeking = openPanel(modelOnly(), 'history', STAGE);
    const replaced = presentPanel(peeking, 'parameters', STAGE);
    expect(replaced.unpinned).toBe('parameters');
    expect(panelStatus(replaced, 'history')).toBe('closed');

    const hidden = setOption(essentials(), 'hidden', true);
    expect(presentPanel(hidden, 'parameters', STAGE).options.hidden).toBe(
      false
    );

    const narrow: PanelStage = {
      width: Math.floor(stageFitting(2)) - 1,
      height: 900
    };
    expect(computePanelGeometry(essentials(), narrow).parked.bodies).toBe(true);
    const revealed = presentPanel(essentials(), 'bodies', narrow);
    expect(revealed.revealed).toBe('bodies');
    expect(panelStatus(revealed, 'bodies')).toBe('docked');
    expect(computePanelGeometry(revealed, narrow).panels.bodies?.mode).toBe(
      'revealed'
    );
  });
});

describe('short stages', () => {
  // A 390px window: the viewer area is the window's full height (the top bar
  // floats over it), and the docks run from --stage-top (a 40px bar between
  // two 10px island gaps = 60px) to one 10px island gap above the bottom.
  const shortStage: PanelStage = { width: 1440, height: 390 };
  const columnHeight =
    390 - DEFAULT_PANEL_INSETS.top - DEFAULT_PANEL_INSETS.bottom;
  const five = layoutWith({ right: [[...PANEL_IDS]] });

  it('scrolls a five-panel column with each panel at its minimum', () => {
    expect(columnHeight).toBe(320);
    const geometry = computePanelGeometry(five, shortStage);
    const column = geometry.columns[0]!;
    expect(column.h).toBe(columnHeight);
    expect(column.overflowing).toBe(true);
    expect(column.contentHeight).toBe(
      PANEL_MIN_HEIGHT * 5 + PANEL_STACK_GAP * 4
    );
    for (const id of PANEL_IDS) {
      expect(geometry.panels[id]!.h).toBe(PANEL_MIN_HEIGHT);
    }
    // Every header stays in order down the scrolling column.
    const tops = PANEL_IDS.map((id) => geometry.panels[id]!.y);
    expect(tops).toEqual([...tops].sort((a, b) => a - b));
    // Gap resizing is off while it scrolls.
    expect(geometry.gaps).toHaveLength(4);
    expect(geometry.gaps.every((g) => !g.enabled)).toBe(true);
  });

  it('keeps the weights, so a taller stage gets the split back', () => {
    const weighted: PanelLayout = {
      ...five,
      weights: { ...five.weights, history: 2.5 }
    };
    computePanelGeometry(weighted, shortStage);
    expect(weighted.weights.history).toBe(2.5);
    const tall = computePanelGeometry(weighted, STAGE);
    expect(tall.columns[0]!.overflowing).toBe(false);
    expect(tall.panels.history!.h).toBeCloseTo(tall.panels.parameters!.h * 2.5);
    const total = PANEL_IDS.reduce((sum, id) => sum + tall.panels[id]!.h, 0);
    expect(total + PANEL_STACK_GAP * 4).toBeCloseTo(tall.columns[0]!.h);
  });

  it('holds a panel at 90px when the split would squeeze it on a column that fits', () => {
    const skewed = layoutWith({
      right: [['parameters', 'history']],
      weights: { ...modelOnly().weights, parameters: 0.1, history: 3 }
    });
    const geometry = computePanelGeometry(skewed, shortStage);
    expect(geometry.columns[0]!.overflowing).toBe(false);
    expect(geometry.panels.parameters!.h).toBeCloseTo(PANEL_MIN_HEIGHT);
    expect(geometry.panels.history!.h).toBeCloseTo(
      columnHeight - PANEL_MIN_HEIGHT - PANEL_STACK_GAP
    );
  });
});

describe('hit-testing a drag out of a full dock', () => {
  it('offers a new column where the dragged panel’s column emptied', () => {
    const layout = layoutWith({ left: [['bodies'], ['history']] });
    expect(layout.left).toHaveLength(PANEL_MAX_COLUMNS.left);
    const geometry = computePanelGeometry(beginDrag(layout, 'history'), STAGE);
    const rail = geometry.rails.left;
    expect(hitTest(geometry, { x: rail.x + 5, y: 400 })).toEqual({
      kind: 'newColumn',
      side: 'left'
    });
    // A dock that is still full after the lift offers none.
    const full = computePanelGeometry(
      beginDrag(
        layoutWith({ left: [['bodies'], ['history', 'revisions']] }),
        'revisions'
      ),
      STAGE
    );
    expect(
      hitTest(full, { x: full.rails.left.x + 5, y: 400 })
    ).not.toMatchObject({ kind: 'newColumn' });
  });
});

describe('rails and hit-testing', () => {
  const geometry = computePanelGeometry(
    beginDrag(essentials(), 'history'),
    STAGE
  );
  const right = geometry.rails.right;
  const left = geometry.rails.left;
  const span = RAIL + GAP + CW + GAP;
  const y = 400;

  it('puts each rail on its dock’s inner edge', () => {
    // The island gap from the screen's edge to the dock, the dock gap from
    // the dock to its rail.
    expect(right.x + right.w).toBe(STAGE.width - GAP - (CW + BETWEEN));
    expect(left.x).toBe(GAP + CW + BETWEEN);
    const bare = computePanelGeometry(modelOnly(), STAGE);
    expect(bare.rails.right.x + bare.rails.right.w).toBe(STAGE.width - GAP);
    expect(bare.rails.left.x).toBe(GAP);
  });

  it('treats a press under 4px as a click', () => {
    expect(PANEL_DRAG_THRESHOLD).toBe(4);
    const start = { x: 100, y: 100 };
    expect(isDragStart(start, { x: 103.9, y: 100 })).toBe(false);
    expect(isDragStart(start, { x: 100, y: 104 })).toBe(true);
  });

  it('ignores targets within 60px of a drag out of the rail', () => {
    expect(PANEL_RAIL_DRAG_CLEARANCE).toBe(60);
    const startPoint = { x: right.x + 20, y };
    expect(
      hitTest(
        geometry,
        { x: startPoint.x - 59, y },
        { fromRail: true, startPoint }
      )
    ).toBe(DROP_SUPPRESSED);
    // Not the same as an empty spot on the stage, which floats the panel.
    expect(
      hitTest(geometry, { x: 720, y }, { fromRail: true, startPoint })
    ).toBeNull();
    expect(
      hitTest(
        geometry,
        { x: startPoint.x - 60, y },
        { fromRail: true, startPoint }
      )
    ).toEqual({
      kind: 'newColumn',
      side: 'right'
    });
    // A header drag has no such dead zone.
    expect(hitTest(geometry, startPoint, { startPoint })).toEqual({
      kind: 'newColumn',
      side: 'right'
    });
  });

  it('spans each rail plus one column for a new column', () => {
    const outer = right.x + right.w;
    expect(hitTest(geometry, { x: outer, y })).toEqual({
      kind: 'newColumn',
      side: 'right'
    });
    expect(hitTest(geometry, { x: outer - span, y })).toEqual({
      kind: 'newColumn',
      side: 'right'
    });
    expect(hitTest(geometry, { x: outer - span - 1, y })).toBeNull();
    expect(hitTest(geometry, { x: left.x, y })).toEqual({
      kind: 'newColumn',
      side: 'left'
    });
    expect(hitTest(geometry, { x: left.x + span, y })).toEqual({
      kind: 'newColumn',
      side: 'left'
    });
    expect(hitTest(geometry, { x: left.x + span + 1, y })).toBeNull();
    // Above or below the docks is not a dock target.
    expect(
      hitTest(geometry, { x: outer - 10, y: geometry.dock.top - 20 })
    ).toBeNull();
  });

  it('offers no new column on a full dock', () => {
    const full = layoutWith({
      left: [['bodies'], ['history']],
      right: [['parameters'], ['revisions'], ['diagnostics']]
    });
    const wide = computePanelGeometry(full, { width: 3000, height: 900 });
    expect(wide.columns).toHaveLength(5);
    const outer = wide.rails.right.x + wide.rails.right.w;
    expect(hitTest(wide, { x: outer - 20, y })).toBeNull();
    expect(hitTest(wide, { x: wide.rails.left.x + 20, y })).toBeNull();
  });

  it('picks the slot in a column from the panels without the preview', () => {
    const stack = computePanelGeometry(
      layoutWith({ right: [['parameters', 'bodies']] }),
      STAGE
    );
    const top = stack.panels.parameters!;
    const below = stack.panels.bodies!;
    const x = top.x + 10;
    expect(hitTest(stack, { x, y: top.y + 5 })).toEqual({
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0
    });
    expect(hitTest(stack, { x, y: top.y + top.h / 2 + 1 })).toMatchObject({
      index: 1
    });
    expect(hitTest(stack, { x, y: below.y + below.h - 5 })).toMatchObject({
      index: 2
    });
    // The left dock's column, mirrored.
    const leftColumn = geometry.columns.find(
      (column) => column.side === 'left'
    )!;
    expect(
      hitTest(geometry, {
        x: leftColumn.x + 5,
        y: 5 + leftColumn.y + leftColumn.h / 2
      })
    ).toEqual({
      kind: 'column',
      side: 'left',
      column: 0,
      index: 1
    });
  });

  it.each(['left', 'right'] as const)(
    'offers a new %s column after lifting a singleton at the column limit',
    (side) => {
      const columns: PanelId[][] =
        side === 'left'
          ? [['bodies'], ['history']]
          : [['bodies'], ['history'], ['revisions']];
      const layout = layoutWith({ [side]: columns });
      const stage = { width: 3000, height: 900 };
      const lifted = beginDrag(layout, 'bodies');
      const geometry = computePanelGeometry(lifted, stage);
      const rail = geometry.rails[side];
      const target = hitTest(geometry, { x: rail.x + rail.w / 2, y: 400 });
      expect(target).toEqual({ kind: 'newColumn', side });
      const placed = placePanel(layout, 'bodies', target as PanelTarget, stage);
      expect(placed[side]).toEqual([...columns.slice(1), ['bodies']]);
      expect(placed[side]).toHaveLength(PANEL_MAX_COLUMNS[side]);
    }
  );

  it('keeps an emptied column a drop target during the drag', () => {
    const dragging = computePanelGeometry(
      beginDrag(essentials(), 'bodies'),
      STAGE
    );
    expect(
      dragging.columns.find((column) => column.side === 'left')
    ).toMatchObject({
      panels: []
    });
    expect(hitTest(dragging, { x: GAP + 5, y })).toEqual({
      kind: 'column',
      side: 'left',
      column: 0,
      index: 0
    });
  });

  it('tests floating windows first, topmost first, the hovered one grown', () => {
    // Model only, so no dock target lies under the windows.
    let layout = popOutPanel(modelOnly(), 'history', {
      x: 400,
      y: 200,
      w: 300,
      h: 300
    });
    layout = popOutPanel(layout, 'revisions', {
      x: 500,
      y: 250,
      w: 300,
      h: 300
    });
    const floats = computePanelGeometry(layout, STAGE);
    expect(hitTest(floats, { x: 550, y: 300 })).toMatchObject({
      kind: 'group',
      groupId: 'float-2'
    });
    expect(hitTest(floats, { x: 420, y: 220 })).toMatchObject({
      kind: 'group',
      groupId: 'float-1'
    });
    // The grip bar above a window takes drops too.
    expect(hitTest(floats, { x: 420, y: 185 })).toMatchObject({
      groupId: 'float-1'
    });
    // Below the window it is a miss, until that window is the one hovered
    // and is tested at the size it grows to.
    const under = { x: 420, y: 200 + 300 + 100 };
    expect(hitTest(floats, under)).toBeNull();
    expect(
      hitTest(floats, under, {
        current: { kind: 'group', groupId: 'float-1', index: 1 }
      })
    ).toMatchObject({ kind: 'group', groupId: 'float-1', index: 1 });
  });

  it('offers no drop into a parked column', () => {
    const narrow = computePanelGeometry(beginDrag(essentials(), 'history'), {
      width: Math.ceil(stageFitting(2)) - 1,
      height: 900
    });
    expect(narrow.parkedColumns).toEqual([{ side: 'left', column: 0 }]);
    // Where the left column would be, only the left rail's new-column span.
    for (let x = 0; x < narrow.stage.width; x += 5) {
      const target = hitTest(narrow, { x, y: 400 });
      expect(
        typeof target === 'object' &&
          target?.kind === 'column' &&
          target.side === 'left'
      ).toBe(false);
    }
  });
});

describe('panel layout persistence', () => {
  it('migrates an open v1 drawer to one right column of its open sections', () => {
    const storage = memoryStorage({
      [PANEL_STATE_STORAGE_KEY]: v1({
        drawerOpen: true,
        sidebarSections: {
          parameters: true,
          bodies: false,
          history: true,
          revisions: false,
          diagnostics: true
        }
      })
    });
    const layout = loadPanelLayout(storage);
    expect(layout.right).toEqual([['parameters', 'history', 'diagnostics']]);
    expect(layout.left).toEqual([]);
    expect(panelStatus(layout, 'history')).toBe('docked');
    expect(storage.writes).toEqual([]);

    const all = memoryStorage({
      [PANEL_STATE_STORAGE_KEY]: v1({ drawerOpen: true })
    });
    expect(loadPanelLayout(all).right).toEqual([[...PANEL_IDS]]);
    expect(all.writes).toEqual([]);
  });

  it('migrates a closed v1 drawer to Model only', () => {
    const storage = memoryStorage({
      [PANEL_STATE_STORAGE_KEY]: v1({ drawerOpen: false })
    });
    const layout = loadPanelLayout(storage, undefined, { leftDock: true });
    expect(layout.left).toEqual([]);
    expect(layout.right).toEqual([]);
    expect(storage.writes).toEqual([]);
    // A drawer open with every section folded has nothing to dock either.
    expect(
      migratePanelState({
        ...defaultPanelState(),
        drawerOpen: true,
        sidebarSections: {
          parameters: false,
          bodies: false,
          history: false,
          revisions: false,
          diagnostics: false
        }
      }).right
    ).toEqual([]);
  });

  it('gives a new device the default for whether the left dock ships', () => {
    const storage = memoryStorage();
    expect(loadPanelLayout(storage).right).toEqual([['bodies', 'parameters']]);
    expect(
      loadPanelLayout(storage, undefined, { leftDock: false }).left
    ).toEqual([]);
    const twoSided = loadPanelLayout(storage, undefined, { leftDock: true });
    expect(twoSided.left).toEqual([['bodies']]);
    expect(twoSided.right).toEqual([['parameters']]);
    expect(storage.writes).toEqual([]);
    // A corrupt v1 key reads as a new device.
    expect(
      loadPanelLayout(memoryStorage({ [PANEL_STATE_STORAGE_KEY]: '{oops' }))
        .right
    ).toEqual([['bodies', 'parameters']]);
  });

  it('migrates from a v1 state handed in, null meaning none stored', () => {
    const storage = memoryStorage();
    const open = { ...defaultPanelState(), drawerOpen: true };
    expect(loadPanelLayout(storage, open).right).toEqual([[...PANEL_IDS]]);
    expect(loadPanelLayout(storage, null, { leftDock: true })).toEqual(
      defaultPanelLayout({ leftDock: true })
    );
  });

  it('reads a stored layout over the v1 state, and leaves the v1 key alone', () => {
    const legacy = v1({ drawerOpen: true });
    const storage = memoryStorage({ [PANEL_STATE_STORAGE_KEY]: legacy });
    const layout = applyPreset(modelOnly(), 'review');
    expect(savePanelLayout(layout, storage)).toBe(true);
    expect(storage.writes).toEqual([PANEL_LAYOUT_STORAGE_KEY]);
    expect(loadPanelLayout(storage)).toEqual(layout);
    expect(storage.entries.get(PANEL_STATE_STORAGE_KEY)).toBe(legacy);
  });

  it('never rewrites a stored layout when the left dock ships', () => {
    const stored = defaultPanelLayout({ leftDock: false });
    const storage = memoryStorage();
    savePanelLayout(stored, storage);
    const raw = storage.entries.get(PANEL_LAYOUT_STORAGE_KEY);
    storage.writes.length = 0;
    expect(loadPanelLayout(storage, undefined, { leftDock: true })).toEqual(
      stored
    );
    expect(storage.entries.get(PANEL_LAYOUT_STORAGE_KEY)).toBe(raw);
    expect(storage.writes).toEqual([]);
    // Model only stays Model only too: an empty layout is not "missing".
    savePanelLayout(modelOnly(), storage);
    expect(
      loadPanelLayout(storage, undefined, { leftDock: true }).left
    ).toEqual([]);
  });

  it('keeps the recency list through normalize, load and presets', () => {
    expect(
      normalizePanelLayout({
        recent: ['history', 'bogus', 7, 'history', 'bodies', null, 'bodies']
      }).recent
    ).toEqual(['history', 'bodies']);
    expect(normalizePanelLayout({ recent: 'history' }).recent).toEqual([]);
    let layout = notePanelUsed(essentials(), 'bodies');
    layout = notePanelUsed(layout, 'revisions');
    expect(layout.recent).toEqual(['revisions', 'bodies']);
    const storage = memoryStorage();
    savePanelLayout(layout, storage);
    const loaded = loadPanelLayout(storage);
    expect(loaded.recent).toEqual(['revisions', 'bodies']);
    // The phone lane after a reload shows what it showed before.
    const phoneStage: PanelStage = { width: 390, height: 844 };
    expect(computePanelGeometry(loaded, phoneStage).phonePanel).toBe('bodies');
    expect(applyPreset(loaded, 'review').recent).toEqual([
      'revisions',
      'bodies'
    ]);
    expect(defaultPanelLayout().recent).toEqual([]);
  });

  it('round-trips every kind of placement', () => {
    let layout = applyPreset(modelOnly(), 'full');
    layout = popOutPanel(layout, 'diagnostics', {
      x: 300,
      y: 200,
      w: 320,
      h: 300
    });
    layout = closePanel(layout, 'revisions');
    layout = openPanel(layout, 'revisions');
    layout = closePanel(layout, 'revisions');
    layout = setOption(layout, 'width', 'narrow');
    const storage = memoryStorage();
    savePanelLayout(layout, storage);
    expect(loadPanelLayout(storage)).toEqual(layout);
  });

  it('survives storage that throws', () => {
    const throwing: PanelLayoutStorage = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      }
    };
    expect(loadPanelLayout(throwing)).toEqual(defaultPanelLayout());
    expect(loadPanelLayout(throwing, undefined, { leftDock: true })).toEqual(
      defaultPanelLayout({ leftDock: true })
    );
    expect(savePanelLayout(essentials(), throwing)).toBe(false);
    expect(loadPanelLayout(null)).toEqual(defaultPanelLayout());
    expect(savePanelLayout(essentials(), null)).toBe(false);
  });

  it('reads corrupt storage as the default', () => {
    for (const raw of ['not json', 'null', '[1,2]', '7', '"text"']) {
      const storage = memoryStorage({ [PANEL_LAYOUT_STORAGE_KEY]: raw });
      expect(loadPanelLayout(storage)).toEqual(defaultPanelLayout());
      expect(storage.writes).toEqual([]);
    }
  });

  it('normalizes hostile layouts strictly', () => {
    const layout = normalizePanelLayout(
      JSON.parse(
        JSON.stringify({
          right: [
            ['parameters', 'bogus', 'parameters'],
            [],
            'history',
            ['bodies'],
            ['history'],
            ['revisions']
          ],
          left: [[42, 'bodies'], ['diagnostics'], ['nope'], [null]],
          floats: [
            {
              id: 'float-1',
              x: 'a',
              y: -50,
              w: 9999,
              h: 1,
              panels: ['diagnostics']
            },
            { id: 'bad id!', x: Infinity, y: 5e9, w: 300, h: 300, panels: [] },
            null
          ],
          unpinned: 'parameters',
          weights: {
            parameters: -3,
            bodies: 1e9,
            history: 'x',
            revisions: Number.NaN,
            __proto__: 5
          },
          homes: {
            parameters: { kind: 'column', side: 'left', column: 9, index: -1 },
            nonsense: { kind: 'float' },
            __proto__: { polluted: true }
          },
          options: { hidden: 'yes', locked: true, compact: 1, width: 'giant' },
          extra: true
        })
      ) as unknown
    );
    // Unknown ids and repeats dropped, empty columns dropped, columns past
    // the right dock's three stacked into its last.
    expect(layout.right).toEqual([
      ['parameters'],
      ['bodies'],
      ['history', 'revisions']
    ]);
    // The left dock: Objects is already on the right, so its column empties.
    expect(layout.left).toEqual([['diagnostics']]);
    // Diagnostics is docked, so the window that repeats it goes.
    expect(layout.floats).toEqual([]);
    // Unpinned and homes only for panels that are not already placed.
    expect(layout.unpinned).toBeNull();
    expect(layout.homes).toEqual({});
    expect(layout.weights.parameters).toBeGreaterThan(0);
    expect(layout.weights.bodies).toBeLessThanOrEqual(100);
    expect(layout.weights.history).toBe(1);
    expect(layout.weights.revisions).toBe(1);
    expect(Object.keys(layout.weights).sort()).toEqual([...PANEL_IDS].sort());
    expect(layout.options).toEqual({
      hidden: false,
      locked: true,
      compact: false,
      fit: true,
      width: 'regular'
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The left dock is capped at two columns.
    expect(
      normalizePanelLayout({ left: [['bodies'], ['history'], ['revisions']] })
        .left
    ).toEqual([['bodies'], ['history', 'revisions']]);
  });

  it('clamps floating windows and homes, and repairs window ids', () => {
    const layout = normalizePanelLayout({
      floats: [
        {
          id: 'w',
          x: -10,
          y: Number.NaN,
          w: 10,
          h: 99999999,
          panels: ['history']
        },
        { id: 'w', x: 10, y: 10, w: 9999, h: 10, panels: ['revisions'] },
        { id: '../../x', x: 10, y: 10, w: 300, h: 300, panels: ['bodies'] }
      ],
      homes: {
        parameters: { kind: 'column', side: 'left', column: 9, index: -1 },
        diagnostics: { kind: 'float', rect: { x: -5, y: 3, w: 1, h: 1 } },
        bodies: { kind: 'column', side: 'right', column: 0, index: 0 }
      },
      unpinned: 'nope'
    });
    expect(layout.floats.map((group) => group.panels)).toEqual([
      ['history'],
      ['revisions'],
      ['bodies']
    ]);
    const ids = layout.floats.map((group) => group.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('w');
    for (const group of layout.floats) {
      expect(group.x).toBeGreaterThanOrEqual(0);
      expect(group.y).toBeGreaterThanOrEqual(0);
      expect(group.w).toBeGreaterThanOrEqual(FLOAT_MIN_WIDTH);
      expect(group.w).toBeLessThanOrEqual(FLOAT_MAX_WIDTH);
      expect(group.h).toBeGreaterThanOrEqual(FLOAT_MIN_HEIGHT);
      expect(Number.isFinite(group.h)).toBe(true);
    }
    expect(layout.homes.parameters).toEqual({
      kind: 'column',
      side: 'left',
      column: PANEL_MAX_COLUMNS.left - 1,
      index: 0
    });
    expect(layout.homes.diagnostics).toEqual({
      kind: 'float',
      rect: { x: 0, y: 3, w: FLOAT_MIN_WIDTH, h: FLOAT_MIN_HEIGHT }
    });
    // Objects is open in a window, so its home is dropped.
    expect(layout.homes.bodies).toBeUndefined();
    expect(layout.unpinned).toBeNull();
  });

  it.each(['float-9007199254740992', 'float-99999999999999999999999999'])(
    'allocates a unique window id after loading %s',
    (id) => {
      const layout = normalizePanelLayout({
        floats: [{ id, x: 100, y: 100, w: 300, h: 300, panels: ['history'] }]
      });
      const added = popOutPanel(layout, 'revisions', {
        x: 150,
        y: 150,
        w: 300,
        h: 300
      });
      const ids = added.floats.map((group) => group.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((value) => /^[A-Za-z0-9_-]{1,32}$/.test(value))).toBe(
        true
      );
      const moved = moveFloat(added, ids[1]!, { x: 500, y: 200 }, STAGE);
      expect(
        moved.floats.find((group) => group.panels.includes('history'))!.x
      ).toBe(100);
      expect(
        moved.floats.find((group) => group.panels.includes('revisions'))!.x
      ).toBe(500);
      const storage = memoryStorage();
      savePanelLayout(added, storage);
      expect(loadPanelLayout(storage).floats.map((group) => group.id)).toEqual(
        ids
      );
    }
  );

  it('normalizes remembered column identities to distinct known panels', () => {
    const layout = normalizePanelLayout({
      homes: {
        history: {
          kind: 'column',
          side: 'right',
          column: 0,
          index: 0,
          peers: ['history', 'bogus', 'history', 'bodies'],
          preceding: ['parameters', 'parameters', null, 'history'],
          following: ['revisions', 'parameters', 'history', 'bogus']
        }
      }
    });
    expect(layout.homes.history).toEqual({
      kind: 'column',
      side: 'right',
      column: 0,
      index: 0,
      peers: ['history', 'bodies'],
      preceding: ['parameters'],
      following: ['revisions']
    });
  });

  it('never stores a preview slot', () => {
    const preview = previewLayout(essentials(), 'history', {
      kind: 'newColumn',
      side: 'left'
    });
    const storage = memoryStorage();
    savePanelLayout(preview as unknown as PanelLayout, storage);
    expect(storage.entries.get(PANEL_LAYOUT_STORAGE_KEY)).not.toContain(
      PANEL_SLOT
    );
  });
});

describe('the unpinned slot beside the right lane', () => {
  // Today's tokens: 40px rail, 10px gaps, a 296px column (306px with its
  // gap) and the 330px card width the lane keeps.
  const insets = { rail: 40, gap: 10 };
  const stage = (width: number) => ({ width, height: 720, insets });

  it('reserves its width while the lane keeps a full card beside it', () => {
    // 60 (rail and gaps) + 306 (dock) + 306 (slot) + 10 + 330 = 1012.
    expect(unpinnedSlotReserves(stage(1012), 306, 306, 330)).toBe(true);
    expect(unpinnedSlotReserves(stage(1280), 306, 306, 330)).toBe(true);
    // No dock: the slot alone needs 60 + 306 + 10 + 330 = 706.
    expect(unpinnedSlotReserves(stage(721), 0, 306, 330)).toBe(true);
  });

  it('covers the lane when reserving would squeeze its card', () => {
    expect(unpinnedSlotReserves(stage(1011), 306, 306, 330)).toBe(false);
    // Just past the phone breakpoint a docked column and the slot would have
    // left the inspector about 39px.
    expect(unpinnedSlotReserves(stage(721), 306, 306, 330)).toBe(false);
  });

  it('leaves the lane its card between the slot and the left dock', () => {
    // The left dock's 306px come off the lane too: 1012 + 306 = 1318.
    expect(unpinnedSlotReserves(stage(1318), 306, 306, 330, 306)).toBe(true);
    expect(unpinnedSlotReserves(stage(1317), 306, 306, 330, 306)).toBe(false);
    // Essentials at 1280px: the slot covers the lane rather than squeeze it.
    expect(unpinnedSlotReserves(stage(1280), 306, 306, 330, 306)).toBe(false);
  });
});
