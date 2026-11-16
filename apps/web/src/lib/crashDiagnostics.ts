/**
 * Where in the component tree a crash happened, as the activity log keeps
 * it. The rest of a crash report (build, browser, a reading of React's
 * minified codes) loads with the crash card, out of the entry chunk.
 */

/** Lines of React's component stack kept in a report; innermost first. */
export const COMPONENT_STACK_LINES = 16;

/** The component stack trimmed to its first lines, blank lines dropped. */
export function trimComponentStack(
  componentStack: string | null | undefined,
  lines = COMPONENT_STACK_LINES
): string | undefined {
  const kept = componentStack
    ?.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, lines)
    .join('\n');
  return kept || undefined;
}
