import {
  CHANNEL_LABELS,
  RELEASE_CHANNEL,
  type ReleaseChannel
} from '../lib/releaseChannel';

/** The word beside the wordmark naming the channel this page runs on. */
export function ChannelTag({
  channel = RELEASE_CHANNEL
}: {
  channel?: ReleaseChannel;
}) {
  return (
    <span className="channel-tag" data-channel={channel}>
      {CHANNEL_LABELS[channel]}
    </span>
  );
}
