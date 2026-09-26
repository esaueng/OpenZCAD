import { MessageSquare } from 'lucide-react';

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
 * The assistant while the conversation is closed: an Ask button inside the
 * command bar, where the conversation will open from. Command search
 * and the assistant are one entry point on the quiet stage — a question typed
 * into search goes to the same conversation — and the button is where replies
 * that landed while it was closed show up.
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
      title={`${preview ? `${label}\n\n${preview}` : label} (⌘J)`}
      aria-label={label}
      aria-hidden={hidden || undefined}
    >
      <MessageSquare size={14} aria-hidden="true" />
      <span className="assistant-launcher-word">Ask</span>
      {unread > 0 && (
        <span className="assistant-launcher-badge" aria-hidden="true" />
      )}
    </button>
  );
}
