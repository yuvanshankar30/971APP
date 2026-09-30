"""Pure math for turning stock chosen at queue time - no Fusion API dependency.

Every value an operator can set (bar length, OD/ID, hex across-flats, tailstock
length) is optional; anything left blank is derived from the imported model.
Kept Fusion-independent so the rules can be unit tested, same reasoning as
SpacerMath.py and HexShaftMath.py.
"""

import math

CM_PER_IN = 2.54

# How much a set bar length and a set tailstock length may disagree before the
# job is refused rather than one silently winning (they describe the same
# material behind the part).
GRIP_AGREEMENT_TOLERANCE_IN = 0.02


def resolve_grip_cm(
    model_length_cm, front_allowance_cm, stock_length_cm, tailstock_cm, default_cm, minimum_cm,
):
    """Length of raw material carried behind the finished part (the grip /
    tailstock-support excess), in cm.

    A set stock_length_cm defines it: everything past the part and the
    front-facing allowance. Otherwise a set tailstock_cm does, otherwise
    default_cm. When both are set they must agree within
    GRIP_AGREEMENT_TOLERANCE_IN, since they name the same material.
    """
    if stock_length_cm is not None:
        grip_cm = stock_length_cm - model_length_cm - front_allowance_cm
        if tailstock_cm is not None and abs(tailstock_cm - grip_cm) > GRIP_AGREEMENT_TOLERANCE_IN * CM_PER_IN:
            raise ValueError(
                "Stock length {:.3f}in leaves {:.3f}in behind the {:.3f}in part, but the tailstock "
                "length is {:.3f}in - set one of them, or make them agree.".format(
                    stock_length_cm / CM_PER_IN, grip_cm / CM_PER_IN,
                    model_length_cm / CM_PER_IN, tailstock_cm / CM_PER_IN,
                )
            )
    elif tailstock_cm is not None:
        grip_cm = tailstock_cm
    else:
        grip_cm = default_cm
    if grip_cm < minimum_cm - 1e-9:
        raise ValueError(
            "Stock leaves {:.3f}in of material behind the part for the chuck to hold; "
            "at least {:.3f}in is required.".format(grip_cm / CM_PER_IN, minimum_cm / CM_PER_IN)
        )
    return grip_cm


# Auto-chosen bar diameter: the part's OD plus this, rounded up to the next
# 1/16in - a real bar size close to the part, unlike Fusion's own default of
# rounding up to the next 10mm (a 10mm spacer got 20mm stock).
_AUTO_OD_MARGIN_IN = 0.0625
_AUTO_OD_STEP_IN = 0.0625
_DIAMETER_TOLERANCE_IN = 0.001


def auto_stock_od_cm(model_od_cm):
    steps = math.ceil((model_od_cm / CM_PER_IN + _AUTO_OD_MARGIN_IN) / _AUTO_OD_STEP_IN - 1e-9)
    return steps * _AUTO_OD_STEP_IN * CM_PER_IN


def resolve_spacer_stock(
    model_od_cm, model_id_cm, model_length_cm, front_allowance_cm, default_grip_cm, minimum_grip_cm,
    stock_od_cm=None, stock_id_cm=None, stock_length_cm=None, tailstock_cm=None,
):
    """Stock for a spacer: {"od_cm", "id_cm", "length_cm", "grip_cm", "drill_needed"}.

    model_id_cm is 0 for a solid spacer. A set stock ID means tube stock; a
    stock already bored to the part's own bore needs no Drill operation.
    """
    tolerance_cm = _DIAMETER_TOLERANCE_IN * CM_PER_IN
    od_cm = stock_od_cm if stock_od_cm is not None else auto_stock_od_cm(model_od_cm)
    if od_cm < model_od_cm - tolerance_cm:
        raise ValueError(
            "Stock OD {:.3f}in is smaller than the {:.3f}in part.".format(od_cm / CM_PER_IN, model_od_cm / CM_PER_IN)
        )
    has_hole = model_id_cm > tolerance_cm
    id_cm = stock_id_cm if stock_id_cm is not None else 0.0
    if id_cm > tolerance_cm:
        if not has_hole:
            raise ValueError("Stock ID is set but the part has no bore; leave the stock ID blank for solid stock.")
        if id_cm > model_id_cm + tolerance_cm:
            raise ValueError(
                "Stock ID {:.3f}in is larger than the part's {:.3f}in bore.".format(
                    id_cm / CM_PER_IN, model_id_cm / CM_PER_IN
                )
            )
        if id_cm >= od_cm:
            raise ValueError("Stock ID must be smaller than the stock OD.")
    grip_cm = resolve_grip_cm(
        model_length_cm, front_allowance_cm, stock_length_cm, tailstock_cm, default_grip_cm, minimum_grip_cm,
    )
    return {
        "od_cm": od_cm,
        "id_cm": id_cm,
        "length_cm": model_length_cm + front_allowance_cm + grip_cm,
        "grip_cm": grip_cm,
        "drill_needed": has_hole and id_cm < model_id_cm - tolerance_cm,
    }


def check_hex_across_flats(model_across_flats_cm, stock_across_flats_cm):
    """A hex shaft's flats are the bar's own surface and are never machined,
    so a bar of a different size cannot produce this part."""
    if stock_across_flats_cm is None:
        return
    if abs(stock_across_flats_cm - model_across_flats_cm) > 0.005 * CM_PER_IN:
        raise ValueError(
            "Hex stock is {:.3f}in across flats but the part is {:.3f}in: the flats are the bar's own "
            "surface and are not machined, so the bar must match the part.".format(
                stock_across_flats_cm / CM_PER_IN, model_across_flats_cm / CM_PER_IN
            )
        )
