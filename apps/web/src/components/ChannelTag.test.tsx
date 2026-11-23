import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChannelTag } from './ChannelTag';

describe('ChannelTag', () => {
  it.each([
    ['stable', 'Stable'],
    ['beta', 'Beta'],
    ['dev', 'Dev']
  ] as const)('labels the %s channel', (channel, label) => {
    render(<ChannelTag channel={channel} />);
    const tag = screen.getByText(label);
    expect(tag.className).toBe('channel-tag');
    expect(tag.dataset.channel).toBe(channel);
  });
});
