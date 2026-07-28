import { useState } from 'react';
import { CircleHelp, CornerDownLeft } from 'lucide-react';
import {
  allQuestionsAnswered,
  collectedAnswers,
  type AssistantQuestionsEntry
} from '../../lib/assistant/conversation';

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
 * tap, with a text field for anything it did not anticipate. A card that has
 * been sent stays on screen as a record of what was asked and answered.
 */
export function QuestionCard({
  entry,
  busy,
  onAnswer,
  onSend
}: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const answered = collectedAnswers(entry).length;
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
        {entry.sent ? 'Asked' : 'Needs an answer'}
      </span>
      {entry.preamble && (
        <p className="assistant-card-copy">{entry.preamble}</p>
      )}
      <ol className="assistant-questions">
        {entry.questions.map((question) => {
          const chosen = entry.answers[question.id];
          return (
            <li key={question.id}>
              <p className="assistant-question-prompt">{question.prompt}</p>
              {chosen ? (
                <p className="assistant-answer">
                  <CornerDownLeft size={12} aria-hidden="true" />
                  {chosen}
                  {!entry.sent && (
                    <button
                      type="button"
                      className="assistant-link"
                      onClick={() => onAnswer(question.id, '')}
                    >
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
            {complete
              ? 'Build it'
              : `Send ${answered} of ${entry.questions.length}`}
          </button>
        </div>
      )}
    </div>
  );
}
