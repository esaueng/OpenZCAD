import type { CollaborationStatus } from './useCollaboration';

/**
 * Every room status as words, so no raw identifier ever reaches the top bar
 * or the sharing popover.
 */
export const COLLABORATION_LABELS: Record<CollaborationStatus, string> = {
  connecting: 'Joining…',
  live: 'Live',
  offline: 'Offline',
  conflict: 'Conflict',
  oversize: 'Local only',
  rejected: 'Not shared',
  'read-only': 'Read-only',
  'lease-denied': 'Edit locked',
  'update-required': 'Update required'
};
