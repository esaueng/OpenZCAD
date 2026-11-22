use serde::Serialize;
use std::{
    cell::RefCell,
    ffi::{c_int, c_void},
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

const EVENT: &str = "openzcad://spacemouse";
// Send unchanged held motion as a heartbeat. Neutral reports are only needed
// on transition, so a device streaming zeros cannot wake an idle viewport.
const HEARTBEAT: Duration = Duration::from_millis(40);

#[derive(Clone, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
enum Report {
    Input([u8; 7]),
    Reset,
    Error(String),
}

#[derive(Default)]
struct Stream {
    last: Option<([u8; 7], Instant)>,
}

impl Stream {
    fn changed_or_held(&mut self, report: [u8; 7], now: Instant) -> bool {
        let neutral = report[1..].iter().all(|&byte| byte == 0);
        match self.last {
            None if neutral => return false,
            Some((previous, at))
                if previous == report && (neutral || now.duration_since(at) < HEARTBEAT) =>
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
    id: u64,
    translation: Stream,
    rotation: Stream,
    /// The device was removed; this reader can no longer capture anything.
    lost: bool,
}

// Names each reader, so deferred teardown after an unplug ends only the
// reader that lost its device, never a later connection.
static NEXT_READER: AtomicU64 = AtomicU64::new(0);

extern "C" {
    fn openzcad_spacemouse_start(
        callback: extern "C" fn(*mut c_void, *const u8, usize),
        context: *mut c_void,
        status: *mut c_int,
    ) -> *mut c_void;
    fn openzcad_spacemouse_stop(handle: *mut c_void);
}

const ABSENT: c_int = 2;

struct SpaceMouse {
    handle: NonNull<c_void>,
    context: *mut Reader,
    id: u64,
}

impl SpaceMouse {
    fn start(app: AppHandle) -> Result<Self, String> {
        let id = NEXT_READER.fetch_add(1, Ordering::Relaxed);
        let context = Box::into_raw(Box::new(Reader {
            app,
            id,
            translation: Stream::default(),
            rotation: Stream::default(),
            lost: false,
        }));
        // Tauri calls Ready and Exit on the main run loop, which owns the C
        // reader and serializes its callbacks with teardown.
        let mut status: c_int = 0;
        let handle = unsafe { openzcad_spacemouse_start(receive, context.cast(), &mut status) };
        if let Some(handle) = NonNull::new(handle) {
            Ok(Self {
                handle,
                context,
                id,
            })
        } else {
            unsafe { drop(Box::from_raw(context)) };
            Err(if status == ABSENT {
                "Plug in the wired SpaceMouse Pro, then connect it again.".into()
            } else {
                "Could not capture the wired SpaceMouse Pro.".into()
            })
        }
    }
}

impl SpaceMouse {
    fn lost(&self) -> bool {
        // The C callbacks and this check both run on the main run loop.
        unsafe { (*self.context).lost }
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

fn emit(app: &AppHandle, report: Report) {
    let _ = app.emit_to(EventTarget::labeled("main"), EVENT, report);
}

extern "C" fn receive(context: *mut c_void, bytes: *const u8, length: usize) {
    let reader = unsafe { &mut *context.cast::<Reader>() };
    if length == 0 {
        // The captured device went away: stop held motion, end the capture
        // and tell Settings. Disable now so a focus change cannot recapture
        // for a page that shows the error. A later Connect replaces this
        // reader (see Capture::update). Freeing it here would free it under
        // its own IOHID callback, and run_on_main_thread runs synchronously
        // on the main thread, so post its teardown from another thread to a
        // later turn of the main loop. The teardown ends only this reader.
        reader.lost = true;
        reader.translation = Stream::default();
        reader.rotation = Stream::default();
        CAPTURE.with(|capture| {
            if let Ok(mut capture) = capture.try_borrow_mut() {
                capture.enabled = false;
            }
        });
        emit(&reader.app, Report::Reset);
        emit(
            &reader.app,
            Report::Error("The wired SpaceMouse Pro was disconnected.".into()),
        );
        let app = reader.app.clone();
        let id = reader.id;
        tauri::async_runtime::spawn(async move {
            let _ = app.run_on_main_thread(move || release_lost(id));
        });
    } else if (2..=7).contains(&length) {
        // C validates the report ID and owns the buffer for this callback.
        // Short button bitmaps represent zero for the missing high bits.
        let bytes = unsafe { std::slice::from_raw_parts(bytes, length) };
        let mut report = [0; 7];
        report[..length].copy_from_slice(bytes);
        let now = Instant::now();
        let send = match report[0] {
            1 => reader.translation.changed_or_held(report, now),
            2 => reader.rotation.changed_or_held(report, now),
            3 => true,
            _ => false,
        };
        if send {
            emit(&reader.app, Report::Input(report));
        }
    }
}

#[derive(Default)]
struct Capture {
    enabled: bool,
    reader: Option<SpaceMouse>,
}

impl Capture {
    fn update(&mut self, app: &AppHandle, focused: bool) -> Result<(), String> {
        if self.enabled && focused {
            if self.reader.as_ref().is_some_and(SpaceMouse::lost) {
                // Replace a reader whose device was unplugged; reusing it
                // would report success with nothing captured.
                self.reader = None;
            }
            if self.reader.is_none() {
                self.reader = Some(SpaceMouse::start(app.clone())?);
            }
        } else if let Some(reader) = self.reader.take() {
            drop(reader);
            emit(app, Report::Reset);
        }
        Ok(())
    }
}

// Counts the main webview's page loads. It is bumped synchronously when a load
// starts, so a Connect sent by the page being replaced cannot capture the
// device after that page's teardown released it.
static PAGE: AtomicU64 = AtomicU64::new(0);

pub fn page_started() {
    PAGE.fetch_add(1, Ordering::SeqCst);
}

pub fn page() -> u64 {
    PAGE.load(Ordering::SeqCst)
}

fn stale_enable(enabled: bool, page: u64, current: u64) -> bool {
    enabled && page != current
}

// IOHID and its callback state belong to the main run loop.
thread_local! {
    static CAPTURE: RefCell<Capture> = RefCell::new(Capture::default());
}

pub async fn set_enabled(
    window: tauri::WebviewWindow,
    enabled: bool,
    page: u64,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window can capture the SpaceMouse.".into());
    }
    let app = window.app_handle().clone();
    let (send, done) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        if stale_enable(enabled, page, PAGE.load(Ordering::SeqCst)) {
            let _ = send.send(Err(
                "The page reloaded before the SpaceMouse connected.".into()
            ));
            return;
        }
        let result = CAPTURE.with(|capture| {
            let mut capture = capture.borrow_mut();
            capture.enabled = enabled;
            let result = capture.update(window.app_handle(), window.is_focused().unwrap_or(false));
            if result.is_err() {
                capture.enabled = false;
            }
            result
        });
        let _ = send.send(result);
    })
    .map_err(|error| error.to_string())?;
    done.await.map_err(|error| error.to_string())?
}

pub fn focus_changed(app: &AppHandle, focused: bool) {
    CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        if let Err(message) = capture.update(app, focused) {
            capture.enabled = false;
            emit(app, Report::Error(message));
        }
    });
}

