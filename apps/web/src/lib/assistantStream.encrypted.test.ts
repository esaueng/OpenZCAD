import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CadDocumentDigest } from '@openzcad/ai-contracts';
import { ASSISTANT_CONSENT_COPY_VERSION, toProjectId } from '@openzcad/shared';
import {
  assistantDisabledReason,
  ENCRYPTED_PROJECT_ASSISTANT_NOT_ALLOWED,
  ENCRYPTED_PROJECT_ASSISTANT_NOTICE,
  UNSETTLED_ENCRYPTED_PROJECT_ASSISTANT_NOTICE
} from './assistant/encryptedProject';
import type { AssistantSendConsent } from './projectWriteGate';
import type * as DesktopBridge from './desktopBridge';
import {
  ENCRYPTED_PROJECT_PIN_FAILED_KEY,
  localStorageEncryptedProjectPins
} from './e2ee/encryptedProjectPins';

/**
 * Every module is loaded fresh per test (`load`), so this page's pins and
 * grants start from storage as a reload would. `desktopFetch` is the only
 * stand-in: what reaches it is what the stream let through; the send gate
 * behind it is covered by `projectRequestContext.test.ts`.
 */
const desktopFetch = vi.hoisted(() =>
  vi.fn(async (_input: string, _init?: RequestInit) => {
    return new Response('offline', { status: 503 });
  })
);
vi.mock('./desktopBridge', async (importOriginal) => ({
  ...(await importOriginal<typeof DesktopBridge>()),
  desktopFetch
}));

const USER = 'user_stream';
const ROUTE = 'v2|deployment|openrouter|test-model|digest';

async function load() {
  vi.resetModules();
  const [stream, api, grants, gate] = await Promise.all([
    import('./assistantStream'),
    import('./api'),
    import('./e2ee/assistantConsentGrants'),
    import('./projectWriteGate')
  ]);
  return { ...stream, ...api, ...grants, ...gate };
}

type Loaded = Awaited<ReturnType<typeof load>>;

/** Another tab's view of the same pins. */
const otherTab = () => localStorageEncryptedProjectPins(window.localStorage);

