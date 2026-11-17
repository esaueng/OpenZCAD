//! "Open in slicer" (L09): hands a 3MF the workspace has just exported to a
//! slicer installed on this Mac, without any server.
//!
//! The slicers' own URL schemes (`bambustudio://open?file=`,
//! `orcaslicer://open?file=`) only download an http(s) URL, which a browser-made
//! file does not have, and Bambu Connect's `import-file` takes only a sliced
//! `.gcode.3mf`. A local file opened by the system is what every slicer
//! accepts, so the shell writes the bytes to a private temporary folder and
//! asks Launch Services to open them with the chosen application.
//!
//! The renderer names a slicer from the fixed list below, never an
//! application or a path, so a compromised renderer cannot use this to launch
//! anything else or to write outside the hand-off folder.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// A slicer the shell may open a 3MF with.
pub(crate) struct Slicer {
    /// What the renderer sends.
    pub(crate) id: &'static str,
    /// The application name `open -a` resolves through Launch Services.
    pub(crate) app: &'static str,
    /// How a message names it.
    pub(crate) label: &'static str,
}

pub(crate) const SLICERS: &[Slicer] = &[
    Slicer {
        id: "bambu-studio",
        app: "BambuStudio",
        label: "Bambu Studio",
    },
    Slicer {
        id: "orcaslicer",
        app: "OrcaSlicer",
        label: "OrcaSlicer",
    },
    Slicer {
        id: "prusaslicer",
        app: "PrusaSlicer",
        label: "PrusaSlicer",
    },
];

/// The folder, under the system's temporary directory, every hand-off goes in.
pub(crate) const HANDOFF_FOLDER: &str = "OpenZCAD slicer hand-off";

/// A hand-off older than this is removed on the next one: the slicer has
/// long since read it, and the system would otherwise keep it until reboot.
pub(crate) const HANDOFF_RETENTION: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) fn slicer(id: &str) -> Result<&'static Slicer, String> {
    SLICERS
        .iter()
        .find(|slicer| slicer.id == id)
        .ok_or_else(|| "That slicer is not one OpenZCAD can open.".to_string())
}

/// The file name a hand-off is written under: the suggested name, which must
/// be a plain name, ending in `.3mf`.
pub(crate) fn handoff_file_name(suggested: &str) -> Result<String, String> {
    let refused = || "The suggested 3MF name is invalid.".to_string();
    let name = suggested.trim();
    if name.is_empty()
        || name.len() > 160
        || name.contains(['/', '\\', '\0', ':'])
        || name == "."
        || name == ".."
    {
        return Err(refused());
    }
    let has_extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("3mf"))
        .unwrap_or(false);
    Ok(if has_extension {
        name.to_string()
    } else {
        format!("{name}.3mf")
    })
}

fn unique_folder_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{}", std::process::id())
}

