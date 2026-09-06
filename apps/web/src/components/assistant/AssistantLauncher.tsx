import { ChevronLeft } from 'lucide-react';

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
 * The assistant when the dock is closed: a tab on the right edge, where the
 * dock will open from. It sits at the seam rather than over the canvas, so
 * the modeling space is given back completely and the handle is always in
 * the one place the panel can appear.
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
      <ChevronLeft size={14} aria-hidden="true" />
      <span className="assistant-launcher-word">Assistant</span>
      {unread > 0 && (
        <span className="assistant-launcher-badge" aria-hidden="true" />
      )}
    </button>
  );
}
