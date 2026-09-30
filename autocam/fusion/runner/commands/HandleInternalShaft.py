"""Build Fusion turning setups for an internal shaft from its own imported body.

An internal shaft is hex bar stock with a plain round journal turned at each
end - the end is turned down to exactly the hex's own inscribed diameter, over
a short length, and there is no snap-ring groove. It is its own CAM type,
separate from HandleHexShaft.py's grooved hex shaft and HandleSpacer.py's
round-bar spacer, but it is built on the same machinery as the hex shaft
(build_shaft_setups): the same real hex-prism stock, the lathe WCS with +Z out
of the tip, the right-hand turning tool with real turret numbers and TL-1
cutting data, the chuck fixture, and a last-setup part-off that severs the
finished shaft from the carried grip excess.

What differs from a hex shaft, per end:

- The feature found in the model is the round journal (a cylinder at the
  hex's inscribed radius, running from the tip to where the hex begins), not a
  groove. Its length is how far the neck turning runs.
- Face -> Profile Roughing -> Profile Finishing only; there is no Single Groove
  operation and no groove suppression on the profile passes.
- Nothing is sized from a groove, so the insert used for the last setup's
  part-off is a fixed parting blade width (HandleHexShaft._PART_OFF_BLADE_IN).
- Setups are named "Internal Shaft" / "Internal Shaft - End 1" / "- End 2".

A model with a journal at each end gets two setups (re-chucked for the second
end); one journal gets one. Blank stock fields and the tailstock length are
derived from the model exactly as for a hex shaft (StockMath.py).
"""

from .HandleHexShaft import END_FEATURE_JOURNAL, build_shaft_setups


def handleInternalShaft(tailstock_length_in=None, stock=None):
    """Create the turning setup(s) that face and neck-turn the round ends of
    an internal shaft. Same arguments and return shape as handleHexShaft, with
    ``ends`` entries of ``journalLength``, ``journalDiameter`` and ``operations``
    instead of the groove fields.
    """
    return build_shaft_setups(tailstock_length_in, stock, END_FEATURE_JOURNAL)
