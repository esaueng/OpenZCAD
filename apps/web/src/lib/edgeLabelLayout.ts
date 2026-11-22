/** A screen rectangle in canvas pixels. */
export interface LabelObstacle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface EdgeLabelLayoutInput {
  /** Where the arrow's middle projects. */
  pin: { x: number; y: number };
  /** Unit screen direction the arrow points, out of the material. */
  along: { x: number; y: number };
  /** Pixels from the pin to just past the arrow's outer head. */
  reach: number;
  /** The pill's upright size; it is drawn rotated to lie along `along`. */
  size: { width: number; height: number };
  /** Air between the arrow head and the pill. */
  gap: number;
  /** Room the pill keeps from the stage's left and top edges. */
  margin: number;
  /** The furthest right and down the pill may reach (lanes, stage edge). */
  right: number;
  bottom: number;
  /** Panels and drawers the pill must not lie under. */
  obstacles: readonly LabelObstacle[];
}

/**
 * Where a fillet or chamfer drag's tilted value pill stands, in canvas
 * pixels. It goes out past the arrow along its leader; where that has no
 * room it lies back along the leader on the arrow's other side. Null where
 * neither side has room (a corner of the stage, a panel across the arrow):
 * the viewer then keeps the label upright beside the arrow, since a pill
 * forced into the stage there would leave its leader. Pure.
 */
export function edgeLabelPlacement(input: EdgeLabelLayoutInput): {
  x: number;
  y: number;
  side: 'out' | 'back';
} | null {
  const { pin, along, size, margin, right, bottom } = input;
  const out = input.reach + input.gap + size.width / 2;
  // The rotated pill's half extents on screen.
  const halfLength = size.width / 2;
  const halfThickness = size.height / 2;
  const extentX =
    Math.abs(along.x) * halfLength + Math.abs(along.y) * halfThickness;
  const extentY =
    Math.abs(along.y) * halfLength + Math.abs(along.x) * halfThickness;
  const fits = (x: number, y: number) =>
    x - extentX >= margin &&
    x + extentX <= right &&
    y - extentY >= margin &&
    y + extentY <= bottom &&
    input.obstacles.every(
      (panel) =>
        x + extentX <= panel.left ||
        x - extentX >= panel.right ||
        y + extentY <= panel.top ||
        y - extentY >= panel.bottom
    );
  const outward = { x: pin.x + along.x * out, y: pin.y + along.y * out };
  if (fits(outward.x, outward.y)) return { ...outward, side: 'out' };
  const back = { x: pin.x - along.x * out, y: pin.y - along.y * out };
  if (fits(back.x, back.y)) return { ...back, side: 'back' };
  return null;
}
