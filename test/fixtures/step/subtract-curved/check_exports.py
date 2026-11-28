"""Check the app's issue #1242 Subtract exports with OCCT, not with Remus.

`test/subtract-curved-operands.test.ts` re-imports each export into Remus, the
kernel that wrote it. This is the same check by a second kernel. Write the
exports, then measure them (`pip install cadquery-ocp`):

    OPENZCAD_SUBTRACT_EXPORT_DIR=<dir> pnpm exec vitest run \
        test/subtract-curved-operands.test.ts
    python3 -I check_exports.py <dir>

Each `<recipe>.step` holds what the reloaded document exports after the
Subtract: one body where it cut, both sources where it refused. A cut must be
a valid solid that excludes the witness and is the same body as OCCT's own
cut of the committed operands. Refused sources must be the committed
operands, unchanged. Exits non-zero otherwise.

"The same body" is measured without a boolean between the two: their
boundaries coincide, which is the case OCCT's boolean answers least reliably
(measured here: it returned an operand untouched). Volume, centre of mass and
the inertia tensor must agree, and so must OCCT's classification of every
point of a grid over the pair that is clear of both boundaries.
"""
import json
import os
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepClass3d import BRepClass3d_SolidClassifier
from OCP.BRepGProp import BRepGProp
from OCP.Bnd import Bnd_Box
from OCP.GProp import GProp_GProps
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_IN, TopAbs_ON, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Pnt

HERE = os.path.dirname(os.path.abspath(__file__))
# Mass properties agree to a part in ten thousand: a STEP round-trip and
# fitted intersection curves, not a different body.
RELATIVE = 1e-4
# Grid points per axis, and the distance (model units) within which a point
# counts as on a boundary and is left out of the comparison.
GRID = 18
ON_BOUNDARY = 1e-3


def properties(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    centre, inertia = props.CentreOfMass(), props.MatrixOfInertia()
    return (props.Mass(), (centre.X(), centre.Y(), centre.Z()),
            [inertia.Value(row, column) for row in (1, 2, 3) for column in (1, 2, 3)])


def volume(shape):
    return properties(shape)[0]


def inside(shape, point):
    return BRepClass3d_SolidClassifier(shape, gp_Pnt(*point), 1e-7).State() == TopAbs_IN


def read(path):
    reader = STEPControl_Reader()
    reader.ReadFile(path)
    reader.TransferRoots()
    return reader.OneShape()


def solids(shape):
    explorer, found = TopExp_Explorer(shape, TopAbs_SOLID), []
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def state(shape, point):
    return BRepClass3d_SolidClassifier(shape, gp_Pnt(*point), ON_BOUNDARY).State()


def same_body(actual, expected):
    valid = BRepCheck_Analyzer(actual).IsValid()
    (mass, centre, inertia), (ref_mass, ref_centre, ref_inertia) = (
        properties(actual), properties(expected))
    box = Bnd_Box()
    BRepBndLib.Add_s(actual, box)
    BRepBndLib.Add_s(expected, box)
    low, high = box.CornerMin(), box.CornerMax()
    lo, hi = (low.X(), low.Y(), low.Z()), (high.X(), high.Y(), high.Z())
    span = max(hi[axis] - lo[axis] for axis in range(3))
    compared = interior = disagreeing = 0
    for i in range(GRID):
        for j in range(GRID):
            for k in range(GRID):
                point = tuple(lo[a] + (s + 0.5) / GRID * (hi[a] - lo[a])
                              for a, s in enumerate((i, j, k)))
                ours, theirs = state(actual, point), state(expected, point)
                if TopAbs_ON in (ours, theirs):
                    continue
                compared += 1
                interior += theirs == TopAbs_IN
                disagreeing += ours != theirs
    centre_offset = max(abs(a - b) for a, b in zip(centre, ref_centre))
    inertia_scale = max(abs(value) for value in ref_inertia)
    inertia_offset = max(abs(a - b) for a, b in zip(inertia, ref_inertia))
    return {
        'valid': valid,
        'volume': round(mass, 6),
        'expectedVolume': round(ref_mass, 6),
        'centreOffset': round(centre_offset, 9),
        'inertiaRelativeOffset': round(inertia_offset / inertia_scale, 9),
        'gridPoints': compared,
        'gridPointsInside': interior,
        'gridPointsDisagreeing': disagreeing,
        'ok': valid
              and abs(mass - ref_mass) < ref_mass * RELATIVE
              and centre_offset < span * RELATIVE
              and inertia_offset < inertia_scale * RELATIVE
              and interior > 0 and disagreeing == 0,
    }


def main(exports):
    reference = json.load(open(os.path.join(HERE, 'reference.json')))
    report, ok = {}, True
    for recipe, expected in reference.items():
        target = read(os.path.join(HERE, expected['target']))
        tool = read(os.path.join(HERE, expected['tool']))
        witness = expected['witness']
        bodies = solids(read(os.path.join(exports, f'{recipe}.step')))
        if len(bodies) == 1:
            entry = {'outcome': 'cut',
                     **same_body(bodies[0], BRepAlgoAPI_Cut(target, tool).Shape()),
                     'witnessInside': inside(bodies[0], witness)}
            entry['ok'] = entry['ok'] and not entry['witnessInside']
        elif len(bodies) == 2:
            # Both sources, in either order: the smaller volume pairs with
            # the smaller operand.
            bodies.sort(key=volume)
            sources = sorted((target, tool), key=volume)
            checks = [same_body(body, source) for body, source in zip(bodies, sources)]
            entry = {'outcome': 'refused, both sources exported',
                     'sources': checks,
                     'witnessInside': [inside(body, witness) for body in bodies],
                     'ok': all(check['ok'] for check in checks)}
            entry['ok'] = entry['ok'] and all(entry['witnessInside'])
        else:
            entry = {'outcome': f'{len(bodies)} solids', 'ok': False}
        report[recipe] = entry
        ok = ok and entry['ok']
    print(json.dumps(report, indent=2))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
