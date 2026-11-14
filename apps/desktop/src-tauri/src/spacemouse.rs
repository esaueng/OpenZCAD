use serde::Serialize;
use std::{
    ffi::c_void,
    ptr::NonNull,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, EventTarget};

const EVENT: &str = "openzcad://spacemouse";
// Send unchanged held motion as a heartbeat. Neutral reports are only needed
// on transition, so a device streaming zeros cannot wake an idle viewport.
const HEARTBEAT: Duration = Duration::from_millis(40);

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum Report {
    Translation([i16; 3]),
    Rotation([i16; 3]),
    Buttons(u32),
    Disconnected,
}

fn decode(bytes: [u8; 7]) -> Option<Report> {
    let [id, a, b, c, d, e, f] = bytes;
    match id {
        1 | 2 => {
            let axes = [
                i16::from_le_bytes([a, b]),
                i16::from_le_bytes([c, d]),
                i16::from_le_bytes([e, f]),
            ];
            Some(if id == 1 {
                Report::Translation(axes)
            } else {
                Report::Rotation(axes)
            })
        }
        3 => Some(Report::Buttons(
            u32::from_le_bytes([a, b, c, d]) & 0x07c0_f137,
        )),
        _ => None,
    }
}

#[derive(Default)]
struct Stream {
    last: Option<(Report, Instant)>,
}

impl Stream {
    fn changed_or_held(&mut self, report: Report, neutral: Report, now: Instant) -> bool {
        match self.last {
            None if report == neutral => return false,
            Some((previous, at))
                if previous == report
                    && (report == neutral || now.duration_since(at) < HEARTBEAT) =>
            {
                return false;
            }
            _ => {}
        }
        self.last = Some((report, now));
        true
    }
}

struct Reader {
    app: AppHandle,
    translation: Stream,
    rotation: Stream,
}

extern "C" {
    fn openzcad_spacemouse_start(
        callback: extern "C" fn(*mut c_void, *const u8, usize),
        context: *mut c_void,
    ) -> *mut c_void;
    fn openzcad_spacemouse_stop(handle: *mut c_void);
}

pub struct SpaceMouse {
    handle: NonNull<c_void>,
    context: *mut Reader,
}

impl SpaceMouse {
    pub fn start(app: AppHandle) -> Option<Self> {
        let context = Box::into_raw(Box::new(Reader {
            app,
            translation: Stream::default(),
            rotation: Stream::default(),
        }));
        // Tauri calls Ready and Exit on the main run loop, which owns the C
        // reader and serializes its callbacks with teardown.
        let handle = unsafe { openzcad_spacemouse_start(receive, context.cast()) };
        if let Some(handle) = NonNull::new(handle) {
            Some(Self { handle, context })
        } else {
            unsafe { drop(Box::from_raw(context)) };
            None
        }
    }
}

impl Drop for SpaceMouse {
    fn drop(&mut self) {
        unsafe {
            openzcad_spacemouse_stop(self.handle.as_ptr());
            drop(Box::from_raw(self.context));
        }
    }
}

extern "C" fn receive(context: *mut c_void, bytes: *const u8, length: usize) {
    let reader = unsafe { &mut *context.cast::<Reader>() };
    let report = match length {
        0 => {
            reader.translation = Stream::default();
            reader.rotation = Stream::default();
            Report::Disconnected
        }
        7 => {
            // The HID report buffer lives for this callback only.
            let Some(report) = decode(unsafe { bytes.cast::<[u8; 7]>().read() }) else {
                return;
            };
            report
        }
        _ => return,
    };
    let now = Instant::now();
    let send = match report {
        Report::Translation(_) => {
            reader
                .translation
                .changed_or_held(report, Report::Translation([0; 3]), now)
        }
        Report::Rotation(_) => {
            reader
                .rotation
                .changed_or_held(report, Report::Rotation([0; 3]), now)
        }
        _ => true,
    };
    if send {
        let _ = reader
            .app
            .emit_to(EventTarget::labeled("main"), EVENT, report);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_live_space_mouse_wire_format() {
        assert_eq!(
            decode([1, 0xc9, 0xff, 0, 0, 0x6c, 0]),
            Some(Report::Translation([-55, 0, 108]))
        );
        assert_eq!(
            decode([2, 0x15, 0, 0x0d, 0, 0, 0]),
            Some(Report::Rotation([21, 13, 0]))
        );
        assert_eq!(
            decode([3, 0x14, 1, 0, 4, 0, 0]),
            Some(Report::Buttons(0x0400_0114))
        );
        assert_eq!(
            decode([3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
            Some(Report::Buttons(0x07c0_f137))
        );
        assert_eq!(decode([4, 0, 0, 0, 0, 0, 0]), None);
    }

    #[test]
    fn suppresses_idle_zero_with_heartbeats_and_immediate_release() {
        let now = Instant::now();
        let held = Report::Translation([100, 0, 0]);
        let neutral = Report::Translation([0; 3]);
        let mut stream = Stream::default();
        assert!(!stream.changed_or_held(neutral, neutral, now));
        assert!(stream.changed_or_held(held, neutral, now));
        assert!(!stream.changed_or_held(held, neutral, now + Duration::from_millis(1)));
        assert!(stream.changed_or_held(held, neutral, now + HEARTBEAT));
        assert!(stream.changed_or_held(neutral, neutral, now + HEARTBEAT));
        assert!(!stream.changed_or_held(neutral, neutral, now + HEARTBEAT * 2));
    }
}
