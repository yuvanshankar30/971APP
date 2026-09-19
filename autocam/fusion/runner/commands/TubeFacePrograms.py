"""Shared naming for the four manually-indexed rectangular-tube setups.

Fusion posts one NC program per Setup.  A box tube is therefore deliberately
four setups, not one setup with four unrelated operations: the operator loads
one physical wall at a time and re-zeros Z after every turn.  Keep these names
in one small Fusion-independent module so the workflow, exporter, and tests
cannot drift into numbered files that give the operator no clue which face is
next.
"""

import re

TUBE_FACE_CLOCKS = (12, 3, 6, 9)
# Fusion silently truncates longer post program names. Leave room for the
# meaningful face suffix so the four indexed setups cannot overwrite one
# another when the base name contains tube/job UUIDs.
FUSION_PROGRAM_NAME_MAX_LENGTH = 40


def tube_face_label(clock):
    if clock not in TUBE_FACE_CLOCKS:
        raise ValueError("Tube face must be one of 12, 3, 6, or 9")
    return "Side {}".format(clock)


def tube_face_setup_name(clock):
    return "Tube {}".format(tube_face_label(clock))


def tube_face_program_name(base_name, clock):
    """Filename stem for one face; Fusion's post processor adds .ngc/.nc."""
    tube_face_label(clock)  # validates clock
    # No spaces or separators anywhere: <FusionFileName>Side<clock>AUTOCAM.
    base = re.sub(r"\s+", "", str(base_name or "")) or "tube"
    suffix = "Side{}AUTOCAM".format(clock)
    return "{}{}".format(base[:FUSION_PROGRAM_NAME_MAX_LENGTH - len(suffix)], suffix)
