import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CadDocumentDigest } from '@openzcad/ai-contracts';
import {
  assistantDisabledReason,
  ENCRYPTED_PROJECT_ASSISTANT_NOTICE
} from './assistant/encryptedProject';
import { AssistantStreamError, streamAssistantReply } from './assistantStream';
import { desktopFetch } from './desktopBridge';

const encrypted = vi.hoisted(() => new Set<string>());
vi.mock('./api', () => ({
  isEncryptedProject: (projectId: string | null | undefined) =>
    projectId ? encrypted.has(projectId) : false
}));
vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(async () => new Response('offline', { status: 503 })),
  isDesktopApp: () => false
}));

afterEach(() => {
  encrypted.clear();
  vi.clearAllMocks();
});

const digest = (projectId: string) =>
  ({ projectId, name: 'Bracket' }) as unknown as CadDocumentDigest;

/**
 * ADR-024 decision D7, from #869's review: a project opened directly while
 * the listing is unavailable has no summary saying it is encrypted, so the
 * page's own marker gates the assistant too.
 */
describe('the assistant and this page’s encrypted-project marker', () => {
  it('is disabled by the marker even without a summary', () => {
    expect(assistantDisabledReason(undefined, true)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    );
    expect(assistantDisabledReason({ storageFormat: 1 }, true)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    );
    expect(assistantDisabledReason(undefined, false)).toBeNull();
  });

  it('sends nothing of a project the page knows is encrypted', async () => {
    encrypted.add('proj_secret');
    const refused = streamAssistantReply({
      prompt: 'Make the wall 3 mm',
      digest: digest('proj_secret')
    });
    await expect(refused).rejects.toBeInstanceOf(AssistantStreamError);
    await expect(refused).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    expect(desktopFetch).not.toHaveBeenCalled();

    // A plaintext project still reaches the route.
    await expect(
      streamAssistantReply({ prompt: 'Hi', digest: digest('proj_plain') })
    ).rejects.toBeDefined();
    expect(desktopFetch).toHaveBeenCalledWith(
      '/api/assistant/proposals',
      expect.anything()
    );
  });
});
