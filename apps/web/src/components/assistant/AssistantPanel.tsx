import type { EditAnalysisRequest } from '@openzcad/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode
} from 'react';
import { ArrowDown, ImageIcon, RotateCcw, Sparkles, X } from 'lucide-react';
import {
  createGrowingHolderProposal,
  createEditCandidateCatalog,
  proposalForEditCandidate,
  createCadDocumentDigest,
  MAX_ASSISTANT_ATTACHMENTS,
  parseCadPatchProposal,
  type CadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
import { createGrowingHolderHoleProposal } from '@openzcad/command-system';
import type { ProjectDocument } from '@openzcad/shared';
import {
  loadAssistantStatus,
  streamAssistantReply,
  type AssistantStatus
} from '../../lib/assistantStream';
import {
  allQuestionsAnswered,
  assistantReducer,
  collectedAnswers,
  EMPTY_CONVERSATION,
  historyForRequest,
  openProposal as findOpenProposal,
  type AssistantAttachmentPreview,
  type AssistantEntry,
  type AssistantQuestionsEntry
} from '../../lib/assistant/conversation';
import {
  clearAssistantThread,
  loadAssistantThread,
  saveAssistantThread
} from '../../lib/assistant/history';
import {
  formatEntryTime,
  groupThreadByDay
} from '../../lib/assistant/timeline';
import {
  describeProgress,
  readAssistantProgress,
  type AssistantProgress
} from '../../lib/assistant/progress';
import {
  assistantSuggestions,
  type AssistantSuggestion
} from '../../lib/assistant/suggestions';
import {
  ACCEPTED_ATTACHMENT_TYPES,
  attachmentDataUrl,
  attachmentsFromFile,
  AttachmentError
} from '../../lib/assistant/attachments';
import {
  ASSISTANT_PROMPT_KEY_EVENT,
  type AssistantPromptKeyDetail
} from '../../lib/assistant/promptKeys';
import { QuestionCard } from './QuestionCard';
import { ProposalCard } from './ProposalCard';
import { RichText } from './RichText';

export type AssistantPreviewOutcome =
  { ok: true } | { ok: false; reason: string };

/** What the conversation tells the prompt line about itself. */
export interface AssistantActivity {
  /** A request is streaming. */
  thinking: boolean;
  /** Replies that landed while the stream was tucked away. */
  unread: number;
  /** What an ask can see, for the prompt's placeholder: "12 selected edges". */
  context: string | null;
}

interface AssistantPanelProps {
  document: ProjectDocument;
  /** Server-confirmed settings, refreshed after account saves and credential changes. */
  effectiveAssistant?: AssistantStatus;
  selection: CadSelectionContext;
  onAnalyze?(
    document: ProjectDocument,
    analysis: EditAnalysisRequest
  ): Promise<ProjectDocument['derived']>;
  /** Returns false when the patch could not be applied, so the panel can say so. */
  onApply(proposal: CadPatchProposal): Promise<boolean>;
  /** Returns the exact rejection reason when the patch could not be previewed. */
  onPreview(
    proposal: CadPatchProposal | null
  ): Promise<AssistantPreviewOutcome>;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /**
   * The user's "Confirm destructive actions" preference. Clearing the thread
   * throws away every drawing attached to it and every reason the model was
   * built the way it was, and nothing anywhere keeps a copy, so it asks on the
   * same setting that guards emptying the trash.
   */
  confirmDestructive: boolean;
  /**
   * Takes the stream off screen without unmounting it. The conversation and
   * the in-flight request live here, so a direct-manipulation mode hides the
   * panel rather than destroying what the user is in the middle of.
   */
  hidden?: boolean;
  /**
   * The prompt line has focus. The stream stands forward while it does and
   * goes quiet otherwise, so the model wins by default.
   */
  prompting?: boolean;
  /**
   * A question typed into the prompt line and sent with Enter. It is sent as
   * if typed here — the user pressed Enter on it, so it is not a suggestion
   * to review — unless the assistant cannot take it right now, in which case
   * it is handed back to the prompt line through `onDraft`.
   */
  request?: { id: number; text: string } | null;
  /**
   * Puts words into the prompt line: a suggestion the user picked to edit
   * before sending, or a question the assistant could not take yet.
   */
  onDraft?(text: string): void;
  /** Tells the prompt line whether a reply is streaming, and what it can see. */
  onActivity?(activity: AssistantActivity): void;
}

let entrySequence = 0;
function nextEntryId(prefix: string): string {
  entrySequence += 1;
  return `${prefix}_${entrySequence}`;
}

function selectionSummaryOf(selection: CadSelectionContext): string | null {
  const topologyKind = selection.topologies[0]?.kind;
  if (
    topologyKind &&
    selection.topologies.every((topology) => topology.kind === topologyKind)
  ) {
    const count = selection.topologies.length;
    return `${count} selected ${topologyKind}${count === 1 ? '' : 's'}`;
  }
  if (selection.bodyIds.length > 0) {
    const count = selection.bodyIds.length;
    return `${count} selected bod${count === 1 ? 'y' : 'ies'}`;
  }
  if (selection.featureIds.length > 0) {
    const count = selection.featureIds.length;
    return `${count} selected feature${count === 1 ? '' : 's'}`;
  }
  return null;
}

function sharedTopologyKind(
  selection: CadSelectionContext
): 'body' | 'face' | 'edge' | null {
  const kind = selection.topologies[0]?.kind ?? null;
  if (!kind) {
    return null;
  }
  return selection.topologies.every((topology) => topology.kind === kind)
    ? kind
    : null;
}

type TurnRole = 'user' | 'assistant';

/**
 * One line of the stream: a glyph in the margin, the body, and the time.
 *
 * The user's lines carry the prompt's own chevron, the assistant's the spark,
 * so the margin reads as a conversation rather than shell output. The time
 * only shows while the pointer is over the stream — it matters when auditing
 * a decision, never while reading the sentence.
 */
function Turn({
  role,
  at,
  children
}: {
  role: TurnRole;
  at: number | undefined;
  children: ReactNode;
}) {
  const time = formatEntryTime(at);
  return (
    <article className={`assistant-turn ${role}`}>
      <span className="assistant-turn-mark" aria-hidden="true">
        {role === 'user' ? '›' : <Sparkles size={12} />}
      </span>
      <div className="assistant-turn-body">{children}</div>
      {time && (
        <time className="assistant-turn-time" dateTime={String(at)}>
          {time}
        </time>
      )}
    </article>
  );
}

/**
 * The assistant as a stream standing on the prompt line.
 *
 * There is no panel chrome: the conversation is text over the viewport, on a
 * ground that fades out at its top edge, and the one text field on the stage
 * (the command bar) is its composer. It holds a thread that outlives the
 * session, a question the assistant asked, thumbnails of an attached drawing,
 * and a proposal detailed enough to audit. Two rules shape the rest: the
 * thread belongs to the project, so it is read back from storage when one
 * opens and written on every turn, and tucking the stream away is a display
 * decision only — the conversation and any request still in flight keep
 * running behind the prompt line.
 */
export function AssistantPanel({
  document: sourceDoc,
  effectiveAssistant,
  selection,
  onApply,
  onPreview,
  onAnalyze,
  collapsed,
  onCollapsedChange,
  confirmDestructive,
  hidden = false,
  prompting = false,
  request = null,
  onDraft,
  onActivity
}: AssistantPanelProps) {
  const [analyzedDocument, setAnalyzedDocument] =
    useState<ProjectDocument | null>(null);
  const [analysisBusy, setAnalysisBusy] = useState(false);
  const analysisEpoch = useRef(0);
  const doc =
    analyzedDocument?.projectId === sourceDoc.projectId &&
    analyzedDocument.version === sourceDoc.version
      ? analyzedDocument
      : sourceDoc;
  useEffect(() => {
    analysisEpoch.current += 1;
    setAnalysisBusy(false);
  }, [sourceDoc.projectId, sourceDoc.version]);
  const projectId = doc.projectId;
  const [conversation, dispatch] = useReducer(
    assistantReducer,
    EMPTY_CONVERSATION
  );
  const [chosenSuggestionId, setChosenSuggestionId] = useState<string | null>(
    null
  );
  const [pending, setPending] = useState<AssistantAttachmentPreview[]>([]);
  // Attachments arrive from async conversions that can overlap — a paste while
  // a dropped PDF is still rasterizing. The ref is what those readers count
  // slots against, because component state is a render behind them.
  const pendingRef = useRef<readonly AssistantAttachmentPreview[]>(pending);
  const updatePending = useCallback(
    (
      next: (
        current: readonly AssistantAttachmentPreview[]
      ) => AssistantAttachmentPreview[]
    ) => {
      pendingRef.current = next(pendingRef.current);
      setPending(pendingRef.current as AssistantAttachmentPreview[]);
    },
    []
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [loadedStatus, setStatus] = useState<AssistantStatus | null>(null);
  const status = effectiveAssistant ?? loadedStatus;
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [applyingEntryId, setApplyingEntryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssistantProgress>({
    stage: 'reading',
    text: ''
  });
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  // Scrollback: the stream takes the stage's height and stops fading.
  const [scrollback, setScrollback] = useState(false);
  const [autoParameterizeResult, setAutoParameterizeResult] = useState<{
    document: ProjectDocument;
    selection: CadSelectionContext;
    proposal: CadPatchProposal | null;
  } | null>(null);
  const applyingEntryRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /**
   * Which project the conversation on screen belongs to.
   *
   * State rather than a ref because it has to change in the same commit as the
   * entries do: on the render where the project changed, the thread is still
   * the previous document's, and saving then would file one project's
   * conversation under another's id.
   */
  const [threadProjectId, setThreadProjectId] = useState<string | null>(null);
  // How much of the thread the user has actually seen, for the badge.
  const seenCountRef = useRef(0);

  const selectionSummary = useMemo(
    () => selectionSummaryOf(selection),
    [selection]
  );
  const thinking = conversation.status === 'thinking';
  const configured = status?.configured ?? false;
  const entries = conversation.entries;
  const autoParameterizeProposal =
    autoParameterizeResult?.document === doc &&
    autoParameterizeResult.selection === selection
      ? autoParameterizeResult.proposal
      : null;
  const groups = useMemo(
    () => groupThreadByDay(entries, Date.now()),
    [entries]
  );
  const growingHolderProposal = useMemo(
    () => createGrowingHolderProposal(doc, selection),
    [doc, selection]
  );
  const editCatalog = useMemo(
    () => createEditCandidateCatalog(doc, selection),
    [doc, selection]
  );
  const growingHolderHoleProposal = useMemo(
    () => createGrowingHolderHoleProposal(doc, selection),
    [doc, selection]
  );
  const suggestions = useMemo(
    () =>
      assistantSuggestions({
        bodyCount: doc.bodyOrder.length,
        topologyKind: sharedTopologyKind(selection),
        selectedBodyCount: selection.bodyIds.length,
        autoParameterizeProposal,
        growingHolderProposal,
        growingHolderHoleProposal
      }),
    [
      autoParameterizeProposal,
      doc.bodyOrder.length,
      growingHolderHoleProposal,
      growingHolderProposal,
      selection
    ]
  );
  const requestSuggestions = useMemo(
    () => [
      ...suggestions,
      ...editCatalog.candidates.map((candidate) => ({
        id: candidate.id,
        label: candidate.label,
        proposal: proposalForEditCandidate(candidate)
      }))
    ],
    [suggestions, editCatalog]
  );
  /** Every app-measured recipe stays one click away once a thread exists. */
  const verifiedSuggestions = useMemo(
    () => suggestions.filter((suggestion) => suggestion.proposal),
    [suggestions]
  );
  const findDirectSuggestion = useCallback(
    (text: string) => {
      const matching = requestSuggestions.filter(
        (suggestion) => suggestion.proposal && suggestion.label === text
      );
      return (
        matching.find((suggestion) => suggestion.id === chosenSuggestionId) ??
        (matching.length === 1 ? matching[0] : undefined)
      );
    },
    [requestSuggestions, chosenSuggestionId]
  );
  /** The last thing the user asked, which is what "try again" repeats. */
  const lastAsk = useMemo(() => {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.kind === 'user') {
        return entry;
      }
    }
    return null;
  }, [entries]);
  /**
   * The proposal the prompt's keys act on: the newest one still open, even
   * when a later proposal has already been decided. Older open proposals
   * keep their own buttons.
   */
  const openProposal = useMemo(
    () => findOpenProposal(conversation),
    [conversation]
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    onActivity?.({ thinking, unread, context: selectionSummary });
  }, [onActivity, thinking, unread, selectionSummary]);

  useEffect(() => {
    if (collapsed) {
      return;
    }
    let active = true;
    void import('@openzcad/ai-contracts/auto-parameterize')
      .then(({ createAutoParameterizeProposal }) => {
        if (active) {
          setAutoParameterizeResult({
            document: doc,
            selection,
            proposal: createAutoParameterizeProposal(doc, selection)
          });
        }
      })
      .catch(() => {
        if (active) {
          setAutoParameterizeResult({
            document: doc,
            selection,
            proposal: null
          });
        }
      });
    return () => {
      active = false;
    };
  }, [collapsed, doc, selection]);

  useEffect(() => {
    const controller = new AbortController();
    setStatus(null);
    setStatusError(null);
    void (
      effectiveAssistant
        ? Promise.resolve(effectiveAssistant)
        : loadAssistantStatus(controller.signal)
    )
      .then((next) => {
        if (controller.signal.aborted) return;
        setStatus(next);
        setStatusError(
          next.configured
            ? null
            : next.provider === 'openrouter'
              ? 'Set OPENROUTER_API_KEY in your shell or apps/web/.dev.vars (or as a beta Worker secret), then restart the app.'
              : 'Add AI_API_KEY to apps/web/.dev.vars (or a beta Worker secret), then restart the app.'
        );
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStatusError(
            error instanceof Error
              ? error.message
              : 'Assistant status is unavailable.'
          );
        }
      });
    return () => controller.abort();
  }, [effectiveAssistant]);

  // Opening a project brings its conversation with it. A turn in flight belongs
  // to the document that asked for it, so switching projects cancels it rather
  // than letting the reply land in someone else's thread.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const restored = loadAssistantThread(projectId);
    dispatch({ type: 'restore', entries: restored });
    setThreadProjectId(projectId);
    // Scrollback that was already there is not news, however the stream is.
    seenCountRef.current = restored.length;
    setNotice(null);
    setUnread(0);
    setScrollback(false);
  }, [projectId]);

  // Every turn is written straight back: a browser tab is closed without
  // ceremony, and a thread that only survives a clean exit is not a record.
  useEffect(() => {
    if (threadProjectId !== projectId) {
      return;
    }
    saveAssistantThread(projectId, entries, Date.now());
  }, [entries, projectId, threadProjectId]);

  // Replies that land behind a tucked-away stream are what the prompt's dot
  // is counting; opening the stream is the acknowledgement.
  useEffect(() => {
    if (threadProjectId !== projectId) {
      // Mid project switch: the entries on screen are the old document's.
      return;
    }
    if (!collapsed || entries.length < seenCountRef.current) {
      // Either the user is looking at the thread, or it was replaced wholesale
      // by a project switch or a clear — neither leaves anything unread.
      seenCountRef.current = entries.length;
      setUnread(0);
      return;
    }
    const arrived = entries
      .slice(seenCountRef.current)
      .filter((entry) => entry.kind !== 'user').length;
    seenCountRef.current = entries.length;
    if (arrived > 0) {
      setUnread((count) => count + arrived);
    }
  }, [collapsed, entries, projectId, threadProjectId]);

  /**
   * `'instant'`, not `'auto'`, for the pinning path.
   *
   * The thread sets `scroll-behavior: smooth` for the jump button, and `'auto'`
   * defers to exactly that — so pinning animated, and the scroll events its own
   * intermediate frames fired read as "the user scrolled away", which switched
   * pinning off and stranded the thread mid-conversation.
   */
  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const thread = threadRef.current;
    if (thread) {
      thread.scrollTo({ top: thread.scrollHeight, behavior });
    }
  }, []);

  // Keep the newest turn in view — but only when the user is already reading the
  // end of the thread. Yanking someone out of scrollback to show a reply is how
  // a long conversation becomes unusable, so a jump button is offered instead.
  useLayoutEffect(() => {
    if (collapsed || hidden) {
      return;
    }
    if (atBottom) {
      scrollToLatest('instant');
    }
  }, [
    atBottom,
    collapsed,
    hidden,
    entries,
    conversation.status,
    progress.text,
    scrollback,
    scrollToLatest
  ]);

  // Reopening the stream lands at the newest turn, which stands on the prompt.
  useLayoutEffect(() => {
    if (!collapsed && !hidden) {
      scrollToLatest('instant');
      setAtBottom(true);
    }
  }, [collapsed, hidden, scrollToLatest]);

  const send = useCallback(
    async (
      text: string,
      attachments: AssistantAttachmentPreview[],
      answers?: ReturnType<typeof collectedAnswers>,
      answeredEntryId?: string
    ) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setNotice(null);
      setProgress({ stage: 'reading', text: '' });
      // Drop any live preview: it belongs to a proposal this turn supersedes.
      void onPreview(null);
      dispatch({ type: 'preview', entryId: null });
      dispatch({
        type: 'submit',
        id: nextEntryId('user'),
        text,
        at: Date.now(),
        attachments,
        ...(answers ? { answers } : {}),
        ...(answeredEntryId ? { answeredEntryId } : {})
      });

      try {
        const verifiedSuggestion =
          attachments.length === 0 ? findDirectSuggestion(text) : undefined;
        if (verifiedSuggestion?.proposal) {
          const proposal = parseCadPatchProposal(
            structuredClone(verifiedSuggestion.proposal)
          );
          const preview = await onPreview(proposal);
          if (!preview.ok) {
            throw new Error(
              `This verified recipe did not pass exact geometry preflight. Nothing was changed.\n\n${preview.reason}`
            );
          }
          const entryId = nextEntryId('reply');
          dispatch({
            type: 'reply',
            id: entryId,
            reply: {
              kind: 'patch',
              proposal,
              readings: []
            },
            at: Date.now()
          });
          dispatch({ type: 'preview', entryId });
          return;
        }
        // One immutable snapshot per turn: if the selection or document changes
        // while the provider is thinking, this turn still means what it meant
        // when it was sent.
        const reply = await streamAssistantReply(
          {
            prompt: text,
            digest: createCadDocumentDigest(doc, selection),
            history: historyForRequest(conversation),
            attachments: attachments.map((attachment) => ({
              id: attachment.id,
              mediaType: attachment.mediaType,
              dataBase64: attachment.dataBase64,
              label: attachment.label
            }))
          },
          {
            signal: controller.signal,
            // The reply is one JSON object, so until it closes the only honest
            // progress is the fields already on the wire.
            onDelta: (partial) => setProgress(readAssistantProgress(partial))
          }
        );
        if (reply.kind === 'patch') {
          const preview = await onPreview(reply.proposal);
          if (!preview.ok) {
            throw new Error(
              `The proposed change did not pass exact geometry preflight. Nothing was changed.\n\n${preview.reason}`
            );
          }
        }
        const entryId = nextEntryId('reply');
        dispatch({
          type: 'reply',
          id: entryId,
          reply,
          at: Date.now()
        });
        if (reply.kind === 'patch') {
          dispatch({ type: 'preview', entryId });
        }
      } catch (error) {
        if (controller.signal.aborted) {
          dispatch({ type: 'cancel' });
          return;
        }
        dispatch({
          type: 'fail',
          id: nextEntryId('error'),
          at: Date.now(),
          message:
            error instanceof Error
              ? error.message
              : 'The assistant could not answer.'
        });
      }
    },
    [conversation, doc, onPreview, selection, findDirectSuggestion]
  );

  const handledRequestId = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handledRequestId.current === request.id) {
      return;
    }
    handledRequestId.current = request.id;
    const text = request.text.trim();
    if (!text) {
      return;
    }
    const verified = Boolean(findDirectSuggestion(text));
    if (thinking || (!configured && !verified)) {
      // Handed back to the prompt line rather than lost. An unconfigured
      // assistant already says so in its own status line.
      onDraft?.(text);
      if (thinking) {
        setNotice(
          'The assistant is still answering the last ask. Press Enter again when it finishes.'
        );
      }
      return;
    }
    const attachments = pendingRef.current as AssistantAttachmentPreview[];
    updatePending(() => []);
    void send(text, attachments);
    // Only a new request id sends; the rest are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  function sendAnswers(entry: AssistantQuestionsEntry) {
    const answers = collectedAnswers(entry);
    if (answers.length === 0 || thinking) {
      return;
    }
    const text = allQuestionsAnswered(entry)
      ? answers.map((answer) => answer.value).join('; ')
      : `${answers.map((answer) => answer.value).join('; ')} — choose sensible defaults for anything I did not answer.`;
    void send(text, [], answers, entry.id);
  }

  function applySuggestion(suggestion: AssistantSuggestion) {
    // Offered, not sent: the opener is a starting point to edit, and a click
    // that fires a request the user has not read yet is a trap.
    setChosenSuggestionId(suggestion.id);
    onDraft?.(suggestion.label);
  }

  async function analyzeSelection() {
    if (!onAnalyze || analysisBusy) return;
    const bodyIds = [
      ...new Set([
        ...selection.bodyIds,
        ...selection.topologies.map((item) => item.bodyId)
      ])
    ];
    const faceHashes = selection.topologies
      .filter((item) => item.kind === 'face')
      .flatMap((item) => (typeof item.hash === 'number' ? [item.hash] : []));
    if (bodyIds.length !== 1 || faceHashes.length > 2) {
      setNotice('Select one part and optionally one or two faces to analyze.');
      return;
    }
    const epoch = ++analysisEpoch.current;
    setAnalysisBusy(true);
    setNotice(null);
    try {
      const derived = await onAnalyze(sourceDoc, {
        bodyId: bodyIds[0]!,
        faceHashes
      });
      if (epoch !== analysisEpoch.current) return;
      setAnalyzedDocument({ ...sourceDoc, derived });
      setNotice(
        'Analysis complete. Review the measured edits below; unavailable dimensions remain unchanged.'
      );
    } catch (error) {
      if (epoch === analysisEpoch.current)
        setNotice(
          error instanceof Error ? error.message : 'Part analysis failed.'
        );
    } finally {
      if (epoch === analysisEpoch.current) setAnalysisBusy(false);
    }
  }

  function stopThinking() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function clearThread() {
    if (
      confirmDestructive &&
      !window.confirm(
        'Clear the AI conversation for this project? This cannot be undone.'
      )
    ) {
      return;
    }
    stopThinking();
    void onPreview(null);
    dispatch({ type: 'reset' });
    clearAssistantThread(projectId);
    setNotice(null);
    setUnread(0);
    setScrollback(false);
  }

  async function addFiles(files: readonly File[]) {
    setNotice(null);
    for (const file of files) {
      const remaining = MAX_ASSISTANT_ATTACHMENTS - pendingRef.current.length;
      if (remaining <= 0) {
        setNotice(
          `Only ${MAX_ASSISTANT_ATTACHMENTS} drawings can be attached at once.`
        );
        break;
      }
      try {
        const converted = await attachmentsFromFile(
          file,
          nextEntryId('att'),
          remaining
        );
        // Reading the live list here rather than a snapshot from before the
        // await is what keeps a concurrent drop from discarding this one.
        updatePending((current) =>
          [...current, ...converted].slice(0, MAX_ASSISTANT_ATTACHMENTS)
        );
      } catch (error) {
        setNotice(
          error instanceof AttachmentError || error instanceof Error
            ? error.message
            : `${file.name} could not be attached.`
        );
      }
    }
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length > 0) {
      void addFiles(files);
    }
  }

  async function previewProposal(entryId: string, proposal: CadPatchProposal) {
    if (conversation.previewEntryId === entryId) {
      await onPreview(null);
      dispatch({ type: 'preview', entryId: null });
      return;
    }
    const preview = await onPreview(proposal);
    if (!preview.ok) {
      setNotice(`That patch could not be previewed: ${preview.reason}`);
      return;
    }
    dispatch({ type: 'preview', entryId });
  }

  async function applyProposal(entryId: string, proposal: CadPatchProposal) {
    if (applyingEntryRef.current) {
      return;
    }
    applyingEntryRef.current = entryId;
    setApplyingEntryId(entryId);
    void onPreview(null);
    dispatch({ type: 'preview', entryId: null });
    // A patch can still fail here — an expression that will not evaluate, or a
    // body an earlier operation consumed. Leave the card open when it does
    // rather than reporting a success that did not happen.
    try {
      if (!(await onApply(proposal))) {
        setNotice(
          'That patch could not be applied. See the status bar for details.'
        );
        return;
      }
      dispatch({ type: 'resolve-proposal', entryId, status: 'applied' });
      setNotice(null);
    } catch {
      setNotice(
        'That patch could not be applied. See the status bar for details.'
      );
    } finally {
      applyingEntryRef.current = null;
      setApplyingEntryId(null);
    }
  }

  function rejectProposal(entryId: string) {
    if (conversation.previewEntryId === entryId) {
      void onPreview(null);
    }
    dispatch({
      type: 'resolve-proposal',
      entryId,
      status: 'rejected'
    });
  }

  // The prompt line's keys, while it is empty: Enter applies the proposal
  // waiting at the foot of the stream (or sends a drawing that waits there),
  // `p` previews it, Escape rejects it, ⌘↑ opens scrollback. Kept in a ref so
  // one listener sees the current turn.
  const promptKeyRef = useRef<
    (key: AssistantPromptKeyDetail['key']) => boolean
  >(() => false);
  promptKeyRef.current = (key) => {
    if (hidden) {
      return false;
    }
    if (key === 'history') {
      if (collapsed) {
        onCollapsedChange(false);
      }
      setScrollback((open) => collapsed || !open);
      return true;
    }
    if (collapsed) {
      return false;
    }
    const busy = thinking || applyingEntryId !== null;
    if (key === 'apply') {
      if (openProposal && !busy) {
        void applyProposal(openProposal.id, openProposal.proposal);
        return true;
      }
      if (pendingRef.current.length > 0 && !busy && configured) {
        const attachments = pendingRef.current as AssistantAttachmentPreview[];
        updatePending(() => []);
        void send(
          `Model the part in ${attachments.length === 1 ? 'this drawing' : 'these drawings'}.`,
          attachments
        );
        return true;
      }
      return false;
    }
    if (!openProposal || busy) {
      return false;
    }
    if (key === 'preview') {
      void previewProposal(openProposal.id, openProposal.proposal);
      return true;
    }
    rejectProposal(openProposal.id);
    return true;
  };
  useEffect(() => {
    function onPromptKey(event: Event) {
      const { key } = (event as CustomEvent<AssistantPromptKeyDetail>).detail;
      if (promptKeyRef.current(key)) {
        event.preventDefault();
      }
    }
    window.addEventListener(ASSISTANT_PROMPT_KEY_EVENT, onPromptKey);
    return () =>
      window.removeEventListener(ASSISTANT_PROMPT_KEY_EVENT, onPromptKey);
  }, []);

  function renderEntry(entry: AssistantEntry) {
    if (entry.kind === 'user') {
      return (
        <Turn role="user" at={entry.at} key={entry.id}>
          {entry.answers.length > 0 ? (
            <dl className="assistant-answer-list">
              {entry.answers.map((answer) => (
                <div key={answer.questionId}>
                  <dt>{answer.prompt}</dt>
                  <dd>{answer.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="assistant-ask">{entry.text}</p>
          )}
          {entry.attachments.length > 0 && (
            <div className="assistant-thumbs">
              {entry.attachments.map((attachment) =>
                attachment.dataBase64 ? (
                  <img
                    key={attachment.id}
                    src={attachmentDataUrl(attachment)}
                    alt={attachment.label}
                    title={attachment.label}
                  />
                ) : (
                  // The bytes aged out of storage; the fact of the drawing
                  // is still part of the record.
                  <span
                    className="assistant-thumb-gone"
                    key={attachment.id}
                    title={`${attachment.label} — no longer stored`}
                  >
                    <ImageIcon size={13} aria-hidden="true" />
                    {attachment.label}
                  </span>
                )
              )}
            </div>
          )}
        </Turn>
      );
    }
    if (entry.kind === 'questions') {
      return (
        <Turn role="assistant" at={entry.at} key={entry.id}>
          <QuestionCard
            entry={entry}
            busy={thinking}
            onAnswer={(questionId, value) =>
              dispatch({
                type: 'answer',
                entryId: entry.id,
                questionId,
                value
              })
            }
            onSend={() => sendAnswers(entry)}
          />
        </Turn>
      );
    }
    if (entry.kind === 'proposal') {
      return (
        <Turn role="assistant" at={entry.at} key={entry.id}>
          <ProposalCard
            entry={entry}
            busy={thinking || applyingEntryId !== null}
            applying={applyingEntryId === entry.id}
            previewing={conversation.previewEntryId === entry.id}
            // The prompt's keys act on the newest open proposal only.
            keyed={openProposal?.id === entry.id}
            onPreview={() => {
              void previewProposal(entry.id, entry.proposal);
            }}
            onApply={() => {
              void applyProposal(entry.id, entry.proposal);
            }}
            onReject={() => rejectProposal(entry.id)}
          />
        </Turn>
      );
    }
    return (
      <Turn role="assistant" at={entry.at} key={entry.id}>
        <div className={`assistant-card message ${entry.tone}`}>
          {entry.tone === 'error' && (
            <span className="assistant-card-label">
              <X size={12} aria-hidden="true" />
              Failed
            </span>
          )}
          <RichText text={entry.text} className="assistant-card-copy" />
          {entry.tone === 'error' && lastAsk && (
            <div className="assistant-card-actions">
              <button
                type="button"
                disabled={thinking}
                title={`Send "${lastAsk.text}" again`}
                onClick={() =>
                  void send(
                    lastAsk.text,
                    // A drawing whose bytes aged out of storage cannot be
                    // resent; the words can.
                    lastAsk.attachments.filter(
                      (attachment) => attachment.dataBase64
                    )
                  )
                }
              >
                <RotateCcw size={12} aria-hidden="true" />
                Try again
              </button>
            </div>
          )}
        </div>
      </Turn>
    );
  }

  if (collapsed) {
    return null;
  }

  const modelLabel = status?.configured
    ? `${status.model.slice(status.model.lastIndexOf('/') + 1)} · ${status.reasoningEffort}`
    : 'Unavailable';
  const modelDescription = status?.configured
    ? `${status.model} · ${status.reasoningEffort} reasoning`
    : 'Assistant unavailable';
  const quiet = !prompting && !thinking && !dragging;

  return (
    <section
      className={`assistant-panel${dragging ? ' dragging' : ''}${
        hidden ? ' assistant-off-screen' : ''
      }${quiet ? ' quiet' : ''}${scrollback ? ' scrollback' : ''}`}
      aria-label="AI modeling assistant"
      aria-hidden={hidden || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <div
        className="assistant-thread"
        ref={threadRef}
        onScroll={(event) => {
          const thread = event.currentTarget;
          const distance =
            thread.scrollHeight - thread.scrollTop - thread.clientHeight;
          // A card that grows after it renders (a reading table, a thumbnail)
          // must not read as the user having scrolled away.
          setAtBottom(distance < 48);
        }}
      >
        {entries.length === 0 && (
          <div className="assistant-empty">
            <p className="assistant-empty-lead">
              Ask for a part, or drop a drawing here and let the assistant read
              it. Every change is previewed and applied by you.
            </p>
            <ul className="assistant-suggestions">
              {suggestions.map((suggestion) => (
                <li key={suggestion.id}>
                  <button
                    type="button"
                    className="assistant-suggestion"
                    disabled={!configured && !suggestion.proposal}
                    onClick={() => applySuggestion(suggestion)}
                  >
                    <span className="assistant-turn-mark" aria-hidden="true">
                      ›
                    </span>
                    <span>{suggestion.label}</span>
                    {suggestion.proposal && (
                      <span className="assistant-suggestion-badge">
                        Verified
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {groups.map((group) => (
          <div className="assistant-day" key={group.key}>
            {/* Today needs no landmark; an older day does. */}
            {group.label !== 'Today' && (
              <div className="assistant-day-rule">
                <span>{group.label}</span>
              </div>
            )}
            {group.entries.map((entry) => renderEntry(entry))}
          </div>
        ))}

        {thinking && (
          <div className="assistant-turn assistant-working" aria-live="polite">
            <span className="assistant-turn-mark" aria-hidden="true">
              <Sparkles size={12} />
            </span>
            <div className="assistant-turn-body">
              <span className="assistant-card-label">Thinking</span>
              <span className="assistant-working-copy">
                {describeProgress(progress, selectionSummary)}
                {progress.text && (
                  <em className="assistant-working-text">{progress.text}</em>
                )}
              </span>
              <button
                type="button"
                className="assistant-link"
                onClick={stopThinking}
                aria-label="Stop the assistant"
                title="Stop"
              >
                stop
              </button>
            </div>
          </div>
        )}
      </div>

      {!atBottom && entries.length > 0 && (
        <button
          type="button"
          className="assistant-jump"
          onClick={() => {
            scrollToLatest();
            setAtBottom(true);
          }}
        >
          <ArrowDown size={12} aria-hidden="true" />
          Jump to latest
        </button>
      )}

      {/* What stands between the stream and the prompt: notices, drawings
          waiting for the next ask, the verified recipes, and the foot line. */}
      <footer className="assistant-actions">
        {notice && (
          <p className="assistant-notice" role="status">
            {notice}
          </p>
        )}
        {!configured && statusError && (
          <p className="assistant-notice" role="status">
            {statusError}
          </p>
        )}
        {pending.length > 0 && (
          <div className="assistant-pending">
            {pending.map((attachment) => (
              <span className="assistant-pending-item" key={attachment.id}>
                <img
                  src={attachmentDataUrl(attachment)}
                  alt={attachment.label}
                />
                <span className="assistant-pending-label">
                  {attachment.label}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.label}`}
                  onClick={() =>
                    updatePending((current) =>
                      current.filter((item) => item.id !== attachment.id)
                    )
                  }
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
            <span className="assistant-pending-hint">
              attached to the next ask · Enter sends without words
            </span>
          </div>
        )}
        {(onAnalyze ||
          (entries.length > 0 && verifiedSuggestions.length > 0)) && (
          <div className="assistant-actions-row">
            {onAnalyze && (
              <button
                type="button"
                className="assistant-verified-action"
                disabled={thinking || analysisBusy || applyingEntryId !== null}
                onClick={() => {
                  void analyzeSelection();
                }}
              >
                {analysisBusy
                  ? 'Analyzing selected geometry…'
                  : 'Analyze selected geometry'}
              </button>
            )}
            {entries.length > 0 &&
              verifiedSuggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className="assistant-verified-action"
                  disabled={thinking || applyingEntryId !== null}
                  onClick={() => applySuggestion(suggestion)}
                >
                  <Sparkles size={12} aria-hidden="true" />
                  <span>{suggestion.label}</span>
                  <span className="assistant-suggestion-badge">Verified</span>
                </button>
              ))}
          </div>
        )}
        {(editCatalog.candidates.length > 0 ||
          editCatalog.measuredOnly.length > 0) && (
          <details className="assistant-edit-catalog">
            <summary>Measured edits ({editCatalog.candidates.length})</summary>
            {editCatalog.candidates.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className="assistant-verified-action"
                title={candidate.description}
                disabled={thinking || applyingEntryId !== null}
                onClick={() =>
                  applySuggestion({
                    id: candidate.id,
                    label: candidate.label,
                    proposal: proposalForEditCandidate(candidate)
                  })
                }
              >
                <span>{candidate.label}</span>
                <span className="assistant-suggestion-badge">Preview</span>
              </button>
            ))}
            {editCatalog.measuredOnly.map((measurement, index) => (
              <p key={`${measurement.bodyId}:${index}`}>
                {measurement.label}: {measurement.value} {measurement.unit} —
                measured only. {measurement.reason}
              </p>
            ))}
            {!editCatalog.complete && (
              <p>
                This list may not include every editable feature. Select
                specific faces to refine the analysis.
              </p>
            )}
          </details>
        )}
        <div className="assistant-foot">
          <span
            className="assistant-model"
            title={modelDescription}
            aria-label={modelDescription}
          >
            {modelLabel}
          </span>
          <button
            type="button"
            className="assistant-foot-action"
            title="Attach a drawing (PNG, JPEG, WebP, or PDF)"
            aria-label="Attach a drawing"
            disabled={thinking || pending.length >= MAX_ASSISTANT_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            attach
          </button>
          <button
            type="button"
            className={`assistant-foot-action${scrollback ? ' active' : ''}`}
            title={scrollback ? 'Close scrollback (⌘↑)' : 'Scrollback (⌘↑)'}
            aria-label={scrollback ? 'Close scrollback' : 'Open scrollback'}
            aria-pressed={scrollback}
            onClick={() => setScrollback((open) => !open)}
          >
            history
          </button>
          {entries.length > 0 && (
            <button
              type="button"
              className="assistant-foot-action"
              title="Clear this project's conversation"
              aria-label="Clear this project's conversation"
              disabled={applyingEntryId !== null}
              onClick={clearThread}
            >
              clear
            </button>
          )}
          {/* Tucks the stream away behind the prompt line: the thread is
              kept, and ⌘J brings it back. */}
          <button
            type="button"
            className="assistant-foot-action"
            title="Collapse the assistant (⌘J)"
            aria-label="Collapse the assistant"
            onClick={() => onCollapsedChange(true)}
          >
            hide
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ACCEPTED_ATTACHMENT_TYPES}
          style={{ display: 'none' }}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (files.length > 0) {
              void addFiles(files);
            }
          }}
        />
      </footer>
    </section>
  );
}
