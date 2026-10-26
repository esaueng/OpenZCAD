---
row: U09
---

Axes and directions are picked in the model, as the plan's §5 table has
them. Revolve, Rotate about axis and Circular pattern take a straight edge
or a cylinder's (or cone's) axis besides the listed lines, and Rotate about
axis now lists X, Y and Z too (Revolve a world axis in its sketch plane that
is not its own); the stored features only turn about datum axes, so Done
adds the picked line as a datum axis in the same undoable step, just
before the feature (an edit moves it before the edited one), and the turn
follows its source. A revolve refuses a line off its profile's plane before
the build would. A linear pattern reads a straight edge, a flat face's
normal or a datum axis as its repeat direction (stored as its numbers, a
world axis when it is one). Circular pattern adds Equal spacing / Fixed
step under Options, a fixed step storing the total its copies span. Not
expressible without schema work, so left out: a two-sided revolve (its
angle runs one way from the profile, (0°, 360°]) and a sweep along model
edges (its path is sketch curves only) (`tools.test.ts`,
`datumPicks.test.ts`, `useInPlaceCommand.test.tsx`,
`in-place-axis-picks.spec.ts`, `datum-axes.spec.ts`).
