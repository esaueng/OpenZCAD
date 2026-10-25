import { toUserId, type ProjectDocument } from '@openzcad/shared';
import { withoutDerivedProjection } from './document-projection';

/** The owner a share-link visitor sees in place of the real account id. */
const SHARED_PROJECT_OWNER_USER_ID = toUserId('user_shared');

/**
 * What an anonymous share link serves: the owner's current model and nothing
 * about how it got there.
 *
 * The stored document also carries its own past. `editHistory` holds the
 * before/after values of recent edits, `commandLog` the payload of every
 * command ever run, `revisions`/`checkpoints` the owner's save-state names and
 * `branchedFrom` another project's name — so a feature deleted before sharing
 * reached the visitor with its name and dimensions, and one Undo in the
 * visitor's tab put it back. Rebuilding and tweaking need none of it: a
 * CommandManager over this document starts the visitor's own undo history
 * from the model as shared. The owner id goes too; it is derived from the
 * owner's email.
 *
 * It lives here, not in `@openzcad/persistence`, so an editor's browser
 * builds the same projection when it republishes an encrypted share
 * snapshot (ADR-024) as the Worker serves for a plaintext link.
 */
export function sharedProjectSnapshotDocument(
  document: ProjectDocument
): ProjectDocument {
  // Drawing sheets stay with the owner: their title blocks carry author,
  // date and drawing-number text, and a share link opens no Draw workspace.
  // Objects folders (U06) are shared: they only organize bodies whose names
  // the visitor already sees, and carry no author, date or history.
  // Reference images stay with the owner too: a share link serves import
  // sources only, never their tracing pictures.
  const {
    editHistory: _editHistory,
    branchedFrom: _branchedFrom,
    drawings: _drawings,
    referenceImages: _referenceImages,
    ...current
  } = withoutDerivedProjection(document);
  return {
    ...current,
    ownerUserId: SHARED_PROJECT_OWNER_USER_ID,
    revisions: [],
    checkpoints: [],
    commandLog: []
  };
}
