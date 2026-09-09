import copy
import importlib.util
import json
import os
import re
import xml.etree.ElementTree as ET
from typing import Any, Callable, Iterable, Optional, Tuple
try:
    from .toolPlanning import plan_endmills
except ImportError:
    # Unit tests load this file directly rather than as the workflows package.
    _planner_spec = importlib.util.spec_from_file_location(
        "toolPlanning", os.path.join(os.path.dirname(__file__), "toolPlanning.py")
    )
    _planner = importlib.util.module_from_spec(_planner_spec)
    _planner_spec.loader.exec_module(_planner)
    plan_endmills = _planner.plan_endmills


_TEMPLATE_NS = "http://www.hsmworks.com/namespace/hsmworks/document/template"
_NUM_RE = re.compile(r"[-+]?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][-+]?\d+)?")

# Keep newly generated Fusion Router toolpaths conservative while the team
# validates the templates on the physical machine. This applies to every
# cutting motion, including the through-slot operation, without changing
# spindle speed or the reviewed source values in the tool library.
#
# Started at 0.5 (half of the tool library's own programmed feeds). Direct
# feedback after watching a real generated job run: still visibly too fast
# on the slot/contour cutting motion even at that reduction. Dropped to
# 0.25 (quarter of the original) - still a real, working feed (the tool
# library's own baseline, e.g. 80 in/min main cutting feed -> 20 in/min),
# not a token gesture.
_ROUTER_FEED_RATE_SCALE = 0.25
_FEED_PRESET_KEYS = (
    "v_f",
    "v_f_leadIn",
    "v_f_leadOut",
    "v_f_transition",
    "v_f_plunge",
    "v_f_ramp",
    "v_f_retract",
)

# A real "Bore" operation exported directly from Fusion (Setup > 2D > Bore,
# right-click > Save as Template) - see templates/Bore.f3dhsm-template's own
# history for why this exists as a separate file instead of guessed inline
# XML. strategy="bore" was confirmed this way after an earlier guess
# (strategy="circular") produced a real, wrong toolpath (a zigzag covering
# almost an entire plate) in live testing - Fusion's internal strategy
# names for hole-milling operations aren't derivable from the API's public
# docs alone, they need a real exported example.
_BORE_TEMPLATE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "templates", "Bore.f3dhsm-template"
)
_COUNTERSINK_TEMPLATE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "templates", "971-real", "countersink.f3dhsm-template"
)


def _q(tag: str) -> str:
    return f"{{{_TEMPLATE_NS}}}{tag}"


def _load_bore_template() -> Optional[ET.Element]:
    """Loads templates/Bore.f3dhsm-template's single <template strategy="bore">
    element fresh each call (the caller mutates/inserts it, so it can't be
    cached and reused across jobs).
    """
    path = os.path.normpath(_BORE_TEMPLATE_PATH)
    if not os.path.isfile(path):
        return None
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return None
    return _find_template(tree.getroot(), strategy="bore")


def _load_countersink_template() -> Optional[ET.Element]:
    """Load the real exported ShopSabre countersink operation."""
    path = os.path.normpath(_COUNTERSINK_TEMPLATE_PATH)
    if not os.path.isfile(path):
        return None
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return None
    return _find_template(tree.getroot(), strategy="drill")


def _as_bool_str(value: Any) -> str:
    return "true" if bool(value) else "false"


def _as_int01_str(value: Any) -> str:
    return "1" if bool(value) else "0"


