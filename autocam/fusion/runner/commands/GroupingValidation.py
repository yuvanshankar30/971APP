"""Checks that prevent an incomplete plate from reaching CAM setup generation."""
import math


class PlateFitError(ValueError):
    """A selected plate cannot safely contain the requested part geometry."""


def require_positive_quantity(value):
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError('Every plate assignment needs a positive integer quantity')
    return value


def plate_spacing(tool_diameter):
    diameter = float(tool_diameter)
    if not math.isfinite(diameter) or diameter <= 0:
        raise ValueError('Plate CAM requires a finite, positive tool diameter')
    return max(0.26, diameter + 0.01)


def required_plate_dimensions(footprints, length_in, width_in, frame_width_in=0.5):
    """The plate size actually needed to fit every individual footprint.

    Direct instruction: a plate's declared size only bounds how much room
    Arrange has to nest parts in - the real CAM stock is a RelativeBoxStock
    sized to the imported geometry's own bounding box (see
    SetupGenerator.py), not the plate's dimensions, so growing the plate
    costs nothing real. Given that, there's no reason to reject an
    individually oversized part the way this used to (Arrange reports the
    same generic ``NO_ROOM`` for an oversized single part as for a
    genuinely crowded group) - grow to fit it instead.

    Sized as a square big enough for the largest footprint's longer side in
    either orientation, plus the same edge margin AutoArrange itself
    reserves on every side - simpler and always safe, at the cost of some
    unused margin versus a tighter rectangle. Only accounts for each part's
    own size in isolation, not a substitute for Arrange's real 2D nesting
    solver when multiple parts are involved, which can still legitimately
    run out of room fitting several parts together even on a plate sized
    for its biggest single one - that remaining case is still caught by
    Arrange's own ARRANGE_ERROR_NO_ROOM result.

    Returns (length_in, width_in), unchanged if the given size already fits
    everything (a rectangular plate can fit a part via rotation without
    needing to grow at all), grown to a sufficient square otherwise.
    """
    length_in = float(length_in)
    width_in = float(width_in)
    frame_width_in = float(frame_width_in)
    usable_length = length_in - 2 * frame_width_in
    usable_width = width_in - 2 * frame_width_in
    spans = [(float(x_span), float(y_span)) for _, x_span, y_span in footprints]

    def fits(x_span, y_span):
        return usable_length > 0 and usable_width > 0 and (
            (x_span <= usable_length and y_span <= usable_width)
            or (y_span <= usable_length and x_span <= usable_width)
        )

    if all(fits(x_span, y_span) for x_span, y_span in spans):
        return length_in, width_in

    longest_side = max((max(x_span, y_span) for x_span, y_span in spans), default=0.0)
    required_side = longest_side + 2 * frame_width_in
    return max(length_in, required_side), max(width_in, required_side)


def require_grouping_mode_matches_assignments(assignments, grouping_mode):
    """Second boundary check on an already-normalized assignment list.

    cam_jobs is validated when a job is queued (the fusion_snapshot_plate_job
    trigger requires an explicit single/grouped mode and enforces the
    matching assignment count there - see the grouping-integrity migration).
    This mirrors that same check at the Runner, the last point before real
    CAM setup generation starts: a malformed or tampered payload should fail
    loudly here rather than the Runner silently reinterpreting it as
    whatever assignment count it happens to contain. Ported from a version
    of this check that validated the raw, not-yet-normalized payload
    (spartanshub#311) - kept here as a lighter check on top of
    camPlate.py's existing _normalize_assignments instead of replacing that
    normalization step, which also tolerates payload shapes (a "parts" key,
    alternate id field names) this stricter check was never meant to cover.
    """
    if grouping_mode not in ('single', 'grouped'):
        raise ValueError('Plate CAM requires an explicit single or grouped mode')
    if grouping_mode == 'single' and len(assignments) != 1:
        raise ValueError('Single-part CAM requires exactly one assignment')
    if grouping_mode == 'grouped' and len(assignments) < 2:
        raise ValueError('Grouped CAM requires at least two distinct part types')
    part_ids = [assignment['part_id'] for assignment in assignments]
    if len(set(part_ids)) != len(part_ids):
        raise ValueError('Grouped CAM assignments must have distinct part IDs')


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
