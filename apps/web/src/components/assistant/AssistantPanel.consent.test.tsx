import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectDocument } from '@openzcad/document-core';
import {
  decodeAssistantConsent,
  encodeAssistantConsent,
  fromBase64Url,
  macAssistantConsent,
  openAssistantConsent,
  toBase64Url
} from '@openzcad/crypto';
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  toUserId,
  type E2eeAssistantConsentRecord,
  type ProjectId
} from '@openzcad/shared';
import * as consentModule from '../../lib/e2ee/assistantConsent';
import { E2eeApiError } from '../../lib/e2ee/e2eeApi';
import { useAssistantConsentGate } from '../../lib/assistant/consentGate';
import {
  ASSISTANT_CONSENT_REQUEST_FIELDS,
  assistantConsentRoute
} from '../../lib/assistant/consentCopy';
import {
  assistantDisabledReason,
  ENCRYPTED_PROJECT_ASSISTANT_NOTICE
} from '../../lib/assistant/encryptedProject';
import { AssistantPanel, ASSISTANT_CONSENT_NOT_GIVEN } from './AssistantPanel';

const USER = 'user_a';
const doc = createProjectDocument('Secret bracket', toUserId(USER));
const ENCRYPTED = { projectId: doc.projectId, storageFormat: 2 } as const;
const PLAINTEXT = { projectId: doc.projectId, storageFormat: 1 } as const;
const ACCOUNT_KEY = new Uint8Array(32).fill(3);
const configured = {
  configured: true,
  source: 'deployment',
  provider: 'openrouter',
  model: 'test-model',
  reasoningEffort: 'medium'
} as const;
const ROUTE = assistantConsentRoute(configured);
const REPLY = `data: ${JSON.stringify({
  type: 'response.output_text.done',
  text: JSON.stringify({
    replyKind: 'message',
    proposal: null,
    questions: null,
    message: 'The wall is 2 mm.',
    readings: null
  })
})}\n\ndata: ${JSON.stringify({ type: 'response.completed' })}\n\n`;

/** The Worker's consent routes, in memory: it stores, it cannot forge a MAC. */
function consentServer() {
  const rows = new Map<string, E2eeAssistantConsentRecord>();
  let unavailable = false;
  const api: consentModule.AssistantConsentApi = {
    list: async () => ({ consents: [...rows.values()] }),
    load: async (projectId) => {
      if (unavailable) throw new E2eeApiError(503, 'Not yet.');
      return { consent: rows.get(projectId) ?? null };
    },
    save: async (projectId, request) => {
      if (unavailable) throw new E2eeApiError(503, 'Not yet.');
      const decoded = decodeAssistantConsent(fromBase64Url(request.record));
      const current = rows.get(projectId);
      if (current && current.sequence >= decoded.sequence) {
        throw new E2eeApiError(409, 'stale');
      }
      const row: E2eeAssistantConsentRecord = {
        projectId,
        record: request.record,
        recordMac: request.recordMac,
        allowed: decoded.allowed,
        copyVersion: decoded.copyVersion,
        route: decoded.route,
        sequence: decoded.sequence,
        updatedAt: new Date().toISOString(),
        revokedAt: decoded.allowed ? null : new Date().toISOString()
      };
      rows.set(projectId, row);
      return { consent: row };
    },
    members: async () => ({ consents: [] })
  };
  return {
    api,
    rows,
    setUnavailable(value: boolean) {
      unavailable = value;
    },
    /** A row the server wrote itself, MAC'd under a key that is not ours. */
    async forge(projectId: string, sequence: number, key = new Uint8Array(32)) {
      const record = encodeAssistantConsent({
        userId: USER,
        projectId,
        allowed: true,
        copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
        route: ROUTE,
        sequence
      });
      rows.set(projectId, {
        projectId,
        record: toBase64Url(record),
        recordMac: toBase64Url(await macAssistantConsent(key, record)),
        allowed: true,
        copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
        route: ROUTE,
        sequence,
        updatedAt: new Date().toISOString(),
        revokedAt: null
      });
    }
  };
}

type Server = ReturnType<typeof consentServer>;

