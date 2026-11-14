import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIX_DOF_PREFERENCES,
  DEFAULT_SIX_DOF_SHAPING,
  SPACE_MOUSE_BUTTON,
  SPACE_MOUSE_HID_FILTERS,
  SPACE_MOUSE_IDLE,
  decodeSpaceMouseReport,
  pressedButtons,
  sixDofFromRaw,
  sixDofFromRawWithPreferences,
  sixDofIsIdle
} from './spaceMouse';

/** Little-endian int16 payload, as the device sends it. */
function int16Report(...values: number[]): DataView {
  const view = new DataView(new ArrayBuffer(values.length * 2));
  values.forEach((value, index) => view.setInt16(index * 2, value, true));
  return view;
}

function byteReport(...bytes: number[]): DataView {
  return new DataView(Uint8Array.from(bytes).buffer);
}

describe('SpaceMouse HID filters', () => {
  it('asks for the multi-axis controller under both vendor IDs', () => {
    // The SpaceMouse Pro (3DX-700040) enumerates as 0x046d:0xc62b.
    expect(SPACE_MOUSE_HID_FILTERS).toEqual([
      { vendorId: 0x256f, usagePage: 0x01, usage: 0x08 },
      { vendorId: 0x046d, usagePage: 0x01, usage: 0x08 }
    ]);
  });
});

describe('decodeSpaceMouseReport', () => {
  it('reads translation from report 1 and rotation from report 2', () => {
    const moved = decodeSpaceMouseReport(
      1,
      int16Report(120, -45, 350),
      SPACE_MOUSE_IDLE
    );
    expect(moved).toEqual({
      translation: [120, -45, 350],
      rotation: [0, 0, 0],
      buttons: 0
    });
    const turned = decodeSpaceMouseReport(2, int16Report(-7, 0, 300), moved!);
    expect(turned).toEqual({
      translation: [120, -45, 350],
      rotation: [-7, 0, 300],
      buttons: 0
    });
  });

  it('reads all six axes from a combined 12-byte report 1', () => {
    expect(
      decodeSpaceMouseReport(
        1,
        int16Report(1, 2, 3, 4, 5, -6),
        SPACE_MOUSE_IDLE
      )
    ).toEqual({ translation: [1, 2, 3], rotation: [4, 5, -6], buttons: 0 });
  });

  it('reads the button bitmask from report 3, keeping the axes', () => {
    const held = { ...SPACE_MOUSE_IDLE, translation: [9, 9, 9] as const };
    // Fit (bit 1) and Ctrl (bit 25).
    const state = decodeSpaceMouseReport(3, byteReport(0x02, 0, 0, 0x02), held);
    expect(state?.translation).toEqual([9, 9, 9]);
    expect(state?.buttons).toBe((1 << 1) | (1 << 25));
    // Bit 31 stays an unsigned bit, not a negative number.
    expect(
      decodeSpaceMouseReport(3, byteReport(0, 0, 0, 0x80), held)?.buttons
    ).toBe(2 ** 31);
  });

  it('ignores unknown and truncated reports', () => {
    expect(
      decodeSpaceMouseReport(4, int16Report(1, 2, 3), SPACE_MOUSE_IDLE)
    ).toBeNull();
    expect(
      decodeSpaceMouseReport(1, int16Report(1, 2), SPACE_MOUSE_IDLE)
    ).toBeNull();
    expect(
      decodeSpaceMouseReport(2, byteReport(1), SPACE_MOUSE_IDLE)
    ).toBeNull();
    expect(
      decodeSpaceMouseReport(3, byteReport(), SPACE_MOUSE_IDLE)
    ).toBeNull();
  });
});

describe('pressedButtons', () => {
  it('reports only newly pressed buttons', () => {
    const fit = 1 << SPACE_MOUSE_BUTTON.fit;
    const top = 1 << SPACE_MOUSE_BUTTON.top;
    expect(pressedButtons(0, fit)).toEqual([SPACE_MOUSE_BUTTON.fit]);
    expect(pressedButtons(fit, fit | top)).toEqual([SPACE_MOUSE_BUTTON.top]);
    expect(pressedButtons(fit | top, top)).toEqual([]);
  });
});

