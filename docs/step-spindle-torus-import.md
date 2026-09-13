# STEP spindle-torus import qualification

This K03 regression covers `DEGENERATE_TOROIDAL_SURFACE` from STEP imports. Remus previously rejected the entity, and OpenZCAD translated its name into an unrelated geometry-collapse message.

The importer represents the selected inner or outer branch with exact rational quadratics, preserving the 3D circular boundaries. Circular inner bands use their two complete rims to bound the rational carrier. This is an exact B-rep representation change, not a fitted or faceted fallback. Original STEP text remains unchanged in the document. Angular PCURVEs on this subtype remain explicitly unsupported.

The shared synthetic fixture `test/fixtures/step/lemon-torus-band.step` has a closed-form reference volume. `test/step-degenerate-torus.test.ts` covers document rebuild, source preservation, export and re-import. Remus's matching regression also covers the outer branch, signed mesh volume, and watertightness. Measurements derived from tessellation remain estimates; these tests do not promote their precision.

The kernel source fix is [Remus PR #433](https://github.com/esaueng/remus/pull/433). Consumer qualification found a pre-existing wedge-fillet failure on current Remus main: the existing OpenZCAD `partial-revolve.test.ts` acceptance passes against the deployed kernel and fails against unmodified newer packages. The application therefore consumes the same STEP patch backported to its deployed kernel source, with paired kernel/translator packages and an immutable pin. This avoids adopting the unrelated fillet regression or weakening its test.

A private Shapr3D model was used for local import and independent OpenCascade checks. Neither that file nor its model data is part of the repository. The synthetic fixture is the redistributable regression. Browser, unit-test and package-build verification are distinct from deployment; this change does not itself deploy production.
