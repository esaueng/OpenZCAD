/**
 * The assistant thread, kept per project across reloads.
 *
 * A conversation is the record of how a part came to be shaped the way it is —
 * which dimension the assistant asked about, what was answered, which proposal
 * was applied and which was turned down. Losing that on a reload (or on
 * collapsing the dock) makes the assistant feel like a one-shot command box, so
 * the thread is written beside the workspace session rather than held in a
 * component.
 *
 * It lives in `localStorage` under its own key: it is per device like the rest
 * of the chrome state, and it must never ride along on the settings sync path,
 * where a strict parser would reject it wholesale.
 *
 * Everything here is a pure function over an injectable storage, so the parts
 * most likely to break — restoring a thread written by an older build, and the
 * size budget — are testable without a DOM.
 */
import {
  ASSISTANT_READING_CONFIDENCES,
  parseCadPatchProposal,
  type AssistantDrawingReading,
  type AssistantQuestion
} from '@openzcad/ai-contracts';
import type {
  AssistantAnswer,
  AssistantAttachmentPreview,
  AssistantEntry
} from './conversation';

export const ASSISTANT_HISTORY_STORAGE_KEY = 'openzcad-assistant-history:v1';

const HISTORY_VERSION = 1;

/** Turns kept per project. Older ones fall off the top of the scrollback. */
export const MAX_STORED_ENTRIES = 200;
/** Projects kept at once, least recently used first out. */
export const MAX_STORED_PROJECTS = 12;
/**
 * Serialized budget for the whole store. `localStorage` is a few megabytes for
 * the entire origin, which the document cache and the workspace session also
 * draw on, so the thread gives up its drawings before it gives up its words.
 */
export const MAX_STORED_CHARS = 600_000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

interface StoredThread {
  updatedAt: number;
  entries: AssistantEntry[];
}

interface StoredHistory {
  version: typeof HISTORY_VERSION;
  threads: Record<string, StoredThread>;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function emptyHistory(): StoredHistory {
  return { version: HISTORY_VERSION, threads: {} };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function timestamp(value: unknown): { at?: number } {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? { at: value }
    : {};
}

function parseAttachments(value: unknown): AssistantAttachmentPreview[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AssistantAttachmentPreview[] => {
    const attachment = record(item);
    if (!attachment || typeof attachment.id !== 'string') {
      return [];
    }
    const mediaType = attachment.mediaType;
    if (
      mediaType !== 'image/png' &&
      mediaType !== 'image/jpeg' &&
      mediaType !== 'image/webp'
    ) {
      return [];
    }
    return [
      {
        id: attachment.id,
        label: text(attachment.label) || 'drawing',
        mediaType,
        // An empty payload is not corruption: the budget below drops the bytes
        // of old drawings and keeps the fact that one was attached.
        dataBase64: text(attachment.dataBase64)
      }
    ];
  });
}

function parseAnswers(value: unknown): AssistantAnswer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AssistantAnswer[] => {
    const answer = record(item);
    if (!answer || typeof answer.questionId !== 'string') {
      return [];
    }
    return [
      {
        questionId: answer.questionId,
        prompt: text(answer.prompt),
        value: text(answer.value)
      }
    ];
  });
}

function parseQuestions(value: unknown): AssistantQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AssistantQuestion[] => {
    const question = record(item);
    if (
      !question ||
      typeof question.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(question.id) ||
      typeof question.prompt !== 'string'
    ) {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((entry) => {
          const option = record(entry);
          return option && typeof option.value === 'string'
            ? [
                {
                  label: text(option.label) || option.value,
                  value: option.value
                }
              ]
            : [];
        })
      : [];
    return [
      {
        id: question.id,
        prompt: question.prompt,
        options,
        allowFreeText: question.allowFreeText !== false,
        unit: typeof question.unit === 'string' ? question.unit : null
      }
    ];
  });
}

