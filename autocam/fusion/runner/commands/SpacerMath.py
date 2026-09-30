"""Pure math for spacer turning setups - no Fusion API dependency.

Kept Fusion-independent for the same reason as TubeHeightMath.py: the rule
has to be unit tested, and HandleSpacer.py only runs inside Fusion.

Fusion's own turning stock parameters (modelDiameter, modelDiameterInner,
modelLength) already auto-measure the imported body once it is bound as the
setup's job_model - this module only interprets those already-measured
values in centimeters (Fusion's own internal unit); it never re-derives
geometry itself.
"""

# Confirmed live: a genuinely solid model's own modelDiameterInner reads
# exactly 0, never a small positive number. Anything at or below this
# tolerance is "no hole", not a vanishingly small real bore.
HOLE_DIAMETER_EPSILON_CM = 0.001


def has_hole(model_diameter_inner_cm):
    return model_diameter_inner_cm > HOLE_DIAMETER_EPSILON_CM
