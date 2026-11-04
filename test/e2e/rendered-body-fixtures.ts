import type { Locator } from '@playwright/test';

/** Minimum world Y of the viewer's visible body meshes. */
export function renderedMinimumY(canvas: Locator): Promise<number> {
  return canvas.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        element.dispatchEvent(
          new CustomEvent('openzcad:e2e-render-policy', {
            detail: {
              resolve: (state: {
                bodyFaces: {
                  visible: boolean;
                  worldBounds?: { min: number[] };
                }[];
              }) =>
                resolve(
                  Math.min(
                    ...state.bodyFaces
                      .filter((face) => face.visible && face.worldBounds)
                      .map((face) => face.worldBounds!.min[1]!)
                  )
                )
            }
          })
        );
      })
  );
}
