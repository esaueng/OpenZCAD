import { useState } from 'react';
import { getActivityLogSnapshot } from '../lib/activityLog';
import { trimComponentStack } from '../lib/crashDiagnostics';
import { explainReactError, formatCrashReport } from '../lib/crashReport';

export interface CrashDetailsProps {
  label: string;
  message: string;
}

interface LoggedCrash {
  at: number;
  errorStack: string | null;
  componentStack: string | null;
}

/**
 * The boundary's own activity-log entry for this crash (the newest, when an
 * automatic remount failed again): when it happened, its JavaScript stack and
 * its component stack. Read from the log so the boundary, in the entry chunk,
 * keeps no copy of either.
 */
function loggedCrash(label: string, message: string): LoggedCrash | null {
  const entries = getActivityLogSnapshot().entries;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.message !== `${label} crashed: ${message}`) continue;
    const [errorStack, componentStack] = (entry.detail ?? '').split(
      /(?:^|\n)Component stack:\n/
    );
    return {
      at: entry.timestamp,
      errorStack: errorStack || null,
      componentStack: componentStack ?? null
    };
  }
  return null;
}

/**
 * A crash card's Error details: the message, a plain reading of a minified
 * React code, the component stack, and one button that copies all of it with
 * the build and browser. A screenshot of the open details, or the paste, is
 * then enough to find the component that failed. Loaded when a card shows,
 * so none of it weighs on startup; the card shows the bare message until
 * (or unless) it arrives.
 */
export function CrashDetails({ label, message }: CrashDetailsProps) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  // Read once: the card is about the crash it opened on.
  const [logged] = useState(() => loggedCrash(label, message));
  const hint = explainReactError(message);
  const components = trimComponentStack(logged?.componentStack);
  const copy = () => {
    const report = formatCrashReport({
      label,
      message,
      componentStack: logged?.componentStack ?? null,
      errorStack: logged?.errorStack ?? null,
      at: logged?.at ?? Date.now()
    });
    const clipboard = navigator.clipboard as Clipboard | undefined;
    void (
      clipboard
        ? clipboard.writeText(report)
        : Promise.reject(new Error('No clipboard'))
    ).then(
      () => setCopied('copied'),
      () => setCopied('failed')
    );
  };
  return (
    <details className="error-page-details">
      <summary>Error details</summary>
      <code>{message}</code>
      {hint ? <p className="error-page-hint">{hint}</p> : null}
      {components ? (
        <code
          className="error-page-stack"
          aria-label="Component stack"
          data-testid="error-component-stack"
        >
          {components}
        </code>
      ) : null}
      <button type="button" className="secondary" onClick={copy}>
        {copied === 'copied' ? 'Copied' : 'Copy details'}
      </button>
      {copied === 'failed' ? (
        <span className="error-page-hint" role="status">
          Copy was blocked. Select the text above, or use Settings › Activity
          log.
        </span>
      ) : null}
    </details>
  );
}
