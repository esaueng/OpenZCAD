/**
 * 3Dconnexion SpaceMouse input, read straight from the device's HID reports
 * (WebHID in the browser). This module is pure: it decodes reports and
 * shapes the six axes, and never touches `navigator.hid`, the DOM or a
 * camera. The app owns the connection; `CameraController.setSixDofInput`
 * consumes the shaped axes.
 *
 * Device frame. The HID axes form a right-handed frame on the desk, seen by
 * the user: +X to the right, +Y toward the user, +Z down into the desk. Each
 * rotation turns right-handedly about its own translation axis. Report 1
 * carries translation (three little-endian int16), report 2 rotation, and
 * report 3 the buttons as a bitmask; newer devices carry all six axes in
 * report 1 alone. Values span roughly ±350 at full deflection.
 *
 * Camera frame. Shaped axes are expressed the way the screen reads: +x
 * right, +y up, +z out of the screen toward the viewer, rotations
 * right-handed about those. The mapping moves the model the way the cap
 * moves ("object mode", 3Dconnexion's default): push right and the model
 * goes right, lift and it rises, pull toward you and it comes closer, twist
 * clockwise and it turns clockwise.
 */

/** 3Dconnexion's own USB vendor ID, used by current devices. */
export const SPACE_MOUSE_VENDOR_ID = 0x256f;
/**
 * Logitech's USB vendor ID, under which 3Dconnexion shipped its older
 * devices: the SpaceMouse Pro (3DX-700040) reports 0x046d:0xc62b.
 */
export const SPACE_MOUSE_LEGACY_VENDOR_ID = 0x046d;
/** HID Generic Desktop page, Multi-axis Controller usage. */
export const MULTI_AXIS_USAGE_PAGE = 0x01;
export const MULTI_AXIS_USAGE = 0x08;

export interface HidDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

/**
 * What `navigator.hid.requestDevice` is asked for. The usage pins the 3D
 * mouse itself, so a Logitech keyboard or mouse (same legacy vendor ID) is
 * never offered in the chooser.
 */
export const SPACE_MOUSE_HID_FILTERS: readonly HidDeviceFilter[] = [
  {
    vendorId: SPACE_MOUSE_VENDOR_ID,
    usagePage: MULTI_AXIS_USAGE_PAGE,
    usage: MULTI_AXIS_USAGE
  },
  {
    vendorId: SPACE_MOUSE_LEGACY_VENDOR_ID,
    usagePage: MULTI_AXIS_USAGE_PAGE,
    usage: MULTI_AXIS_USAGE
  }
];

/**
 * Button bit indices in report 3, following 3Dconnexion's virtual-key
 * numbering (bit = key − 1). Named for the SpaceMouse Pro's labels; a
 * device without a key never sets its bit.
 */
export const SPACE_MOUSE_BUTTON = {
  menu: 0,
  fit: 1,
  top: 2,
  right: 4,
  front: 5,
  rollClockwise: 8,
  one: 12,
  two: 13,
  three: 14,
  four: 15,
  escape: 22,
  alt: 23,
  shift: 24,
  control: 25,
  rotationLock: 26
} as const;

export type SpaceMouseButtonName = keyof typeof SPACE_MOUSE_BUTTON;

/** Device-frame readings as the reports carry them. */
export interface SpaceMouseRawState {
  /** X right, Y toward the user, Z down. */
  translation: readonly [number, number, number];
  /** About those same axes, right-handed. */
  rotation: readonly [number, number, number];
  /** Report 3's bitmask, bits 0–31. */
  buttons: number;
}

export const SPACE_MOUSE_IDLE: SpaceMouseRawState = {
  translation: [0, 0, 0],
  rotation: [0, 0, 0],
  buttons: 0
};

/** Six shaped axes in the camera frame, each in [−1, 1]. */
export interface SixDofAxes {
  tx: number;
  ty: number;
  tz: number;
  rx: number;
  ry: number;
  rz: number;
}

export const SIX_DOF_IDLE: Readonly<SixDofAxes> = Object.freeze({
  tx: 0,
  ty: 0,
  tz: 0,
  rx: 0,
  ry: 0,
  rz: 0
});

export function sixDofIsIdle(axes: SixDofAxes): boolean {
  return (
    axes.tx === 0 &&
    axes.ty === 0 &&
    axes.tz === 0 &&
    axes.rx === 0 &&
    axes.ry === 0 &&
    axes.rz === 0
  );
}

function readTriple(
  data: DataView,
  offset: number
): readonly [number, number, number] {
  return [
    data.getInt16(offset, true),
    data.getInt16(offset + 2, true),
    data.getInt16(offset + 4, true)
  ];
}

/**
 * Folds one input report into the device state. Returns the next state, or
 * null when the report is not one this decoder understands (an unknown ID
 * or a truncated payload), in which case the previous state stands.
 */
export function decodeSpaceMouseReport(
  reportId: number,
  data: DataView,
  previous: SpaceMouseRawState
): SpaceMouseRawState | null {
  switch (reportId) {
    case 1: {
      if (data.byteLength >= 12) {
        return {
          ...previous,
          translation: readTriple(data, 0),
          rotation: readTriple(data, 6)
        };
      }
      if (data.byteLength >= 6) {
        return { ...previous, translation: readTriple(data, 0) };
      }
      return null;
    }
    case 2:
      return data.byteLength >= 6
        ? { ...previous, rotation: readTriple(data, 0) }
        : null;
    case 3: {
      if (data.byteLength < 1) {
        return null;
      }
      let buttons = 0;
      const bytes = Math.min(data.byteLength, 4);
      for (let index = 0; index < bytes; index += 1) {
        buttons |= data.getUint8(index) << (8 * index);
      }
      return { ...previous, buttons: buttons >>> 0 };
    }
    default:
      return null;
  }
}

