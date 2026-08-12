/**
 * Assistant conversation state, as pure functions.
 *
 * The panel that renders this is incidental; what matters is that a turn's
 * entries, the answers collected against a question, and the history sent
 * upstream are all derived deterministically. Keeping it out of the component
 * means the two things most likely to break — history derivation and the
 * lifecycle of a proposal — are testable without a DOM.
 */
import {
  MAX_ASSISTANT_HISTORY_CHARS,
  MAX_ASSISTANT_HISTORY_TURNS,
  type AssistantDrawingReading,
  type AssistantHistoryTurn,
  type AssistantQuestion,
  type AssistantReply,
  type CadPatchProposal
} from '@openzcad/ai-contracts';

/** A drawing the user attached, as the panel needs to show it. */
export interface AssistantAttachmentPreview {
  id: string;
  label: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
}

export interface AssistantAnswer {
  questionId: string;
  prompt: string;
  value: string;
}

/**
 * When a turn happened, in epoch milliseconds.
 *
 * The clock is the caller's, never `Date.now()` in here — the reducer stays
 * pure so a restored thread replays identically. It is optional because a
 * thread persisted before timestamps existed still has to load.
 */
export interface AssistantEntryTime {
  at?: number;
}

export interface AssistantUserEntry extends AssistantEntryTime {
  kind: 'user';
  id: string;
  text: string;
  attachments: AssistantAttachmentPreview[];
  /** Present when this turn answered an earlier question card. */
  answers: AssistantAnswer[];
}

export interface AssistantQuestionsEntry extends AssistantEntryTime {
  kind: 'questions';
  id: string;
  preamble: string;
  questions: AssistantQuestion[];
  /** Question id to chosen answer, filled in as the user picks. */
  answers: Record<string, string>;
  /** True once the answers were sent; the card then reads as history. */
  sent: boolean;
}

export interface AssistantProposalEntry extends AssistantEntryTime {
  kind: 'proposal';
  id: string;
  proposal: CadPatchProposal;
  readings: AssistantDrawingReading[];
  status: 'open' | 'applied' | 'rejected';
}

export interface AssistantMessageEntry extends AssistantEntryTime {
  kind: 'message';
  id: string;
  text: string;
  tone: 'info' | 'error';
}

export type AssistantEntry =
  | AssistantUserEntry
  | AssistantQuestionsEntry
  | AssistantProposalEntry
  | AssistantMessageEntry;

export interface AssistantConversation {
  entries: AssistantEntry[];
  status: 'idle' | 'thinking';
  /** Entry id of the proposal currently drawn as a viewport preview. */
  previewEntryId: string | null;
}

export const EMPTY_CONVERSATION: AssistantConversation = {
  entries: [],
  status: 'idle',
  previewEntryId: null
};

export type AssistantAction =
  | {
      type: 'submit';
      id: string;
      text: string;
      at?: number;
      attachments?: AssistantAttachmentPreview[];
      answers?: AssistantAnswer[];
      /** Question card these answers came from, so it can be marked sent. */
      answeredEntryId?: string;
    }
  | { type: 'reply'; id: string; reply: AssistantReply; at?: number }
  | { type: 'fail'; id: string; message: string; at?: number }
  | { type: 'cancel' }
  | {
      type: 'answer';
      entryId: string;
      questionId: string;
      value: string;
    }
  | { type: 'preview'; entryId: string | null }
  | { type: 'resolve-proposal'; entryId: string; status: 'applied' | 'rejected' }
  /** Swap in a thread read back from storage, e.g. when a project opens. */
  | { type: 'restore'; entries: readonly AssistantEntry[] }
  | { type: 'reset' };

function withEntry(
  conversation: AssistantConversation,
  entry: AssistantEntry
): AssistantEntry[] {
  return [...conversation.entries, entry];
}

/** Omits the key entirely when the caller passed no clock reading. */
function stamp(at: number | undefined): AssistantEntryTime {
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? { at } : {};
}