function Harness({
  server,
  pins,
  project,
  request,
  status = configured
}: {
  server: Server;
  pins: consentModule.ConsentPinStore;
  project: { projectId: ProjectId; storageFormat: 1 | 2 };
  request?: { id: number; text: string } | null;
  status?:
    typeof configured | (Omit<typeof configured, 'model'> & { model: string });
}) {
  const gate = useAssistantConsentGate(USER, project, {
    loadModule: async () => consentModule,
    context: (_module, userId) => ({
      userId,
      accountKey: ACCOUNT_KEY,
      api: server.api,
      pins
    })
  });
  return (
    <AssistantPanel
      document={doc}
      selection={{ bodyIds: [], featureIds: [], topologies: [] }}
      onApply={vi.fn().mockResolvedValue(true)}
      onPreview={vi.fn().mockResolvedValue({ ok: true })}
      collapsed={false}
      onCollapsedChange={vi.fn()}
      confirmDestructive
      effectiveAssistant={status}
      signedIn
      request={request ?? null}
      disabledReason={assistantDisabledReason(project, gate)}
      consent={gate}
    />
  );
}

/** Every request the panel posts to the assistant route, with its body. */
let proposals: { body: Record<string, unknown>; signal?: AbortSignal }[];
let hold: Promise<void> | null;

