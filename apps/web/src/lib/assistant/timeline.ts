/**
 * Turning a long thread into something readable at a glance.
 *
 * Once the conversation outlives the session, scrollback needs landmarks: a
 * reply from three weeks ago and one from this morning must not look alike. The
 * grouping is a pure function of the entries and a reference time so the labels
 * are testable — `Date.now()` is never read in here.
 */
import type { AssistantEntry } from './conversation';

export interface AssistantThreadGroup {
  /** Stable across re-renders: the day, as `YYYY-MM-DD`, or `undated`. */
  key: string;
  /** `Today`, `Yesterday`, or a written date. */
  label: string;
  entries: AssistantEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKey(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `14:32`, in the viewer's locale. */
export function formatEntryTime(at: number | undefined): string {
  if (!at) {
    return '';
  }
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  });
}

export function formatDayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days <= 0) {
    return 'Today';
  }
  if (days === 1) {
    return 'Yesterday';
  }
  const date = new Date(at);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    // A thread that crosses a year boundary must not read as last week's.
    ...(date.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: 'numeric' })
  });
}

/**
 * Consecutive entries from the same day, in order.
 *
 * Entries stored before timestamps existed have no day of their own; they keep
 * their place at the front of the thread under one undated heading rather than
 * being dropped or given an invented date.
 */
export function groupThreadByDay(
  entries: readonly AssistantEntry[],
  now: number
): AssistantThreadGroup[] {
  const groups: AssistantThreadGroup[] = [];
  for (const entry of entries) {
    const key = entry.at ? dayKey(entry.at) : 'undated';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.entries.push(entry);
      continue;
    }
    groups.push({
      key,
      label: entry.at ? formatDayLabel(entry.at, now) : 'Earlier',
      entries: [entry]
    });
  }
  return groups;
}

/** A one-line preview of the thread, for the collapsed launcher's tooltip. */
export function summarizeThread(entries: readonly AssistantEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === 'proposal') {
      return entry.proposal.summary;
    }
    if (entry.kind === 'message') {
      return entry.text;
    }
    if (entry.kind === 'questions') {
      return entry.preamble || (entry.questions[0]?.prompt ?? '');
    }
    if (entry.kind === 'user' && entry.text.trim()) {
      return entry.text.trim();
    }
  }
  return '';
}
