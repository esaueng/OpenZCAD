# U05-V1: seven standard-view commands

This bounded slice extends the existing number-key convention without changing
project data or camera construction. `ROADMAP.md` remains the delivery ledger.

| View      | Default key |
| --------- | ----------- |
| Front     | 1           |
| Top       | 2           |
| Right     | 3           |
| Isometric | 4           |
| Back      | 5           |
| Bottom    | 6           |
| Left      | 7           |

Acceptance:

- Each key and its named command-palette action reaches the canonical camera
  direction already used by the orientation cube.
- Existing 1–4 bindings and view names remain. View commands stay inactive in
  sketch text entry and use the existing modeling/view context contract.
- Settings can remap each command. The palette, Controls reference and both
  standard-view flyouts show the live key; reload retains a saved remap.
- A newly added default yields to an explicit saved binding in any overlapping
  context. In particular, an existing grid-on-5 or Extrude-on-6 remap retains
  its action; the conflicting view shows no assigned key. Disjoint sketch
  contexts can continue sharing a key.
- No document commands, schema changes, new dependencies or camera algorithm
  changes are introduced.

The broader U05 hotkey coverage, hotkey/search preference, modifier-number
convention, hover actions, search behavior and marking-menu work remain outside
this slice. The bare defaults follow the existing 1–4 convention; this slice
makes no new promise about browser-reserved modifier-number chords.

Evidence: `apps/web/src/lib/keymap.test.ts`,
`apps/web/src/components/KeymapEditor.test.tsx`,
`apps/web/src/components/StandardViews.test.tsx`,
`test/control-reference.test.ts` and
`test/e2e/standard-view-shortcuts.spec.ts`. Browser assertions read the live
camera after keyboard/palette actions and cover remapping, reload and a
previously saved conflicting shortcut.
