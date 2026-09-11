import json
import os
import zipfile


_RUNNER_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_TOOL_LIBRARY_PATH = os.path.join(_RUNNER_PATH, "tools")
# A sibling of this runner folder inside the repo (autocam/postprocessors/),
# NOT a child of it - reachable via "../../postprocessors" only while this
# code still lives at its original repo path. The team-setup-guide's own
# install step copies just this runner folder out to Fusion's AddIns
# directory (renamed to SpartanRoboticsAutoCAM), at which point that
# relative climb lands outside Fusion's AddIns folder entirely and finds
# nothing. Bundled a copy at postprocessors/ (a child, like tools/ already
# is) so it travels with the runner wherever it's copied, instead of
# reaching for a repo-relative path that stops existing once installed.
_POST_PROCESSOR_PATH = os.path.join(_RUNNER_PATH, "postprocessors")

# These values are deliberately filenames, not URLs. Fusion Runner is shipped
# with the app's known-good assets, so an already-claimed job must not depend
# on web endpoints that the app does not expose.
_POST_PROCESSOR_FILES = {
    "971_emc.cps": "971_emc.cps",
    "971_emc": "971_emc.cps",
    "linuxcnc": "971_emc.cps",
    "shopsabre.cps": "shopsabre.cps",
    "shopsabre": "shopsabre.cps",
    "wincnc": "shopsabre.cps",
    "haas_turning.cps": "haas_turning.cps",
    "haas turning": "haas_turning.cps",
    "haas": "haas_turning.cps",
}

# Physical-machine invariants, not operator-tunable preferences. A New Router
# job is always for the ShopSabre Pro 408; a stale profile must never post
# LinuxCNC code to it. Same reasoning for the lathe: 971 Lathe is Haas-
# controlled, and Fusion's own bundled generic "linuxcnc" post is
# CAPABILITY_MILLING only - it cannot turn at all, so a stale/reverted
# profile posting through it would be silently wrong, not just rejected.
_MACHINE_POST_PROCESSORS = {
    "new router": "shopsabre.cps",
    "unc router": "971_emc.cps",
    "971 lathe": "haas_turning.cps",
}


def _joined_record(data: dict, key: str) -> dict:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _selected_diameter(tool: dict) -> float:
    try:
        diameter = float(tool.get("diameter"))
    except (TypeError, ValueError) as error:
        raise ValueError("Selected CAM tool has no valid diameter") from error
    if diameter <= 0:
        raise ValueError("Selected CAM tool has no valid diameter")
    return diameter


def _tool_diameter(entry: dict):
    geometry = entry.get("geometry")
    if not isinstance(geometry, dict):
        return None
    try:
        return float(geometry.get("DC"))
    except (TypeError, ValueError):
        return None


def _is_drill_entry(entry: dict) -> bool:
    """Same "type" field templateTools.py's _is_drill_tool checks - kept
    independent since this module has no import relationship with that one.
    """
    return "drill" in str(entry.get("type") or "").lower()


def _is_endmill_entry(entry: dict) -> bool:
    tool_type = str(entry.get("type") or "").lower()
    return "end mill" in tool_type or "endmill" in tool_type


def _tool_number(entry: dict):
    post = entry.get("post-process")
    if not isinstance(post, dict):
        return None
    try:
        return int(post.get("number"))
    except (TypeError, ValueError):
        return None


_MULTI_TOOL_LIBRARY_FILE = "Normal router tools (use this).tools"


