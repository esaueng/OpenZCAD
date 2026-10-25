/**
 * What an assistant request sends, as the consent for an encrypted project
 * lists it (ADR-024 Phase 6, slice 6-1). Plain data, no crypto: the panel
 * and the dialog import it statically.
 *
 * The inventory is exact. `assistantStream.ts` posts one JSON body to
 * `/api/assistant/proposals` with these top-level fields and nothing else,
 * and the digest inside it has only the fields listed below. Tests pin both
 * lists to `ASSISTANT_CONSENT_COPY_VERSION`: a request or digest field added
 * later fails them until the copy says what it sends and the version is
 * bumped, which asks every user again.
 */
import {
  ASSISTANT_CONSENT_COPY_VERSION,
  assistantConsentRoute,
  type AssistantConsentRouteInput
} from '@openzcad/shared';

export { ASSISTANT_CONSENT_COPY_VERSION, assistantConsentRoute };

/** The request body's top-level fields, sorted. */
export const ASSISTANT_CONSENT_REQUEST_FIELDS = [
  'attachments',
  'digest',
  'history',
  'operations',
  'prompt',
  'retryAttempt'
] as const;

/** The model digest's fields (`CadDocumentDigest`), sorted. */
export const ASSISTANT_CONSENT_DIGEST_FIELDS = [
  'bodies',
  'editCatalog',
  'features',
  'name',
  'parameters',
  'projectId',
  'schemaVersion',
  'selection',
  'units',
  'version',
  'warnings'
] as const;

/**
 * Each copy version's field lists. Never edit a published entry: add the
 * next version and bump ASSISTANT_CONSENT_COPY_VERSION in
 * `@openzcad/shared` instead.
 */
export const ASSISTANT_CONSENT_FIELDS_BY_COPY_VERSION: Readonly<
  Record<number, { request: readonly string[]; digest: readonly string[] }>
> = {
  1: {
    request: ASSISTANT_CONSENT_REQUEST_FIELDS,
    digest: ASSISTANT_CONSENT_DIGEST_FIELDS
  }
};

export interface AssistantConsentItem {
  /** Where it travels in the request body. */
  readonly fields: readonly string[];
  readonly label: string;
  readonly detail: string;
}

/** Everything a request carries, in the words the dialog shows. */
export const ASSISTANT_CONSENT_ITEMS: readonly AssistantConsentItem[] = [
  {
    fields: ['prompt'],
    label: 'What you ask',
    detail: 'The text you send, or the answer you pick.'
  },
  {
    fields: ['history'],
    label: 'This project’s conversation',
    detail: 'Up to 12 earlier turns of the assistant conversation.'
  },
  {
    fields: [
      'digest.projectId',
      'digest.name',
      'digest.units',
      'digest.version',
      'digest.schemaVersion'
    ],
    label: 'The project’s id and name',
    detail: 'With its units and document version.'
  },
  {
    fields: [
      'digest.parameters',
      'digest.features',
      'digest.bodies',
      'digest.editCatalog',
      'digest.warnings'
    ],
    label: 'A summary of the model',
    detail:
      'Every parameter (name, expression and value); every feature with its full definition, including sketches and any text in them; each body’s name, volume, bounding box, faces and edges with their measurements; the dimensions the app found editable; and model warnings.'
  },
  {
    fields: ['digest.selection'],
    label: 'Your selection',
    detail: 'The features, bodies, faces and edges selected when you send.'
  },
  {
    fields: ['attachments'],
    label: 'Drawings and images you attach',
    detail: 'Each attached image or drawing page, with its file name.'
  },
  {
    fields: ['operations', 'retryAttempt'],
    label: 'Request details',
    detail:
      'The list of edits this app can apply, and whether the request is an automatic retry. Nothing from the project.'
  }
];

const PROVIDER_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  'responses-compatible': 'a Responses-compatible endpoint'
};

/** Who receives the request, in words: the copy names the provider route. */
export function describeAssistantRoute(
  status: AssistantConsentRouteInput
): string {
  const provider = PROVIDER_NAMES[status.provider] ?? status.provider;
  const route =
    status.source === 'personal'
      ? `your own key with ${provider}, model ${status.model}`
      : `OpenZCAD’s AI provider, ${provider}, model ${status.model}`;
  const host = endpointHost(status.endpoint);
  return host ? `${route}, at ${host}` : route;
}

function endpointHost(endpoint: string | undefined): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).host;
  } catch {
    return null;
  }
}

/** The sentences around the list; shown in the dialog and on Settings. */
export const ASSISTANT_CONSENT_TRANSIT =
  'OpenZCAD’s server reads each request in plaintext to pass it on, adding its own instructions, any custom instructions from your settings, and an identifier derived from your account.';
export const ASSISTANT_CONSENT_FINALITY =
  'What has been sent cannot be recalled. Stopping only prevents later requests.';
