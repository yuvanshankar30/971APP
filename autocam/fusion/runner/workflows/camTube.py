import adsk.core, adsk.fusion, adsk.cam, traceback

import json
import os
import shutil
import time

import requests
from typing import Optional

from ..commands.MultiImport import importFiles
from ..commands.NewNCProgram import export
from ..commands.DeleteToolpaths import DeleteToolpaths
from ..commands.HandleTube import handleTube
from ..config import (
    BASE_URL,
    FINAL_PATH,
    FUSION_DATA_PROJECT_NAME,
    FUSION_DROP_FOLDER_PATH,
    INITIAL_PATH,
    TEMP_PATH,
    TOOLS_PATH,
)
from .dropFolder import resolve_drop_folder
from .job_status import ensure_completion_response, send_job_error
from .templateTools import patch_cam_template_with_tool_libraries


def _read_time_value(value) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    for attr in ("value", "valueInSeconds", "seconds"):
        try:
            v = getattr(value, attr)
        except Exception:
            continue
        try:
            return float(v)
        except Exception:
            continue
    return None


def _operation_machining_time(operation) -> Optional[float]:
    if getattr(operation, "isSuppressed", False):
        return None
    if hasattr(operation, "isToolpathValid") and not operation.isToolpathValid:
        return None
    for attr in ("machiningTime", "cycleTime", "toolpathTime"):
        if not hasattr(operation, attr):
            continue
        try:
            val = getattr(operation, attr)
            if callable(val):
                val = val()
        except Exception:
            continue
        t = _read_time_value(val)
        if t is not None:
            return t
    for attr in ("toolpathStatistics", "toolpathStatistic", "toolpathStats"):
        if not hasattr(operation, attr):
            continue
        try:
            stats = getattr(operation, attr)
            if callable(stats):
                stats = stats()
        except Exception:
            continue
        if stats is None:
            continue
        for stat_attr in ("machiningTime", "cycleTime", "totalTime"):
            if not hasattr(stats, stat_attr):
                continue
            t = _read_time_value(getattr(stats, stat_attr))
            if t is not None:
                return t
    return None


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    total = 0.0
    found = False
    for setup in cam.setups:
        for operation in setup.operations:
            t = _operation_machining_time(operation)
            if t is None:
                continue
            total += t
            found = True
    return total if found else None


def _get(payload: dict, *keys: str, default=None):
    for key in keys:
        if key in payload:
            return payload[key]
    return default


def _download_tool_library_json(
    session: requests.Session, tool_id: int, dest_dir: str
) -> tuple[dict, str]:
    os.makedirs(dest_dir, exist_ok=True)
    resp = session.get(f"{BASE_URL}/api/tools/{tool_id}", timeout=30)
    resp.raise_for_status()
    info = resp.json()
    if not isinstance(info, dict):
        raise TypeError(f"Unexpected tool response: {type(info)}")

    url = info.get("file")
    if not url:
        raise ValueError("Tool response missing 'file' signed URL")

    out_path = os.path.join(dest_dir, f"{tool_id}.json")
    if not os.path.exists(out_path):
        content = requests.get(url, timeout=30).content
        with open(out_path, "wb") as f:
            f.write(content)

    return info, out_path


