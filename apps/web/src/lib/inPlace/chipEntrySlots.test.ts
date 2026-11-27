import { describe, expect, it } from 'vitest';
import {
  chipEntryLostItsPicks,
  chipEntryOpenedOver,
  slotPickCounts
} from './chipEntrySlots';
import type { FacePick, InPlaceSlots } from './tools';

const EMPTY: InPlaceSlots = {
  profiles: [],
  axis: null,
  path: [],
  guide: [],
  faces: [],
  bodies: [],
  plane: null,
  edges: [],
  placement: null,
  refs: [],
  image: null
};

/** Synthetic face picks: only their presence matters here. */
const face = (bodyId: string, hash: number) =>
  ({ bodyId, hash }) as unknown as FacePick;
const pair: InPlaceSlots = {
  ...EMPTY,
  faces: [face('block', 1), face('target', 2)]
};
const OFFSET_CHIP = [{ valueId: 'offset' }];

describe('chip entry over its picks (U11)', () => {
  it('counts the picks of each filled slot, lists and single picks alike', () => {
    expect(slotPickCounts(EMPTY)).toEqual({});
    expect(slotPickCounts(pair)).toEqual({ faces: 2 });
    expect(
      slotPickCounts({
        ...EMPTY,
        plane: {} as InPlaceSlots['plane'],
        planeEdges: []
      })
    ).toEqual({ plane: 1 });
  });

  it("closes Align's Offset entry once a click on the moving face clears the pair", () => {
    const openedOver = chipEntryOpenedOver(pair, OFFSET_CHIP, 'offset');
    expect(openedOver).toEqual({ faces: 2 });
    // The pair taken back: the Offset chip goes with it.
    expect(chipEntryLostItsPicks(openedOver, EMPTY, [], 'offset')).toBe(true);
    // The target alone taken back: the chip goes too, nothing to edit.
    expect(
      chipEntryLostItsPicks(
        openedOver,
        { ...EMPTY, faces: [face('block', 1)] },
        [],
        'offset'
      )
    ).toBe(true);
  });

  it('keeps an entry whose chip is still drawn, or whose picks are all there', () => {
    const openedOver = chipEntryOpenedOver(pair, OFFSET_CHIP, 'offset');
    // A new target face: the slot is refilled, the chip stays.
    const replaced = {
      ...EMPTY,
      faces: [face('block', 1), face('target', 3)]
    };
    expect(
      chipEntryLostItsPicks(openedOver, replaced, OFFSET_CHIP, 'offset')
    ).toBe(false);
    // The chip briefly gone while a preview builds: the picks are all there,
    // and a replaced pick keeps the count.
    expect(chipEntryLostItsPicks(openedOver, pair, [], 'offset')).toBe(false);
    expect(chipEntryLostItsPicks(openedOver, replaced, [], 'offset')).toBe(
      false
    );
    // A pick taken back while the value keeps its chip (a fillet with an
    // edge left): it still has something to edit.
    expect(
      chipEntryLostItsPicks(
        openedOver,
        { ...EMPTY, faces: [face('block', 1)] },
        OFFSET_CHIP,
        'offset'
      )
    ).toBe(false);
  });

  it('never closes an entry opened without a chip or before any pick', () => {
    // A value with no chip yet (Precise values before a face): over nothing.
    expect(chipEntryOpenedOver(pair, [], 'diameter')).toEqual({});
    expect(chipEntryLostItsPicks({}, EMPTY, [], 'diameter')).toBe(false);
    // A Box's Width typed before any footprint: no picks to lose.
    const width = chipEntryOpenedOver(EMPTY, [{ valueId: 'width' }], 'width');
    expect(width).toEqual({});
    expect(chipEntryLostItsPicks(width, EMPTY, [], 'width')).toBe(false);
  });
});
