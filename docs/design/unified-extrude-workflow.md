# Unified Extrude workflow

## First modeling milestone

A user selects a bracket profile, previews its extrusion, chooses how it affects
the part, confirms it, and revises the same feature later. Toolbar, keyboard,
sketch toolbar, and selected-region entry converge on the same creation editor.

## Interaction contract

- Show the source sketch and number of selected profiles. Keep profile identity
  separate from disposable preview bodies; changing a source sketch requires
  deliberate profile reselection.
- Use the same Operation, Target body, Distance, Reverse direction, Symmetric,
  and Back distance controls for creation and history editing.
- Creation defaults to Automatic, preserving existing exact overlap inference.
  New Body, Add, and Cut are explicit overrides. Add/Cut require a target;
  choose it automatically only when there is a single eligible body.
- Dragging previews geometry. Releasing a new extrusion updates the editor's
  distance; Create or Enter commits one undoable feature. Cancel or Escape
  dismisses the draft. The optional numeric keypad's Apply is also explicit
  confirmation. Existing face-edit gestures retain their established behavior.
- Expressions remain expressions. Reversing an expression negates it rather
  than replacing it with its evaluated number. Symmetry uses total distance;
  Back distance is nonnegative and inactive while symmetry is enabled.
- Editing history preserves the stored operation unless the user changes it.
  New Body clears its former target dependency. Eligible targets must exist
  at the edited feature's history position; self and downstream targets are
  unavailable.
- Preview documents do not enter autosave or undo history. Exact validation
  checks the edited feature and affected downstream results before commit.
  Refusal preserves the committed model and the entered draft. Cancelled or
  superseded work cannot publish a late commit.

## Acceptance workflow

Use a mounting plate with two circular profiles. Preview and cancel a Cut;
create it through the shared form; change the existing extrusion to New Body;
undo, redo, and reopen; change it back to Cut. Verify exact volume, profile
references, target identity, and one history entry. A held region drag must
produce a preview before release, and release alone must not create history.

## Scope

This milestone reuses the existing document schema and browser worker kernel.
It does not add Through All/Up to Face extents, change sketch constraints, or
extend topology-lineage coverage. Those remain subsequent modeling work.
