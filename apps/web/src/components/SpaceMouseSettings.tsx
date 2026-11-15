import { useSyncExternalStore } from 'react';
import { Plug, Unplug } from 'lucide-react';
import {
  spaceMouse as defaultHub,
  type SpaceMouseHub,
  type SpaceMouseStatus
} from '../lib/spaceMouse';
import {
  SPACE_MOUSE_AXIS_NAMES,
  SPACE_MOUSE_DEAD_ZONE_BOUNDS,
  SPACE_MOUSE_SPEED_BOUNDS,
  type SpaceMouseAxisName,
  type SpaceMouseRotateAbout,
  type SpaceMouseSettings
} from '@openzcad/shared';
import {
  NumberSetting,
  Segmented,
  SettingRow,
  Toggle,
  type SegmentOption
} from './settingsControls';

function hintFor(status: SpaceMouseStatus): string {
  switch (status.state) {
    case 'unsupported':
      return 'Needs Chrome or Edge on a computer.';
    case 'blocked':
      return 'This page is not allowed to use USB devices.';
    case 'disconnected':
      return 'Connect a 3Dconnexion SpaceMouse. The browser asks which device to share.';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return status.rotationLocked
        ? `${status.name} is connected. Rotation is locked; press Lock to turn the view again.`
        : `${status.name} moves the view, and every key works.`;
    case 'error':
      return `${status.message} 3Dconnexion's driver (3DxWare) keeps the device to itself while it is installed; uninstall it, or quit any other app using the device, then connect again.`;
  }
}

/**
 * The 3D mouse row: connection status and the one control that changes it.
 * The browser keeps the permission, so a connected device reconnects on its
 * own next time; Disconnect gives that permission up.
 */
export function SpaceMouseSettings({
  hub = defaultHub
}: {
  hub?: SpaceMouseHub;
}) {
  const status = useSyncExternalStore(hub.subscribeStatus, hub.getStatus);
  const connected = status.state === 'connected';
  const unavailable =
    status.state === 'unsupported' ||
    status.state === 'blocked' ||
    status.state === 'connecting';
  return (
    <SettingRow
      title="3D mouse"
      hint={
        <span role="status" aria-live="polite">
          {hintFor(status)}
        </span>
      }
    >
      {connected ? (
        <button
          className="secondary"
          type="button"
          onClick={() => void hub.disconnect()}
        >
          <Unplug size={14} aria-hidden="true" />
          Disconnect
        </button>
      ) : (
        <button
          className="secondary"
          type="button"
          disabled={unavailable}
          onClick={() => void hub.connect()}
        >
          <Plug size={14} aria-hidden="true" />
          Connect
        </button>
      )}
    </SettingRow>
  );
}

const AXIS_LABELS: Record<SpaceMouseAxisName, string> = {
  'pan-x': 'Left/right',
  'pan-y': 'Up/down',
  zoom: 'Zoom',
  tilt: 'Tilt',
  spin: 'Spin',
  roll: 'Roll'
};

const ROTATE_ABOUT_OPTIONS: readonly SegmentOption<SpaceMouseRotateAbout>[] = [
  {
    value: 'model',
    label: 'Model',
    title: 'The selection, or the whole model'
  },
  { value: 'orbit-point', label: 'Orbit point', title: 'The orbit point' }
];

/**
 * How the cap moves the view: speeds, the dead zone that keeps a light
 * touch from turning, one axis at a time, the rotation centre, roll, and
 * which axes run the other way. Saved with the account's settings.
 */
export function SpaceMousePreferenceRows({
  value,
  onChange
}: {
  value: SpaceMouseSettings;
  onChange(next: SpaceMouseSettings): void;
}) {
  const reversed = new Set(value.reversed);
  return (
    <>
      <SettingRow
        title="Pan and zoom speed"
        hint="How fast pushing, pulling and lifting the cap moves the view."
      >
        <NumberSetting
          label="Pan and zoom speed"
          value={value.panZoomSpeed}
          min={SPACE_MOUSE_SPEED_BOUNDS.min}
          max={SPACE_MOUSE_SPEED_BOUNDS.max}
          step={10}
          integer
          unit="%"
          onCommit={(panZoomSpeed) => onChange({ ...value, panZoomSpeed })}
        />
      </SettingRow>
      <SettingRow
        title="Rotation speed"
        hint="How fast tilting, spinning and rolling the cap turns the view."
      >
        <NumberSetting
          label="Rotation speed"
          value={value.rotationSpeed}
          min={SPACE_MOUSE_SPEED_BOUNDS.min}
          max={SPACE_MOUSE_SPEED_BOUNDS.max}
          step={10}
          integer
          unit="%"
          onCommit={(rotationSpeed) => onChange({ ...value, rotationSpeed })}
        />
      </SettingRow>
      <SettingRow
        title="Dead zone"
        hint="Cap travel ignored around rest. Raise it if a push also turns the view."
      >
        <NumberSetting
          label="Dead zone"
          value={value.deadZone}
          min={SPACE_MOUSE_DEAD_ZONE_BOUNDS.min}
          max={SPACE_MOUSE_DEAD_ZONE_BOUNDS.max}
          integer
          unit="%"
          onCommit={(deadZone) => onChange({ ...value, deadZone })}
        />
      </SettingRow>
      <SettingRow
        title="One motion at a time"
        hint="Only the direction you push hardest moves the view."
      >
        <Toggle
          checked={value.dominantAxis}
          label="One motion at a time"
          onChange={(dominantAxis) => onChange({ ...value, dominantAxis })}
        />
      </SettingRow>
      <SettingRow
        title="Rotate around"
        hint="Model turns the selection, or the whole model, in place."
      >
        <Segmented
          label="Rotate around"
          value={value.rotateAbout}
          options={ROTATE_ABOUT_OPTIONS}
          onChange={(rotateAbout) => onChange({ ...value, rotateAbout })}
        />
      </SettingRow>
      <SettingRow
        title="Roll"
        hint="Rolling the cap sideways rolls the view. A turntable orbit never rolls."
      >
        <Toggle
          checked={value.roll}
          label="Roll"
          onChange={(roll) => onChange({ ...value, roll })}
        />
      </SettingRow>
      <SettingRow
        title="Reverse"
        hint="Selected directions move the view the other way."
      >
        <div
          className="space-mouse-axis-filter"
          role="group"
          aria-label="Reverse 3D mouse directions"
        >
          {SPACE_MOUSE_AXIS_NAMES.map((axis) => (
            <button
              key={axis}
              type="button"
              className="space-mouse-axis-toggle"
              aria-pressed={reversed.has(axis)}
              aria-label={`Reverse ${AXIS_LABELS[axis].toLowerCase()}`}
              onClick={() =>
                onChange({
                  ...value,
                  reversed: SPACE_MOUSE_AXIS_NAMES.filter((candidate) =>
                    candidate === axis
                      ? !reversed.has(axis)
                      : reversed.has(candidate)
                  )
                })
              }
            >
              {AXIS_LABELS[axis]}
            </button>
          ))}
        </div>
      </SettingRow>
    </>
  );
}
