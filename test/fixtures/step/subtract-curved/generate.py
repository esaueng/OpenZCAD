"""Regenerate the issue #1242 Subtract operands and their OCCT reference.

Run with OCCT's Python bindings (`pip install cadquery-ocp`):

    python3 -I generate.py <output-directory>

The operands mirror the issue's FreeCAD 1.1.3 recipe (FreeCAD's Part
workbench calls these same OCCT builders). The reference volumes and
witnesses are measured by OCCT on the written STEP files, read back, so they
check what the app imports, independently of the Remus kernel.
"""
import json
import math
import re
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace,
                                BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeVertex,
                                BRepBuilderAPI_MakeWire, BRepBuilderAPI_NurbsConvert,
                                BRepBuilderAPI_Transform)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepGProp import BRepGProp
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell, BRepOffsetAPI_ThruSections
from OCP.BRepPrimAPI import (BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakeHalfSpace,
                             BRepPrimAPI_MakeRevol)
from OCP.Bnd import Bnd_Box
from OCP.GC import GC_MakeArcOfCircle
from OCP.GProp import GProp_GProps
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
from OCP.TopAbs import TopAbs_IN, TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Ax1, gp_Ax2, gp_Circ, gp_Dir, gp_Elips, gp_Pln, gp_Pnt, gp_Trsf, gp_Vec

P = gp_Pnt
# The issue's witness for the primary recipe, over 1.09 mm inside both
# operand boundaries.
ISSUE_WITNESS = (6.17578517, 1.03101320, 4.87029036)


def volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def inside(shape, point):
    return BRepClass3d_SolidClassifier(shape, P(*point), 1e-7).State() == TopAbs_IN


def clearance(shape, point):
    """Distance from an interior point to the solid's boundary shells."""
    vertex = BRepBuilderAPI_MakeVertex(P(*point)).Vertex()
    shells = TopExp_Explorer(shape, TopAbs_SHELL)
    best = math.inf
    while shells.More():
        best = min(best, BRepExtrema_DistShapeShape(vertex, shells.Current()).Value())
        shells.Next()
    return best


def write(shape, path):
    Interface_Static.SetCVal_s('write.step.schema', 'AP214IS')
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    writer.Write(path)
    # Anonymous, reproducible header: no author, host or wall-clock time.
    text = open(path).read()
    text = re.sub(r"FILE_NAME\(.*?\);", "FILE_NAME('','2026-01-01T00:00:00',(''),(''),'','','');",
                  text, count=1, flags=re.S)
    open(path, 'w').write(text)


def read(path):
    reader = STEPControl_Reader()
    reader.ReadFile(path)
    reader.TransferRoots()
    return reader.OneShape()


def transformed(shape, scale=None, translation=None):
    if scale:
        trsf = gp_Trsf()
        trsf.SetScaleFactor(scale)
        shape = BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    if translation:
        trsf = gp_Trsf()
        trsf.SetTranslation(gp_Vec(*translation))
        shape = BRepBuilderAPI_Transform(shape, trsf, True).Shape()
    return shape


def arc_sweep(start, middle, end, radius):
    """`Part.Wire([arc]).makePipeShell([circle], True, False)`."""
    arc = GC_MakeArcOfCircle(P(*start), P(*middle), P(*end)).Value()
    spine = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(arc).Edge()).Wire()
    origin, tangent = gp_Pnt(), gp_Vec()
    arc.D1(arc.FirstParameter(), origin, tangent)
    circle = gp_Circ(gp_Ax2(P(*start), gp_Dir(tangent)), radius)
    profile = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(circle).Edge()).Wire()
    pipe = BRepOffsetAPI_MakePipeShell(spine)
    pipe.Add(profile, False, False)
    pipe.Build()
    pipe.MakeSolid()
    return pipe.Shape()


def annulus_tool():
    """The issue's annular revolve: radii 4..10, z -6..6."""
    section = BRepBuilderAPI_MakePolygon(P(4, 0, -6), P(10, 0, -6), P(10, 0, 6),
                                         P(4, 0, 6), True).Wire()
    face = BRepBuilderAPI_MakeFace(section).Face()
    return BRepPrimAPI_MakeRevol(face, gp_Ax1(P(0, 0, 0), gp_Dir(0, 0, 1)), 2 * math.pi).Shape()


def swept_arc_target():
    """The issue's swept target, scaled 0.82 and moved by (6, 1, 0.5)."""
    return transformed(arc_sweep((-8, 0, -5), (0, 0, 6), (8, 0, -5), 2), 0.82, (6, 1, 0.5))


