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
from .localCamAssets import load_local_tool_library_json, resolve_local_post_processor
from ..commands.NcArtifacts import collect_nc_artifacts
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


def _download_box_tube_file(
    session: requests.Session, tube_id: str, step_file_url: str, dest_dir: str
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
    response = requests.get(step_file_url, timeout=30)
    response.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(response.content)

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
        box_tube_id = str(box_tube_id)

        # Download STEP file - URL already resolved server-side, see
        # _download_box_tube_file's docstring.
        step_file_url = _get(payload, "step_file_url")
        if not step_file_url:
            raise ValueError("Payload missing required 'step_file_url'")
        try:
            _download_box_tube_file(session, box_tube_id, step_file_url, INITIAL_PATH)
        except Exception:
            app.log("Failed to download box tube file:\n{}".format(traceback.format_exc()))
            raise

        # Import the single tube
        importFiles(
            [os.path.join(INITIAL_PATH, f"{box_tube_id}.step")],
            [1],
        )

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

        orientation = _get(payload, "orientation")
        if isinstance(orientation, str):
            orientation = orientation.strip().lower()

        # The claim response already joins these records. Keep the Runner
        # offline after a claim: the old /api/tools, /api/materials, and
        # /api/machines endpoints were never part of this application.
        machine = data.get("cam_machines") or {}
        material = data.get("cam_materials") or {}
        machine_name = machine.get("name") or _get(payload, "machine")
        material_name = material.get("name") or _get(payload, "material")
        machine_post_processor_path = resolve_local_post_processor(data)
        template_path = os.path.join(
            os.path.dirname(__file__), "../templates/boxtubes.f3dhsm-template"
        )

        _tool_info, tool_json_path = load_local_tool_library_json(data, TOOLS_PATH)
        patched_template = os.path.join(
            TOOLS_PATH, f"Boxtubes_job{job_id}.f3dhsm-template"
        )
        patch_info = patch_cam_template_with_tool_libraries(
            template_path,
            patched_template,
            [tool_json_path],
            material_name=material_name,
            filter_guids=filter_guids,
        )
        if patch_info.get("missing"):
            app.log(f"Template tool matches missing: {patch_info.get('missing')}")
        template_path = patched_template

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

        export(box_tube_id, machine_post_processor_path)

        # Preserve each Fusion-posted setup program byte-for-byte and keep
        # independent setup/WCS programs as separate downloads.
        nc_files = collect_nc_artifacts(export_dir)
        shutil.rmtree(export_dir, ignore_errors=True)

        completion_data = {
            "jobId": job_id,
            "ncFiles": nc_files,
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
