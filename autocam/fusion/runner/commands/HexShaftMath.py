"""Pure math for hex-shaft turning setups - no Fusion API dependency.

Kept Fusion-independent for the same reason as TubeHeightMath.py: the rule
has to be unit tested, and HandleHexShaft.py only runs inside Fusion.

Fusion's turning module has no native "hex stock" shape (unlike round bar's
Relative Cylinder auto-stock, used by HandleSpacer.py) - hex across-flats,
groove position/width/floor-diameter, and overall length are all read here
from the finished model body's own measured geometry, not invented.
"""

import math


# The hex's own inscribed-circle radius (apothem) - the minimum round-down
# that removes just the corners, leaving the flats' own width as the new
# diameter. Confirmed live: a real reviewed hex shaft turns each end down to
# exactly this diameter before cutting its snap-ring groove, since a
# continuous circular groove cannot be cut into an interrupted hex cross
# section. Never an independent input - it is fixed by across_flats alone.
def neck_radius_cm(across_flats_cm):
    return across_flats_cm / 2.0


# The corresponding circumscribed-circle radius (center to corner) - what a
# rapid move must clear when passing the un-necked hex, same reasoning as
# autocam/turning.js's stockEnvelopeRadius for hex mill stock.
def circumscribed_radius_cm(across_flats_cm):
    return across_flats_cm / math.sqrt(3)


# Confirmed live: a plain, unmachined hex bar's own corner geometry shows up
# as cylindrical BRep faces at (silently) the circumscribed radius - a
# Fusion/STEP hex-construction artifact present on stock and model alike,
# never a real machined feature. A real groove floor is always well inside
# the hex's own inscribed circle; this tolerance keeps the artifact (and the
# neck's own inscribed-radius cylinder) from ever being mistaken for one.
GROOVE_RADIUS_TOLERANCE_CM = 0.01


def is_groove_floor_radius(candidate_radius_cm, across_flats_cm):
    return candidate_radius_cm < neck_radius_cm(across_flats_cm) - GROOVE_RADIUS_TOLERANCE_CM


# Two coplanar-split pieces of the same physical groove floor measure a
# hair's breadth apart on a real STEP import - same reasoning and same
# reused clustering tolerance as TubeHeightMath.PLANE_CLUSTER_TOLERANCE_CM.
GROOVE_CLUSTER_TOLERANCE_CM = 0.005


def cluster_groove_faces(faces_with_axial_position, tolerance=GROOVE_CLUSTER_TOLERANCE_CM):
    """Group candidate groove-floor faces into distinct groove instances.

    ``faces_with_axial_position`` is an iterable of (axial_low, axial_high,
    face) tuples, one per candidate cylindrical face, in any order. Faces
    whose axial ranges touch or overlap within ``tolerance`` belong to the
    same physical groove (a STEP-imported floor can be split into several
    coplanar pieces - see TubeHeightMath.cluster_by_projection's identical
    reasoning). Returns a list of {"axialLow", "axialHigh", "faces"} dicts,
    one per distinct groove instance, sorted by axialLow.
    """
    items = sorted(faces_with_axial_position, key=lambda item: item[0])
    groups = []
    for low, high, face in items:
        if groups and low <= groups[-1]["axialHigh"] + tolerance:
            groups[-1]["axialHigh"] = max(groups[-1]["axialHigh"], high)
            groups[-1]["faces"].append(face)
        else:
            groups.append({"axialLow": low, "axialHigh": high, "faces": [face]})
    return groups
