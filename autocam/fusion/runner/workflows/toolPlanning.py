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
    # Width of cut times programmed feed is a conservative, unit-consistent
    # proxy for planar material-removal rate when axial engagement is shared.
    return (_diameter(tool) or 0.0) * _feed(tool)


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

    roughing = max(endmills, key=lambda tool: (_rate(tool), _diameter(tool) or 0.0))
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
