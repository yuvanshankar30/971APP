"""Pure math for spacer turning setups - no Fusion API dependency.

Kept Fusion-independent for the same reason as TubeHeightMath.py: the rule
has to be unit tested, and HandleSpacer.py only runs inside Fusion.

Fusion's own turning stock parameters (modelDiameter, modelDiameterInner,
modelLength) already auto-measure the imported body once it is bound as the
setup's job_model - this module only interprets those already-measured
values in centimeters (Fusion's own internal unit); it never re-derives
geometry itself.
"""

import math

# Confirmed live: a genuinely solid model's own modelDiameterInner reads
# exactly 0, never a small positive number. Anything at or below this
# tolerance is "no hole", not a vanishingly small real bore.
HOLE_DIAMETER_EPSILON_CM = 0.001


def has_hole(model_diameter_inner_cm):
    return model_diameter_inner_cm > HOLE_DIAMETER_EPSILON_CM


# Bore drilling on the lathe: the drill is the bore's own diameter (a
# template drill of a different size drills a wrong-size hole), fed per
# revolution at a fixed rpm, and pecked when the hole is deep.
_DRILL_SFM = 100
_DRILL_REACH_IN = 0.35
_DEEP_HOLE_DEPTH_RATIO = 3.0


def drill_feed_ipr(diameter_in):
    if diameter_in < 0.25:
        return 0.004
    return 0.006 if diameter_in < 0.5 else 0.008


def drill_cutting_data(bore_diameter_in, hole_depth_in, max_rpm):
    """Speeds, feed and geometry for the bore drill, in inches.

    rpm is _DRILL_SFM converted for the drill diameter and capped at
    max_rpm; flute_in reaches past the hole's depth (the template drill's
    1.125in flutes cannot reach a 2in hole); pecking at one diameter starts
    when the hole is deeper than _DEEP_HOLE_DEPTH_RATIO diameters.
    """
    rpm = int(min(max_rpm, _DRILL_SFM * 12 / (math.pi * bore_diameter_in)))
    return {
        "rpm": rpm,
        "feed_ipr": drill_feed_ipr(bore_diameter_in),
        "flute_in": hole_depth_in + _DRILL_REACH_IN,
        "deep": hole_depth_in > _DEEP_HOLE_DEPTH_RATIO * bore_diameter_in,
        "peck_in": bore_diameter_in,
    }
