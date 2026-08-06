import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { assistantSuggestions } from '../apps/web/src/lib/assistant/suggestions';
import { preflightCadPatch } from '../apps/web/src/lib/aiPatchPreflight';

describe('verified assistant suggestions', { timeout: 120_000 }, () => {
  let adapter: ExactKernelAdapter;

  beforeAll(async () => {
    adapter = await createExactKernelAdapter();
  });

  afterAll(() => {
    adapter.dispose();
  });

  const suggestions = assistantSuggestions({
    bodyCount: 0,
    topologyKind: null,
    selectedBodyCount: 0
  });

  it.each(suggestions)(
    '$label exact-preflights to one exportable solid',
    async (suggestion) => {
      expect(suggestion.proposal).toBeDefined();
      const base = createProjectDocument(
        suggestion.label,
        toUserId(`user_${suggestion.id}`)
      );
      const result = await preflightCadPatch(
        base,
        suggestion.proposal!,
        (candidate) => adapter.syncDocument(candidate)
      );

      expect(result.candidate.derived.warnings).toEqual([]);
      expect(result.candidate.derived.exportableBodyIds).toHaveLength(1);
      const bodyId = result.candidate.derived.exportableBodyIds[0]!;
      expect(
        result.candidate.derived.bodyRepresentations[bodyId]
      ).toMatchObject({
        consumed: false
      });

      const step = await adapter.exportStep(result.candidate, [bodyId]);
      await expect(adapter.inspectStep(step)).resolves.toMatchObject({
        solid: true,
        valid: true
      });
    }
  );
});
