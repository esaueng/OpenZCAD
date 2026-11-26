import { CompactTrayAnchor } from './CompactTray';
import {
  CompactTweakTray,
  type CompactTweakTrayProps
} from './CompactTweakTray';
import { CompactViewTray, type CompactViewTrayProps } from './CompactViewTray';

export type { CompactMeasure } from './CompactViewTray';
export type { CompactTweakTrayProps, CompactViewTrayProps };

/** View's or Tweak's tray, by mode, or Draw's anchor. */
export type CompactModeTrayProps =
  | ({ mode: 'view' } & CompactViewTrayProps)
  | ({ mode: 'tweak' } & CompactTweakTrayProps)
  | { mode: 'drawing' };

/**
 * The compact workspace's tray for View, Tweak and Draw (U12 slices 7 and
 * 9), loaded only where the compact workspace is in force: the regular
 * workspace's entry chunk does not carry it. Draw keeps its state on the
 * stage, so its tray here is only the anchor the drawing workspace draws
 * its own tray into.
 */
export default function CompactModeTray(props: CompactModeTrayProps) {
  if (props.mode === 'drawing') return <CompactTrayAnchor />;
  if (props.mode === 'view') {
    const { mode: _mode, ...view } = props;
    return <CompactViewTray {...view} />;
  }
  const { mode: _mode, ...tweak } = props;
  return <CompactTweakTray {...tweak} />;
}