def _first_material_name(session: requests.Session, material_ids) -> Optional[str]:
    if not isinstance(material_ids, list) or not material_ids:
        return None
    material_id = material_ids[0]
    try:
        material_id_int = int(material_id)
    except Exception:
        return None

    resp = session.get(f"{BASE_URL}/api/materials", timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not isinstance(data, list):
        return None
    for material in data:
        if not isinstance(material, dict):
            continue
        try:
            if int(material.get("id")) != material_id_int:
                continue
        except Exception:
            continue
        name = material.get("name")
        return str(name) if name else None
    return None


def _download_machine_post_processor(
    session: requests.Session, machine_id: int, dest_dir: str
) -> tuple[dict, str]:
    """Download machine post processor file from API and return machine info and file path."""
    os.makedirs(dest_dir, exist_ok=True)
    resp = session.get(f"{BASE_URL}/api/machines/{machine_id}", timeout=30)
    resp.raise_for_status()
    info = resp.json()
    if not isinstance(info, dict):
        raise TypeError(f"Unexpected machine response: {type(info)}")

    url = info.get("file")
    if not url:
        raise ValueError("Machine response missing 'file' signed URL")

    file_ext = ".cps"
    out_path = os.path.join(dest_dir, f"machine_{machine_id}{file_ext}")
    if not os.path.exists(out_path):
        content = requests.get(url, timeout=30).content
        with open(out_path, "wb") as f:
            f.write(content)

    return info, out_path


def _download_box_tube_file(
    session: requests.Session, tube_id: int, step_file_url: str, dest_dir: str
) -> str:
    """Download a box tube's STEP file and save it locally.

    step_file_url comes straight from the claim response's payload
    (/api/fusion-runner's buildJobPayload() already generated a signed
    Supabase Storage URL server-side) - no /api/boxTubes/{id} lookup, that
    endpoint never existed on this app.
    """
    os.makedirs(dest_dir, exist_ok=True)
    app = adsk.core.Application.get()
    app.log(f"Downloading box tube STEP file from URL: {step_file_url}")
    out_path = os.path.join(dest_dir, f"{tube_id}.step")
    content = requests.get(step_file_url, timeout=30).content
    with open(out_path, "wb") as f:
        f.write(content)

    return out_path


def start(data, session):
    app = adsk.core.Application.get()
    ui = app.userInterface
    # Computed before the try block so it's always available in the except
    # handler below - see the same comment in camPlate.py's start().
    job_id = str(data.get("id", "unknown"))
    try:
        app.log("Starting box tube CAM workflow...")
        app.log(f"Job data: {json.dumps(data)}")

        # Expect payload to follow BoxTubePayload schema
        payload = data.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}

        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
            adsk.doEvents()
        except Exception:
            pass

        # Create a new document instead of using existing one
        new_doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        new_doc.activate()
        time.sleep(0.5)

        doc = app.activeDocument
        design = adsk.fusion.Design.cast(
            doc.products.itemByProductType("DesignProductType")
        )
        if not design:
            design = adsk.fusion.Design.cast(app.activeProduct)
        if not design:
            raise RuntimeError("No active Design product.")


        # Single box tube per payload
        box_tube_id = _get(payload, "box_tube_id")
        if box_tube_id is None:
            raise ValueError("Payload missing required 'box_tube_id'")
        try:
            box_tube_id_int = int(box_tube_id)
        except Exception:
            raise ValueError(f"Invalid box_tube_id: {box_tube_id}")

        # Download STEP file - URL already resolved server-side, see
        # _download_box_tube_file's docstring.
        step_file_url = _get(payload, "step_file_url")
        if not step_file_url:
            raise ValueError("Payload missing required 'step_file_url'")
        try:
            _download_box_tube_file(session, box_tube_id_int, step_file_url, INITIAL_PATH)
        except Exception:
            app.log("Failed to download box tube file:\n{}".format(traceback.format_exc()))
            raise

        # Import the single tube
        importFiles(
            [os.path.join(INITIAL_PATH, f"{box_tube_id_int}.step")],
            [1],
        )

        # Handle tool_id as a list
        tool_ids_raw = _get(payload, "tool_id", "toolId", "tool_ids")
        tool_ids = []
        if tool_ids_raw is not None:
            if isinstance(tool_ids_raw, list):
                tool_ids = [int(tid) for tid in tool_ids_raw if tid is not None]
            else:
                try:
                    tool_ids = [int(tool_ids_raw)]
                except Exception:
                    pass

        # Extract tool_items (specific tool GUIDs from within libraries)
        tool_items_raw = _get(payload, "tool_items")
        filter_guids = None
        if isinstance(tool_items_raw, list) and tool_items_raw:
            filter_guids = set()
            for item in tool_items_raw:
                if isinstance(item, dict):
                    guid = item.get("tool_guid")
                    if guid:
                        filter_guids.add(str(guid))
            if not filter_guids:
                filter_guids = None

        machine_id = _get(payload, "machine_id", "machineId")
        orientation = _get(payload, "orientation")
        if isinstance(orientation, str):
            orientation = orientation.strip().lower()

        try:
            machine_id_int = int(machine_id) if machine_id is not None else None
        except Exception:
            machine_id_int = None

        material_name = None
        machine_name = None
        machine_post_processor_path = None
        template_path = os.path.join(
            os.path.dirname(__file__), "../templates/boxtubes.f3dhsm-template"
        )

        tool_library_paths = []
        tool_info = None
        tool_list_cache = None

        # Download machine post processor if machine_id is provided
        if machine_id_int is not None:
            try:
                machine_info, machine_post_processor_path = (
                    _download_machine_post_processor(
                        session, machine_id_int, dest_dir=TOOLS_PATH
                    )
                )
                machine_name = machine_info.get("name")
            except Exception:
                app.log(
                    "Failed to download machine post processor:\n{}".format(
                        traceback.format_exc()
                    )
                )

        # If no tool_ids provided, pick the first compatible one.
        if not tool_ids:
            try:
                resp = session.get(f"{BASE_URL}/api/tools", timeout=30)
                resp.raise_for_status()
                tool_list_cache = resp.json()
                if isinstance(tool_list_cache, dict) and isinstance(
                    tool_list_cache.get("data"), list
                ):
                    tool_list_cache = tool_list_cache["data"]

                if isinstance(tool_list_cache, list):
                    for lib in tool_list_cache:
                        if not isinstance(lib, dict):
                            continue
                        lib_id = lib.get("id")
                        if lib_id is None:
                            continue
                        try:
                            candidate_id = int(lib_id)
                        except Exception:
                            continue

                        if machine_id_int is not None:
                            machine_ids = lib.get("machine_ids") or []
                            try:
                                machine_ids = [int(x) for x in machine_ids]
                            except Exception:
                                machine_ids = []
                            if machine_id_int not in machine_ids:
                                continue

                        tool_ids = [candidate_id]
                        break
            except Exception:
                app.log(
                    "Failed to list tool libraries:\n{}".format(traceback.format_exc())
                )

        # Download all tool libraries for the provided tool_ids
        seen_tool_ids = set()
        for tool_id_int in tool_ids:
            if tool_id_int in seen_tool_ids:
                continue
            seen_tool_ids.add(tool_id_int)
            try:
                tool_info, tool_json_path = _download_tool_library_json(
                    session, tool_id_int, dest_dir=TOOLS_PATH
                )
                tool_library_paths.append(tool_json_path)
                # Use material from first tool library
                if material_name is None:
                    material_name = _first_material_name(
                        session, tool_info.get("material_ids")
                    )
            except Exception:
                app.log(
                    "Failed to download tool library:\n{}".format(
                        traceback.format_exc()
                    )
                )

        # Machine name, if not already resolved via the post-processor
        # download above: already present in the claim response's existing
        # cam_machines join (see /api/fusion-runner's claimNextJob select) -
        # no separate lookup needed.
        if machine_name is None:
            machine_name = (data.get("cam_machines") or {}).get("name")

        if tool_library_paths:
            try:
                # Create a unique template name based on all tool_ids
                tool_ids_str = (
                    "_".join(str(tid) for tid in sorted(tool_ids))
                    if tool_ids
                    else "none"
                )
                patched_template = os.path.join(
                    TOOLS_PATH,
                    f"Boxtubes_tool{tool_ids_str}_machine{machine_id_int}.f3dhsm-template",
                )
                patch_info = patch_cam_template_with_tool_libraries(
                    template_path,
                    patched_template,
                    tool_library_paths,
                    material_name=material_name,
                    filter_guids=filter_guids,
                )
                if patch_info.get("missing"):
                    app.log(
                        f"Template tool matches missing: {patch_info.get('missing')}"
                    )
                template_path = patched_template
            except Exception:
                app.log(
                    "Failed to patch CAM template:\n{}".format(traceback.format_exc())
                )

        # Bug fix: this used to reference `patched_template` directly, a
        # name only ever assigned inside the `if tool_library_paths:` block
        # above - a NameError whenever that block was skipped (which was
        # always, before this Phase A pass, since tool-library downloads
        # always failed). `template_path` is the variable that's actually
        # guaranteed to be defined either way (reassigned on success, left
        # as the base template on failure).
        handleTube(template_path, orientation)
        DeleteToolpaths()

        total_machining_time = None
        try:
            cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
            cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
            if cam:
                total_machining_time = _total_machining_time(cam)
        except Exception:
            app.log("Failed to compute machining time:\n{}".format(traceback.format_exc()))

        box_tube_id = str(_get(payload, "box_tube_id", default="cam_tube"))
        doc_name = f"Tube{box_tube_id}Job{job_id}"

        # Save the document to the configured AutoCAM drop folder
        try:
            data_project, autocam_drop_folder = resolve_drop_folder(
                app, FUSION_DATA_PROJECT_NAME, FUSION_DROP_FOLDER_PATH
            )

            # Save the document with Tube<tube_id>Job<job_id> format
            # Check if file already exists and delete it
            try:
                existing_file = autocam_drop_folder.dataFiles.itemByName(doc_name)
                if existing_file:
                    existing_file.deleteMe()
            except Exception:
                pass

            # Save the document
            doc.saveAs(doc_name, autocam_drop_folder, "", "")
            app.log(f"Saved document '{doc_name}' to '{data_project.name}/{FUSION_DROP_FOLDER_PATH}'")

        except Exception as e:
            app.log(
                f"Failed to save document to '{FUSION_DROP_FOLDER_PATH}' folder:\n{traceback.format_exc()}"
            )

        export_dir = os.path.join(FINAL_PATH, box_tube_id)
        try:
            shutil.rmtree(export_dir)
        except FileNotFoundError:
            pass

        export(box_tube_id, machine_id_int)

        # See the matching comment in camPlate.py's start() - cam_jobs.gcode
        # is a single text column, not a zip bundle, so exported NC files
        # (one per setup/WCS in general) are concatenated with a per-file
        # boundary comment rather than uploaded as a zip. Same unverified-MVP
        # caveat applies: needs a real multi-setup box-tube job tested
        # against a real Fusion 360 template to confirm this is sufficient.
        gcode_parts = []
        for root, _dirs, files in os.walk(export_dir) if os.path.isdir(export_dir) else []:
            for fname in sorted(files):
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as ncf:
                        gcode_parts.append(f"(=== {fname} ===)\n{ncf.read()}")
                except Exception:
                    app.log(f"Could not read exported NC file {fpath}:\n{traceback.format_exc()}")
        combined_gcode = "\n\n".join(gcode_parts)
        shutil.rmtree(export_dir, ignore_errors=True)

        completion_data = {
            "jobId": job_id,
            "gcode": combined_gcode,
            "gcodeFileName": f"{box_tube_id}.ngc",
        }
        if total_machining_time is not None:
            completion_data["stats"] = {"total_machining_time": total_machining_time}

        resp = session.post(
            f"{BASE_URL}/api/fusion-runner",
            params={"action": "complete"},
            json=completion_data,
            timeout=30,
        )
        app.log(str(resp.status_code) + " " + resp.reason)
        ensure_completion_response(
            session,
            resp,
            job_id,
            f"Tube {box_tube_id} job {job_id} completion upload",
        )
        doc.close(False)
        app.log(f"Closed document '{doc_name}'")

        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
        except Exception:
            pass

    except Exception:
        if app:
            app.log("Failed:\n{}".format(traceback.format_exc()))
        send_job_error(session, job_id, traceback.format_exc())