def trimmed_nurbs_target():
    """A cylinder across the annulus wall, trimmed by an inclined plane, with
    every face converted to a B-spline: trimmed NURBS faces."""
    cylinder = BRepPrimAPI_MakeCylinder(gp_Ax2(P(10, -6, 2), gp_Dir(0, 1, 0)), 2.5, 12).Shape()
    plane = BRepBuilderAPI_MakeFace(gp_Pln(P(10, 0, 2), gp_Dir(0.25, 0.35, -1))).Face()
    half = BRepPrimAPI_MakeHalfSpace(plane, P(10, 0, -20)).Solid()
    return BRepBuilderAPI_NurbsConvert(BRepAlgoAPI_Common(cylinder, half).Shape(), True).Shape()


def crossing_sweep_tool():
    """A second arc sweep crossing the target's crown at right angles."""
    return arc_sweep((6, -7, 1), (6, 1, 7), (6, 9, 1), 2)


def loft_tool():
    """A smooth three-section loft through the target's left leg.

    Each section is two half-arcs. A single closed section edge gives OCCT's
    loft a periodic seam, and Remus 2026.1.135's STEP reader rejects that seam
    pcurve pairing for every closed-section loft tried, so the split sections
    keep this recipe on the Subtract under test rather than on that import.
    """
    def section(centre, major, minor):
        if major == minor:
            curve = gp_Circ(gp_Ax2(P(*centre), gp_Dir(0, 0, 1)), major)
        else:
            curve = gp_Elips(gp_Ax2(P(*centre), gp_Dir(0, 0, 1)), major, minor)
        first = BRepBuilderAPI_MakeEdge(curve, 0, math.pi).Edge()
        second = BRepBuilderAPI_MakeEdge(curve, math.pi, 2 * math.pi).Edge()
        return BRepBuilderAPI_MakeWire(first, second).Wire()
    loft = BRepOffsetAPI_ThruSections(True, False, 1e-6)
    loft.AddWire(section((1.5, 1, -3), 2.6, 2.6))
    loft.AddWire(section((2.5, 0.8, 1.5), 2.0, 2.0))
    loft.AddWire(section((3.5, 1.5, 6), 2.2, 1.2))
    loft.Build()
    return loft.Shape()


OPERANDS = {
    'swept-arc-target': swept_arc_target,
    'trimmed-nurbs-target': trimmed_nurbs_target,
    'annulus-tool': annulus_tool,
    'crossing-sweep-tool': crossing_sweep_tool,
    'loft-tool': loft_tool,
}
RECIPES = {
    'revolve-sweep': ('swept-arc-target', 'annulus-tool'),
    'revolve-trimmed-nurbs': ('trimmed-nurbs-target', 'annulus-tool'),
    'sweep-sweep': ('swept-arc-target', 'crossing-sweep-tool'),
    'sweep-loft': ('swept-arc-target', 'loft-tool'),
}


def deepest_shared_point(target, tool, common, steps=14):
    """The grid point inside both operands farthest from either boundary."""
    box = Bnd_Box()
    BRepBndLib.Add_s(common, box)
    low, high = box.CornerMin(), box.CornerMax()
    lo, hi = (low.X(), low.Y(), low.Z()), (high.X(), high.Y(), high.Z())
    best = None
    for i in range(steps):
        for j in range(steps):
            for k in range(steps):
                point = tuple(lo[a] + (s + 0.5) / steps * (hi[a] - lo[a])
                              for a, s in enumerate((i, j, k)))
                if not inside(common, point):
                    continue
                margin = min(clearance(target, point), clearance(tool, point))
                if best is None or margin > best[0]:
                    best = (margin, point)
    return best


def main(out):
    for name, build in OPERANDS.items():
        shape = build()
        assert BRepCheck_Analyzer(shape).IsValid(), name
        write(shape, f'{out}/{name}.step')
    reference = {}
    for recipe, (target_name, tool_name) in RECIPES.items():
        target, tool = read(f'{out}/{target_name}.step'), read(f'{out}/{tool_name}.step')
        cut = BRepAlgoAPI_Cut(target, tool).Shape()
        common = BRepAlgoAPI_Common(target, tool).Shape()
        if recipe == 'revolve-sweep':
            witness = ISSUE_WITNESS
            margin = min(clearance(target, witness), clearance(tool, witness))
        else:
            margin, witness = deepest_shared_point(target, tool, common)
        assert inside(target, witness) and inside(tool, witness) and not inside(cut, witness)
        reference[recipe] = {
            'target': f'{target_name}.step',
            'tool': f'{tool_name}.step',
            'targetVolume': round(volume(target), 6),
            'toolVolume': round(volume(tool), 6),
            'cutVolume': round(volume(cut), 6),
            'sharedVolume': round(volume(common), 6),
            'witness': [round(v, 8) for v in witness],
            'witnessClearance': round(margin, 6),
        }
    with open(f'{out}/reference.json', 'w') as handle:
        json.dump(reference, handle, indent=2)
        handle.write('\n')
    print(json.dumps(reference, indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
