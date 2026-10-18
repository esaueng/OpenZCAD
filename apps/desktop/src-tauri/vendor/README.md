# GLib 0.18 iterator security backport

`glib/` is the published crates.io `glib` 0.18.5 source, with its MIT license
and copyright notice preserved. `.cargo_vcs_info.json` identifies upstream
source commit `42b9caf98e03ded086362d9653ca58fe94dc8658`. The only source changes
are the two lines from upstream
[gtk-rs-core #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343), merge commit
`05dff0ee696f9bcd8617cd48c4b812d046d440cb`:

- Make the output pointer in `VariantStrIter::impl_get` mutable.
- Pass `&mut p` to `g_variant_get_child`, which writes that pointer.

This removes the undefined behavior described by
[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
without changing GLib's 0.18 API or GTK's dependency constraints. Tauri 2.12.4,
its GTK runtime dependencies, and WebKitGTK 2.0.2 still require this older
series; adding GLib 0.20 alongside it does not replace the vulnerable copy.
The supported macOS desktop does not link this Linux/BSD GTK dependency, but
the lockfile must resolve that dependency to the repaired source as well.

The desktop manifest patches crates.io GLib 0.18 to this local source. The
package version intentionally remains 0.18.5: this is a local backport, not
an upstream 0.20 release. Version-only security scanners may still report
the advisory. Do not suppress the advisory or relabel the package version.

The dependency-audit workflow checks the desktop resolution and runs the
standalone regression crate with release optimizations:

```sh
cargo test --release --locked --manifest-path apps/desktop/glib-regression/Cargo.toml
```

This needs GLib development libraries and pkg-config (Ubuntu:
`libglib2.0-dev pkg-config`). It exercises forward, backward and mixed iteration,
`last`, `nth`, `nth_back`, Unicode, empty strings/arrays, exhausted bounds,
and rejection of non-string arrays. The same test crashes with SIGSEGV against
the unmodified registry crate under release optimization.

Remove the patch and vendored source only once every desktop GTK dependency
resolves to an officially repaired GLib release, then retain the regression.
