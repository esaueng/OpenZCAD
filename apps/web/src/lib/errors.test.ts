import { describe, expect, it } from 'vitest';
import { errorMessage } from './errors';
import { STALE_CHUNK_MESSAGE } from './staleChunk';

describe('errorMessage', () => {
  it('passes an ordinary error through and falls back for non-errors', () => {
    expect(errorMessage(new Error('Box is too small.'), 'Failed.')).toBe(
      'Box is too small.'
    );
    expect(errorMessage({ code: 1 }, 'Failed.')).toBe('Failed.');
  });

  it('names a chunk lost to a deploy instead of quoting its URL', () => {
    expect(
      errorMessage(
        new TypeError(
          'Failed to fetch dynamically imported module: https://zcad.app/assets/demos-BLYQ4WoN.js'
        ),
        'Failed to build the demo.'
      )
    ).toBe(STALE_CHUNK_MESSAGE);
  });
});
