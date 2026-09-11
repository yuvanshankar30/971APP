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


def default_tailstock_length_cm(model_length_cm):
    """The tailstock/live-center support length used when the operator
    hasn't overridden it: the part's own full length, auto-detected from the
    imported STEP body via Fusion's own modelLength. This is the "regular"
    length - not a guess independent of the real part - and stays a plain
    pass-through on purpose, so a future refinement (e.g. subtracting a grip
    allowance) has exactly one place to change.
    """
    return model_length_cm