def load_local_tool_library_json(data: dict, dest_dir: str) -> tuple[dict, str]:
    """Extract the selected checked-in Fusion tool library for template patching."""
    tool = _joined_record(data, "cam_tools")
    payload = data.get("payload")
    multi_tool_mode = isinstance(payload, dict) and payload.get("multi_tool_mode") is True
    configured_file = tool.get("fusion_tool_library_file")
    if not configured_file and multi_tool_mode:
        # Multi-tool mode has no single selected cam_tools row (tool_id is
        # deliberately null - the planner resolves from every loaded
        # candidate server-side, not one manual selection; see
        # jobPayload.js's resolveLoadedToolItems), so there is no
        # fusion_tool_library_file to read here the way single-tool mode
        # has one. Every UI entry point gates multi-tool mode to New
        # Router only, and every one of its real loaded tools comes from
        # this one bundled library. Use it directly for this single-library
        # shop rather than plumbing the filename through tool_items.
        configured_file = _MULTI_TOOL_LIBRARY_FILE
    if not isinstance(configured_file, str) or not configured_file.strip():
        raise ValueError(
            "Selected CAM tool has no local Fusion tool library configured. "
            "Set cam_tools.fusion_tool_library_file before running this job."
        )

    file_name = configured_file.strip()
    if os.path.basename(file_name) != file_name or not file_name.endswith(".tools"):
        raise ValueError(f"Invalid local Fusion tool library filename: {configured_file}")

    archive_path = os.path.join(_TOOL_LIBRARY_PATH, file_name)
    if not os.path.isfile(archive_path):
        raise FileNotFoundError(f"Fusion tool library is not bundled with the Runner: {file_name}")

    try:
        with zipfile.ZipFile(archive_path) as archive:
            tools_json = archive.read("tools.json")
        parsed = json.loads(tools_json.decode("utf-8"))
    except (OSError, KeyError, UnicodeDecodeError, ValueError, zipfile.BadZipFile) as error:
        raise ValueError(f"Could not read Fusion tool library {file_name}: {error}") from error

    if not isinstance(parsed, dict):
        raise ValueError(f"Fusion tool library {file_name} does not contain a JSON object")

    # No single selected tool to size-match against in multi-tool mode -
    # every entry there is matched by candidate_guids below instead (the
    # loaded set resolved server-side), never by comparing to this value.
    selected_diameter = _selected_diameter(tool) if tool.get("diameter") is not None else None
    single_tool_mode = isinstance(payload, dict) and payload.get("single_tool_mode") is True
    multi_tool_mode = isinstance(payload, dict) and payload.get("multi_tool_mode") is True
    candidate_guids = {
        str(item.get("tool_guid")) for item in (payload.get("tool_items") or [])
        if isinstance(item, dict) and item.get("tool_guid")
    } if multi_tool_mode else set()
    if single_tool_mode and not _is_endmill_entry({"type": tool.get("tool_type")}):
        raise ValueError("Single-tool Fusion CAM requires an endmill selected on the job")
    selected_tool_number = tool.get("tool_number") if single_tool_mode else None
    entries = parsed.get("data")
    matching_entries = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            if single_tool_mode:
                # Prefer the physical slot when known. Legacy tools without
                # slot metadata retain the established diameter fallback.
                if selected_tool_number is not None:
                    if _tool_number(entry) == selected_tool_number:
                        matching_entries.append(entry)
                elif _is_endmill_entry(entry):
                    entry_diameter = _tool_diameter(entry)
                    if entry_diameter is not None and abs(entry_diameter - selected_diameter) < 0.0001:
                        matching_entries.append(entry)
                continue
            if candidate_guids:
                if entry.get("guid") in candidate_guids:
                    matching_entries.append(entry)
                continue
            # Keep every drill regardless of diameter - a drill isn't "a
            # variant of the selected endmill" the way a same-named
            # different-size end mill is, and templateTools.py's own
            # drill-matching already picks the right diameter per hole
            # (_set_drill_diameter_range). Diameter-filtering drills out
            # here meant a plate job could never drill a single hole no
            # matter what was in the library - confirmed via a real job:
            # holes rendered in the toolpath preview but nothing cut them,
            # and every run logged "Template tool matches missing" for a
            # drill diameter with candidates=0 before this fix, because
            # this filter had already discarded any drill entry that
            # didn't happen to match the endmill's own diameter.
            if _is_drill_entry(entry):
                matching_entries.append(entry)
                continue
            entry_diameter = _tool_diameter(entry)
            if selected_diameter is not None and entry_diameter is not None and abs(entry_diameter - selected_diameter) < 0.0001:
                matching_entries.append(entry)
    if not matching_entries:
        raise ValueError(
            f"Fusion tool library {file_name} has no tool matching this job's selection"
            if selected_diameter is None else
            f"Fusion tool library {file_name} has no tool with diameter {selected_diameter:g} in"
        )

    # A library can contain several variants of a similarly named bit. Keep
    # only the diameter selected on the web job so templateTools cannot choose
    # a different cutter merely because it is larger.
    parsed["data"] = list({entry.get("guid"): entry for entry in matching_entries if entry.get("guid")}.values())
    tools_json = json.dumps(parsed, indent=2).encode("utf-8")

    os.makedirs(dest_dir, exist_ok=True)
    json_path = os.path.join(dest_dir, f"{os.path.splitext(file_name)[0]}.tools.json")
    with open(json_path, "wb") as output:
        output.write(tools_json)
    return tool, json_path


def resolve_local_post_processor(data: dict) -> str:
    """Resolve the claimed machine's configured post processor to a bundled CPS file."""
    machine = _joined_record(data, "cam_machines")
    configured_post = machine.get("post_processor")
    machine_name = machine.get("name") or "selected machine"
    required_post = _MACHINE_POST_PROCESSORS.get(str(machine_name).strip().lower())
    normalized_configured_post = (
        configured_post.strip().lower()
        if isinstance(configured_post, str) and configured_post.strip()
        else None
    )

    if required_post:
        configured_file = _POST_PROCESSOR_FILES.get(normalized_configured_post)
        if normalized_configured_post and configured_file != required_post:
            raise ValueError(
                f"{machine_name} must use {required_post}, not {configured_post}"
            )
        file_name = required_post
    elif not normalized_configured_post:
        raise ValueError(f"{machine_name} has no Fusion post processor configured")
    else:
        file_name = _POST_PROCESSOR_FILES.get(normalized_configured_post)

    if not file_name:
        raise ValueError(
            f"{machine_name} uses unsupported Fusion post processor: {configured_post}"
        )

    post_processor_path = os.path.join(_POST_PROCESSOR_PATH, file_name)
    if not os.path.isfile(post_processor_path):
        raise FileNotFoundError(
            f"Fusion post processor is not bundled with the Runner: {file_name}"
        )
    return post_processor_path