fn release_lost(id: u64) {
    CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        if capture
            .reader
            .as_ref()
            .is_some_and(|reader| reader.id == id)
        {
            capture.reader = None;
        }
    });
}

pub fn close(app: &AppHandle) {
    CAPTURE.with(|capture| {
        let mut capture = capture.borrow_mut();
        capture.enabled = false;
        let _ = capture.update(app, false);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_idle_zero_with_heartbeats_and_immediate_release() {
        let now = Instant::now();
        let held = [1, 100, 0, 0, 0, 0, 0];
        let neutral = [1, 0, 0, 0, 0, 0, 0];
        let mut stream = Stream::default();
        assert!(!stream.changed_or_held(neutral, now));
        assert!(stream.changed_or_held(held, now));
        assert!(!stream.changed_or_held(held, now + Duration::from_millis(1)));
        assert!(stream.changed_or_held(held, now + HEARTBEAT));
        assert!(stream.changed_or_held(neutral, now + HEARTBEAT));
        assert!(!stream.changed_or_held(neutral, now + HEARTBEAT * 2));
    }

    #[test]
    fn refuses_a_connect_from_a_replaced_page_but_always_allows_release() {
        assert!(!stale_enable(true, 3, 3));
        assert!(stale_enable(true, 2, 3));
        assert!(!stale_enable(false, 2, 3));
    }
}
