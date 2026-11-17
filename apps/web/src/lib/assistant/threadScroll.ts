/** Room left above a pinned ask: the thread's own top padding. */
export const ASK_TOP_MARGIN = 14;

/**
 * Where following the conversation stops: the foot of the thread, unless a
 * reply taller than the thread would carry the ask that prompted it out of
 * sight. The ask then stays at the top, whole, and the reply reads down from
 * it; it used to land half-clipped under the panel's head (13 November
 * review, I72).
 */
export function latestScrollTop(thread: HTMLElement): number {
  const foot = Math.max(0, thread.scrollHeight - thread.clientHeight);
  const asks = thread.querySelectorAll<HTMLElement>('.assistant-turn.user');
  const ask = asks[asks.length - 1];
  if (!ask) {
    return foot;
  }
  const askTop =
    ask.getBoundingClientRect().top -
    thread.getBoundingClientRect().top +
    thread.scrollTop -
    ASK_TOP_MARGIN;
  return Math.max(0, Math.min(foot, askTop));
}
