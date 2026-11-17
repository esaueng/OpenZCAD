import { describe, expect, it } from 'vitest';
import { toUserId } from '@openzcad/shared';
import { currentCheckpointAuthor } from './checkpointAuthor';

const mac =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('currentCheckpointAuthor', () => {
  it('names the account and this device', () => {
    expect(
      currentCheckpointAuthor(
        { userId: toUserId('user_a'), displayName: 'Ada' },
        mac
      )
    ).toEqual({ userId: 'user_a', name: 'Ada', device: 'Chrome on macOS' });
  });

  it('records only the device when signed out or unnamed', () => {
    expect(currentCheckpointAuthor(null, mac)).toEqual({
      device: 'Chrome on macOS'
    });
    expect(
      currentCheckpointAuthor(
        { userId: toUserId('user_a'), displayName: '  ' },
        mac
      )
    ).toEqual({ userId: 'user_a', device: 'Chrome on macOS' });
  });
});
