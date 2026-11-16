import { trimComponentStack } from './crashDiagnostics';
import { buildDescription, environmentDescription } from './crashEnvironment';

/**
 * The crash card's Copy details text. Loaded with the card's details, not
 * at startup: only a crash reaches it.
 */

/**
 * Production React throws "Minified React error #N" and nothing else. These
 * are the codes a render crash in this app can plausibly raise, in words a
 * bug report can be read by without looking the number up.
 */
const REACT_ERROR_HINTS: Record<string, string> = {
  '185':
    'Maximum update depth exceeded: a component kept setting state from an effect or update, in a loop.',
  '300': 'Rendered fewer hooks than expected: a hook was skipped on a render.',
  '301': 'Too many re-renders: a component set state while rendering.',
  '310': 'Rendered more hooks than during the previous render.'
};

/** A plain reading of a minified React error, or null for any other error. */
export function explainReactError(message: string | undefined): string | null {
  const code = /Minified React error #(\d+)/.exec(message ?? '')?.[1];
  if (!code) return null;
  const hint = REACT_ERROR_HINTS[code];
  return hint ? `React error #${code}: ${hint}` : `React error #${code}.`;
}

export interface CrashReportInput {
  label: string;
  message: string;
  componentStack?: string | null;
  errorStack?: string | null;
  at: number;
}

/** Plain text for the crash card's Copy details: one paste for a bug report. */
export function formatCrashReport(
  input: CrashReportInput,
  environment: string[] = environmentDescription()
): string {
  const hint = explainReactError(input.message);
  const components = trimComponentStack(input.componentStack);
  const errorStack = input.errorStack
    ?.split('\n')
    .slice(0, 12)
    .join('\n')
    .trim();
  return [
    `${input.label} crashed: ${input.message}`,
    ...(hint ? [hint] : []),
    `Time ${new Date(input.at).toISOString()}`,
    buildDescription(),
    ...environment,
    ...(components ? ['', 'Component stack:', components] : []),
    ...(errorStack ? ['', 'Error stack:', errorStack] : [])
  ].join('\n');
}