def _fmt_num(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return _as_int01_str(value)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        # Match the precision typically seen in Fusion template files.
        return f"{value:.8g}"
    return str(value)


def _parse_number(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    match = _NUM_RE.search(value)
    if not match:
        return None
    try:
        return float(match.group(0))
    except Exception:
        return None


# Entry moves (plunge straight down, ramp helically in) engage far more of
# the tool at once than a horizontal cut does, so a CAM preset deliberately
# programs them SLOWER than the cutting feed. Every reviewed preset in this
# project's own tool library follows that rule with a wide margin - ramp at
# 1/4 and plunge at 1/6 of the cutting feed, consistently across all 8
# materials.
#
# This ceiling exists because collapsing that margin caused real damage, not
# a hypothetical: issue #360 records an attempt to make feed/speed "not vary
# between operations" that forced every motion type - plunge included - to
# the base cutting feed. On a real test cut the bit flew through the stock
# and ripped it instead of entering under control, on the plunge move
# specifically.
#
# 0.5 is deliberately far looser than any real preset needs (the tightest is
# 0.25) so it can never reject legitimate cutting data someone tunes later -
# it exists to catch the specific failure mode of an entry feed being raised
# to, or near, the cutting feed.
_MAX_ENTRY_FEED_FRACTION_OF_CUTTING = 0.5
_ENTRY_FEED_KEYS = ("v_f_plunge", "v_f_ramp")


def assert_safe_entry_feeds(preset: dict, context: str = "") -> None:
    """Raise if a preset's plunge/ramp feed is not safely below its cutting
    feed. See _MAX_ENTRY_FEED_FRACTION_OF_CUTTING for why this is enforced
    rather than trusted.

    Only validates values that are actually present and positive - a preset
    that simply doesn't program an entry feed is left alone rather than
    failed on missing data, which would turn a documentation gap into a
    refusal to cut.
    """
    cutting = _parse_number(preset.get("v_f"))
    if cutting is None or cutting <= 0:
        return
    ceiling = cutting * _MAX_ENTRY_FEED_FRACTION_OF_CUTTING
    where = f" for {context}" if context else ""
    for key in _ENTRY_FEED_KEYS:
        value = _parse_number(preset.get(key))
        if value is None or value <= 0:
            continue
        # Presets at exactly the approved boundary can acquire a microscopic
        # rounding residue after the conservative rate scale (for example
        # 30 * .25 vs. 60 * .25). Do not turn that equal-value case into a
        # false unsafe-feed failure, while retaining the real upper bound.
        if value > ceiling + 1e-9:
            raise ValueError(
                f"Unsafe {key}{where}: {value:g} is more than "
                f"{_MAX_ENTRY_FEED_FRACTION_OF_CUTTING:g}x the cutting feed "
                f"({cutting:g}). Entry moves engage the whole tool at once and "
                "must stay well below the cutting feed - see issue #360, where "
                "raising them to the cutting feed tore through real stock."
            )


def _conservative_router_preset(preset: dict) -> dict:
    """Copy a tool preset with every programmed feed reduced for the router.

    Scaling every feed by the same factor preserves the preset's own
    plunge:cutting and ramp:cutting ratios; the safety check afterward
    confirms that, and catches a preset whose ratios were unsafe to begin
    with before any of it reaches a real machine.
    """
    scaled = copy.deepcopy(preset)
    for key in _FEED_PRESET_KEYS:
        value = _parse_number(scaled.get(key))
        if value is not None:
            scaled[key] = value * _ROUTER_FEED_RATE_SCALE
    assert_safe_entry_feeds(scaled, str(preset.get("name") or "this preset"))
    return scaled


def _normalize_desc(value: str) -> str:
    value = (value or "").strip().lower()
    # Normalize whitespace and quote variants.
    value = value.replace("“", '"').replace("”", '"').replace("’", "'")
    value = re.sub(r"\s+", " ", value)
    return value


def _material_aliases(material_name: str) -> list[str]:
    name = (material_name or "").strip().lower()
    aliases: list[str] = []
    if not name:
        return aliases

    if any(token in name for token in ("aluminum", "aluminium", "6061")) or name in (
        "al",
        "alu",
        "alum",
    ):
        # Deliberately NOT a bare "al" substring check - that false-matched
        # "Baltic Birch Plywood" (contains "al" in "baltic") and "Delrin
        # (Acetal)" (contains "al" in "acetal"), silently routing both to
        # the aluminum preset. Found by testing _choose_preset against every
        # real cam_materials name after adding presets for them.
        aliases.extend(["aluminium", "aluminum", "alum", "alu", "6061"])
    if (
        "polycarb" in name
        or "lexan" in name
        or "pc" == name
        or ("poly" in name and "propylene" not in name)
    ):
        aliases.extend(["polycarb", "polycarbonate", "pc", "lexan"])
    if "mdf" in name:
        aliases.append("mdf")
    if "acrylic" in name:
        aliases.extend(["acrylic", "pmma"])
    if "srpp" in name:
        aliases.append("srpp")
    if any(token in name for token in ("wood", "plywood", "birch")):
        aliases.extend(["wood", "plywood", "birch"])
    if "delrin" in name or "acetal" in name:
        aliases.extend(["delrin", "acetal"])
    if "nylon" in name:
        aliases.append("nylon")

    # Also try the raw material name.
    aliases.append(name)
    # Deduplicate while preserving order.
    seen = set()
    out: list[str] = []
    for a in aliases:
        if not a or a in seen:
            continue
        seen.add(a)
        out.append(a)
    return out


def _choose_preset(tool: dict, material_name: Optional[str]) -> Optional[dict]:
    presets = tool.get("start-values", {}).get("presets", [])
    if not isinstance(presets, list) or not presets:
        raise ValueError(f"{_tool_display_name(tool)} has no reviewed feed/speed presets")

    aliases = _material_aliases(material_name or "")
    if not aliases:
        raise ValueError(
            f"A material is required to choose a reviewed feed/speed preset for {_tool_display_name(tool)}"
        )

    # Never use a substring as short as "al" here: it matches the "al" in
    # "Default preset", silently selecting aluminum cutting data for any
    # material whose aliases happen to include it. A job without an explicit,
    # reviewed match must stop before Fusion creates a dangerous toolpath.
    for preset in presets:
        preset_name = _normalize_desc(str(preset.get("name") or ""))
        if any(len(alias) >= 3 and alias in preset_name for alias in aliases):
            return preset

    # The checked-in 971 Main Bit's historic "Default preset" is the
    # reviewed Aluminum 6061 setting. Keep that legacy library usable for
    # aluminum only, while requiring every other material to have a named
    # preset. This exception is deliberately narrow; a generic default is
    # never permission to cut an unreviewed material.
    normalized_material = _normalize_desc(material_name or "")
    if normalized_material in {"aluminum", "aluminium", "aluminum 6061", "aluminium 6061", "6061 aluminum", "6061 aluminium"}:
        for preset in presets:
            if _normalize_desc(str(preset.get("name") or "")) == "default preset":
                return preset

    raise ValueError(
        f"No reviewed feed/speed preset for {material_name!r} on {_tool_display_name(tool)}; "
        "add a named preset before queueing this material"
    )


def _tool_type_lower(tool: dict) -> str:
    return str(tool.get("type") or "").lower()


def _tool_diameter(tool: dict) -> Optional[float]:
    geometry = tool.get("geometry")
    if isinstance(geometry, dict):
        diameter = _parse_number(geometry.get("DC"))
        if diameter is not None:
            return diameter

    expressions = tool.get("expressions")
    if isinstance(expressions, dict):
        diameter = _parse_number(expressions.get("tool_diameter"))
        if diameter is not None:
            return diameter

    return None


def _tool_matches_keyword(tool: dict, keywords: Iterable[str]) -> bool:
    tool_type = _tool_type_lower(tool)
    return any(keyword in tool_type for keyword in keywords)


def _select_tools(
    indexes: list[dict], predicate: Callable[[dict], bool]
) -> list[Tuple[dict, dict, Optional[float]]]:
    selected: list[Tuple[dict, dict, Optional[float]]] = []
    for idx in indexes:
        tools = idx.get("tools")
        if not isinstance(tools, list):
            continue
        for tool in tools:
            if not isinstance(tool, dict):
                continue
            if not predicate(tool):
                continue
            diameter = _tool_diameter(tool)
            selected.append((tool, idx, diameter))
    return selected


def _is_drill_tool(tool: dict) -> bool:
    return _tool_matches_keyword(tool, ("drill",))


def _is_endmill_tool(tool: dict) -> bool:
    return _tool_matches_keyword(tool, ("end mill", "endmill"))


def _is_countersink_tool(tool: dict) -> bool:
    return _tool_matches_keyword(tool, ("counter sink", "countersink"))


def _tool_display_name(tool: dict) -> str:
    description = (tool.get("description") or "").strip()
    if description:
        return description
    diameter = _tool_diameter(tool)
    if diameter is not None:
        return f"{_fmt_num(diameter)} in"
    return _tool_type_lower(tool).strip() or "tool"


def _clone_template(template_elem: ET.Element) -> ET.Element:
    return copy.deepcopy(template_elem)


def _replace_template(
    root: ET.Element, base: ET.Element, clones: list[ET.Element]
) -> None:
    if not clones:
        return
    children = list(root)
    if base not in children:
        return
    index = children.index(base)
    root.remove(base)
    for clone in reversed(clones):
        root.insert(index, clone)


def _set_rest_machining(template_elem: ET.Element, enabled: bool = True) -> None:
    # The pocket_new template's own baked-in default for useRestMachining is
    # "true" (confirmed by reading Plates.f3dhsm-template directly) - so
    # simply not calling this for the first/largest tool clone is not
    # enough, it leaves the template's own default of true in place. The
    # first clone needs useRestMachining explicitly forced to false.
    value = "true" if enabled else "false"
    for parameter in template_elem.findall(_q("parameter")):
        if parameter.get("name") == "useRestMachining":
            parameter.set("expression", value)


def _unit_suffix_from_tool(tool_elem: Optional[ET.Element]) -> str:
    if tool_elem is None:
        return "in"
    unit = (tool_elem.get("unit") or "").strip().lower()
    if "mm" in unit:
        return "mm"
    if "inch" in unit:
        return "in"
    return "in"


def _format_diameter_expression(value: float, suffix: str) -> str:
    expr = _fmt_num(value)
    if suffix:
        expr = f"{expr}{suffix}"
    return expr


def _set_drill_diameter_range(template_elem: ET.Element, diameter: float) -> None:
    if diameter is None:
        return
    tool_elem = template_elem.find(_q("tool"))
    suffix = _unit_suffix_from_tool(tool_elem)
    min_value = diameter - 0.003
    max_value = diameter + 0.003
    min_expr = _format_diameter_expression(min_value, suffix)
    max_expr = _format_diameter_expression(max_value, suffix)
    for parameter in template_elem.findall(_q("parameter")):
        name = parameter.get("name")
        if name == "holeDiameterMinimum":
            parameter.set("expression", min_expr)
        elif name == "holeDiameterMaximum":
            parameter.set("expression", max_expr)


# Generous-but-bounded cap on what counts as a "small hole" for the Bore
# fallback below - covers real FRC mounting/bolt hole sizes (the real
# exported Bore.f3dhsm-template used 0.188-0.4999in for one example) without
# reaching into sizes that should actually be a deliberate pocket.
_MAX_BORE_HOLE_DIAMETER_IN = 0.75

# Mirrors DeleteToolpaths.py's own "<.3"/"&gt;.3" naming convention (see
# that file's _MIN_HOLE_DIAMETER_NAME_THRESHOLDS_IN) for the opposite
# direction: the New Router template's own dedicated small-hole Bore
# operation is literally named "<.3 Circluar Through Hole" (sic - matches
# the real template file's own typo), so its own upper recognition bound
# should read from its own name rather than defaulting to the generic
# _MAX_BORE_HOLE_DIAMETER_IN meant for a template with no such op at all.
_SMALL_HOLE_MAX_DIAMETER_NAME_MARKERS_IN = (
    ("<.3", 0.3),
    ("&lt;.3", 0.3),  # XML-escaped '<' - a description can come through either way
)


def _small_hole_max_diameter_in(description: Optional[str]) -> Optional[float]:
    lower = (description or "").lower()
    for marker, threshold_in in _SMALL_HOLE_MAX_DIAMETER_NAME_MARKERS_IN:
        if marker in lower:
            return threshold_in
    return None


def _set_hole_diameter_range(template_elem: ET.Element, min_diameter: float, max_diameter: float) -> None:
    """Like _set_drill_diameter_range, but an explicit range independent of
    the assigned tool's own diameter. A drill bit only cuts the one hole
    size it's ground for, so the old range (matched diameter +/- .003) was
    right for that. A bored hole (Bore strategy) isn't limited that way -
    the tool machines the hole's actual recognized size via helical
    interpolation - so this widens recognition instead of pinning it to one
    size.
    """
    tool_elem = template_elem.find(_q("tool"))
    suffix = _unit_suffix_from_tool(tool_elem)
    min_expr = _format_diameter_expression(min_diameter, suffix)
    max_expr = _format_diameter_expression(max_diameter, suffix)
    for parameter in template_elem.findall(_q("parameter")):
        name = parameter.get("name")
        if name == "holeDiameterMinimum":
            parameter.set("expression", min_expr)
        elif name == "holeDiameterMaximum":
            parameter.set("expression", max_expr)


def _find_template(
    root: ET.Element,
    *,
    strategy: Optional[str] = None,
    description: Optional[str] = None,
) -> Optional[ET.Element]:
    for template_elem in root.findall(f".//{_q('template')}"):
        if strategy is not None and template_elem.get("strategy") != strategy:
            continue
        if description is not None and template_elem.get("description") != description:
            continue
        return template_elem
    return None


def load_tool_library_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise TypeError(f"Tool library JSON must be an object, got {type(data)}")
    return data


def _index_tools(
    tool_library: dict,
    filter_guids: Optional[set[str]] = None,
) -> dict:
    tools = tool_library.get("data")
    if not isinstance(tools, list):
        tools = []

    # Filter tools by GUID if filter_guids is provided
    if filter_guids is not None:
        tools = [
            tool for tool in tools
            if isinstance(tool, dict) and tool.get("guid") in filter_guids
        ]

    by_desc: dict[str, dict] = {}
    by_type: dict[str, list[dict]] = {}
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        desc = _normalize_desc(str(tool.get("description") or ""))
        if desc and desc not in by_desc:
            by_desc[desc] = tool
        tool_type = str(tool.get("type") or "")
        by_type.setdefault(tool_type, []).append(tool)

    return {
        "version": tool_library.get("version"),
        "tools": tools,
        "by_desc": by_desc,
        "by_type": by_type,
    }


def _required_tool_signature(tool_elem: ET.Element) -> dict:
    desc = (tool_elem.findtext(_q("description")) or "").strip()
    tool_type = str(tool_elem.get("type") or "").strip()

    diameter = None
    for expr in tool_elem.findall(f"{_q('expressions')}/{_q('expression')}"):
        if expr.get("parameterKey") == "tool_diameter":
            diameter = _parse_number(expr.get("value"))
            break

    return {
        "description": desc,
        "type": tool_type,
        "diameter": diameter,
    }


def _find_matching_tool(
    signature: dict, indexes: list[dict]
) -> Optional[tuple[dict, dict]]:
    desc = _normalize_desc(signature.get("description") or "")
    tool_type = signature.get("type") or ""
    diameter = signature.get("diameter")

    if desc:
        for idx in indexes:
            tool = idx["by_desc"].get(desc)
            if tool:
                return tool, idx

    if diameter is None:
        return None

    for idx in indexes:
        candidates = idx["by_type"].get(tool_type, [])
        for tool in candidates:
            tool_dia = _parse_number(tool.get("geometry", {}).get("DC"))
            if tool_dia is None:
                tool_dia = _parse_number(
                    tool.get("expressions", {}).get("tool_diameter")
                )
            if tool_dia is None:
                continue
            if abs(tool_dia - float(diameter)) <= 1e-4:
                return tool, idx

    return None


def _strip_outer_quotes(value: str) -> str:
    value = (value or "").strip()
    if len(value) >= 2 and (
        (value[0] == value[-1] == "'") or (value[0] == value[-1] == '"')
    ):
        return value[1:-1]
    return value


def _ensure_child(parent: ET.Element, tag: str) -> ET.Element:
    child = parent.find(_q(tag))
    if child is None:
        child = ET.SubElement(parent, _q(tag))
    return child


def _reset_children(elem: ET.Element) -> None:
    for child in list(elem):
        elem.remove(child)


def _apply_tool_to_elem(
    template_elem: ET.Element,
    tool_elem: ET.Element,
    tool: dict,
    tool_library_version: Optional[Any],
    material_name: Optional[str],
) -> None:
    preset = _conservative_router_preset(_choose_preset(tool, material_name))

    tool_guid = tool.get("guid")
    if tool_guid:
        tool_elem.set("guid", str(tool_guid))

    tool_unit = str(tool.get("unit") or tool_elem.get("unit") or "inches")
    tool_elem.set("unit", tool_unit)

    tool_type = str(tool.get("type") or tool_elem.get("type") or "")
    if tool_type:
        tool_elem.set("type", tool_type)

    if tool_library_version is not None:
        tool_elem.set("tool-library-version", str(tool_library_version))

    tool_desc = str(tool.get("description") or "")
    desc_node = _ensure_child(tool_elem, "description")
    desc_node.text = tool_desc

    expressions_node = _ensure_child(tool_elem, "expressions")
    _reset_children(expressions_node)
    expressions = tool.get("expressions", {})
    if isinstance(expressions, dict):
        for key, value in expressions.items():
            expr = ET.SubElement(expressions_node, _q("expression"))
            expr.set("parameterKey", str(key))
            expr.set("value", str(value))

    post = tool.get("post-process", {})
    if not isinstance(post, dict):
        post = {}
    nc_node = _ensure_child(tool_elem, "nc")
    nc_node.set("break-control", _as_int01_str(post.get("break-control")))
    nc_node.set("diameter-offset", str(post.get("diameter-offset", 1)))
    nc_node.set("length-offset", str(post.get("length-offset", 1)))
    nc_node.set("live-tool", _as_int01_str(post.get("live")))
    nc_node.set("manual-tool-change", _as_int01_str(post.get("manual-tool-change")))
    nc_node.set("number", str(post.get("number", 1)))
    nc_node.set("turret", str(post.get("turret", 0)))

    coolant_mode = None
    if preset:
        coolant_mode = preset.get("tool-coolant")
    coolant_mode = str(coolant_mode or "disabled")
    coolant_node = _ensure_child(tool_elem, "coolant")
    coolant_node.set("mode", coolant_mode)

    material_expr = ""
    if isinstance(expressions, dict):
        material_expr = str(expressions.get("tool_material") or "")
    material_node = _ensure_child(tool_elem, "material")
    material_node.set("name", _strip_outer_quotes(material_expr) or "unspecified")

    geometry = tool.get("geometry", {})
    if not isinstance(geometry, dict):
        geometry = {}
    body_node = _ensure_child(tool_elem, "body")
    body_map = {
        "assembly-gauge-length": geometry.get("assemblyGaugeLength"),
        "body-length": geometry.get("LB"),
        "diameter": geometry.get("DC"),
        "flute-length": geometry.get("LCF"),
        "number-of-flutes": geometry.get("NOF"),
        "overall-length": geometry.get("OAL"),
        "shaft-diameter": geometry.get("SFDM"),
        "shoulder-length": geometry.get("shoulder-length"),
        "shoulder-diameter": geometry.get("shoulder-diameter"),
        "taper-angle": geometry.get("SIG"),
        "thread-pitch": geometry.get("TP"),
        "thread-profile-angle": geometry.get("thread-profile-angle"),
    }
    for attr, val in body_map.items():
        if val is None:
            continue
        body_node.set(attr, _fmt_num(val))

    # Best-effort motion + presets (Fusion will still load even if some values differ).
    motion_node = _ensure_child(tool_elem, "motion")
    if preset:
        n = _parse_number(preset.get("n")) or _parse_number(preset.get("n_ramp")) or 0
        n_ramp = _parse_number(preset.get("n_ramp")) or n
        v_f = _parse_number(preset.get("v_f")) or 0
        v_f_lead_in = _parse_number(preset.get("v_f_leadIn")) or v_f
        v_f_lead_out = _parse_number(preset.get("v_f_leadOut")) or v_f
        v_f_plunge = _parse_number(preset.get("v_f_plunge")) or 0
        v_f_ramp = _parse_number(preset.get("v_f_ramp")) or 0
        v_f_retract = _parse_number(preset.get("v_f_retract")) or 0
        v_f_transition = _parse_number(preset.get("v_f_transition")) or v_f

        ramp_angle_deg = _parse_number(preset.get("ramp-angle"))
        ramp_angle_internal = None
        if ramp_angle_deg is not None:
            # Fusion template files appear to store ramp angle in 5° units (10° -> 2).
            ramp_angle_internal = float(ramp_angle_deg) / 5.0

        motion_updates = {
            "cutting-feedrate": v_f,
            "entry-feedrate": v_f_lead_in,
            "exit-feedrate": v_f_lead_out,
            "plunge-feedrate": v_f_plunge,
            "ramp-feedrate": v_f_ramp,
            "retract-feedrate": v_f_retract,
            "transition-feedrate": v_f_transition,
            "spindle-rpm": n,
            "ramp-spindle-rpm": n_ramp,
        }
        for key, val in motion_updates.items():
            motion_node.set(key, _fmt_num(val))
        if ramp_angle_internal is not None:
            motion_node.set("ramp-angle", _fmt_num(ramp_angle_internal))

    presets_node = _ensure_child(tool_elem, "presets")
    _reset_children(presets_node)
    if preset and preset.get("guid"):
        preset_id = str(preset.get("guid"))
        template_elem.set("toolPresetId", f"{{{preset_id}}}")

        preset_node = ET.SubElement(presets_node, _q("preset"))
        preset_node.set("description", str(preset.get("description") or ""))
        preset_node.set("id", f"{{{preset_id}}}")
        preset_node.set("name", str(preset.get("name") or "Default preset"))

        preset_exprs = preset.get("expressions", {})
        if not isinstance(preset_exprs, dict):
            preset_exprs = {}

        def add_param(key: str, value: Any, expression: Optional[str] = None) -> None:
            param = ET.SubElement(preset_node, _q("parameter"))
            param.set("key", key)
            param.set("value", str(value))
            if expression is not None:
                param.set("expression", str(expression))

        tool_unit_is_inches = tool_unit.lower().startswith("inch")

        def mm_value(inches_value: float) -> float:
            return inches_value * 25.4 if tool_unit_is_inches else inches_value

        add_param(
            "tool_useFeedPerRevolution",
            _as_bool_str(preset.get("use-feed-per-revolution", False)),
        )

        coolant_expr = preset_exprs.get("tool_coolant") or f"'{coolant_mode}'"
        add_param("tool_coolant", coolant_mode, expression=coolant_expr)

        n = _parse_number(preset.get("n")) or 0
        n_expr = preset_exprs.get("tool_spindleSpeed") or (
            f"{_fmt_num(n)} rpm" if n else None
        )
        add_param("tool_spindleSpeed", _fmt_num(n), expression=n_expr)

        n_ramp = _parse_number(preset.get("n_ramp"))
        if n_ramp is not None:
            add_param("tool_rampSpindleSpeed", _fmt_num(n_ramp))

        v_f = _parse_number(preset.get("v_f"))
        if v_f is not None:
            v_f_expr = preset_exprs.get("tool_feedCutting")
            add_param("tool_feedCutting", _fmt_num(mm_value(v_f)), expression=v_f_expr)
            add_param(
                "tool_feedEntry",
                _fmt_num(mm_value(_parse_number(preset.get("v_f_leadIn")) or v_f)),
            )
            add_param(
                "tool_feedExit",
                _fmt_num(mm_value(_parse_number(preset.get("v_f_leadOut")) or v_f)),
            )
            add_param(
                "tool_feedTransition",
                _fmt_num(mm_value(_parse_number(preset.get("v_f_transition")) or v_f)),
            )

        v_f_plunge = _parse_number(preset.get("v_f_plunge"))
        if v_f_plunge is not None:
            v_f_plunge_expr = preset_exprs.get("tool_feedPlunge")
            add_param(
                "tool_feedPlunge",
                _fmt_num(mm_value(v_f_plunge)),
                expression=v_f_plunge_expr,
            )

        v_f_ramp = _parse_number(preset.get("v_f_ramp"))
        if v_f_ramp is not None:
            v_f_ramp_expr = preset_exprs.get("tool_feedRamp")
            add_param(
                "tool_feedRamp", _fmt_num(mm_value(v_f_ramp)), expression=v_f_ramp_expr
            )

        v_f_retract = _parse_number(preset.get("v_f_retract"))
        if v_f_retract is not None:
            add_param("tool_feedRetract", _fmt_num(mm_value(v_f_retract)))

        material_info = preset.get("material", {})
        if isinstance(material_info, dict):
            add_param(
                "tool_presetMaterialCategory",
                str(material_info.get("category") or "all"),
            )
            add_param("tool_presetMaterialQuery", str(material_info.get("query") or ""))

        stepdown = _parse_number(preset.get("stepdown"))
        if stepdown is not None:
            stepdown_expr = preset_exprs.get("tool_stepdown")
            add_param(
                "tool_stepdown", _fmt_num(mm_value(stepdown)), expression=stepdown_expr
            )

        stepover = _parse_number(preset.get("stepover"))
        if stepover is not None:
            stepover_expr = preset_exprs.get("tool_stepover")
            add_param(
                "tool_stepover", _fmt_num(mm_value(stepover)), expression=stepover_expr
            )

        ramp_angle_deg = _parse_number(preset.get("ramp-angle"))
        if ramp_angle_deg is not None:
            ramp_angle_expr = preset_exprs.get("tool_rampAngle")
            add_param(
                "tool_rampAngle",
                _fmt_num(float(ramp_angle_deg) / 5.0),
                expression=ramp_angle_expr,
            )

    if template_elem.get("strategy") == "drill":
        diameter = _tool_diameter(tool)
        if diameter is not None:
            _set_drill_diameter_range(template_elem, diameter)

    if preset:
        _set_template_level_feed_params(template_elem, preset)


# A real Fusion-exported template (any of templates/971-real/*.f3dhsm-template,
# unlike the minimal generic Plates.f3dhsm-template) carries its OWN
# top-level <template><parameter name="tool_spindleSpeed" expression="22000.">
# entries - a snapshot of whatever tool/preset was bound when it was
# originally exported - as siblings of the <tool> element, not inside it.
# Confirmed by direct inspection: patching one of these richer templates
# with a Lexan preset left every one of these top-level parameters at their
# original hardcoded values (22000 rpm, 40-60 in/min) - _apply_tool_to_elem
# only ever wrote into the nested <tool> element's own expressions/motion/
# presets data, never these template-level siblings. Confirmed this wasn't
# just a template-inspection artifact: a REAL Lexan job's actual posted
# G-code showed S13000/S18000 (Plates.f3dhsm-template's and Bore.f3dhsm-
# template's own hardcoded values), never the researched Lexan preset's
# 12000 rpm - every material-specific preset built this session had never
# actually been reaching real G-code output. Fixed by overwriting these
# top-level parameters directly from the same chosen preset, immediately
# after _apply_tool_to_elem finishes updating the tool's own data.
_TEMPLATE_LEVEL_FEED_PARAMS = {
    "tool_spindleSpeed": "n",
    "tool_rampSpindleSpeed": "n_ramp",
    "tool_feedCutting": "v_f",
    "tool_feedEntry": "v_f_leadIn",
    "tool_feedExit": "v_f_leadOut",
    "tool_feedTransition": "v_f_transition",
    "tool_feedPlunge": "v_f_plunge",
    "tool_feedRamp": "v_f_ramp",
    "tool_feedRetract": "v_f_retract",
}
# Parameters with no unit suffix in real exported templates (rpm is bare;
# every feed rate is "<number>in/min" - confirmed by direct inspection of
# templates/971-real/*.f3dhsm-template and templates/Plates.f3dhsm-template).
_TEMPLATE_LEVEL_FEED_PARAMS_NO_UNIT = {"tool_spindleSpeed", "tool_rampSpindleSpeed"}


def _set_template_level_feed_params(template_elem: ET.Element, preset: dict) -> None:
    fallback_v_f = _parse_number(preset.get("v_f"))
    fallback_n = _parse_number(preset.get("n"))
    values: dict[str, Optional[float]] = {}
    for param_name, preset_key in _TEMPLATE_LEVEL_FEED_PARAMS.items():
        value = _parse_number(preset.get(preset_key))
        if value is None:
            if preset_key in ("v_f_leadIn", "v_f_leadOut", "v_f_transition"):
                value = fallback_v_f
            elif preset_key == "n_ramp":
                value = fallback_n
        values[param_name] = value

    # finishFeedrate (present on pocket/adaptive-style strategies with a
    # dedicated finishing pass, e.g. ">.3 Circular Through Hole (sized)")
    # isn't in _TEMPLATE_LEVEL_FEED_PARAMS above because there's no matching
    # preset field to copy it from - the real ShopSabre tool library has no
    # separate "finish feed" value at all. Left at its original exported
    # literal (this template's own real export: 30 in/min finish against a
    # 60 in/min cutting feed), a tool swap that lowers the new cutting feed
    # below that stale literal makes finishFeedrate exceed it - confirmed
    # live: Fusion's own "Finish Feedrate: The finish feedrate is higher
    # than the cutting feedrate" warning on this exact operation once New
    # Router's tool substitution dropped cutting feed under 30. Rather than
    # just clamping (which would erase whatever real finish-quality
    # slowdown the template was originally authored with), preserve that
    # template's own finish/cutting RATIO and scale it to the new tool's
    # cutting feed - a true no-op for a template/tool pairing that was
    # already internally consistent (every UNC Router job today), a real
    # fix for one that no longer is.
    new_cutting_feed = values.get("tool_feedCutting")
    if new_cutting_feed:
        original_cutting_feed = None
        finish_param = None
        for parameter in template_elem.findall(_q("parameter")):
            name = parameter.get("name")
            if name == "tool_feedCutting":
                original_cutting_feed = _parse_number(parameter.get("expression"))
            elif name == "finishFeedrate":
                finish_param = parameter
        if finish_param is not None and original_cutting_feed:
            original_finish_feed = _parse_number(finish_param.get("expression"))
            if original_finish_feed is not None:
                ratio = original_finish_feed / original_cutting_feed
                finish_param.set("expression", f"{_fmt_num(new_cutting_feed * ratio)}in/min")

    for parameter in template_elem.findall(_q("parameter")):
        name = parameter.get("name")
        if name not in values or values[name] is None:
            continue
        value = values[name]
        if name in _TEMPLATE_LEVEL_FEED_PARAMS_NO_UNIT:
            parameter.set("expression", _fmt_num(value))
        else:
            parameter.set("expression", f"{_fmt_num(value)}in/min")


def _find_largest_endmill(indexes: list[dict]) -> Optional[tuple[dict, dict]]:
    """Find the largest endmill (by diameter) from all tool indexes."""
    candidates = _select_tools(indexes, _is_endmill_tool)
    best_tool = None
    best_idx = None
    best_diameter = -1.0
    for tool, idx, diameter in candidates:
        if diameter is None:
            continue
        if best_tool is None or diameter > best_diameter:
            best_diameter = diameter
            best_tool = tool
            best_idx = idx
    if best_tool and best_idx:
        return best_tool, best_idx
    return None


_NESTED_SHEET_LEAD_STRATEGIES = {"contour2d", "pocket2d"}


def _set_parameter_expression(template_elem: ET.Element, name: str, expression: str) -> bool:
    parameter = template_elem.find(f"{_q('parameter')}[@name='{name}']")
    if parameter is None:
        return False
    parameter.set("expression", expression)
    return True


def disable_geometry_dependent_leads(template_path: str) -> list[str]:
    """Make imported/nested sheet contours valid without stale lead geometry.

    A real material-sheet template stores lead-in and lead-out choices from
    the CAD used when that template was exported. On a grouped or otherwise
    tightly-packed plate those leads can collide with a neighboring contour
    or a tight circular pocket, so Fusion skips the contour entirely with a
    "given lead parameters would cause a collision" warning - confirmed live
    on a real grouped job (Shape Through/Shape Pocket finishing passes both
    warned and were left unmachined). The cutting path itself remains valid
    without a lead-in/out; disabling them is safe for closed internal
    features and thin sheet, which is what these strategies are used for
    here. The tabbed outer profile (the one operation tabs actually depend
    on) already has leads disabled in the real exported templates, so this
    is a no-op for it, not a behavior change.
    """
    ET.register_namespace("", _TEMPLATE_NS)
    tree = ET.parse(template_path)
    changed: list[str] = []
    for template_elem in tree.getroot().findall(f".//{_q('template')}"):
        if template_elem.get("strategy") not in _NESTED_SHEET_LEAD_STRATEGIES:
            continue
        altered = False
        for name, expression in (
            ("doLeadIn", "false"),
            ("doLeadOut", "false"),
            ("leadsForAllFinishingPasses", "false"),
            ("entryPositions", "false"),
            ("exitPositions", "false"),
        ):
            altered = _set_parameter_expression(template_elem, name, expression) or altered
        if altered:
            changed.append(template_elem.get("description") or template_elem.get("strategy") or "operation")
    tree.write(template_path, encoding="utf-8", xml_declaration=True)
    return changed


def patch_cam_template_with_tool_libraries(
    template_path: str,
    output_path: str,
    tool_library_paths: list[str],
    *,
    material_name: Optional[str] = None,
    filter_guids: Optional[set[str]] = None,
    countersink_guid: Optional[str] = None,
    multi_tool_mode: bool = False,
) -> dict:
    if not tool_library_paths:
        raise ValueError("tool_library_paths must not be empty")

    indexes: list[dict] = []
    for path in tool_library_paths:
        lib = load_tool_library_json(path)
        indexes.append(_index_tools(lib, filter_guids=filter_guids))

    ET.register_namespace("", _TEMPLATE_NS)
    tree = ET.parse(template_path)
    root = tree.getroot()

    replaced = 0
    missing: list[dict] = []
    handled_templates: set[int] = set()
    # Diagnostic trail for the Bore fallback below - camPlate.py logs this,
    # since real testing has twice now shown a toolpath result that didn't
    # match what the code was expected to do, with nothing in the log to
    # say whether the fallback even ran. Silent success/failure here isn't
    # good enough after that.
    bore_fallback: list[dict] = []

    drill_candidates = _select_tools(indexes, _is_drill_tool)
    endmill_candidates = _select_tools(indexes, _is_endmill_tool)
    endmill_plan = plan_endmills([entry[0] for entry in endmill_candidates], multi_tool_mode=multi_tool_mode)
    planned_guids = {tool.get("guid") for tool in endmill_plan["tools"]}
    endmill_candidates = [entry for entry in endmill_candidates if entry[0].get("guid") in planned_guids]
    largest_endmill = _find_largest_endmill([{"tools": [entry[0] for entry in endmill_candidates]}])

    drill_template = _find_template(root, strategy="drill")
    bore_template_native = _find_template(root, strategy="bore")
    pocket_template = _find_template(root, strategy="pocket_new")
    suppress_template = _find_template(root, description="Suppress")
    contour_templates = [
        template_elem
        for template_elem in root.findall(f".//{_q('template')}")
        if template_elem.get("strategy") == "contour2d"
    ]
    contour_templates = [
        template_elem
        for template_elem in contour_templates
        if template_elem is not suppress_template
    ]
    # The bulk-clearing operations that dominate real machining time
    # (confirmed live: ~93% of total feed time on a real job). Their real
    # exported template signature calls for the same small "971 Main Bit"
    # every other operation uses - there's nothing here that would ever
    # pick a bigger tool on its own, unlike contour2d below, which already
    # gets whatever the largest available endmill is. Extended the same
    # existing convention to these strategies: with today's one-tool
    # library this is a no-op (largest_endmill IS that one tool, same
    # result as before), but the pipeline is ready the moment a genuinely
    # larger roughing endmill is added to a machine's tool library,
    # without needing another code change then.
    roughing_templates = [
        template_elem
        for template_elem in root.findall(f".//{_q('template')}")
        if template_elem.get("strategy") in ("adaptive2d", "pocket2d")
    ]

    if multi_tool_mode and bore_template_native is not None and endmill_candidates:
        # Real, confirmed live bug: the New Router's own template already
        # ships its dedicated small-hole operation as strategy="bore"
        # ("<.3 Circluar Through Hole") rather than strategy="drill" - so
        # none of the drill_template branches below (all gated on finding
        # a "drill"-strategy op) ever ran for it, and it fell through to
        # the generic exact-tool-signature match against whatever tool the
        # ORIGINAL captured template used. In multi-tool mode that original
        # tool is often not even loaded, and the match picked a genuinely
        # too-large substitute - Fusion's own real error, not a guess:
        # "3 : Tool doesn't fit" on a Bore-strategy toolpath (a helical-
        # interpolation cut that must fit INSIDE the recognized hole).
        #
        # Scoped to multi_tool_mode ONLY - real, confirmed regression risk
        # otherwise: UNC Router's own (DEPRECATED)971 Metal Sheet template
        # ships this exact same strategy="bore" op, and single-tool-mode
        # jobs (UNC Router's only mode, and New Router's when not using
        # Auto multi-tool) already resolve this correctly via the generic
        # exact-tool-signature match below - which additionally verifies
        # the substituted tool actually matches what this op's own
        # template expects, a check this multi-tool-only fix does not
        # perform. Overriding that path unconditionally would have
        # silently changed UNC Router's own long-proven-in-production tool
        # assignment AND hole-diameter recognition range for no reason.
        #
        # A Bore operation mills a hole with an end mill via helical
        # interpolation (confirmed by templates/Bore.f3dhsm-template's own
        # history, a real Setup > 2D > Bore export - not a drill bit), so
        # the SMALLEST loaded endmill - the one most able to actually
        # reach into this op's own smallest real holes - is the correct
        # tool here, not whichever one happens to name-match the template's
        # original captured tool.
        tool, idx, diameter = min(
            endmill_candidates, key=lambda entry: (entry[2] if entry[2] is not None else float("inf"))
        )
        tool_elem = bore_template_native.find(_q("tool"))
        if tool_elem is not None:
            _apply_tool_to_elem(
                bore_template_native,
                tool_elem,
                tool,
                tool_library_version=idx.get("version"),
                material_name=material_name,
            )
            if diameter is not None:
                max_diameter_in = (
                    _small_hole_max_diameter_in(bore_template_native.get("description"))
                    or _MAX_BORE_HOLE_DIAMETER_IN
                )
                _set_hole_diameter_range(bore_template_native, diameter, max_diameter_in)
            handled_templates.add(id(bore_template_native))
            replaced += 1

    if drill_template and drill_candidates:
        sorted_drills = sorted(
            drill_candidates, key=lambda entry: (entry[2] or 0.0), reverse=True
        )
        # Loaded tools are candidates, including drills. Cloning the same
        # recognition operation for every installed drill makes Fusion apply
        # every one to the same holes, which is both duplicate machining and
        # an avoidable series of ATC swaps. One drill preserves the template's
        # drilling strategy; remaining holes still fall through to the bore
        # and contour operations when this drill does not apply.
        if multi_tool_mode:
            sorted_drills = sorted_drills[:1]
        clones: list[ET.Element] = []
        for tool, idx, diameter in sorted_drills:
            clone = _clone_template(drill_template)
            tool_elem = clone.find(_q("tool"))
            if tool_elem is None:
                continue
            _apply_tool_to_elem(
                clone,
                tool_elem,
                tool,
                tool_library_version=idx.get("version"),
                material_name=material_name,
            )
            clone.set("description", _tool_display_name(tool))
            clones.append(clone)
            handled_templates.add(id(clone))
        if clones:
            _replace_template(root, drill_template, clones)
            replaced += len(clones)
    elif drill_template and largest_endmill:
        # No real drill tool in the library - direct instruction from real-
        # world testing: mill these small holes out with the same router
        # bit instead. An earlier attempt at this guessed strategy="circular"
        # for the fallback operation and produced a real, wrong toolpath in
        # live testing (a zigzag covering almost the entire plate) - Fusion's
        # internal strategy name for this isn't "circular", and isn't
        # derivable from the public API docs alone. templates/Bore.f3dhsm-template
        # is a real operation exported directly from Fusion (Setup > 2D >
        # Bore > Save as Template) confirming the actual strategy is "bore",
        # with its own real, working parameter set - used here wholesale
        # (only the tool and hole-diameter recognition range get replaced)
        # instead of guessing at XML structure again.
        bore_template = _load_bore_template()
        if bore_template is None:
            bore_fallback.append({"status": "bore_template_not_found", "path": _BORE_TEMPLATE_PATH})
        else:
            tool, idx = largest_endmill
            clone = _clone_template(bore_template)
            clone.set("description", f"Bore ({_tool_display_name(tool)})")
            tool_elem = clone.find(_q("tool"))
            if tool_elem is None:
                bore_fallback.append({"status": "clone_has_no_tool_element"})
            else:
                _apply_tool_to_elem(
                    clone,
                    tool_elem,
                    tool,
                    tool_library_version=idx.get("version"),
                    material_name=material_name,
                )
                diameter = _tool_diameter(tool)
                hole_range = None
                if diameter is not None:
                    _set_hole_diameter_range(clone, diameter, _MAX_BORE_HOLE_DIAMETER_IN)
                    hole_range = [diameter, _MAX_BORE_HOLE_DIAMETER_IN]
                _replace_template(root, drill_template, [clone])
                replaced += 1
                handled_templates.add(id(clone))
                bore_fallback.append({
                    "status": "applied",
                    "tool": _tool_display_name(tool),
                    "tool_diameter": diameter,
                    "hole_diameter_range_in": hole_range,
                })

    if pocket_template and endmill_candidates:
        sorted_endmills = sorted(
            endmill_candidates, key=lambda entry: (entry[2] or 0.0), reverse=True
        )
        clones: list[ET.Element] = []
        for index, (tool, idx, _) in enumerate(sorted_endmills):
            clone = _clone_template(pocket_template)
            tool_elem = clone.find(_q("tool"))
            if tool_elem is None:
                continue
            _apply_tool_to_elem(
                clone,
                tool_elem,
                tool,
                tool_library_version=idx.get("version"),
                material_name=material_name,
            )
            # Rest machining means "only clear what a previous, LARGER tool
            # pass left behind" - real for every clone after the first
            # (smaller tools cleaning up corners the big one couldn't
            # reach), but wrong for index 0 itself: the largest/first tool
            # has no earlier pass to rest against, so with this set it
            # computes there is nothing left to clear and produces a
            # genuinely empty toolpath (Fusion's own wording: "Toolpath is
            # empty. Try checking the rest machining, collision avoidance,
            # or machining boundaries and height settings."). That empty
            # toolpath is what made cam.postProcess() fail with
            # "Initialization fails" - confirmed directly, not guessed:
            # a real local run logged isToolpathValid=True on the failing
            # Pocket 1 operation, with exactly this "Toolpath is empty"
            # warning attached. Applied unconditionally here since this
            # code was forked in; never previously exercised end to end.
            _set_rest_machining(clone, enabled=index > 0)
            clone.set("description", f"Pocket {index + 1} ({_tool_display_name(tool)})")
            clones.append(clone)
            handled_templates.add(id(clone))
        if clones:
            _replace_template(root, pocket_template, clones)
            replaced += len(clones)

    if suppress_template and largest_endmill:
        tool, idx = largest_endmill
        tool_elem = suppress_template.find(_q("tool"))
        if tool_elem is not None:
            _apply_tool_to_elem(
                suppress_template,
                tool_elem,
                tool,
                tool_library_version=idx.get("version"),
                material_name=material_name,
            )
            handled_templates.add(id(suppress_template))
            replaced += 1

    if largest_endmill:
        tool, idx = largest_endmill
        for template_elem in contour_templates + roughing_templates:
            tool_elem = template_elem.find(_q("tool"))
            if tool_elem is None:
                continue
            _apply_tool_to_elem(
                template_elem,
                tool_elem,
                tool,
                tool_library_version=idx.get("version"),
                material_name=material_name,
            )
            handled_templates.add(id(template_elem))
            replaced += 1

    for template_elem in root.findall(f".//{_q('template')}"):
        if id(template_elem) in handled_templates:
            continue
        tool_elem = template_elem.find(_q("tool"))
        if tool_elem is None:
            continue

        signature = _required_tool_signature(tool_elem)
        match = _find_matching_tool(signature, indexes)
        if not match:
            missing.append(signature)
            continue

        tool, idx = match
        _apply_tool_to_elem(
            template_elem,
            tool_elem,
            tool,
            tool_library_version=idx.get("version"),
            material_name=material_name,
        )
        handled_templates.add(id(template_elem))
        replaced += 1

    countersink = None
    if countersink_guid:
        matches = [item for item in _select_tools(indexes, _is_countersink_tool) if item[0].get("guid") == countersink_guid]
        if not matches:
            raise ValueError("Requested countersink is not available in the selected tool library")
        countersink_template = _load_countersink_template()
        if countersink_template is None:
            raise ValueError("The bundled ShopSabre countersink template is unavailable")
        tool, idx, _ = matches[0]
        clone = _clone_template(countersink_template)
        tool_elem = clone.find(_q("tool"))
        if tool_elem is None:
            raise ValueError("The bundled ShopSabre countersink template has no tool")
        _apply_tool_to_elem(clone, tool_elem, tool, tool_library_version=idx.get("version"), material_name=material_name)
        # The exported template's selected faces belong to its source model.
        # Imported jobs need Fusion's feature recognition over this job's own
        # geometry, constrained to the reviewed standard hole range.
        _set_parameter_expression(clone, "holeMode", "'diameter'")
        _set_parameter_expression(clone, "holePoints", "false")
        _set_parameter_expression(clone, "holeFaces", "false")
        _set_parameter_expression(clone, "holeDiameterMinimum", "0.2in")
        _set_parameter_expression(clone, "holeDiameterMaximum", "0.4in")
        clone.set("description", f"Countersink ({_tool_display_name(tool)})")
        children = list(root)
        insert_at = next((i for i, element in enumerate(children)
                          if element.tag == _q("template")
                          and element.get("strategy") == "contour2d"
                          and element.get("description") != "Suppress"), len(children))
        root.insert(insert_at, clone)
        replaced += 1
        countersink = {"guid": countersink_guid, "tool": _tool_display_name(tool), "hole_diameter_range_in": [0.2, 0.4]}

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    tree.write(output_path, encoding="utf-8", xml_declaration=True)
    return {
        "replaced": replaced,
        "missing": missing,
        "bore_fallback": bore_fallback,
        "tool_plan": {"reason": endmill_plan["reason"], "endmill_guids": list(planned_guids), "skipped_guids": endmill_plan.get("skipped_guids", [])},
        "countersink": countersink,
        "output_path": output_path,
    }
