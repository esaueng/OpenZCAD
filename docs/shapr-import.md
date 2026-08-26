# Shapr3D project interoperability

OpenZCAD's first Shapr3D migration path is deliberately paired: the user must
select one `.shapr` project and one STEP export of the same design. The STEP is
the only geometry source. The `.shapr` archive supplies bounded, non-operative
history evidence for the preview and the canonical migration record.

## Trust boundary

- ZIP central-directory metadata is validated before decompression. ZIP64,
  encryption, symlinks, unsafe paths, duplicates, unsupported compression,
  excess entry/output sizes, and excess compression ratios fail closed.
- The `workspace` entry is opened only inside a one-shot browser worker using
  SQLite-WASM's in-memory VFS with an immutable URI, defensive mode,
  `query_only`, disabled extension/attach capabilities, and explicit SQLite
  limits.
- JSON and the independently implemented MessagePack subset have byte, depth,
  node, string, array, row, and control-point limits. Unknown encodings fail
  closed.
- Only the exact observed schema tuple `269/307000/100/249000` is accepted.
  A future schema needs a new adapter and fixtures; similarity is not
  compatibility.
- Raw SQLite rows, database bytes, Parasolid data, revision bodies,
  thumbnails, UI state, remote identifiers, paths, usernames, and timestamps
  are never added to the document. The raw `.shapr` file is not archived.
- The companion STEP `FILE_NAME` field is privacy-sanitized before local
  storage, exact-kernel validation, or upload. STEP `DATA` records are not
  rewritten.

## Geometry and history contract

The exact browser kernel must rebuild and accept the sanitized STEP before the
single guided-import command can commit. The command adds that exact STEP body
and a versioned, sanitized migration record atomically, so undo, redo,
persistence, collaboration replay, and offline replay cannot separate the
evidence from its geometry witness. Validation runs in a disposable worker;
cancelling terminates its exact rebuild and leaves document history unchanged.

Recognized sketch, transform, union, and extrusion rows are `candidate` data.
Import, delete, midplane, split, face-offset, unknown operations, and all
unproven references remain `unsupported` or `ambiguous`. No recovered operation
is executed in this version. A later adapter may promote an operation only when
its schema, units, coordinate frame, operands, analytic geometry, adjacency,
operation order, and topology correspondence are uniquely proven. A missing or
multiple match remains unresolved; ordinal or nearest-geometry substitution is
not allowed.

After import, Auto-parameterize may offer an opposing-planar face distance only
when the exact pair is re-proved and its deterministic move passes a non-zero
strict B-Rep and watertight-mesh rebuild. Unsupported pairs are omitted, and a
same-value binding still resolves both stored references before leaving the
original exact shape unchanged.

That proof does not promote a source-history number by itself. The
hammer-holder's nominal 46 mm dimension remains unavailable unless its exact
pair and intended coordinated move pass the same changed-value contract;
semantic reconstruction still requires the broader guided workflow.

## Legal boundary

This is an independently written interoperability reader for user-exported
content, not an implementation of Shapr3D or Parasolid. It copies no Shapr3D
source, UI, icons, assets, branding, or proprietary algorithms. It does not
decode Parasolid transmit data or X_T; standalone exact geometry would require
a separately cleared, browser-capable Parasolid implementation and likely a
commercial licence.

Shapr3D's terms effective May 20, 2026 restrict reverse engineering of the
application, while including language for integration legitimately required
with other software and rights that applicable law does not allow a contract
to exclude. They also state that customers retain ownership of intellectual
property in Customer Content. Those statements do not themselves clear this
feature for every customer or jurisdiction. Obtain legal review and, where
advisable, written permission before public release; keep engineering
feasibility separate from that decision.

- <https://www.shapr3d.com/terms-and-conditions>
- <https://support.shapr3d.com/hc/en-us/articles/7874524196764-Export>
