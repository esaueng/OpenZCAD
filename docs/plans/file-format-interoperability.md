# File-format interoperability scope

Specification recorded 2026-09-29. [ROADMAP.md](../../ROADMAP.md) owns all
priorities and delivery status; this document defines scope and acceptance,
not a second implementation queue. No translator, dependency, service,
licence purchase or deployment is introduced by this planning change.

## Existing owners and recommended additions

The recommended set includes the earlier 2D/mesh exchange recommendations and
the native-CAD families. Existing support is retained rather than reopened.

| Format / capability | Direction and boundary | Master owner |
| --- | --- | --- |
| STEP `.step`/`.stp` | Existing import/export; add names, colors, hierarchy and placements with semantic round-trip evidence. Application-protocol selection needs a qualified writer, not a UI-only option. | [I02](../../ROADMAP.md#i02), controls in [I04](../../ROADMAP.md#i04) |
| DXF `.dxf` | Existing planar-face/section export; add whole-sketch export and sketch import. Begin with lines, circles, arcs and polylines; extend curves only when the canonical sketch model supports them. Drawing-view export follows drawing qualification. | [D04](../../ROADMAP.md#d04) |
| PDF `.pdf` | Scaled drawing export, then dimensioned/annotated sheets. PDF reference-image import remains I05; this is not 3D PDF support. | [D01](../../ROADMAP.md#d01), annotations in D02 |
| STL, 3MF, OBJ, GLB | Existing import/export; retain format-specific fixture coverage and improve controls/appearance under existing owners. | [F04](../../ROADMAP.md#f04), [I04](../../ROADMAP.md#i04) |
| SVG `.svg` | Sketch/profile import/export, initially bounded paths and basic shapes with explicit scale. | [I07](../../ROADMAP.md#i07) |
| IGES `.igs`/`.iges` | Precise geometry import/export for qualified solid/surface families. | [I06](../../ROADMAP.md#i06) |
| PLY `.ply` | Existing import plus binary mesh export. | [I08](../../ROADMAP.md#i08), import remains F04 |
| USDZ `.usdz` | Visualization export for Apple AR Quick Look; manufacturing exactness is not a claim. | [I09](../../ROADMAP.md#i09) |
| Parasolid `.x_t`/`.x_b` | Precise geometry import/export. | [I11](../../ROADMAP.md#i11) |
| ACIS `.sat`/`.sab` | Precise geometry import/export. | [I12](../../ROADMAP.md#i12) |
| Rhino `.3dm` | Supported curves/surfaces/solids import/export; meshes remain classified separately. | [I13](../../ROADMAP.md#i13) |
| SolidWorks `.sldprt`/`.sldasm` | Import parts first, then assemblies with their referenced parts. | [I14](../../ROADMAP.md#i14) |
| Inventor `.ipt`/`.iam` | Part/assembly import. | [I15](../../ROADMAP.md#i15) |
| JT `.jt` | Import/export; classify precise, mesh-only and mixed representations. | [I16](../../ROADMAP.md#i16) |
| Creo `.prt`/`.asm` | Part/assembly import, including supported versioned filenames. | [I17](../../ROADMAP.md#i17) |
| Siemens NX `.prt` | Part/assembly import; actual format detection distinguishes Creo. | [I18](../../ROADMAP.md#i18) |
| CATIA V5 `.CATPart`/`.CATProduct` | Part/assembly import. | [I19](../../ROADMAP.md#i19) |
| Solid Edge `.par`/`.psm`/`.asm` | Part/sheet-metal/assembly geometry import. | [I20](../../ROADMAP.md#i20) |

Native application import targets geometry, supported metadata and assembly
placements. It does not promise editable source sketches, constraints, joints,
feature trees or sheet-metal bend history. Native application export is outside
this scope; a separately qualified writer would need its own bounded slice.
The paired SHAPR + STEP workflow and L04's semantic-evidence restrictions remain
unchanged. DWG remains a separately qualified optional slice of I04; JSON glTF,
G-code and BIM formats are not added by this scope.

## Translator qualification (I10)

Remus remains the modeling authority. Evaluate a commercial translator SDK,
a local Tauri/native converter, or an independently implemented Remus reader.
Prefer a measured, bounded integration over assuming a published format or SDK
advertisement proves browser compatibility or geometric fidelity.

An initial bridge can translate native CAD to STEP and reuse the existing
Remus import/validation path; export reverses it for qualified writer formats.
Also evaluate direct geometry mapping when STEP cannot carry required metadata
or surface classes. A mesh intermediate is never an exact-geometry bridge.

Before integration, record:

- The exact SDK/reader version, supported input versions and separate read/write
  directions. Detect actual content, particularly shared `.prt`/`.asm` suffixes.
- Browser-WASM, desktop or server execution requirements, startup/memory budgets,
  redistribution terms, deployment terms and cost. Web viewer support alone
  does not establish browser-native parsing of proprietary files.
- Source handling and retention: offline availability, explicit consent before
  private files leave the device, cancellation/cleanup and replayable source
  persistence. Keep credentials and private CAD out of fixtures and logs.
- B-rep and metadata mapping, units, placements, healing/approximation reports,
  unsupported entities and mixed mesh/solid behavior. Define the surface
  representation and tolerance policy before making exactness claims.

Licence purchase and service deployment require their own authorization. This
specification adds evaluation work; it does not select a vendor or change the
default local browser workflow.

## Acceptance shared by all new directions

1. Use independently produced, licensed or synthetic fixtures for every
   advertised format/version/direction, with an independent reader where
   available. A self-generated round-trip alone is insufficient.
2. Prove equivalent units, dimensions, bounding boxes, analytic surface/curve
   properties and topology validity. For supported closed solids, compare
   volume/area and relevant edge/face invariants to the source within existing
   justified tolerances. Preserve cavities, disconnected bodies and transforms;
   topology reordering is not itself a defect. Name any healing/approximation.
3. For native assemblies, test repeated instances, nested hierarchy, names,
   colors and placements where advertised. Explicitly resolve external parts;
   missing references default to refusal, with any partial import requiring an
   explicit choice and named omissions. Hierarchy uses I02/U06; assembly instance
   behavior uses AS01. Part-only slices can precede those dependencies.
4. Bound input bytes, entities, archive expansion, XML/path complexity and
   execution time. Refuse malformed, unsupported and truncated input by name.
   SVG does not execute scripts or fetch external resources. USDZ packaging
   validates archive paths and resource completeness.
5. Validate before one atomic import commit. Cancellation, failure and stale
   worker responses preserve the prior document; undo/redo, offline save/reopen
   and account/collaboration replay retain geometry and source provenance.
6. Export the requested bodies/sketch/sheet from the current exact model or
   explicit drawing snapshot. Preserve units and inclusion policy; retain mesh
   quality controls. Demonstrate the full UI import/export flow and reimport in
   a representative receiving application. USDZ additionally needs Quick Look
   scale/orientation evidence; PDF needs page-scale and annotation evidence.

## Evidence and implementation starting points

At the consumer manifest/lockfile pin inspected for this scope,
[`594cd308` Remus IO declarations](https://github.com/esaueng/remus/blob/960e777cb1c47b24abe85c78d6a5599c11e00c15/crates/wasm-io/pkg/remus_wasm_io.d.ts)
expose IGES read/write and PLY writing, but no Parasolid, ACIS or Rhino API.
This is API inventory, not runtime qualification; refresh the actual manifest
and lockfile before implementation rather than relying on a roadmap header.

- [Whole-sketch DXF contract](sketch-dxf-export-plan.md) defines the existing
  first-slice geometry, completeness and unit rules; SVG should reuse the
  extraction boundary where compatible, while owning its parser/writer.
- [Drawing MVP design](drawing-mvp-design.md) defines PDF's sheet/view snapshot
  and scale contract. It remains independent of native-CAD translation.
- [Siemens Parasolid data access](https://www.siemens.com/en-us/products/plm-components/parasolid/data-access-translation/)
  describes XT as open/published and provides licensed translator options.
- [CAD Exchanger format matrix](https://cadexchanger.com/formats/) separates
  reader/writer directions and precise/mesh representations; evaluate actual
  deployment and licence terms rather than assuming every native format writes.
- [HOOPS Exchange technical overview](https://docs.techsoft3d.com/hoops/exchange/start/technical-overview.html)
  describes native-CAD geometry/assembly access;
  [platform support](https://docs.techsoft3d.com/hoops/exchange/start/supported-platforms.html)
  must be checked separately from browser visualization.
- [McNeel openNURBS](https://www.rhino3d.com/features/developer/opennurbs/)
  provides 3DM read/write source libraries; precise mapping into Remus still
  requires qualification.
- [LightBurn workflows](https://lightburnsoftware.com/pages/about-us) accept
  SVG/DXF artwork; [Apple Quick Look](https://developer.apple.com/quick-look-gallery/)
  documents the USDZ viewing target.
