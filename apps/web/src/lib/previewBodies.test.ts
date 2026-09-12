import { describe, expect, it } from 'vitest';
import type { BodyRepresentation } from '@openzcad/shared';
import { mergePreviewBodies } from './previewBodies';

const body = (bodyId: string, name = bodyId): BodyRepresentation =>
  ({ bodyId, name }) as unknown as BodyRepresentation;

describe('mergePreviewBodies', () => {
  it('replaces only the previewed result and keeps every other part', () => {
    const bracket = body('bracket');
    const holder = body('holder');
    const preview = body('holder', 'holder preview');
    expect(mergePreviewBodies([bracket, holder], [preview])).toEqual([
      bracket,
      preview
    ]);
  });

  it('passes the list through without a preview and appends a preview of a body the list lacks', () => {
    const bracket = body('bracket');
    expect(mergePreviewBodies([bracket], null)).toEqual([bracket]);
    expect(mergePreviewBodies([bracket], [])).toEqual([bracket]);
    // Hidden bodies are the caller's business: it drops their previews before
    // merging, so anything that reaches here is meant to be shown.
    expect(mergePreviewBodies([bracket], [body('holder')])).toEqual([
      bracket,
      body('holder')
    ]);
  });
});
