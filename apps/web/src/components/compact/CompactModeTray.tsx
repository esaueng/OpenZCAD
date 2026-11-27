import { CompactTrayAnchor } from './CompactTray';
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

/** View's or Tweak's tray, an open sketch's, by mode, or Draw's anchor. */
export type CompactModeTrayProps =
  | ({ mode: 'view' } & CompactViewTrayProps)
  | ({ mode: 'tweak' } & CompactTweakTrayProps)
  | ({ mode: 'sketch' } & CompactSketchTrayProps)
  | { mode: 'drawing' };

/**
 * The compact workspace's tray for View and Tweak (U12 slice 7), for an open
 * sketch (slice 6) and for Draw (slice 9), loaded only where the compact
 * workspace is in force: the regular workspace's entry chunk does not carry
 * it. Draw keeps its state on the stage, so its tray here is only the anchor
 * the drawing workspace draws its own tray into.
 */
export default function CompactModeTray(props: CompactModeTrayProps) {
  if (props.mode === 'drawing') return <CompactTrayAnchor />;
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
