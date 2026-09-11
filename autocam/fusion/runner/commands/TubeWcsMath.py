"""Pure WCS math for the four indexed tube setups - no Fusion API dependency.

Kept Fusion-independent for the same reason as TubeHeightMath.py: the rule
has to be unit tested, and HandleTube.py only runs inside Fusion.

The reviewed tube setup puts the WCS origin on the right-hand corner of the
machined exterior face at one end of the tube, with X along the tube and both
X and Y pointing away from the stock - every point of the tube sits at
X <= 0, Y <= 0. The tube cutoff runs along the opposite (far) end.
"""


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def tube_wcs_axes(face_normal, toward_origin_end):
    """Return the (x, y) unit directions for one tube setup's WCS.

    ``face_normal`` is the machined exterior face's outward normal (WCS +Z).
    ``toward_origin_end`` is the tube axis pointing at the end the origin
    sits on. X always runs along the tube toward that end and Y = Z x X
    completes a right-handed frame; with the corner from ``pick_origin_corner``
    both point away from the stock and the origin is the face's right-hand
    corner. The only other outward-facing frame - the along-tube axis on Y -
    moves the origin to the left-hand corner, which the operator rejected.
    """
    x = tuple(toward_origin_end)
    return x, _cross(face_normal, x)


def pick_origin_corner(origins_by_label, x, y, tolerance=1e-3):
    """Return the box-point label whose WCS origin is furthest along both x and y.

    ``origins_by_label`` maps each candidate label (e.g. Fusion's "top 1".."top 4")
    to the origin Fusion reported for it. Only the candidates are compared
    with each other, so their shared units never matter. Fusion's own
    corner numbering is never assumed; exactly one corner must win on both
    axes, otherwise the setup is refused rather than zeroed on a wrong corner.
    """
    best_x = max(_dot(origin, x) for origin in origins_by_label.values())
    best_y = max(_dot(origin, y) for origin in origins_by_label.values())
    matches = [
        label
        for label, origin in origins_by_label.items()
        if _dot(origin, x) >= best_x - tolerance and _dot(origin, y) >= best_y - tolerance
    ]
    if len(matches) != 1:
        raise ValueError(
            "Expected exactly one top corner furthest along WCS +X and +Y; got {}".format(matches)
        )
    return matches[0]
