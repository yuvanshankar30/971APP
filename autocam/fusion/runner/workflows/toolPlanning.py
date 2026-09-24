"""Conservative tool selection for ShopSabre multi-tool plate CAM.

Loaded tools are candidates, not a mandate to run every cutter.  The planner
keeps the fastest broad cutter plus one genuinely smaller detail cutter; any
middle-sized cutter is dominated for the shipped plate strategies (roughing
and rest/detail machining) and would only add an ATC cycle.
"""

from typing import Optional


def _diameter(tool: dict) -> Optional[float]:
    try:
        return float((tool.get("geometry") or {}).get("DC"))
    except (TypeError, ValueError):
        return None


def _is_sized(tool: dict) -> bool:
    # Mirrors templateTools.py's own _is_sized_description: the shop's
    # established convention for flagging its one dimensioned/toleranced-
    # hole cutter (real library: "4mm sized for toolchager", tool number 6).
    # Direct instruction: that tool is reserved for genuinely sized holes
    # from now on, never a general roughing/detail default - excluded from
    # the ordinary diameter-driven roughing/detail picks below so a tie
    # against an identically-sized general-purpose tool (the real library's
    # own 971 Main Bit, also 0.1575in) can no longer silently win "detail"
    # by list order alone, the exact bug this comment replaces.
    return "sized" in str(tool.get("description") or "").lower()


def _feed(tool: dict) -> float:
    for preset in (tool.get("start-values") or {}).get("presets") or []:
        try:
            feed = float(preset.get("v_f"))
            if feed > 0:
                return feed
        except (TypeError, ValueError):
            pass
    return 0.0


def _rate(tool: dict) -> float:
    # Programmed feed alone, used only to break a tie between two tools of
    # the *same* diameter - never to outrank diameter itself. Width of cut
    # for these shipped strategies (contour2d/adaptive2d/pocket2d) scales
    # with the tool's own diameter (stepover is a percentage of it), so a
    # genuinely bigger tool clears more material per pass regardless of
    # whatever linear feed rate its library entry happens to be programmed
    # with. Real counterexample confirmed against this exact library: the
    # 6mm endmill (dia 0.2362in, feed 100) computes a higher diameter*feed
    # product than the 0.25in endmill (feed 60) - 23.6 vs 15.0 - despite
    # being the physically smaller tool. Ranking by that product picked the
    # smaller tool as "roughing" and discarded the actually-larger one as
    # dominated, backwards from this module's own stated intent.
    return _feed(tool)


def plan_endmills(tools: list[dict], *, multi_tool_mode: bool) -> dict:
    """Return the non-dominated cutters for a routing template.

    Single-tool jobs retain their one supplied cutter.  Multi-tool jobs use
    one high-throughput roughing cutter and, only when materially smaller, one
    detail/rest cutter. The caller still removes empty operations after Fusion
    recognizes actual geometry, so an available detail cutter never forces a
    physical tool change when the part has no detail it can reach.
    """
    endmills = [tool for tool in tools if _diameter(tool) and "end mill" in str(tool.get("type") or "").lower()]
    if not endmills:
        return {"tools": [], "reason": "no endmills"}
    if not multi_tool_mode:
        return {"tools": [endmills[0]], "reason": "single-tool mode"}

    # The "sized" cutter (see _is_sized) is reserved for genuinely sized
    # holes, not this roughing/detail diameter optimization - pick roughing
    # and detail from the general-purpose candidates only, so a same-
    # diameter sized tool can never win "detail" over a real general-
    # purpose tool by tie order. Falls back to every loaded endmill only
    # when nothing non-"sized" is loaded at all, so a job that loaded only
    # the sized cutter still gets a usable plan instead of an empty one.
    general = [tool for tool in endmills if not _is_sized(tool)] or endmills

    # Diameter first, feed only as a tiebreak among equal-diameter tools -
    # see _rate's docstring for the real, confirmed case this fixes.
    roughing = max(general, key=lambda tool: (_diameter(tool) or 0.0, _rate(tool)))
    detail = min(general, key=lambda tool: _diameter(tool) or float("inf"))
    chosen = [roughing]
    # A near-identical cutter cannot unlock tighter geometry. Avoid paying an
    # ATC cycle for it; 10% is deliberately below the library's 4 mm vs 6 mm
    # distinction while treating duplicate/similar tools as interchangeable.
    if detail is not roughing and (_diameter(detail) or 0) < (_diameter(roughing) or 0) * 0.9:
        chosen.append(detail)
    # A loaded "sized" cutter is never picked by the roughing/detail
    # optimization above (it's excluded from `general`), but it's still a
    # real tool the operator selected for this job - keep it in the ATC
    # plan unconditionally so the dedicated sized-hole operation can still
    # resolve it, independent of whatever roughing/detail diameters were
    # chosen for everything else.
    for tool in endmills:
        if _is_sized(tool) and tool not in chosen:
            chosen.append(tool)
    return {
        "tools": chosen,
        "reason": "roughing plus detail" if len(chosen) >= 2 else "one cutter dominates loaded alternatives",
        "skipped_guids": [tool.get("guid") for tool in endmills if tool not in chosen],
    }