export function assistantReducer(
  conversation: AssistantConversation,
  action: AssistantAction
): AssistantConversation {
  switch (action.type) {
    case 'submit': {
      const answeredEntryId = action.answeredEntryId;
      const entries = conversation.entries.map((entry) =>
        entry.kind === 'questions' && entry.id === answeredEntryId
          ? { ...entry, sent: true }
          : entry
      );
      return {
        ...conversation,
        entries: [
          ...entries,
          {
            kind: 'user',
            id: action.id,
            text: action.text,
            attachments: action.attachments ?? [],
            answers: action.answers ?? [],
            ...stamp(action.at)
          }
        ],
        status: 'thinking'
      };
    }
    case 'reply': {
      if (action.reply.kind === 'patch') {
        return {
          ...conversation,
          entries: withEntry(conversation, {
            kind: 'proposal',
            id: action.id,
            proposal: action.reply.proposal,
            readings: action.reply.readings,
            status: 'open',
            ...stamp(action.at)
          }),
          status: 'idle'
        };
      }
      if (action.reply.kind === 'questions') {
        return {
          ...conversation,
          entries: withEntry(conversation, {
            kind: 'questions',
            id: action.id,
            preamble: action.reply.preamble,
            questions: action.reply.questions,
            answers: {},
            sent: false,
            ...stamp(action.at)
          }),
          status: 'idle'
        };
      }
      return {
        ...conversation,
        entries: withEntry(conversation, {
          kind: 'message',
          id: action.id,
          text: action.reply.message,
          tone: 'info',
          ...stamp(action.at)
        }),
        status: 'idle'
      };
    }
    case 'fail':
      return {
        ...conversation,
        entries: withEntry(conversation, {
          kind: 'message',
          id: action.id,
          text: action.message,
          tone: 'error',
          ...stamp(action.at)
        }),
        status: 'idle'
      };
    case 'cancel':
      return { ...conversation, status: 'idle' };
    case 'answer':
      return {
        ...conversation,
        entries: conversation.entries.map((entry) =>
          entry.kind === 'questions' && entry.id === action.entryId
            ? {
                ...entry,
                answers: { ...entry.answers, [action.questionId]: action.value }
              }
            : entry
        )
      };
    case 'preview':
      return { ...conversation, previewEntryId: action.entryId };
    case 'resolve-proposal':
      return {
        ...conversation,
        // A resolved proposal can no longer be the live preview.
        previewEntryId:
          conversation.previewEntryId === action.entryId
            ? null
            : conversation.previewEntryId,
        entries: conversation.entries.map((entry) =>
          entry.kind === 'proposal' && entry.id === action.entryId
            ? { ...entry, status: action.status }
            : entry
        )
      };
    case 'restore':
      // A restored thread is history, not a turn in flight: nothing is being
      // streamed into it and no proposal it carries is the live viewport
      // preview, whatever the panel was showing before the swap.
      return {
        entries: [...action.entries],
        status: 'idle',
        previewEntryId: null
      };
    case 'reset':
      return EMPTY_CONVERSATION;
    default:
      return conversation;
  }
}

/** The answers collected so far on a question card, in question order. */
export function collectedAnswers(
  entry: AssistantQuestionsEntry
): AssistantAnswer[] {
  return entry.questions.flatMap((question) => {
    const value = entry.answers[question.id];
    return value
      ? [{ questionId: question.id, prompt: question.prompt, value }]
      : [];
  });
}

export function allQuestionsAnswered(entry: AssistantQuestionsEntry): boolean {
  return entry.questions.every((question) =>
    Boolean(entry.answers[question.id])
  );
}

function questionsEntryText(entry: AssistantQuestionsEntry): string {
  return [entry.preamble, ...entry.questions.map((q) => q.prompt)]
    .filter(Boolean)
    .join(' ');
}

function proposalEntryText(entry: AssistantProposalEntry): string {
  // A rejected proposal must say so, or the next turn re-proposes the design
  // the user just turned down.
  const outcome =
    entry.status === 'applied'
      ? ' (the user applied this)'
      : entry.status === 'rejected'
        ? ' (the user rejected this)'
        : '';
  return `${entry.proposal.summary}${outcome}`;
}

/**
 * The conversation as turns for the next request.
 *
 * Text only, and trimmed from the front to the wire budget: the document state
 * travels as one current digest, so replaying an old one would let the model act
 * on a document that no longer exists. Dropping the oldest turns can lose an
 * early answer, which is why the assistant is told to build as soon as it has
 * enough rather than stretch a conversation out.
 */
export function historyForRequest(
  conversation: AssistantConversation
): AssistantHistoryTurn[] {
  const turns = conversation.entries.flatMap(
    (entry): AssistantHistoryTurn[] => {
      switch (entry.kind) {
        case 'user':
          // One turn per answered question keeps each answer bound to its id.
          return entry.answers.length > 0
            ? entry.answers.map((answer) => ({
                role: 'user' as const,
                text: answer.value,
                answeredQuestionId: answer.questionId
              }))
            : entry.text.trim()
              ? [{ role: 'user' as const, text: entry.text }]
              : [];
        case 'questions': {
          const text = questionsEntryText(entry);
          return text ? [{ role: 'assistant' as const, text }] : [];
        }
        case 'proposal':
          return [{ role: 'assistant' as const, text: proposalEntryText(entry) }];
        case 'message':
          // A client-side failure is noise to the model, not conversation.
          return entry.tone === 'error'
            ? []
            : [{ role: 'assistant' as const, text: entry.text }];
        default:
          return [];
      }
    }
  );

  const bounded = turns.slice(-MAX_ASSISTANT_HISTORY_TURNS);
  let characters = 0;
  const kept: AssistantHistoryTurn[] = [];
  for (let index = bounded.length - 1; index >= 0; index -= 1) {
    const turn = bounded[index]!;
    if (characters + turn.text.length > MAX_ASSISTANT_HISTORY_CHARS) {
      break;
    }
    characters += turn.text.length;
    kept.unshift(turn);
  }
  return kept;
}

/** The still-open proposal, if any. Only one can be previewed or applied. */
export function openProposal(
  conversation: AssistantConversation
): AssistantProposalEntry | null {
  for (let index = conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = conversation.entries[index]!;
    if (entry.kind === 'proposal' && entry.status === 'open') {
      return entry;
    }
  }
  return null;
}