beforeEach(() => {
  window.localStorage.clear();
  proposals = [];
  hold = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = input;
      if (url.endsWith('/api/assistant/proposals')) {
        proposals.push({
          body: JSON.parse(init?.body as string) as Record<string, unknown>,
          signal: init?.signal ?? undefined
        });
        if (hold) {
          await new Promise<void>((resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
            void hold!.then(resolve);
          });
        }
        return new Response(REPLY, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function ask(
  rerender: (ui: React.ReactElement) => void,
  props: Parameters<typeof Harness>[0],
  id: number,
  text = 'How thick is the wall?'
) {
  rerender(<Harness {...props} request={{ id, text }} />);
  await act(async () => {});
}

describe('assistant consent on an encrypted project (ADR-024 6-1)', () => {
  it('asks first, sends nothing when declined, and sends exactly the listed fields once allowed', async () => {
    const user = userEvent.setup();
    const server = consentServer();
    const props = {
      server,
      pins: consentModule.memoryConsentPins(),
      project: ENCRYPTED
    };
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {});
    expect(screen.queryByText(ENCRYPTED_PROJECT_ASSISTANT_NOTICE)).toBeNull();

    await ask(rerender, props, 1);
    const dialog = await screen.findByRole('dialog', {
      name: 'Let the assistant read this encrypted project?'
    });
    // The copy names who receives it and every item that leaves.
    expect(dialog.textContent).toContain(
      'OpenZCAD’s AI provider, OpenRouter, model test-model'
    );
    for (const label of [
      'What you ask',
      'This project’s conversation',
      'The project’s id and name',
      'A summary of the model',
      'Your selection',
      'Drawings and images you attach'
    ]) {
      expect(dialog.textContent).toContain(label);
    }
    expect(dialog.textContent).toContain('cannot be recalled');
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(await screen.findByText(ASSISTANT_CONSENT_NOT_GIVEN)).toBeTruthy();
    expect(proposals).toEqual([]);
    expect(server.rows.size).toBe(0);

    await ask(rerender, props, 2);
    await user.click(
      await screen.findByRole('button', { name: 'Allow for this project' })
    );
    await waitFor(() => expect(proposals).toHaveLength(1));
    expect(Object.keys(proposals[0]!.body).sort()).toEqual([
      ...ASSISTANT_CONSENT_REQUEST_FIELDS
    ]);
    expect((proposals[0]!.body.digest as { projectId: string }).projectId).toBe(
      doc.projectId
    );
    // The stored record is ours: it opens under the account key.
    const row = server.rows.get(doc.projectId)!;
    await expect(
      openAssistantConsent(
        ACCOUNT_KEY,
        fromBase64Url(row.record),
        fromBase64Url(row.recordMac)
      )
    ).resolves.toEqual({
      userId: USER,
      projectId: doc.projectId,
      allowed: true,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
      route: ROUTE,
      sequence: 1
    });
    expect(await screen.findByText('Allowed for this project')).toBeTruthy();

    // The next ask goes straight through, re-reading the consent first.
    const load = vi.spyOn(server.api, 'load');
    await ask(rerender, props, 3, 'And the boss?');
    await waitFor(() => expect(proposals).toHaveLength(2));
    expect(load).toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Stop aborts the request in flight, revokes, and nothing is sent after', async () => {
    const user = userEvent.setup();
    const server = consentServer();
    const pins = consentModule.memoryConsentPins();
    const props = { server, pins, project: ENCRYPTED };
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {});
    await ask(rerender, props, 1);
    await user.click(
      await screen.findByRole('button', { name: 'Allow for this project' })
    );
    await waitFor(() => expect(proposals).toHaveLength(1));

    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    await ask(rerender, props, 2, 'Make it thicker');
    await waitFor(() => expect(proposals).toHaveLength(2));
    const inFlight = proposals[1]!.signal!;
    expect(inFlight.aborted).toBe(false);
    await user.click(
      screen.getByRole('button', {
        name: 'Stop the assistant reading this project'
      })
    );
    await waitFor(() => expect(inFlight.aborted).toBe(true));
    release();
    await waitFor(() =>
      expect(server.rows.get(doc.projectId)).toMatchObject({
        allowed: false,
        sequence: 2
      })
    );
    // The pin rises once the stored revocation verifies, just after the
    // server row: wait for it rather than racing it.
    await waitFor(async () =>
      expect(await pins.read(USER, doc.projectId)).toBe(2)
    );
    expect(screen.queryByText('Allowed for this project')).toBeNull();

    hold = null;
    await ask(rerender, props, 3, 'Try again');
    expect(
      await screen.findByRole('dialog', {
        name: 'Let the assistant read this encrypted project?'
      })
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(proposals).toHaveLength(2);
  });

  it('never sends on a consent the server forged or rolled back', async () => {
    const user = userEvent.setup();
    const server = consentServer();
    const pins = consentModule.memoryConsentPins();
    await server.forge(doc.projectId, 5);
    const props = { server, pins, project: ENCRYPTED };
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {});
    expect(screen.queryByText('Allowed for this project')).toBeNull();
    await ask(rerender, props, 1);
    await user.click(
      await screen
        .findByRole('dialog')
        .then((dialog) =>
          within(dialog).getByRole('button', { name: 'Not now' })
        )
    );
    expect(proposals).toEqual([]);

    // A real consent at sequence 6, then the server serves an older,
    // genuinely MAC'd allow after this device saw a revocation.
    await ask(rerender, props, 2);
    await user.click(
      await screen.findByRole('button', { name: 'Allow for this project' })
    );
    await waitFor(() => expect(proposals).toHaveLength(1));
    const allowedRow = server.rows.get(doc.projectId)!;
    expect(allowedRow.sequence).toBe(6);
    await user.click(
      screen.getByRole('button', {
        name: 'Stop the assistant reading this project'
      })
    );
    await waitFor(() =>
      expect(server.rows.get(doc.projectId)?.allowed).toBe(false)
    );
    server.rows.set(doc.projectId, allowedRow);
    await ask(rerender, props, 3);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(proposals).toHaveLength(1);
  });

  it('asks again when the provider route changes', async () => {
    const user = userEvent.setup();
    const server = consentServer();
    const props = {
      server,
      pins: consentModule.memoryConsentPins(),
      project: ENCRYPTED
    };
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {});
    await ask(rerender, props, 1);
    await user.click(
      await screen.findByRole('button', { name: 'Allow for this project' })
    );
    await waitFor(() => expect(proposals).toHaveLength(1));
    const moved = {
      ...props,
      status: { ...configured, model: 'another-model' }
    };
    rerender(<Harness {...moved} />);
    await act(async () => {});
    expect(screen.queryByText('Allowed for this project')).toBeNull();
    await ask(rerender, moved, 2);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('model another-model');
    expect(proposals).toHaveLength(1);
  });

  it('stays off, as before, when the account cannot store consent', async () => {
    const server = consentServer();
    server.setUnavailable(true);
    const props = {
      server,
      pins: consentModule.memoryConsentPins(),
      project: ENCRYPTED
    };
    const { rerender } = render(<Harness {...props} />);
    await waitFor(() =>
      expect(screen.getByText(ENCRYPTED_PROJECT_ASSISTANT_NOTICE)).toBeTruthy()
    );
    await ask(rerender, props, 1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(proposals).toEqual([]);
  });

  it('leaves a plaintext project exactly as before: no gate, no consent read', async () => {
    const server = consentServer();
    const load = vi.spyOn(server.api, 'load');
    const props = {
      server,
      pins: consentModule.memoryConsentPins(),
      project: PLAINTEXT
    };
    const { rerender } = render(<Harness {...props} />);
    await act(async () => {});
    await ask(rerender, props, 1);
    await waitFor(() => expect(proposals).toHaveLength(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(Object.keys(proposals[0]!.body).sort()).toEqual([
      ...ASSISTANT_CONSENT_REQUEST_FIELDS
    ]);
  });
});
