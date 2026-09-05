import json
import os
import zipfile


_RUNNER_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
_TOOL_LIBRARY_PATH = os.path.join(_RUNNER_PATH, "tools")
_POST_PROCESSOR_PATH = os.path.abspath(
    os.path.join(_RUNNER_PATH, "..", "..", "postprocessors")
)

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


def load_local_tool_library_json(data: dict, dest_dir: str) -> tuple[dict, str]:
    """Extract the selected checked-in Fusion tool library for template patching."""
    tool = _joined_record(data, "cam_tools")
    configured_file = tool.get("fusion_tool_library_file")
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

    selected_diameter = _selected_diameter(tool)
    entries = parsed.get("data")
    matching_entries = []
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            entry_diameter = _tool_diameter(entry)
            if entry_diameter is not None and abs(entry_diameter - selected_diameter) < 0.0001:
                matching_entries.append(entry)
    if not matching_entries:
        raise ValueError(
            f"Fusion tool library {file_name} has no tool with diameter "
            f"{selected_diameter:g} in"
        )

    # A library can contain several variants of a similarly named bit. Keep
    # only the diameter selected on the web job so templateTools cannot choose
    # a different cutter merely because it is larger.
    parsed["data"] = matching_entries
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
    if not isinstance(configured_post, str) or not configured_post.strip():
        raise ValueError(f"{machine_name} has no Fusion post processor configured")

    file_name = _POST_PROCESSOR_FILES.get(configured_post.strip().lower())
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
