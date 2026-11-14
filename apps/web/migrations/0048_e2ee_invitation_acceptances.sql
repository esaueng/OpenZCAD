-- The invitee's signed acceptance of an invitation to an encrypted project
-- ("OZJ", @openzcad/crypto): a certified device of the accepting account
-- signs the invitation (by its statement's hash), that account and its
-- identity, and the email hash the invitation names. The Worker checks it
-- against the newest stored device list and keeps the newest one here; the
-- owner's browser checks it again against its own pins before an Add, and
-- adds nobody without one. Base64url text, NULL until one is posted.

ALTER TABLE e2ee_invitations ADD COLUMN acceptance_statement TEXT;
ALTER TABLE e2ee_invitations ADD COLUMN acceptance_signature TEXT;
