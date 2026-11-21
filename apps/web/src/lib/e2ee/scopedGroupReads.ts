import type { ProjectGroupsApi } from './projectGroups';

/** Runs `run` with repeated group reads answered once (see below). */
export type ScopeGroupReads = <T>(run: () => Promise<T>) => Promise<T>;

/**
 * The reads that one share-link action repeats: every ownership, role and
 * key check fetches the project's group info, leaves and authority again.
 * Creating one link made 123 such requests for three answers.
 */
const REPEATED_READS = new Set<keyof ProjectGroupsApi>([
  'group',
  'leaves',
  'authority'
]);

/** Other reads: sent as before, and they leave the shared answers alone. */
const OTHER_READS = new Set<keyof ProjectGroupsApi>([
  'keys',
  'archives',
  'resets',
  'memberCutoffs',
  'welcome',
  'proposals'
]);

/** How long one answer is reused, even inside a scope. */
export const SCOPED_READ_MAX_AGE_MS = 5_000;

/**
 * Wraps the page's project-group API so that, while a scope runs, the
 * same group, leaves or authority read is sent once and its answer shared.
 * Nothing is cached outside a scope. The cache is dropped when:
 *
 * - any write starts or ends (a Commit, an authority save, a key upload:
 *   anything that may change what the server answers);
 * - a Commits read returns Commits (the group moved on);
 * - a read fails (a retry must reach the server);
 * - an answer is older than `SCOPED_READ_MAX_AGE_MS`;
 * - the last scope ends.
 *
 * Every answer is still verified by its caller as before: this only
 * skips sending the same request again within one action.
 */
export function withScopedGroupReads(
  api: ProjectGroupsApi,
  now: () => number = Date.now
): { readonly api: ProjectGroupsApi; readonly scope: ScopeGroupReads } {
  let depth = 0;
  const answers = new Map<string, { at: number; answer: Promise<unknown> }>();
  const drop = () => answers.clear();
  const wrapped: Record<string, unknown> = {};
  for (const name of Object.keys(api) as (keyof ProjectGroupsApi)[]) {
    const method = api[name] as
      ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (typeof method !== 'function') continue;
    const call = (...args: unknown[]) => method.apply(api, args);
    if (REPEATED_READS.has(name)) {
      wrapped[name] = (...args: unknown[]) => {
        if (depth === 0) return call(...args);
        const key = JSON.stringify([name, ...args]);
        const held = answers.get(key);
        // Each caller gets its own copy: none sees another's changes.
        if (held && now() - held.at <= SCOPED_READ_MAX_AGE_MS)
          return held.answer.then((value) => structuredClone(value));
        const answer = call(...args);
        answers.set(key, { at: now(), answer });
        answer.catch(() => {
          if (answers.get(key)?.answer === answer) drop();
        });
        return answer.then((value) => structuredClone(value));
      };
    } else if (name === 'commits') {
      wrapped[name] = async (...args: unknown[]) => {
        const result = (await call(...args)) as {
          readonly commits?: readonly unknown[];
        };
        if (result?.commits?.length) drop();
        return result;
      };
    } else if (OTHER_READS.has(name)) {
      wrapped[name] = call;
    } else {
      // A write, or a method this list does not know: treated as a write.
      wrapped[name] = async (...args: unknown[]) => {
        drop();
        try {
          return await call(...args);
        } finally {
          drop();
        }
      };
    }
  }
  return {
    api: wrapped as unknown as ProjectGroupsApi,
    scope: async (run) => {
      depth++;
      try {
        return await run();
      } finally {
        depth--;
        if (depth === 0) drop();
      }
    }
  };
}
