import {
  CompactSketchTray,
  type CompactSketchTrayProps
} from './CompactSketchTray';
import {
  CompactTweakTray,
  type CompactTweakTrayProps
} from './CompactTweakTray';
import { CompactViewTray, type CompactViewTrayProps } from './CompactViewTray';

export type { CompactMeasure } from './CompactViewTray';
export type {
  CompactSketchTrayProps,
  CompactTweakTrayProps,
  CompactViewTrayProps
};

/** View's or Tweak's tray, or an open sketch's, by mode. */
export type CompactModeTrayProps =
  | ({ mode: 'view' } & CompactViewTrayProps)
  | ({ mode: 'tweak' } & CompactTweakTrayProps)
  | ({ mode: 'sketch' } & CompactSketchTrayProps);

/**
 * The compact workspace's tray for View and Tweak (U12 slice 7) and for an
 * open sketch (slice 6), loaded only where the compact workspace is in
 * force: the regular workspace's entry chunk does not carry it.
 */
export default function CompactModeTray(props: CompactModeTrayProps) {
  if (props.mode === 'view') {
    const { mode: _mode, ...view } = props;
    return <CompactViewTray {...view} />;
  }
  if (props.mode === 'sketch') {
    const { mode: _mode, ...sketch } = props;
    return <CompactSketchTray {...sketch} />;
  }
  const { mode: _mode, ...tweak } = props;
  return <CompactTweakTray {...tweak} />;
}