describe('sixDofFromRaw', () => {
  const full = DEFAULT_SIX_DOF_SHAPING.fullScale;

  it('reads rest, and a hand resting inside the dead zone, as idle', () => {
    expect(sixDofIsIdle(sixDofFromRaw(SPACE_MOUSE_IDLE))).toBe(true);
    const resting = sixDofFromRaw({
      translation: [5, -8, 3],
      rotation: [-4, 6, 2],
      buttons: 0
    });
    expect(sixDofIsIdle(resting)).toBe(true);
    expect(Object.is(resting.ty, -0)).toBe(false);
  });

  it('maps the device frame onto the screen frame', () => {
    // Push right, lift (−Z is up), pull toward the user (+Y).
    const translated = sixDofFromRaw({
      translation: [full, full, -full],
      rotation: [0, 0, 0],
      buttons: 0
    });
    expect(translated).toMatchObject({ tx: 1, ty: 1, tz: 1 });

    // Tilt the top toward the user (+RX), twist clockwise from above
    // (+RZ about the down axis), roll right (+RY about the toward-user axis).
    const rotated = sixDofFromRaw({
      translation: [0, 0, 0],
      rotation: [full, full, full],
      buttons: 0
    });
    expect(rotated).toMatchObject({ rx: 1, ry: -1, rz: 1 });
  });

  it('clamps past full scale and eases in near rest', () => {
    const axes = sixDofFromRaw({
      translation: [2 * full, full / 2, 0],
      rotation: [0, 0, 0],
      buttons: 0
    });
    expect(axes.tx).toBe(1);
    // Half deflection lands well under half speed, for fine control.
    const half = (0.5 - 0.04) / (1 - 0.04);
    expect(axes.tz).toBeCloseTo(half * half, 12);
    expect(axes.tz).toBeLessThan(0.25);
  });

  it('can be shaped linearly with no dead zone', () => {
    const axes = sixDofFromRaw(
      { translation: [-175, 0, 0], rotation: [0, 0, 0], buttons: 0 },
      { fullScale: 350, deadZone: 0, exponent: 1 }
    );
    expect(axes.tx).toBeCloseTo(-0.5, 12);
  });
});

describe('sixDofFromRawWithPreferences', () => {
  const full = DEFAULT_SIX_DOF_SHAPING.fullScale;
  const raw = (
    translation: [number, number, number],
    rotation: [number, number, number] = [0, 0, 0]
  ) => ({ translation, rotation, buttons: 0 });

  it('drops small accidental deflections inside a wider dead zone', () => {
    // A firm push right with a slight unintended tilt (10% of travel).
    const reading = raw([full, 0, 0], [full * 0.1, 0, 0]);
    const loose = sixDofFromRawWithPreferences(reading, {
      ...DEFAULT_SIX_DOF_PREFERENCES,
      deadZone: 0.04
    });
    expect(loose.rx).toBeGreaterThan(0);
    const firm = sixDofFromRawWithPreferences(reading, {
      ...DEFAULT_SIX_DOF_PREFERENCES,
      deadZone: 0.15
    });
    expect(firm).toMatchObject({ tx: 1, rx: 0 });
  });

  it('keeps only the strongest axis with dominant axis on', () => {
    const reading = raw([full * 0.6, 0, 0], [full * 0.4, full * 0.3, 0]);
    const axes = sixDofFromRawWithPreferences(reading, {
      ...DEFAULT_SIX_DOF_PREFERENCES,
      dominantAxis: true
    });
    expect(axes.tx).toBeGreaterThan(0);
    expect([axes.ty, axes.tz, axes.rx, axes.ry, axes.rz]).toEqual([
      0, 0, 0, 0, 0
    ]);
  });

  it('switches roll off before choosing the dominant axis', () => {
    // Roll is the strongest reading, but it is off: the tilt wins.
    const reading = raw([0, 0, 0], [full * 0.5, full, 0]);
    const axes = sixDofFromRawWithPreferences(reading, {
      ...DEFAULT_SIX_DOF_PREFERENCES,
      roll: false,
      dominantAxis: true
    });
    expect(axes.rz).toBe(0);
    expect(axes.rx).toBeGreaterThan(0);
  });

  it('reverses chosen axes and scales translation and rotation apart', () => {
    const reading = raw([full, 0, 0], [0, 0, full]);
    const axes = sixDofFromRawWithPreferences(reading, {
      ...DEFAULT_SIX_DOF_PREFERENCES,
      reversed: ['tx'],
      translationScale: 2,
      rotationScale: 0.5
    });
    expect(axes.tx).toBe(-2);
    // Twist (device Z rotation) is camera −ry, halved.
    expect(axes.ry).toBe(-0.5);
  });

  it('holds every rotation at zero while locked', () => {
    const axes = sixDofFromRawWithPreferences(
      raw([full, 0, 0], [full, full, full]),
      { ...DEFAULT_SIX_DOF_PREFERENCES, rotationLocked: true }
    );
    expect(axes).toMatchObject({ tx: 1, rx: 0, ry: 0, rz: 0 });
  });
});
