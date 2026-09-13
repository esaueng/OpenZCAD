# On/off body parameters

In Build, choose **On/off toggle** under Parameters, enter a name such as
`show_text`, select the separate bodies it controls, and add it. One switch can
control several bodies. Expand **Bodies** below an existing switch to change
its bindings. Expose it with the eye beside the parameter to offer it in Tweak
and share links.

On/off parameters use `1` for on and `0` for off. They can also be used in
numeric expressions. A toggle with no body bindings is a general boolean
control. Each body can belong to one toggle. Configuration is a Build command;
Tweak can only change the existing scalar value. Parameter rename, undo/redo,
backup, and collaboration retain bindings by stable body ID.

Off bodies disappear from the viewport and STEP/mesh exports. The exact export
adapter enforces this even if a caller passes stale body IDs. The local body eye
and isolate settings for unbound bodies keep their existing view-only behavior.
Bodies remain in the exact history: switching an operand off does not undo a
union, subtraction, or other feature that already consumed it. Select separate
result bodies when creating the switch.

Schema v15 adds optional `ParameterNode.toggle.bodyIds`. Older projects keep
numeric parameters unchanged; applications predating schema v15 must update
before opening a new backup. No server database migration is needed.

## Lettering on a growing holder

The existing recognized-height recipe can grow a gap between letters when text
is fused into the imported STEP. A visibility switch cannot separate that
geometry. A prepared model can instead retain the plain holder and import all
lettering as one exact body with several solids. Translate that entire body
with the arm's width shift and a height expression, such as half the height
change to keep the word centered. This preserves every character and their
spacing. Keep it separate from the holder to make `show_text` effective.

The supplied private holder was prepared and verified separately: a flat
support face closes the original emboss footprints while the seven original
cap profiles produce the exact lettering solids. Whole-word translation was
checked at 58, 65, and 72 mm, with valid STEP round-trips for on (holder plus
seven letters) and off (holder alone). Private geometry and generated backups
are not repository fixtures. This preparation does not add automatic text
recognition or separation to the app. STEP/mesh export retains the lettering
as separate touching solids, suitable for a multi-body workflow.

Regression coverage: `test/body-visibility-parameter.test.ts`,
`test/body-visibility-export.test.ts`, `ParameterRows.test.tsx`, and
`test/e2e/body-visibility-parameter.spec.ts` cover bindings, replay, undo/reopen,
rigid placement, export enforcement, and Build/Tweak interactions.
