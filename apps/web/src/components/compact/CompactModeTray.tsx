import {
  CompactTweakTray,
  type CompactTweakTrayProps
} from './CompactTweakTray';
import { CompactViewTray, type CompactViewTrayProps } from './CompactViewTray';

export type { CompactMeasure } from './CompactViewTray';
export type { CompactTweakTrayProps, CompactViewTrayProps };

/** View's or Tweak's tray, by mode. */
export type CompactModeTrayProps =
  | ({ mode: 'view' } & CompactViewTrayProps)
  | ({ mode: 'tweak' } & CompactTweakTrayProps);

/**
 * The compact workspace's tray for View and Tweak (U12 slice 7), loaded
 * only where the compact workspace is in force: the regular workspace's
 * entry chunk does not carry it.
 */
export default function CompactModeTray(props: CompactModeTrayProps) {
  if (props.mode === 'view') {
    const { mode: _mode, ...view } = props;
    return <CompactViewTray {...view} />;
  }
  const { mode: _mode, ...tweak } = props;
  return <CompactTweakTray {...tweak} />;
}
