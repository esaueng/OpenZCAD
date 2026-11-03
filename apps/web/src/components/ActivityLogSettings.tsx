import { useMemo, useState } from 'react';
import { Copy, Download, Search, Trash2 } from 'lucide-react';
import {
  ACTIVITY_LEVEL_LABELS,
  ACTIVITY_SOURCE_LABELS,
  clearActivityLog,
  filterActivityLog,
  formatActivityLogJson,
  formatActivityLogText,
  useActivityLog,
  type ActivityLevel,
  type ActivityLogEntry,
  type ActivitySource
} from '../lib/activityLog';
import { downloadText } from '../lib/model';
import { countLabel } from '../lib/toasts';
import { Section } from './settingsControls';

const LEVELS: readonly ActivityLevel[] = [
  'ready',
  'running',
  'warning',
  'error'
];
const SOURCES: readonly ActivitySource[] = [
  'status',
  'geometry',
  'notice',
  'error'
];

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

function clockTime(timestamp: number): string {
  const millis = String(new Date(timestamp).getMilliseconds()).padStart(3, '0');
  return `${timeFormatter.format(timestamp)}.${millis}`;
}

/** Seconds since the log started, to a tenth: how far apart things were. */
function elapsed(timestamp: number, startedAt: number): string {
  const seconds = Math.max(0, timestamp - startedAt) / 1000;
  if (seconds < 60) {
    return `+${seconds.toFixed(1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `+${minutes} min ${(seconds - minutes * 60).toFixed(1)} s`;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) {
    next.add(value);
  }
  return next;
}

function fileStamp(date: Date): string {
  return date.toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');
}

/**
 * Settings › Activity log: every status message, geometry phase, notice and
 * uncaught error of this session, newest first by default, with filters and
 * an export for bug reports. Live: entries arrive while it is open.
 */
export function ActivityLogSettings() {
  const { entries, dropped, startedAt } = useActivityLog();
  const [query, setQuery] = useState('');
  const [levels, setLevels] = useState<ReadonlySet<ActivityLevel>>(
    () => new Set()
  );
  const [sources, setSources] = useState<ReadonlySet<ActivitySource>>(
    () => new Set()
  );
  const [newestFirst, setNewestFirst] = useState(true);
  const [feedback, setFeedback] = useState('');

  const levelCounts = useMemo(() => {
    const counts: Record<ActivityLevel, number> = {
      ready: 0,
      running: 0,
      warning: 0,
      error: 0
    };
    for (const entry of entries) {
      counts[entry.level] += 1;
    }
    return counts;
  }, [entries]);

  const matching = useMemo(
    () => filterActivityLog(entries, { query, levels, sources }),
    [entries, levels, query, sources]
  );
  const shown = useMemo(
    () => (newestFirst ? [...matching].reverse() : matching),
    [matching, newestFirst]
  );
  const filtered = query.trim() !== '' || levels.size > 0 || sources.size > 0;
  const newestId = entries.at(-1)?.id;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatActivityLogText(matching));
      setFeedback(`Copied ${countLabel(matching.length, 'entry', 'entries')}.`);
    } catch {
      setFeedback('Could not copy. Use Download instead.');
    }
  };
  const download = () => {
    downloadText(
      `openzcad-activity-${fileStamp(new Date())}.json`,
      formatActivityLogJson(matching),
      'application/json'
    );
    setFeedback(
      `Downloaded ${countLabel(matching.length, 'entry', 'entries')}.`
    );
  };

  return (
    <Section
      title="Activity log"
      intro="Everything this session has reported: status messages, geometry, notices and errors. Kept in this tab only; nothing is sent anywhere."
      wide
    >
      <div className="activity-log" role="region" aria-label="Activity log">
        <div className="activity-log-toolbar">
          <label className="activity-log-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={query}
              placeholder="Filter entries"
              aria-label="Filter entries"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears the filter before it closes Settings.
                if (event.key === 'Escape' && query) {
                  event.stopPropagation();
                  setQuery('');
                }
              }}
            />
          </label>
          <div className="activity-log-chips" role="group" aria-label="Levels">
            {LEVELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`activity-log-chip ${level}`}
                aria-pressed={levels.has(level)}
                onClick={() => setLevels((current) => toggled(current, level))}
              >
                <i aria-hidden="true" />
                {ACTIVITY_LEVEL_LABELS[level]}
                <span className="activity-log-chip-count">
                  {levelCounts[level]}
                </span>
              </button>
            ))}
          </div>
          <div className="activity-log-chips" role="group" aria-label="Sources">
            {SOURCES.map((source) => (
              <button
                key={source}
                type="button"
                className="activity-log-chip"
                aria-pressed={sources.has(source)}
                onClick={() =>
                  setSources((current) => toggled(current, source))
                }
              >
                {ACTIVITY_SOURCE_LABELS[source]}
              </button>
            ))}
          </div>
        </div>
        <div className="activity-log-bar">
          <span className="activity-log-count" aria-live="polite">
            {filtered
              ? `${matching.length} of ${countLabel(entries.length, 'entry', 'entries')}`
              : countLabel(entries.length, 'entry', 'entries')}
            {dropped > 0
              ? ` · ${countLabel(dropped, 'older entry', 'older entries')} dropped`
              : ''}
          </span>
          <span className="activity-log-feedback" role="status">
            {feedback}
          </span>
          <div className="settings-button-row">
            {filtered ? (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setQuery('');
                  setLevels(new Set());
                  setSources(new Set());
                }}
              >
                Clear filters
              </button>
            ) : null}
            <button
              type="button"
              className="secondary"
              aria-pressed={!newestFirst}
              title="Show the oldest entries first"
              onClick={() => setNewestFirst((current) => !current)}
            >
              {newestFirst ? 'Newest first' : 'Oldest first'}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={matching.length === 0}
              title="Copy the shown entries as text"
              onClick={() => void copy()}
            >
              <Copy size={13} aria-hidden="true" />
              Copy
            </button>
            <button
              type="button"
              className="secondary"
              disabled={matching.length === 0}
              title="Download the shown entries as JSON"
              onClick={download}
            >
              <Download size={13} aria-hidden="true" />
              Download
            </button>
            <button
              type="button"
              className="secondary danger"
              disabled={entries.length === 0}
              onClick={() => {
                clearActivityLog();
                setFeedback('Log cleared.');
              }}
            >
              <Trash2 size={13} aria-hidden="true" />
              Clear
            </button>
          </div>
        </div>
        {shown.length === 0 ? (
          <p className="activity-log-empty">
            {entries.length === 0
              ? 'Nothing logged yet.'
              : 'No entries match these filters.'}
          </p>
        ) : null}
        <ol className="activity-log-list">
          {shown.map((entry) => (
            <ActivityLogRow
              key={entry.id}
              entry={entry}
              startedAt={startedAt}
              newest={entry.id === newestId}
            />
          ))}
        </ol>
      </div>
    </Section>
  );
}

function ActivityLogRow({
  entry,
  startedAt,
  newest
}: {
  entry: ActivityLogEntry;
  startedAt: number;
  newest: boolean;
}) {
  const date = new Date(entry.timestamp);
  const where = [entry.project, entry.workspace].filter(Boolean).join(' · ');
  return (
    <li
      className={`activity-log-entry ${entry.level}${newest ? ' current' : ''}`}
      aria-current={newest ? 'true' : undefined}
    >
      <i className={entry.level} aria-hidden="true" />
      <time dateTime={date.toISOString()} title={date.toString()}>
        {clockTime(entry.timestamp)}
      </time>
      <span className="activity-log-copy">
        <span className="activity-log-message">{entry.message}</span>
        {entry.detail ? (
          <span className="activity-log-detail">{entry.detail}</span>
        ) : null}
        <span className="activity-log-meta">
          <span>{ACTIVITY_LEVEL_LABELS[entry.level]}</span>
          <span>{ACTIVITY_SOURCE_LABELS[entry.source]}</span>
          {where ? <span>{where}</span> : null}
          <span>{elapsed(entry.timestamp, startedAt)}</span>
        </span>
      </span>
    </li>
  );
}
