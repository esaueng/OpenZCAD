# Interaction design

What the viewport's interaction is tuned to, and the constraints that keep it
that way. Written so a new feature inherits the feel instead of re-deriving
it. Measurements behind these choices are in `docs/performance-baseline.md`.

## Motion

One vocabulary, defined twice because the two layers cannot share a
mechanism, and kept in step by matching values:

| | Chrome (CSS) | Scene (TypeScript) |
| --- | --- | --- |
| Fast — hover, handles, cursor states | `--dur-fast` 100 ms | `DUR_FAST_MS` |
| Base — selection, panels | `--dur-base` 200 ms | `DUR_BASE_MS` |
| Slow — largest state changes | `--dur-slow` 350 ms | `DUR_SLOW_MS` |
| Curve | `--ease-out` `cubic-bezier(0.16, 1, 0.3, 1)` | `easeToward`, τ = 60 ms |

`packages/viewport/src/motion.ts` is the scene's half. It eases per rendered
frame rather than over a fixed duration, which is why it is exponential: the
same gesture settles in the same wall-clock time at 60 Hz and at 120 Hz, a
dropped frame does not leave a value behind, and retargeting mid-ramp needs no
bookkeeping. Anything that reaches its target within `SETTLE_EPSILON` snaps
and stops being stepped, which is also what lets the render loop go back to
sleep.

Camera motion is separate and older: view changes tween over 170–520 ms scaled
by travel (`camera/views.ts`), and orbit uses two damping regimes — tight
while the pointer is down, a short glide on release, bounded in wall-clock so
a slow device cannot stretch it into a coast.

### Rules

- **Arriving and leaving are symmetric.** Anything that fades in fades out.
  A highlight that vanishes in one frame reads as cheap however good its
  entrance was.
- **Never animate what positions something.** A chip's `transform` tracks a
  moving anchor; easing it drags the chip behind its handle. Ease colour,
  opacity, and elevation instead. The same rule is why an overlay's entrance
  is opacity-only.
- **Never animate a hit target.** Scaling a handle in also scales its hit
  mesh, so for the length of the animation the grab area is smaller than it
  looks and a press can miss. This shipped once and was caught by two E2E
  specs; it would have read as "the handle sometimes ignores me".
- **Respect reduced motion.** The camera reads it per call; scene fades snap
  when it is set. A new eased surface must do the same.

## Input

- **Hover is coalesced into the render loop**, one pick per frame. Drags are
  coalesced too, except the first move after a frame, which applies
  immediately — deferring every move adds latency to the unhurried hand that
  never had a problem, and under load that latency is long enough to change
  what a gesture did before anything reads it.
- **Some things must see every raw event**: threshold tracking that decides
  click-versus-drag, and `preventDefault`, which only works during dispatch.
- **A drag position is absolute, not path-integrated.** The newest event is
  the only one carrying information, which is what makes coalescing safe.
- **Wheel intent is classified, not assumed** (`input/wheelGesture.ts`): a
  pinch sets `ctrlKey` and always zooms; line and page deltas come only from a
  wheel; a horizontal component and sub-notch pixel deltas come from a
  trackpad. Settings › Viewport › **Scroll wheel** forces a device's meaning
  for hardware the heuristic reads wrongly; `auto` is the default and
  classifies each event on its own.
- **Click threshold is 5 px**, centralised in `GestureRouter` along with
  pointer capture.

## The React boundary

The viewport owns per-frame values imperatively; React owns gesture
*lifecycle*. A drag publishes into a sink the panel provides and tells the
workspace once, when it settles — from the values the drag produced, not from
whatever the last render saw. Every path that can end a drag has to publish,
or a commit applies the pose from before the gesture.

This matters because there are no memoised components between `App` and the
viewport: a `setState` during a gesture re-renders the entire editor. The
acceptance signal is the probe's `reactCommits`, and the target is a handful
per gesture rather than one per pointer event.

Props the viewport installs scene objects from — body lists, sketch overlays,
selected profile ids — must be memoised. An inline `[]` is new every render,
and the viewport reads a new array as new content to install.

## Budgets

From the headed baseline on an M5 Pro at 120 Hz: orbit 8.3 ms p50, hover
8.4 ms, preview drag 8.4 ms with a 25 ms p95. Treat 8.3 ms p50 as the target
and a p95 above one frame as a regression worth explaining.

Two traps that have each cost an investigation:

- `frameTimeMs` is the **interval between rendered frames**, not the cost of
  one. In an on-demand renderer, removing a redundant invalidation raises it.
  Read `frames` against `pointerMoves` first: one frame per move means the
  harness set the pace, not the app.
- **Headless numbers are not feel.** SwiftShader put a 500 ms p95 on a drag
  that holds 25 ms on a real GPU. Draw calls, triangles, React commits and
  drag applications are hardware-independent; frame times are not.

## What is deliberately not optimised

Picking has no BVH, sketch drawing reallocates its preview geometry per
pointer move, and move-drag snap candidates are gathered on pointerdown. All
three are real waste with no measured symptom on target hardware. They are
listed in `docs/plans/interaction-feel-refinement-plan-2026-08-12.md` with
that caveat, so the case for doing them stays a case rather than an
assumption.