/** An Allow clicked on this device for the record at `sequence`. */
function grantHere(
  modules: Loaded,
  projectId: string,
  sequence = 1
): AssistantSendConsent {
  const ticket = modules.beginAssistantAllow(USER, projectId);
  const grant = ticket
    ? modules.completeAssistantAllow(ticket, {
        sequence,
        route: ROUTE,
        copyVersion: ASSISTANT_CONSENT_COPY_VERSION
      })
    : null;
  if (!grant) throw new Error('grant not made');
  return {
    userId: USER,
    projectId,
    sequence,
    route: ROUTE,
    copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
    grant: grant.id
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

const digest = (projectId: string) =>
  ({ projectId, name: 'Bracket' }) as unknown as CadDocumentDigest;

const sentTo = () => desktopFetch.mock.calls.map(([path]) => path);

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
    const modules = await load();
    const { streamAssistantReply, AssistantStreamError } = modules;
    otherTab().pin('proj_secret');
    const refused = streamAssistantReply({
      prompt: 'Make the wall 3 mm',
      digest: digest('proj_secret')
    });
    await expect(refused).rejects.toBeInstanceOf(AssistantStreamError);
    await expect(refused).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    expect(desktopFetch).not.toHaveBeenCalled();

    // A consent this device never granted (no Allow clicked here) lifts
    // nothing, nor one granted for another project.
    const forged: AssistantSendConsent = {
      userId: USER,
      projectId: 'proj_secret',
      sequence: 1,
      route: ROUTE,
      copyVersion: ASSISTANT_CONSENT_COPY_VERSION,
      grant: 'not-a-grant'
    };
    await expect(
      streamAssistantReply({
        prompt: 'Make the wall 3 mm',
        digest: digest('proj_secret'),
        consent: forged
      })
    ).rejects.toMatchObject({
      code: 'AI_E2EE_PROJECT',
      message: ENCRYPTED_PROJECT_ASSISTANT_NOT_ALLOWED
    });
    otherTab().pin('proj_other');
    await expect(
      streamAssistantReply({
        prompt: 'Hi',
        digest: digest('proj_secret'),
        consent: grantHere(modules, 'proj_other')
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    // A requirement carried to a project the account does not hold
    // encrypted is not a settled encrypted project: refused, grant or not.
    otherTab().requireEncryption('proj_required');
    await expect(
      streamAssistantReply({
        prompt: 'Hi',
        digest: digest('proj_required'),
        consent: grantHere(modules, 'proj_required')
      })
    ).rejects.toMatchObject({
      code: 'AI_E2EE_PROJECT',
      message: UNSETTLED_ENCRYPTED_PROJECT_ASSISTANT_NOTICE
    });
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

describe('a pinned, settled encrypted project', () => {
  it('sends with this device’s grant of its verified consent, carrying it to the send gate', async () => {
    const modules = await load();
    otherTab().pin('proj_settled');
    const consent = grantHere(modules, 'proj_settled');
    await modules
      .streamAssistantReply({
        prompt: 'How thick is the wall?',
        digest: digest('proj_settled'),
        consent
      })
      .catch(() => undefined);
    expect(sentTo()[0]).toBe('/api/assistant/proposals');
    // The consent travels with the request, for the check at the send.
    const [path, init] = desktopFetch.mock.calls[0]!;
    expect(modules.resolveProjectRequest(path, init).assistantConsent).toEqual(
      consent
    );
  });

  it('asks nothing of the network without consent', async () => {
    const { streamAssistantReply } = await load();
    otherTab().pin('proj_unasked');
    await expect(
      streamAssistantReply({ prompt: 'Hi', digest: digest('proj_unasked') })
    ).rejects.toMatchObject({
      code: 'AI_E2EE_PROJECT',
      message: ENCRYPTED_PROJECT_ASSISTANT_NOT_ALLOWED
    });
    expect(desktopFetch).not.toHaveBeenCalled();
  });

  it('refuses once a Stop removed the grant, in this tab or another', async () => {
    const modules = await load();
    otherTab().pin('proj_stopped');
    const here = grantHere(modules, 'proj_stopped');
    modules.stopAssistantGrant(USER, 'proj_stopped');
    await expect(
      modules.streamAssistantReply({
        prompt: 'Hi',
        digest: digest('proj_stopped'),
        consent: here
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });

    // Another tab's Stop reaches this page only through storage.
    const again = grantHere(modules, 'proj_stopped', 2);
    window.localStorage.removeItem(
      `${modules.ASSISTANT_GRANT_PREFIX}${USER}:proj_stopped`
    );
    await expect(
      modules.streamAssistantReply({
        prompt: 'Hi',
        digest: digest('proj_stopped'),
        consent: again
      })
    ).rejects.toMatchObject({ code: 'AI_E2EE_PROJECT' });
    expect(desktopFetch).not.toHaveBeenCalled();
  });
});

describe('a project held as encrypted but not settled here', () => {
  /** Each state, made after this page granted the project's consent. */
  const states: [string, (projectId: string, modules: Loaded) => void][] = [
    [
      'whose switch to encryption is unresolved',
      (projectId) => {
        otherTab().markCutoverUnresolved(projectId);
      }
    ],
    [
      'reset in another tab',
      (projectId) => {
        expect(otherTab().resetProject(projectId)).toBe(true);
      }
    ],
    [
      'while the pins are degraded',
      () => {
        window.localStorage.setItem(ENCRYPTED_PROJECT_PIN_FAILED_KEY, '1');
      }
    ],
    [
      'whose listing disagrees with the pin',
      (projectId, modules) => {
        modules.rememberProjectFormats([
          { projectId: toProjectId(projectId), storageFormat: 1 }
        ]);
      }
    ]
  ];

  it.each(states)(
    'stays blocked %s, even with a grant',
    async (_state, hold) => {
      const modules = await load();
      const projectId = 'proj_unsettled';
      otherTab().pin(projectId);
      const consent = grantHere(modules, projectId);
      // Settled first: this page sees the pin and the grant.
      expect(modules.encryptedProjectSettled(projectId)).toBe(true);
      expect(modules.assistantSendBlock(projectId, consent)).toBeNull();
      hold(projectId, modules);
      expect(modules.encryptedProjectSettled(projectId)).toBe(false);
      expect(modules.assistantHeldUnsettled(projectId)).toBe(true);
      await expect(
        modules.streamAssistantReply({
          prompt: 'Hi',
          digest: digest(projectId),
          consent
        })
      ).rejects.toMatchObject({
        code: 'AI_E2EE_PROJECT',
        message: UNSETTLED_ENCRYPTED_PROJECT_ASSISTANT_NOTICE
      });
      expect(desktopFetch).not.toHaveBeenCalled();
    }
  );
});
