import { useState } from 'react';
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

  function commitDraft(questionId: string) {
    const value = (drafts[questionId] ?? '').trim();
    if (!value) {
      return;
    }
    onAnswer(questionId, value);
    setDrafts((current) => ({ ...current, [questionId]: '' }));
  }

  return (
    <div className={`assistant-card questions${entry.sent ? ' sent' : ''}`}>
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
          return (
            <li
              key={question.id}
              className={chosen ? 'answered' : 'unanswered'}
            >
              <p className="assistant-question-prompt">
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
                      onClick={() => onAnswer(question.id, '')}
                    >
                      <Pencil size={10} aria-hidden="true" />
                      change
                    </button>
                  )}
                </p>
              ) : (
                <div className="assistant-chips">
                  {question.options.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="assistant-chip"
                      disabled={busy || entry.sent}
                      onClick={() => onAnswer(question.id, option.value)}
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
            onClick={onSend}
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
