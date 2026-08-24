import { Fragment } from 'react';
import { LIVE_DIAMETER_ATTRIBUTE } from '../lib/liveLabels';
import { formatDiameter, type LabelSegment } from '../lib/topologyLabels';

/**
 * React counterpart of `renderLabelSegments`: the same nodes and the same
 * attribute, so `setLiveDiameter` drives a React-rendered name and an
 * imperatively built viewport callout through one code path.
 */
export function LabelSegments({
  segments
}: {
  segments: readonly LabelSegment[];
}) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'diameter' ? (
          <span
            key={index}
            {...{ [LIVE_DIAMETER_ATTRIBUTE]: segment.diameter }}
          >
            {formatDiameter(segment.diameter)}
          </span>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        )
      )}
    </>
  );
}
