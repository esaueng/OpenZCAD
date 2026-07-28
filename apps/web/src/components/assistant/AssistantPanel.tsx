import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent
} from 'react';
import {
  ArrowUp,
  Paperclip,
  PanelRightClose,
  Sparkles,
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
  type AssistantQuestionsEntry
} from '../../lib/assistant/conversation';
import {
  ACCEPTED_ATTACHMENT_TYPES,
  attachmentDataUrl,
  attachmentsFromFile,
  AttachmentError
} from '../../lib/assistant/attachments';
import { QuestionCard } from './QuestionCard';
import { ProposalCard } from './ProposalCard';

interface AssistantPanelProps {
  document: ProjectDocument;
  selection: CadSelectionContext;
  /** Returns false when the patch could not be applied, so the panel can say so. */
  onApply(proposal: CadPatchProposal): boolean;
  /** Returns false when the patch could not be previewed. */
  onPreview(proposal: CadPatchProposal | null): boolean;
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
  /** Bumped by the workspace to move focus into the prompt. */
  focusNonce: number;
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

/**
 * The assistant as a conversation rather than a single-shot command.
 *
 * It has to hold a thread, a question the assistant asked, thumbnails of an
 * attached drawing, and a proposal detailed enough to audit — none of which fit
 * in the one ellipsized line the old bottom rail gave it.
 */
export function AssistantPanel({
  document: doc,
  selection,
  onApply,
  onPreview,
  collapsed,
  onCollapsedChange,
  focusNonce
}: AssistantPanelProps) {
  const [conversation, dispatch] = useReducer(
    assistantReducer,
    EMPTY_CONVERSATION
  );
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState<AssistantAttachmentPreview[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const selectionSummary = useMemo(
    () => selectionSummaryOf(selection),
    [selection]
  );
  const thinking = conversation.status === 'thinking';
  const configured = status?.configured ?? false;

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
              ? 'Add OPENROUTER_API_KEY to apps/web/.dev.vars (or a beta Worker secret), then restart the app.'
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

  useEffect(() => {
    if (focusNonce > 0 && !collapsed) {
      promptRef.current?.focus();
    }
  }, [collapsed, focusNonce]);

  // Keep the newest turn in view; a reply that lands off-screen reads as nothing
  // having happened.
  useEffect(() => {
    const thread = threadRef.current;
    if (thread) {
      thread.scrollTop = thread.scrollHeight;
    }
  }, [conversation.entries, conversation.status]);

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
      // Drop any live preview: it belongs to a proposal this turn supersedes.
      onPreview(null);
      dispatch({ type: 'preview', entryId: null });
      dispatch({
        type: 'submit',
        id: nextEntryId('user'),
        text,
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
          { signal: controller.signal }
        );
        dispatch({ type: 'reply', id: nextEntryId('reply'), reply });
      } catch (error) {
        if (controller.signal.aborted) {
          dispatch({ type: 'cancel' });
          return;
        }
        dispatch({
          type: 'fail',
          id: nextEntryId('error'),
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
    setPending([]);
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

  async function addFiles(files: readonly File[]) {
    setNotice(null);
    let accepted = [...pending];
    for (const file of files) {
      try {
        const converted = await attachmentsFromFile(
          file,
          nextEntryId('att'),
          MAX_ASSISTANT_ATTACHMENTS - accepted.length
        );
        accepted = [...accepted, ...converted].slice(
          0,
          MAX_ASSISTANT_ATTACHMENTS
        );
      } catch (error) {
        setNotice(
          error instanceof AttachmentError || error instanceof Error
            ? error.message
            : `${file.name} could not be attached.`
        );
      }
    }
    setPending(accepted);
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

  function previewProposal(entryId: string, proposal: CadPatchProposal) {
    if (conversation.previewEntryId === entryId) {
      onPreview(null);
      dispatch({ type: 'preview', entryId: null });
      return;
    }
    if (!onPreview(proposal)) {
      setNotice(
        'That patch could not be previewed. See the status bar for details.'
      );
      return;
    }
    dispatch({ type: 'preview', entryId });
  }

  function applyProposal(entryId: string, proposal: CadPatchProposal) {
    onPreview(null);
    dispatch({ type: 'preview', entryId: null });
    // A patch can still fail here — an expression that will not evaluate, or a
    // body an earlier operation consumed. Leave the card open when it does
    // rather than reporting a success that did not happen.
    if (!onApply(proposal)) {
      setNotice(
        'That patch could not be applied. See the status bar for details.'
      );
      return;
    }
    dispatch({ type: 'resolve-proposal', entryId, status: 'applied' });
    setNotice(null);
  }

  if (collapsed) {
    return (
      <button
        type="button"
        className="assistant-launcher"
        onClick={() => onCollapsedChange(false)}
        title="Open the modeling assistant"
      >
        <Sparkles size={15} aria-hidden="true" />
        <span>Assistant</span>
      </button>
    );
  }

  return (
    <section
      className={`assistant-panel${dragging ? ' dragging' : ''}`}
      aria-label="AI modeling assistant"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <header className="assistant-header">
        <Sparkles size={14} aria-hidden="true" />
        <span className="assistant-title">Assistant</span>
        {conversation.entries.length > 0 && (
          <button
            type="button"
            className="assistant-icon-button"
            title="Clear this conversation"
            aria-label="Clear this conversation"
            onClick={() => {
              abortRef.current?.abort();
              onPreview(null);
              dispatch({ type: 'reset' });
              setNotice(null);
            }}
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="assistant-icon-button"
          title="Hide the assistant"
          aria-label="Hide the assistant"
          onClick={() => onCollapsedChange(true)}
        >
          <PanelRightClose size={14} aria-hidden="true" />
        </button>
      </header>

      <div className="assistant-thread" ref={threadRef}>
        {conversation.entries.length === 0 && (
          <div className="assistant-empty">
            <p>
              Describe the part you want, or attach a drawing and let the
              assistant read it.
            </p>
            <p className="assistant-empty-hint">
              It asks before guessing a dimension it cannot infer, and every
              change is previewed and applied by you.
            </p>
          </div>
        )}

        {conversation.entries.map((entry) => {
          if (entry.kind === 'user') {
            return (
              <div className="assistant-turn user" key={entry.id}>
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
                    {entry.attachments.map((attachment) => (
                      <img
                        key={attachment.id}
                        src={attachmentDataUrl(attachment)}
                        alt={attachment.label}
                        title={attachment.label}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          }
          if (entry.kind === 'questions') {
            return (
              <QuestionCard
                key={entry.id}
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
            );
          }
          if (entry.kind === 'proposal') {
            return (
              <ProposalCard
                key={entry.id}
                entry={entry}
                busy={thinking}
                previewing={conversation.previewEntryId === entry.id}
                onPreview={() => previewProposal(entry.id, entry.proposal)}
                onApply={() => applyProposal(entry.id, entry.proposal)}
                onReject={() => {
                  if (conversation.previewEntryId === entry.id) {
                    onPreview(null);
                  }
                  dispatch({
                    type: 'resolve-proposal',
                    entryId: entry.id,
                    status: 'rejected'
                  });
                }}
              />
            );
          }
          return (
            <div
              className={`assistant-card message ${entry.tone}`}
              key={entry.id}
            >
              <span className="assistant-card-label">
                {entry.tone === 'error' ? 'Failed' : 'Assistant'}
              </span>
              <p className="assistant-card-copy">{entry.text}</p>
            </div>
          );
        })}

        {thinking && (
          <p className="assistant-thinking" aria-live="polite">
            {selectionSummary
              ? `Reasoning over ${selectionSummary} and the feature history…`
              : 'Reasoning over the feature history…'}
          </p>
        )}
      </div>

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
                    setPending((current) =>
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
            rows={1}
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
          <button
            type="button"
            className="assistant-submit"
            disabled={
              thinking ||
              !configured ||
              (!prompt.trim() && pending.length === 0)
            }
            onClick={submitPrompt}
            aria-label="Send to the assistant"
            title="Send (Enter)"
          >
            <ArrowUp size={15} aria-hidden="true" />
          </button>
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
