"""Haas TL-1 limits shared by the lathe CAM handlers - no Fusion API dependency."""

# The TL-1's spindle limit (Haas spec, and the Spacer Turning template's own
# tool maximum). Also the post's G50 clamp (postprocessors/haas_turning.cps).
TL1_MAX_SPINDLE_RPM = 2000
