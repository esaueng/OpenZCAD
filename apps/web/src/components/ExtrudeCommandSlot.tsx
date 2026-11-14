import {
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject
} from 'react';
import type { ParamValue } from '@openzcad/shared';
import type * as ExtrudeCommandModule from './ExtrudeCommand';
import { preloadableSlot, type PreloadableSlot } from './PreloadableSlot';
import { WorkspacePending } from './WorkspaceLoading';

type ExtrudeCommandProps = ComponentProps<
  typeof ExtrudeCommandModule.ExtrudeCommand
>;
type DistanceSetter = (value: ParamValue) => void;

/**
 * The in-place Extrude bar, its own chunk loaded by `load`, behind its own
 * error boundary (see `preloadableSlot`).
 *
 * The region's arrow is drawn by the viewer, not the bar, so it can be
 * dragged before a cold chunk has arrived (Save-Data skips the warm-up, and a
 * selection can beat it). The arrow sets the distance through
 * `distanceSetterRef`, which this slot owns from the moment it mounts: until
 * the bar is there, the last distance set is held, and it is handed to the
 * bar as soon as the bar takes its setter. Without that, a completed drag
 * went to a null setter and the bar opened at its initial distance of 0 with
 * Done unavailable.
 */
export function extrudeCommandSlot(
  load: () => Promise<typeof ExtrudeCommandModule> = () =>
    import('./ExtrudeCommand')
): PreloadableSlot<ExtrudeCommandProps> {
  const Bar = preloadableSlot(
    'Extrude',
    () => load().then((module) => ({ default: module.ExtrudeCommand })),
    { pending: <WorkspacePending /> }
  );
  const ExtrudeCommandSlot = (({
    distanceSetterRef,
    ...props
  }: ExtrudeCommandProps) => {
    const held = useRef<ParamValue | null>(null);
    const barSetter = useRef<DistanceSetter | null>(null);
    // The ref the bar fills with its own setter as it mounts; filling it
    // replays a distance set while the bar was still loading.
    const [barSetterRef] = useState<MutableRefObject<DistanceSetter | null>>(
      () => ({
        get current() {
          return barSetter.current;
        },
        set current(setter) {
          barSetter.current = setter;
          const value = held.current;
          if (setter && value !== null) {
            held.current = null;
            setter(value);
          }
        }
      })
    );
    useLayoutEffect(() => {
      distanceSetterRef.current = (value) => {
        if (barSetter.current) barSetter.current(value);
        else held.current = value;
      };
      return () => {
        distanceSetterRef.current = null;
      };
    }, [distanceSetterRef]);
    return <Bar {...props} distanceSetterRef={barSetterRef} />;
  }) as PreloadableSlot<ExtrudeCommandProps>;
  ExtrudeCommandSlot.preload = () => Bar.preload();
  ExtrudeCommandSlot.isLoaded = () => Bar.isLoaded();
  return ExtrudeCommandSlot;
}
