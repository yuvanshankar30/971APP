"""Checks that prevent an incomplete plate from reaching CAM setup generation."""
import math


def require_positive_quantity(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError('Every plate assignment needs a positive integer quantity')
    return value


def plate_spacing(tool_diameter):
    diameter = float(tool_diameter)
    if not math.isfinite(diameter) or diameter <= 0:
        raise ValueError('Plate CAM requires a finite, positive tool diameter')
    return max(0.26, diameter + 0.01)


def require_complete_arrangement(arrange, occurrences):
    """Compare occurrence paths, not part names: repeated copies have unique paths."""
    expected = [occ.fullPathName for occ in occurrences]
    if not expected or len(set(expected)) != len(expected):
        raise ValueError('Plate contains no parts or duplicate occurrence paths')
    envelopes = list(arrange.resultEnvelopes)
    if len(envelopes) != 1:
        raise ValueError('All requested parts must fit on exactly one plate')
    placed = [result.occurrence.fullPathName for result in envelopes[0].occurrences]
    if len(placed) != len(expected) or set(placed) != set(expected):
        raise ValueError('Fusion did not arrange every requested part copy; reduce the group or use larger stock')
