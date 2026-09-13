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

Import a normal STEP, open the assistant, and choose **Parameterize holder and
text** when offered. You can also ask the AI for editable opening/height,
`show_text`, and intact lettering. The kernel verifies constant-depth raised
profiles on one planar arm face, and the AI copies that measurement into its
proposal. Exact preflight must pass before Apply.

The resulting history retains the original STEP bytes. Each imported source
records a measured `planarEmboss` selection that is re-verified during rebuild:
the holder uses the plain support and a separate Text body contains every
raised profile. It follows the arm's width shift and half the height change.
The viewport preview translates the whole word by the same expression while
the exact result rebuilds. Character spacing never changes.

The native v3 arena proof checks connected face groups, straight side surfaces,
uniform positive depth, unique cap fingerprints, manifold topology, and strict
validity of the resulting solids. It preserves letter holes and refuses
unverified/ambiguous groups. This is a bounded geometry recognizer, not OCR;
engraving or lettering on curved faces remains unsupported. STEP/mesh export
retains the lettering as separate touching solids.

The original private STEP was tested directly at 58, 65, and 72 mm, including
exact STEP round-trips with text on/off. Public regression fixtures use
independently constructed CAD profiles; private source bytes stay out of Git.

Regression coverage: `test/body-visibility-parameter.test.ts`,
`test/body-visibility-export.test.ts`, `ParameterRows.test.tsx`, and
`test/e2e/body-visibility-parameter.spec.ts` cover bindings, replay, undo/reopen,
rigid placement, export enforcement, and Build/Tweak interactions.
`planar-emboss.test.ts`, `growing-holder-lettering.test.ts`, and
`test/e2e/ai-holder-lettering.spec.ts` cover the normal STEP-to-assistant path,
source preservation, exact grouped movement, preview, refusal cases, and
undo/reopen.
