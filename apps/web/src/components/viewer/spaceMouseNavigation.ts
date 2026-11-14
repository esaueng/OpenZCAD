import type { SpaceMouseReport } from '../../lib/desktopBridge';

const DEAD_ZONE = 12;
const AXIS_MAX = 350;
// A missing release or an unplug must not leave the view moving.
const REPORT_TIMEOUT_MS = 150;
const MAX_FRAME_MS = 32;
const ORBIT_RADIANS_PER_SECOND = 2.2;

const VIEW_BUTTONS = [
  [1, 'fit'],
  [2, 'top'],
  [4, 'right'],
  [5, 'front'],
  [8, 'roll'],
  [26, 'toggle-rotation']
] as const;

export type SpaceMouseAction = (typeof VIEW_BUTTONS)[number][1];
type Axes = [number, number, number];

function normalize(raw: number): number {
  const magnitude = Math.min(Math.abs(raw), AXIS_MAX);
  return (
    Math.sign(raw) *
    (Math.max(magnitude - DEAD_ZONE, 0) / (AXIS_MAX - DEAD_ZONE))
  );
}

export class SpaceMouseNavigation {
  private translation: { axes: Axes; at: number } | null = null;
  private rotation: { axes: Axes; at: number } | null = null;
  private lastFrame: number | null = null;
  private buttons = 0;
  private rotationLocked = false;

  reset() {
    this.translation = this.rotation = null;
    this.lastFrame = null;
  }

  receive(
    report: SpaceMouseReport,
    now: number,
    active: boolean
  ): SpaceMouseAction[] {
    if (report.kind === 'disconnected') {
      this.reset();
      this.buttons = 0;
    } else if (report.kind === 'buttons') {
      const down = report.value & ~this.buttons;
      this.buttons = report.value;
      if (active) {
        const actions = VIEW_BUTTONS.filter(
          ([bit]) => (down & (1 << bit)) !== 0
        ).map(([, action]) => action);
        if (actions.includes('toggle-rotation')) {
          this.rotationLocked = !this.rotationLocked;
          this.rotation = null;
        }
        return actions;
      }
    } else if (active) {
      const axes: Axes = [
        normalize(report.value[0]),
        normalize(report.value[1]),
        normalize(report.value[2])
      ];
      this[report.kind] = axes.some(Boolean) ? { axes, at: now } : null;
    }
    return [];
  }

  get moving(): boolean {
    return (
      this.translation !== null ||
      (!this.rotationLocked && this.rotation !== null)
    );
  }

  step(now: number) {
    if (this.translation && now - this.translation.at > REPORT_TIMEOUT_MS)
      this.translation = null;
    if (this.rotation && now - this.rotation.at > REPORT_TIMEOUT_MS)
      this.rotation = null;
    if (!this.moving) {
      this.lastFrame = null;
      return null;
    }
    const previous = this.lastFrame ?? now - 1000 / 60;
    this.lastFrame = now;
    const seconds = Math.max(0, Math.min(now - previous, MAX_FRAME_MS)) / 1000;
    const [x, y, z] = this.translation?.axes ?? [0, 0, 0];
    const [rx, ry, rz] = (!this.rotationLocked && this.rotation?.axes) || [
      0, 0, 0
    ];
    // HID +X is right, +Y is toward the user, and +Z is down.
    // Camera-local +X is right, +Y is up, and +Z is toward the viewer.
    return {
      panX: x * seconds,
      panY: -z * seconds,
      zoom: -y * seconds * 1.6,
      pitch: -rx * seconds * ORBIT_RADIANS_PER_SECOND,
      yaw: rz * seconds * ORBIT_RADIANS_PER_SECOND,
      roll: -ry * seconds * ORBIT_RADIANS_PER_SECOND
    };
  }
}
