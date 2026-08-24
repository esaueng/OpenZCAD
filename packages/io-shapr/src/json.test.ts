import { describe, expect, it } from 'vitest';

import { parseBoundedJson } from './json';
import { resolveShaprImportLimits } from './limits';

describe('bounded SHAPR JSON decoding', () => {
  it('rejects excessive nesting before parsing', () => {
    expect(() =>
      parseBoundedJson(
        '{"value":{"nested":1}}',
        'curve data',
        resolveShaprImportLimits({ maxValueDepth: 1 })
      )
    ).toThrow('nesting-depth limit');
  });

  it('ignores structural characters inside strings during the depth scan', () => {
    expect(
      parseBoundedJson(
        '{"value":"[[{escaped}]]"}',
        'curve data',
        resolveShaprImportLimits({ maxValueDepth: 1 })
      )
    ).toEqual({ value: '[[{escaped}]]' });
  });
});
