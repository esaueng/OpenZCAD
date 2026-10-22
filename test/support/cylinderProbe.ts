/** Read the synchronous viewport hook without waiting for an absent listener. */
export function readCylinderCapX(element: EventTarget): number | null {
  let capX: number | null = null;
  element.dispatchEvent(
    new CustomEvent('openzcad:e2e-select-cylinder', {
      detail: {
        surface: 'wall',
        select: false,
        resolve: (
          geometry: {
            axisStart?: { x: number };
            axisEnd?: { x: number };
          } | null
        ) => {
          capX =
            geometry?.axisStart && geometry.axisEnd
              ? Math.max(geometry.axisStart.x, geometry.axisEnd.x)
              : null;
        }
      }
    })
  );
  // A canvas can appear before its hook is registered after reload. Returning
  // null lets expect.poll retry; an unresolved Promise stalls the whole test.
  return capX;
}
