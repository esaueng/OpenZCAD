import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CadDocumentDigest } from '@openzcad/ai-contracts';
import {
  assistantDisabledReason,
  ENCRYPTED_PROJECT_ASSISTANT_NOTICE
} from './assistant/encryptedProject';
import { AssistantStreamError, streamAssistantReply } from './assistantStream';
import { desktopFetch } from './desktopBridge';

const encrypted = vi.hoisted(() => new Set<string>());
/** Held as encrypted here without a pin (unresolved, or required). */
const required = vi.hoisted(() => new Set<string>());
vi.mock('./api', () => ({
  ApiError: class ApiError extends Error {
    code?: string;
  },
  E2EE_CUTOVER_UNRESOLVED_CODE: 'E2EE_CUTOVER_UNRESOLVED',
  E2EE_PLAINTEXT_REFUSED_CODE: 'E2EE_PLAINTEXT_REFUSED',
  encryptionRequired: (projectId: string | null | undefined) =>
    projectId ? encrypted.has(projectId) || required.has(projectId) : false,
  isEncryptedProject: (projectId: string | null | undefined) =>
    projectId ? encrypted.has(projectId) : false
}));
vi.mock('./desktopBridge', () => ({
  desktopFetch: vi.fn(async () => new Response('offline', { status: 503 })),
  isDesktopApp: () => false
}));

afterEach(() => {
  encrypted.clear();
  required.clear();
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
  it('is disabled for an encrypted project until a consent gate opens it', () => {
    // App gives a directly opened project, known only by the page's
    // marker, a format-2 summary; without a gate it stays off.
    expect(assistantDisabledReason({ storageFormat: 2 })).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    );
    expect(
      assistantDisabledReason(
        { storageFormat: 2 },
        { status: { kind: 'ready' } }
      )
    ).toBeNull();
    expect(assistantDisabledReason(undefined)).toBeNull();
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

    // PR #1418, owner decision 2026-11-14: a project this device holds as
    // encrypted is refused even when the panel verified its consent.
    await expect(
      streamAssistantReply({
        prompt: 'Make the wall 3 mm',
        digest: digest('proj_secret'),
        consentedProjectId: 'proj_secret'
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    required.add('proj_required');
    await expect(
      streamAssistantReply({
        prompt: 'Hi',
        digest: digest('proj_required'),
        consentedProjectId: 'proj_required'
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
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
