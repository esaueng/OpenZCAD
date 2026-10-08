import { useEffect, useId, useRef, useState } from 'react';
import { Check, CircleHelp, Pencil } from 'lucide-react';
import {
  allQuestionsAnswered,
  collectedAnswers,
  type AssistantQuestionsEntry
} from '../../lib/assistant/conversation';
import { RichText } from './RichText';
import { StableLabel } from '../StableLabel';

interface QuestionCardProps {
  entry: AssistantQuestionsEntry;
  busy: boolean;
  onAnswer(questionId: string, value: string): void;
  onSend(): void;
}

/**
 * The assistant's questions for one turn.
 *
 * Chips carry the model's own suggested values so the common case is a single
 * tap, with a text field for anything it did not anticipate. Answering is the
 * one place the conversation is genuinely two-way, so the card tracks how far
 * through it the user is and says what sending will do — including what the
 * assistant will decide on its own if some are left blank. A card that has been
 * sent stays on screen as a record of what was asked and answered.
 */
export function QuestionCard({
  entry,
  busy,
  onAnswer,
  onSend
}: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const answered = collectedAnswers(entry).length;
  const total = entry.questions.length;
  const complete = allQuestionsAnswered(entry);
  const idPrefix = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLLIElement>());

  /*
    Every control here replaces itself when used: a chip with the answer and
    its "change", "change" with the chips again, the send button with the
    card as sent. Focus follows to what took its place, once the answer has
    come back round through the conversation, rather than falling to the page.
  */
  const focusNext = useRef<
    { to: 'answer' | 'choices'; questionId: string } | { to: 'card' } | null
  >(null);
  useEffect(() => {
    const next = focusNext.current;
    if (!next) {
      return;
    }
    focusNext.current = null;
    if (next.to === 'card') {
      cardRef.current?.focus({ preventScroll: true });
      return;
    }
    const item = itemRefs.current.get(next.questionId);
    const target = item?.querySelector<HTMLElement>(
      next.to === 'answer'
        ? '.assistant-answer button'
        : '.assistant-chips button:not(:disabled), .assistant-chips input:not(:disabled)'
    );
    target?.focus();
  }, [entry.answers, entry.sent]);

  function answer(questionId: string, value: string) {
    focusNext.current = { to: value ? 'answer' : 'choices', questionId };
    onAnswer(questionId, value);
  }

  function commitDraft(questionId: string) {
    const value = (drafts[questionId] ?? '').trim();
    if (!value) {
      return;
    }
    answer(questionId, value);
    setDrafts((current) => ({ ...current, [questionId]: '' }));
  }

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      className={`assistant-card questions${entry.sent ? ' sent' : ''}`}
    >
      <span className="assistant-card-label">
        <CircleHelp size={13} aria-hidden="true" />
        <StableLabel reserve={['Asked', 'Needs an answer']}>
          {entry.sent ? 'Asked' : 'Needs an answer'}
        </StableLabel>
        {!entry.sent && (
          <span className="assistant-progress-pill">
            {answered} of {total}
          </span>
        )}
      </span>
      {!entry.sent && (
        <span
          className="assistant-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={answered}
          aria-label="Questions answered"
        >
          <span
            className="assistant-progress-fill"
            style={{ width: `${total > 0 ? (answered / total) * 100 : 0}%` }}
          />
        </span>
      )}
      {entry.preamble && (
        <RichText text={entry.preamble} className="assistant-card-copy" />
      )}
      <ol className="assistant-questions">
        {entry.questions.map((question) => {
          const chosen = Object.hasOwn(entry.answers, question.id)
            ? entry.answers[question.id]
            : undefined;
          const promptId = `${idPrefix}-${question.id}`;
          return (
            <li
              key={question.id}
              ref={(node) => {
                if (node) {
                  itemRefs.current.set(question.id, node);
                } else {
                  itemRefs.current.delete(question.id);
                }
              }}
              className={chosen ? 'answered' : 'unanswered'}
            >
              <p className="assistant-question-prompt" id={promptId}>
                {question.prompt}
                {question.unit && (
                  <span className="assistant-question-unit">
                    {question.unit}
                  </span>
                )}
              </p>
              {chosen ? (
                <p className="assistant-answer">
                  <Check size={12} aria-hidden="true" />
                  <span className="assistant-answer-value">{chosen}</span>
                  {!entry.sent && (
                    <button
                      type="button"
                      className="assistant-link"
                      aria-label={`Change answer for ${question.prompt}`}
                      onClick={() => answer(question.id, '')}
                    >
                      <Pencil size={12} aria-hidden="true" />
                      change
                    </button>
                  )}
                </p>
              ) : (
                <div
                  className="assistant-chips"
                  role="group"
                  aria-labelledby={promptId}
                >
                  {question.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="assistant-chip"
                      disabled={busy || entry.sent}
                      onClick={() => answer(question.id, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                  {question.allowFreeText && !entry.sent && (
                    <span className="assistant-chip-input">
                      <input
                        value={drafts[question.id] ?? ''}
                        placeholder={
                          question.unit ? `value in ${question.unit}` : 'answer'
                        }
                        aria-label={question.prompt}
                        disabled={busy}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [question.id]: event.target.value
                          }))
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitDraft(question.id);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="assistant-chip"
                        aria-label={`Use answer for ${question.prompt}`}
                        disabled={busy || !(drafts[question.id] ?? '').trim()}
                        onClick={() => commitDraft(question.id)}
                      >
                        Use
                      </button>
                    </span>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!entry.sent && (
        <div className="assistant-card-actions">
          <button
            type="button"
            className="assistant-primary"
            disabled={busy || answered === 0}
            onClick={() => {
              focusNext.current = { to: 'card' };
              onSend();
            }}
            title={
              complete
                ? 'Send these answers'
                : 'Send what you have; the assistant will choose the rest'
            }
          >
            {complete ? 'Build it' : `Send ${answered} of ${total}`}
          </button>
          {!complete && answered > 0 && (
            <span className="assistant-action-hint">
              the rest gets a sensible default
            </span>
          )}
        </div>
      )}
    </div>
  );
}
