/**
 * Co-members' device lists for a shared encrypted project (ADR-024 Phase 5):
 * slice 5-2's `ProjectGroupContext.members`, supplied by slice 5-1's
 * contacts module.
 *
 * Whose lists: every other account that holds a leaf in the project's leaf
 * registry. The MLS directory refuses a leaf of an account whose list it is
 * not given, and an archive or version must come from a device holding a
 * leaf, so those are exactly the lists the directory and authorship checks
 * need. A solo project (no other account's leaf) asks nothing more of the
 * server.
 *
 * Trust level: each list comes from `inspectContact`, so it verifies as an
 * identity-signed hash chain and must extend both the head the user's
 * signed contacts list pinned (a verified contact) and the newest head this
 * browser accepted (a seen one); a rollback or fork is refused (`fork`)
 * and nothing is read. Verified and seen (unverified, key-changed or
 * untrusted) contacts' lists are all inputs: MLS authority still checks
 * that every leaf is certified by a device of the list and holds a role in
 * the epoch, and seen standing only means the user has not compared the
 * contact's code. What a seen list cannot do is take a project key wrap:
 * that stays `verifiedEncryptionKey`'s, for verified contacts only.
 *
 * A co-member the server will not look up (404: no shared project or
 * invitation any more) or who has no keys gets no list; the directory then
 * refuses their leaves visibly instead of dropping them.
 */
import type { VerifiedDeviceList } from '@openzcad/crypto';
import type { E2eeProjectLeavesResponse } from '@openzcad/shared';
import type { AccountView } from './accountKeys';
import {
  inspectContact,
  loadContacts,
  type ContactsContext,
  type ContactView
} from './contacts';
import { E2eeApiError } from './e2eeApi';
import type { ProjectMemberLists } from './projectGroups';

export interface ContactMemberListsOptions {
  readonly contacts: ContactsContext;
  /** The account the directory reads for; its own list is never looked up. */
  readonly account: Pick<AccountView, 'userId' | 'generation' | 'list'>;
  /** The project's leaf registry (`ProjectGroupsApi.leaves`). */
  readonly leaves: (projectId: string) => Promise<E2eeProjectLeavesResponse>;
  /** Every contact as inspected, for callers that show trust levels. */
  readonly onInspected?: (
    projectId: string,
    views: readonly ContactView[]
  ) => void;
}

/** `ProjectGroupContext.members` from the contacts module (5-1 into 5-2). */
export function contactMemberLists(
  options: ContactMemberListsOptions
): ProjectMemberLists {
  const own = options.account.userId;
  return {
    async lists(
      projectId: string,
      historicalUsers: readonly string[] = []
    ): Promise<readonly VerifiedDeviceList[]> {
      const { leaves } = await options.leaves(projectId);
      const others = [
        ...new Set(
          [...leaves.map((leaf) => leaf.userId), ...historicalUsers].filter(
            (userId) => userId !== own
          )
        )
      ].sort();
      if (others.length === 0) return [];
      const book = await loadContacts(
        options.contacts,
        options.account as AccountView
      );
      const views: ContactView[] = [];
      const lists: VerifiedDeviceList[] = [];
      for (const userId of others) {
        let view: ContactView;
        try {
          view = await inspectContact(options.contacts, book, userId);
        } catch (error) {
          // No longer related (M2): the directory refuses their leaves.
          if (error instanceof E2eeApiError && error.status === 404) continue;
          throw error;
        }
        views.push(view);
        if (view.list) lists.push(view.list);
      }
      options.onInspected?.(projectId, views);
      return lists;
    }
  };
}