function parseReadings(value: unknown): AssistantDrawingReading[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): AssistantDrawingReading[] => {
    const reading = record(item);
    const confidence = reading?.confidence;
    if (
      !reading ||
      typeof reading.label !== 'string' ||
      typeof confidence !== 'string' ||
      !ASSISTANT_READING_CONFIDENCES.includes(
        confidence as AssistantDrawingReading['confidence']
      )
    ) {
      return [];
    }
    return [
      {
        label: reading.label,
        value: text(reading.value),
        source: text(reading.source),
        confidence: confidence as AssistantDrawingReading['confidence']
      }
    ];
  });
}

/**
 * One stored entry, or null when it cannot be trusted.
 *
 * A proposal goes back through the contract parser it arrived by: the apply
 * path assumes a valid patch, and a hand-edited or half-written record must not
 * reach it. Anything that fails is dropped rather than repaired — a thread with
 * a turn missing is honest; a thread with an invented one is not.
 */
export function parseStoredEntry(value: unknown): AssistantEntry | null {
  const entry = record(value);
  if (!entry || typeof entry.id !== 'string') {
    return null;
  }
  switch (entry.kind) {
    case 'user':
      return {
        kind: 'user',
        id: entry.id,
        text: text(entry.text),
        attachments: parseAttachments(entry.attachments),
        answers: parseAnswers(entry.answers),
        ...timestamp(entry.at)
      };
    case 'questions': {
      const questions = parseQuestions(entry.questions);
      if (questions.length === 0) {
        return null;
      }
      const answers = record(entry.answers) ?? {};
      return {
        kind: 'questions',
        id: entry.id,
        preamble: text(entry.preamble),
        questions,
        answers: Object.fromEntries(
          Object.entries(answers).flatMap(([key, answer]) =>
            typeof answer === 'string' ? [[key, answer]] : []
          )
        ),
        // A card restored mid-answer can still be sent; only a card that was
        // already sent reads as history.
        sent: entry.sent === true,
        ...timestamp(entry.at)
      };
    }
    case 'proposal': {
      const status = entry.status;
      if (status !== 'open' && status !== 'applied' && status !== 'rejected') {
        return null;
      }
      try {
        return {
          kind: 'proposal',
          id: entry.id,
          proposal: parseCadPatchProposal(entry.proposal),
          readings: parseReadings(entry.readings),
          // A restored proposal no longer has the document snapshot it was
          // generated against. Keep it as history, but never restore actions.
          status: status === 'open' ? 'rejected' : status,
          ...timestamp(entry.at)
        };
      } catch {
        return null;
      }
    }
    case 'message': {
      const body = text(entry.text);
      if (!body) {
        return null;
      }
      return {
        kind: 'message',
        id: entry.id,
        text: body,
        tone: entry.tone === 'error' ? 'error' : 'info',
        ...timestamp(entry.at)
      };
    }
    default:
      return null;
  }
}

export function parseStoredEntries(value: unknown): AssistantEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((item) => {
      const entry = parseStoredEntry(item);
      return entry ? [entry] : [];
    })
    .slice(-MAX_STORED_ENTRIES);
}

function parseHistory(value: unknown): StoredHistory {
  const root = record(value);
  const threads = root ? record(root.threads) : null;
  if (!threads) {
    return emptyHistory();
  }
  const parsed: Record<string, StoredThread> = {};
  for (const [projectId, thread] of Object.entries(threads)) {
    const stored = record(thread);
    if (!stored) {
      continue;
    }
    const entries = parseStoredEntries(stored.entries);
    if (entries.length === 0) {
      continue;
    }
    parsed[projectId] = {
      updatedAt:
        typeof stored.updatedAt === 'number' &&
        Number.isFinite(stored.updatedAt)
          ? stored.updatedAt
          : 0,
      entries
    };
  }
  return { version: HISTORY_VERSION, threads: parsed };
}

function readHistory(storage: StorageLike | null): StoredHistory {
  if (!storage) {
    return emptyHistory();
  }
  try {
    const raw = storage.getItem(ASSISTANT_HISTORY_STORAGE_KEY);
    return raw ? parseHistory(JSON.parse(raw) as unknown) : emptyHistory();
  } catch {
    return emptyHistory();
  }
}

