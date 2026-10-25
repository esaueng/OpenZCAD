import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  assistantDisabledReason,
  ENCRYPTED_PROJECT_ASSISTANT_NOTICE
} from '../../lib/assistant/encryptedProject';
import { AssistantPanel } from './AssistantPanel';

const doc = createProjectDocument('Bracket', toUserId('user_a'));
const configured = {
  configured: true,
  provider: 'openrouter',
  model: 'test-model',
  reasoningEffort: 'medium'
} as const;

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * ADR-024 decision D7: the assistant stays off on an end-to-end encrypted
 * project until per-project consent (Phase 6), even with a provider ready.
 */
describe('the assistant on an encrypted project', () => {
  it('is disabled only for a project stored encrypted', () => {
    expect(assistantDisabledReason(undefined)).toBeNull();
    expect(assistantDisabledReason({})).toBeNull();
    expect(assistantDisabledReason({ storageFormat: 1 })).toBeNull();
    expect(assistantDisabledReason({ storageFormat: 2 })).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    );
  });

  it('opens to per-project consent only through a consent gate (Phase 6)', () => {
    const encrypted = { storageFormat: 2 } as const;
    // No gate (an older build path) or a gate that cannot store consent:
    // off exactly as before.
    expect(assistantDisabledReason(encrypted, null)).toBe(
      ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    );
    expect(
      assistantDisabledReason(encrypted, {
        status: { kind: 'unavailable', reason: '' }
      })
    ).toBe(ENCRYPTED_PROJECT_ASSISTANT_NOTICE);
    // A gate that can ask: the panel runs and asks before sending.
    for (const kind of ['checking', 'locked', 'ready']) {
      expect(
        assistantDisabledReason(encrypted, { status: { kind } })
      ).toBeNull();
    }
    // A plaintext project ignores any gate.
    expect(
      assistantDisabledReason(
        { storageFormat: 1 },
        { status: { kind: 'unavailable', reason: 'x' } }
      )
    ).toBeNull();
  });

  it('explains itself, takes nothing and sends nothing', async () => {
    const onActivity = vi.fn();
    const onDraft = vi.fn();
    const props = {
      document: doc,
      selection: { bodyIds: [], featureIds: [], topologies: [] },
      onApply: vi.fn().mockResolvedValue(true),
      onPreview: vi.fn().mockResolvedValue({ ok: true }),
      collapsed: false,
      onCollapsedChange: vi.fn(),
      confirmDestructive: true,
      effectiveAssistant: configured,
      signedIn: true,
      onActivity,
      onDraft,
      disabledReason: ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    };
    const { rerender } = render(<AssistantPanel {...props} />);
    await act(async () => {});
    expect(screen.getByText(ENCRYPTED_PROJECT_ASSISTANT_NOTICE)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Attach a drawing' })
    ).toBeDisabled();
    expect(onActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({ unavailable: true })
    );
    // A question typed into the prompt line is handed back, not sent.
    rerender(
      <AssistantPanel
        {...props}
        request={{ id: 1, text: 'Make the wall 3 mm' }}
      />
    );
    await act(async () => {});
    expect(onDraft).toHaveBeenCalledWith('Make the wall 3 mm');
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/assistant/proposals',
      expect.anything()
    );
  });

  it('stays available on a plaintext project', async () => {
    render(
      <AssistantPanel
        document={doc}
        selection={{ bodyIds: [], featureIds: [], topologies: [] }}
        onApply={vi.fn().mockResolvedValue(true)}
        onPreview={vi.fn().mockResolvedValue({ ok: true })}
        collapsed={false}
        onCollapsedChange={vi.fn()}
        confirmDestructive
        effectiveAssistant={configured}
        disabledReason={null}
      />
    );
    await act(async () => {});
    expect(screen.queryByText(ENCRYPTED_PROJECT_ASSISTANT_NOTICE)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Attach a drawing' })
    ).toBeEnabled();
  });
});
