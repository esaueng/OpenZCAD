# FreeCAD import

Native `.FCStd` import is unavailable. Export solids as STEP in FreeCAD and
import the resulting `.step` or `.stp` file into OpenZCAD.

The saved-solid converter and its OCCT dependency have been removed. Existing
projects created by that converter retain their converted STEP sources and
continue to rebuild through Remus; they do not need the original archive or
converter. FreeCAD sketches and feature history were never transferred.
