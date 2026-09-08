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

    # Diameter first, feed only as a tiebreak among equal-diameter tools -
    # see _rate's docstring for the real, confirmed case this fixes.
    roughing = max(endmills, key=lambda tool: (_diameter(tool) or 0.0, _rate(tool)))
    detail = min(endmills, key=lambda tool: _diameter(tool) or float("inf"))
    chosen = [roughing]
    # A near-identical cutter cannot unlock tighter geometry. Avoid paying an
    # ATC cycle for it; 10% is deliberately below the library's 4 mm vs 6 mm
    # distinction while treating duplicate/similar tools as interchangeable.
    if detail is not roughing and (_diameter(detail) or 0) < (_diameter(roughing) or 0) * 0.9:
        chosen.append(detail)
    return {
        "tools": chosen,
        "reason": "roughing plus detail" if len(chosen) == 2 else "one cutter dominates loaded alternatives",
        "skipped_guids": [tool.get("guid") for tool in endmills if tool not in chosen],
    }