/** Bits set in `next` that were clear in `previous`, lowest first. */
export function pressedButtons(previous: number, next: number): number[] {
  const pressed: number[] = [];
  const rising = (next & ~previous) >>> 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (rising & (1 << bit)) {
      pressed.push(bit);
    }
  }
  return pressed;
}

export interface SixDofShaping {
  /** Raw magnitude read as full deflection. */
  fullScale: number;
  /** Fraction of full scale ignored around rest, so a resting hand is still. */
  deadZone: number;
  /**
   * Response exponent past the dead zone: 1 is linear; above 1 trades top
   * speed onset for fine control near rest.
   */
  exponent: number;
}

export const DEFAULT_SIX_DOF_SHAPING: Readonly<SixDofShaping> = Object.freeze({
  fullScale: 350,
  deadZone: 0.04,
  exponent: 2
});

function shapeAxis(raw: number, shaping: SixDofShaping): number {
  if (!Number.isFinite(raw) || !(shaping.fullScale > 0)) {
    return 0;
  }
  const magnitude = Math.min(Math.abs(raw) / shaping.fullScale, 1);
  const deadZone = Math.min(Math.max(shaping.deadZone, 0), 0.95);
  if (magnitude <= deadZone) {
    return 0;
  }
  const live = (magnitude - deadZone) / (1 - deadZone);
  // `+ 0` folds a negative zero away so idle reads compare cleanly.
  return Math.sign(raw) * Math.pow(live, Math.max(shaping.exponent, 1)) + 0;
}

/**
 * Device readings → camera-frame axes. Device (right, toward user, down)
 * maps to camera (x, z, −y): x stays, the toward-user axis is the screen's
 * out-of-plane z, and down is −y. The rotations follow the same map.
 */
export function sixDofFromRaw(
  raw: SpaceMouseRawState,
  shaping: SixDofShaping = DEFAULT_SIX_DOF_SHAPING
): SixDofAxes {
  const [x, y, z] = raw.translation;
  const [rx, ry, rz] = raw.rotation;
  return {
    tx: shapeAxis(x, shaping),
    ty: shapeAxis(-z, shaping),
    tz: shapeAxis(y, shaping),
    rx: shapeAxis(rx, shaping),
    ry: shapeAxis(-rz, shaping),
    rz: shapeAxis(ry, shaping)
  };
}

/** A cap axis by the camera-frame name `SixDofAxes` gives it. */
export type SixDofAxisKey = keyof SixDofAxes;

const SIX_DOF_KEYS: readonly SixDofAxisKey[] = [
  'tx',
  'ty',
  'tz',
  'rx',
  'ry',
  'rz'
];

/** How the user wants the cap read; see `SpaceMouseSettings`. */
export interface SixDofPreferences {
  /** Multiplies pan and zoom; 1 is the default speed. */
  translationScale: number;
  /** Multiplies tilt, spin and roll; 1 is the default speed. */
  rotationScale: number;
  /** Fraction of full travel ignored around rest, 0–1. */
  deadZone: number;
  /** Keep only the axis deflected furthest. */
  dominantAxis: boolean;
  /** Whether the roll axis acts at all. */
  roll: boolean;
  /** Axes whose direction is flipped. */
  reversed: readonly SixDofAxisKey[];
  /** Turn rotation off entirely (the Lock key). */
  rotationLocked?: boolean;
}

export const DEFAULT_SIX_DOF_PREFERENCES: Readonly<SixDofPreferences> =
  Object.freeze({
    translationScale: 1,
    rotationScale: 1,
    deadZone: 0.08,
    dominantAxis: false,
    roll: true,
    reversed: []
  });

/**
 * Device readings → the camera-frame axes the camera consumes, with the
 * user's preferences applied in the order a driver applies them: the dead
 * zone and response curve, the axes switched off, the dominant axis, the
 * reversed axes, then the speeds. The dominant axis is chosen after the
 * dead zone and the switched-off axes, so a disabled roll never wins it.
 */
export function sixDofFromRawWithPreferences(
  raw: SpaceMouseRawState,
  preferences: SixDofPreferences = DEFAULT_SIX_DOF_PREFERENCES,
  shaping: SixDofShaping = DEFAULT_SIX_DOF_SHAPING
): SixDofAxes {
  const axes = sixDofFromRaw(raw, {
    ...shaping,
    deadZone: Math.min(Math.max(preferences.deadZone, 0), 0.95)
  });
  if (preferences.rotationLocked) {
    axes.rx = 0;
    axes.ry = 0;
    axes.rz = 0;
  }
  if (!preferences.roll) {
    axes.rz = 0;
  }
  if (preferences.dominantAxis) {
    let strongest: SixDofAxisKey | null = null;
    for (const key of SIX_DOF_KEYS) {
      if (
        axes[key] !== 0 &&
        (strongest === null || Math.abs(axes[key]) > Math.abs(axes[strongest]))
      ) {
        strongest = key;
      }
    }
    for (const key of SIX_DOF_KEYS) {
      if (key !== strongest) axes[key] = 0;
    }
  }
  const translation = Math.max(preferences.translationScale, 0);
  const rotation = Math.max(preferences.rotationScale, 0);
  for (const key of SIX_DOF_KEYS) {
    const reversed = preferences.reversed.includes(key) ? -1 : 1;
    const scale = key.startsWith('t') ? translation : rotation;
    // `+ 0` folds a negative zero away so idle reads compare cleanly.
    axes[key] = axes[key] * reversed * scale + 0;
  }
  return axes;
}
