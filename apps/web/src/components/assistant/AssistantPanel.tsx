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
import {
  ArrowDown,
  ArrowUp,
  ImageIcon,
  Paperclip,
  PanelRightClose,
  RotateCcw,
  Sparkles,
  Square,
  Trash2,
  X
} from 'lucide-react';
import {
  createCadDocumentDigest,
  MAX_ASSISTANT_ATTACHMENTS,
  type CadPatchProposal,
  type CadSelectionContext
} from '@openzcad/ai-contracts';
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
  groupThreadByDay,
  summarizeThread
} from '../../lib/assistant/timeline';
import {
  describeProgress,
  readAssistantProgress,
  type AssistantProgress
} from '../../lib/assistant/progress';
import { assistantSuggestions } from '../../lib/assistant/suggestions';
import {
  ACCEPTED_ATTACHMENT_TYPES,
  attachmentDataUrl,
  attachmentsFromFile,
  AttachmentError
} from '../../lib/assistant/attachments';
import { QuestionCard } from './QuestionCard';
import { ProposalCard } from './ProposalCard';
import { RichText } from './RichText';
import { AssistantLauncher } from './AssistantLauncher';

interface AssistantPanelProps {
  document: ProjectDocument;
  selection: CadSelectionContext;
  /** Returns false when the patch could not be applied, so the panel can say so. */
  onApply(proposal: CadPatchProposal): Promise<boolean>;
  /** Returns false when the patch could not be previewed. */
  onPreview(proposal: CadPatchProposal | null): Promise<boolean>;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /**
   * Takes the dock off screen without unmounting it. The conversation and the
   * in-flight request live here, so a direct-manipulation mode hides the panel
   * rather than destroying what the user is in the middle of.
   */
  hidden?: boolean;
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

/** Who a turn came from, for grouping consecutive ones under one heading. */
function roleOf(entry: AssistantEntry): TurnRole {
  return entry.kind === 'user' ? 'user' : 'assistant';
}

/**
 * A turn, with its role and time, wrapped so every row reads the same way.
 *
 * Two turns in a row from the same speaker are one block: the second drops the
 * "Assistant" heading and squares the corner facing the first, which is what
 * keeps a long back-and-forth from reading as a stack of unrelated boxes. The
 * time only shows on hover — it matters when auditing a decision, never while
 * reading the sentence.
 */
function Turn({
  role,
  label,
  at,
  continues,
  children
}: {
  role: TurnRole;
  label?: string;
  at: number | undefined;
  continues: boolean;
  children: ReactNode;
}) {
  const time = formatEntryTime(at);
  return (
    <article
      className={`assistant-turn ${role}${continues ? ' continues' : ''}`}
      // A continued turn drops the heading that would have carried its time, so
      // the time stays reachable here rather than disappearing.
      {...(continues && time
        ? { title: label ? `${label} · ${time}` : time }
        : {})}
    >
      {!continues && (
        <header className="assistant-turn-meta">
          {role === 'assistant' && (
            <span className="assistant-turn-mark" aria-hidden="true">
              <Sparkles size={11} />
            </span>
          )}
          {label && <span className="assistant-turn-who">{label}</span>}
          {time && (
            <time className="assistant-turn-time" dateTime={String(at)}>
              {time}
            </time>
          )}
        </header>
      )}
      <div className="assistant-turn-body">{children}</div>
    </article>
  );
}

/**
 * The assistant as a conversation rather than a single-shot command.
 *
 * It holds a thread that outlives the session, a question the assistant asked,
 * thumbnails of an attached drawing, and a proposal detailed enough to audit.
 * Two rules shape the rest: the thread belongs to the project, so it is read
 * back from storage when one opens and written on every turn, and closing the
 * dock is a display decision only — the conversation and any request still in
 * flight keep running behind the launcher.
 */
export function AssistantPanel({
  document: doc,
  selection,
  onApply,
  onPreview,
  collapsed,
  onCollapsedChange,
  hidden = false
}: AssistantPanelProps) {
  const projectId = doc.projectId;
  const [conversation, dispatch] = useReducer(
    assistantReducer,
    EMPTY_CONVERSATION
  );
  const [prompt, setPrompt] = useState('');
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
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [applyingEntryId, setApplyingEntryId] = useState<string | null>(null);
  const [progress, setProgress] = useState<AssistantProgress>({
    stage: 'reading',
    text: ''
  });
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);
  const applyingEntryRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
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
  const groups = useMemo(
    () => groupThreadByDay(entries, Date.now()),
    [entries]
  );
  const suggestions = useMemo(
    () =>
      assistantSuggestions({
        bodyCount: doc.bodyOrder.length,
        topologyKind: sharedTopologyKind(selection),
        selectedBodyCount: selection.bodyIds.length
      }),
    [doc.bodyOrder.length, selection]
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

  // Let the composer grow with the request while keeping enough of the thread
  // visible to preserve conversational context. Resetting to `auto` first also
  // lets it shrink again when text is removed or a prompt is sent.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [collapsed, prompt]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    void loadAssistantStatus(controller.signal)
      .then((next) => {
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
  }, []);

  // Opening a project brings its conversation with it. A turn in flight belongs
  // to the document that asked for it, so switching projects cancels it rather
  // than letting the reply land in someone else's thread.
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    const restored = loadAssistantThread(projectId);
    dispatch({ type: 'restore', entries: restored });
    setThreadProjectId(projectId);
    // Scrollback that was already there is not news, however the dock is.
    seenCountRef.current = restored.length;
    setNotice(null);
    setUnread(0);
  }, [projectId]);

  // Every turn is written straight back: a browser tab is closed without
  // ceremony, and a thread that only survives a clean exit is not a record.
  useEffect(() => {
    if (threadProjectId !== projectId) {
      return;
    }
    saveAssistantThread(projectId, entries, Date.now());
  }, [entries, projectId, threadProjectId]);

  // Replies that land behind a closed dock are what the launcher's badge is
  // counting; opening it is the acknowledgement.
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
    scrollToLatest
  ]);

  // Reopening the dock lands at the newest turn, which is where the composer is.
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
        dispatch({
          type: 'reply',
          id: nextEntryId('reply'),
          reply,
          at: Date.now()
        });
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
    [conversation, doc, onPreview, selection]
  );

  function submitPrompt() {
    const text = prompt.trim();
    if ((!text && pending.length === 0) || thinking || !configured) {
      return;
    }
    const attachments = pending;
    setPrompt('');
    updatePending(() => []);
    void send(
      text ||
        `Model the part in ${attachments.length === 1 ? 'this drawing' : 'these drawings'}.`,
      attachments
    );
  }

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

  function applySuggestion(text: string) {
    // Offered, not sent: the opener is a starting point to edit, and a click
    // that fires a request the user has not read yet is a trap.
    setPrompt(text);
    promptRef.current?.focus();
  }

  function stopThinking() {
    abortRef.current?.abort();
    abortRef.current = null;
  }

  function clearThread() {
    stopThinking();
    void onPreview(null);
    dispatch({ type: 'reset' });
    clearAssistantThread(projectId);
    setNotice(null);
    setUnread(0);
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
    promptRef.current?.focus();
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
    if (!(await onPreview(proposal))) {
      setNotice(
        'That patch could not be previewed. See the status bar for details.'
      );
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

  function renderEntry(entry: AssistantEntry, continues: boolean) {
    if (entry.kind === 'user') {
      return (
        <Turn role="user" at={entry.at} continues={continues} key={entry.id}>
          <div className="assistant-bubble">
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
              <p>{entry.text}</p>
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
          </div>
        </Turn>
      );
    }
    if (entry.kind === 'questions') {
      return (
        <Turn
          role="assistant"
          label="Assistant"
          at={entry.at}
          continues={continues}
          key={entry.id}
        >
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
        <Turn
          role="assistant"
          label="Assistant"
          at={entry.at}
          continues={continues}
          key={entry.id}
        >
          <ProposalCard
            entry={entry}
            busy={thinking || applyingEntryId !== null}
            applying={applyingEntryId === entry.id}
            previewing={conversation.previewEntryId === entry.id}
            onPreview={() => {
              void previewProposal(entry.id, entry.proposal);
            }}
            onApply={() => {
              void applyProposal(entry.id, entry.proposal);
            }}
            onReject={() => {
              if (conversation.previewEntryId === entry.id) {
                void onPreview(null);
              }
              dispatch({
                type: 'resolve-proposal',
                entryId: entry.id,
                status: 'rejected'
              });
            }}
          />
        </Turn>
      );
    }
    return (
      <Turn
        role="assistant"
        label={entry.tone === 'error' ? 'Failed' : 'Assistant'}
        at={entry.at}
        continues={continues}
        key={entry.id}
      >
        <div className={`assistant-card message ${entry.tone}`}>
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
    return (
      <AssistantLauncher
        unread={unread}
        thinking={thinking}
        preview={summarizeThread(entries)}
        hidden={hidden}
        onOpen={() => onCollapsedChange(false)}
      />
    );
  }

  const turnCount = entries.filter((entry) => entry.kind === 'user').length;

  return (
    <section
      className={`assistant-panel${dragging ? ' dragging' : ''}${
        hidden ? ' assistant-off-screen' : ''
      }`}
      aria-label="AI modeling assistant"
      aria-hidden={hidden || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <header className="assistant-header">
        <span className="assistant-title">AI Assistant</span>
        {turnCount > 0 && (
          <span className="assistant-turn-count">
            {turnCount} {turnCount === 1 ? 'ask' : 'asks'}
          </span>
        )}
        {entries.length > 0 && (
          <button
            type="button"
            className="assistant-icon-button"
            title="Clear this project's conversation"
            aria-label="Clear this project's conversation"
            disabled={applyingEntryId !== null}
            onClick={clearThread}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="assistant-icon-button"
          title="Collapse the assistant"
          aria-label="Collapse the assistant"
          onClick={() => onCollapsedChange(true)}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </header>

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
              Describe the part you want, or attach a drawing and let the
              assistant read it.
            </p>
            <p className="assistant-empty-hint">
              It asks before guessing a dimension it cannot infer, and every
              change is previewed and applied by you.
            </p>
            <ul className="assistant-suggestions">
              {suggestions.map((suggestion) => (
                <li key={suggestion}>
                  <button
                    type="button"
                    className="assistant-suggestion"
                    disabled={!configured}
                    onClick={() => applySuggestion(suggestion)}
                  >
                    {suggestion}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {groups.map((group) => (
          <div className="assistant-day" key={group.key}>
            <div className="assistant-day-rule">
              <span>{group.label}</span>
            </div>
            {group.entries.map((entry, index) =>
              renderEntry(
                entry,
                // A run of turns from one speaker reads as one block.
                index > 0 && roleOf(entry) === roleOf(group.entries[index - 1]!)
              )
            )}
          </div>
        ))}

        {thinking && (
          <div className="assistant-turn assistant-working" aria-live="polite">
            <span className="assistant-typing" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="assistant-working-copy">
              {describeProgress(progress, selectionSummary)}
              {progress.text && (
                <em className="assistant-working-text">{progress.text}</em>
              )}
            </span>
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

      <footer className="assistant-composer">
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
          </div>
        )}
        <div className="assistant-prompt">
          <button
            type="button"
            className="assistant-icon-button"
            title="Attach a drawing (PNG, JPEG, WebP, or PDF)"
            aria-label="Attach a drawing"
            disabled={thinking || pending.length >= MAX_ASSISTANT_ATTACHMENTS}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={14} aria-hidden="true" />
          </button>
          <textarea
            ref={promptRef}
            value={prompt}
            rows={3}
            placeholder={
              selectionSummary
                ? `Ask about ${selectionSummary}…`
                : 'Describe a part, or attach a drawing…'
            }
            aria-label="CAD change request"
            disabled={!configured}
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData?.files ?? []);
              if (files.length > 0) {
                event.preventDefault();
                void addFiles(files);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitPrompt();
              }
            }}
          />
          {thinking ? (
            <button
              type="button"
              className="assistant-submit stop"
              onClick={stopThinking}
              aria-label="Stop the assistant"
              title="Stop"
            >
              <Square size={11} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="assistant-submit"
              disabled={!configured || (!prompt.trim() && pending.length === 0)}
              onClick={submitPrompt}
              aria-label="Send to the assistant"
              title="Send (Enter)"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
          )}
        </div>
        <p className="assistant-foot">
          {status?.configured
            ? `${status.model} · ${status.reasoningEffort} reasoning`
            : 'Assistant unavailable'}
          {pending.length > 0 && ' · drawings are sent to your AI provider'}
        </p>
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
