import { Sparkles } from 'lucide-react';

interface AssistantLauncherProps {
  /** Turns that landed while the dock was closed. */
  unread: number;
  /** A request is still streaming behind the closed dock. */
  thinking: boolean;
  /** Last thing said, for the tooltip. */
  preview: string;
  hidden: boolean;
  onOpen(): void;
}

/**
 * The assistant when the dock is closed: one mark in the corner of the
 * viewport.
 *
 * Collapsing has to give the modeling space back completely — the panel's
 * column, not just its contents — so what is left is deliberately the smallest
 * thing that can still say "there is a conversation here, and it moved while
 * you were away".
 */
export function AssistantLauncher({
  unread,
  thinking,
  preview,
  hidden,
  onOpen
}: AssistantLauncherProps) {
  const label = thinking
    ? 'Assistant is working — open it'
    : unread > 0
      ? `Open the assistant · ${unread} new ${unread === 1 ? 'reply' : 'replies'}`
      : 'Open the modeling assistant';

  return (
    <button
      type="button"
      className={`assistant-launcher${thinking ? ' working' : ''}${
        unread > 0 ? ' unread' : ''
      }${hidden ? ' assistant-off-screen' : ''}`}
      onClick={onOpen}
      title={preview ? `${label}\n\n${preview}` : label}
      aria-label={label}
      aria-hidden={hidden || undefined}
    >
      <Sparkles size={20} aria-hidden="true" />
      <span className="assistant-launcher-word">Assistant</span>
      {unread > 0 && (
        <span className="assistant-launcher-badge" aria-hidden="true">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </button>
  );
}