#[cfg(unix)]
fn private_folder(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn private_folder(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// Removes hand-offs older than `retention`; what cannot be removed stays.
pub(crate) fn prune_handoffs(root: &Path, retention: Duration, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root.join(HANDOFF_FOLDER)) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .map(|age| age > retention)
            .unwrap_or(false);
        if stale && entry.path().is_dir() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/// Writes one hand-off into its own private folder under `root` and returns
/// the file's path. Refuses anything that is not a 3MF package (a Zip) or
/// that is larger than `max_bytes`.
pub(crate) fn write_handoff(
    root: &Path,
    suggested_name: &str,
    contents: &[u8],
    max_bytes: u64,
) -> Result<PathBuf, String> {
    if contents.len() as u64 > max_bytes {
        return Err("The 3MF exceeds the 50 MB desktop safety limit.".to_string());
    }
    if !contents.starts_with(b"PK\x03\x04") {
        return Err("Only a 3MF package can be opened in a slicer.".to_string());
    }
    let name = handoff_file_name(suggested_name)?;
    let parent = root.join(HANDOFF_FOLDER);
    fs::create_dir_all(&parent).map_err(|error| error.to_string())?;
    private_folder(&parent)?;
    let folder = parent.join(unique_folder_name());
    fs::create_dir(&folder).map_err(|error| error.to_string())?;
    private_folder(&folder)?;
    let path = folder.join(name);
    fs::write(&path, contents).map_err(|error| error.to_string())?;
    Ok(path)
}

/// The command that opens `path` with `slicer`: Launch Services, by name.
pub(crate) fn open_command(slicer: &Slicer, path: &Path) -> Command {
    let mut command = Command::new("/usr/bin/open");
    // Each value is one argument to `open`; no shell sees them.
    command.arg("-a").arg(slicer.app).arg(path);
    command
}

pub(crate) fn open_in(slicer: &Slicer, path: &Path) -> Result<(), String> {
    let status = open_command(slicer, path)
        .status()
        .map_err(|_| format!("OpenZCAD could not ask macOS to open {}.", slicer.label))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{} did not open. Is it installed? Export the 3MF and open it from the slicer instead.",
            slicer.label
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "openzcad-slicer-test-{name}-{}",
            unique_folder_name()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn knows_each_slicer_by_id_and_refuses_anything_else() {
        assert_eq!(slicer("bambu-studio").unwrap().app, "BambuStudio");
        assert_eq!(slicer("orcaslicer").unwrap().app, "OrcaSlicer");
        assert_eq!(slicer("prusaslicer").unwrap().app, "PrusaSlicer");
        for id in ["", "Bambu Studio", "Terminal", "/bin/sh", "BambuStudio"] {
            assert!(slicer(id).is_err(), "{id}");
        }
    }

    #[test]
    fn names_the_file_as_a_plain_3mf() {
        assert_eq!(handoff_file_name("Gear.3mf").unwrap(), "Gear.3mf");
        assert_eq!(handoff_file_name("Gear.3MF").unwrap(), "Gear.3MF");
        assert_eq!(handoff_file_name("Gear").unwrap(), "Gear.3mf");
        assert_eq!(handoff_file_name("Gear.stl").unwrap(), "Gear.stl.3mf");
        for name in ["", " ", "../x.3mf", "a/b.3mf", "a\\b", "a:b", "..", "a\0b"] {
            assert!(handoff_file_name(name).is_err(), "{name:?}");
        }
        assert!(handoff_file_name(&"x".repeat(161)).is_err());
    }

    #[test]
    fn writes_a_3mf_into_its_own_private_folder() {
        let root = scratch("write");
        let bytes = b"PK\x03\x04rest of the package";
        let first = write_handoff(&root, "Part.3mf", bytes, 1024).unwrap();
        let second = write_handoff(&root, "Part.3mf", bytes, 1024).unwrap();
        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), bytes);
        assert!(first.starts_with(root.join(HANDOFF_FOLDER)));
        assert_eq!(first.file_name().unwrap(), "Part.3mf");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(first.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_what_is_not_a_3mf_or_is_too_large() {
        let root = scratch("refuse");
        assert!(write_handoff(&root, "Part.3mf", b"solid stl", 1024).is_err());
        assert!(write_handoff(&root, "Part.3mf", b"PK\x03\x04", 3).is_err());
        assert!(write_handoff(&root, "../Part.3mf", b"PK\x03\x04", 1024).is_err());
        assert!(!root.join(HANDOFF_FOLDER).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn prunes_only_hand_offs_past_their_retention() {
        let root = scratch("prune");
        let path = write_handoff(&root, "Part.3mf", b"PK\x03\x04", 1024).unwrap();
        let folder = path.parent().unwrap().to_path_buf();
        prune_handoffs(&root, HANDOFF_RETENTION, SystemTime::now());
        assert!(folder.exists());
        prune_handoffs(
            &root,
            HANDOFF_RETENTION,
            SystemTime::now() + HANDOFF_RETENTION + Duration::from_secs(60),
        );
        assert!(!folder.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opens_with_launch_services_by_application_name() {
        let path = Path::new("/tmp/OpenZCAD slicer hand-off/1/Part.3mf");
        let command = open_command(slicer("orcaslicer").unwrap(), path);
        assert_eq!(command.get_program(), "/usr/bin/open");
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args, ["-a", "OrcaSlicer", path.to_str().unwrap()]);
    }
}
