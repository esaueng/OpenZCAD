/**
 * Why an encrypted project offers no comments yet. It lives apart from
 * `projectCommentsApi` so the workspace can explain the refusal without
 * carrying the comment client, which loads when the panel first needs it.
 */
export const ENCRYPTED_COMMENTS_UNAVAILABLE =
  'Comments are not available on encrypted projects yet.';