function withoutAttachmentData(entry: AssistantEntry): AssistantEntry {
  if (entry.kind !== 'user' || entry.attachments.length === 0) {
    return entry;
  }
  return {
    ...entry,
    attachments: entry.attachments.map((attachment) => ({
      ...attachment,
      dataBase64: ''
    }))
  };
}

/**
 * The store, shrunk to fit its budget.
 *
 * Drawings go first, oldest turn first: a scanned PDF page is worth more
 * kilobytes than every word in the thread put together, and the thumbnail is
 * the least of what the record is for. Only once the images are gone do whole
 * turns fall off the front.
 */
function fitToBudget(history: StoredHistory): {
  history: StoredHistory;
  serialized: string;
} {
  let threads = { ...history.threads };
  let serialized = JSON.stringify({ version: HISTORY_VERSION, threads });
  if (serialized.length <= MAX_STORED_CHARS) {
    return { history: { version: HISTORY_VERSION, threads }, serialized };
  }

  const order = Object.entries(threads).sort(
    (left, right) => left[1].updatedAt - right[1].updatedAt
  );
  for (const [projectId] of order) {
    const thread = threads[projectId];
    if (!thread) {
      continue;
    }
    threads = {
      ...threads,
      [projectId]: {
        ...thread,
        entries: thread.entries.map(withoutAttachmentData)
      }
    };
    serialized = JSON.stringify({ version: HISTORY_VERSION, threads });
    if (serialized.length <= MAX_STORED_CHARS) {
      return { history: { version: HISTORY_VERSION, threads }, serialized };
    }
  }

  for (const [projectId] of order) {
    while (serialized.length > MAX_STORED_CHARS) {
      const thread = threads[projectId];
      if (!thread || thread.entries.length === 0) {
        break;
      }
      const trimmed = thread.entries.slice(1);
      if (trimmed.length === 0) {
        const { [projectId]: _dropped, ...rest } = threads;
        threads = rest;
      } else {
        threads = { ...threads, [projectId]: { ...thread, entries: trimmed } };
      }
      serialized = JSON.stringify({ version: HISTORY_VERSION, threads });
    }
    if (serialized.length <= MAX_STORED_CHARS) {
      break;
    }
  }
  return { history: { version: HISTORY_VERSION, threads }, serialized };
}

function writeHistory(
  history: StoredHistory,
  storage: StorageLike | null
): boolean {
  if (!storage) {
    return false;
  }
  const { serialized } = fitToBudget(history);
  try {
    storage.setItem(ASSISTANT_HISTORY_STORAGE_KEY, serialized);
    return true;
  } catch {
    // A full quota is not worth an error path in the panel: the thread on
    // screen is intact, it just will not outlive this tab.
    return false;
  }
}

/** The stored thread for a project, oldest turn first. */
export function loadAssistantThread(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): AssistantEntry[] {
  return readHistory(storage).threads[projectId]?.entries ?? [];
}

/**
 * Replaces a project's thread. `now` is passed in rather than read from the
 * clock so eviction order is deterministic under test.
 */
export function saveAssistantThread(
  projectId: string,
  entries: readonly AssistantEntry[],
  now: number,
  storage: StorageLike | null = defaultStorage()
): boolean {
  const history = readHistory(storage);
  if (entries.length === 0) {
    const { [projectId]: _cleared, ...rest } = history.threads;
    return writeHistory({ version: HISTORY_VERSION, threads: rest }, storage);
  }
  const threads: Record<string, StoredThread> = {
    ...history.threads,
    [projectId]: {
      updatedAt: now,
      entries: entries.slice(-MAX_STORED_ENTRIES)
    }
  };
  const kept = Object.entries(threads)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
    .slice(0, MAX_STORED_PROJECTS);
  return writeHistory(
    { version: HISTORY_VERSION, threads: Object.fromEntries(kept) },
    storage
  );
}

export function clearAssistantThread(
  projectId: string,
  storage: StorageLike | null = defaultStorage()
): boolean {
  return saveAssistantThread(projectId, [], 0, storage);
}
