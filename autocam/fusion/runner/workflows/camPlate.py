from ..commands.GroupingValidation import require_complete_arrangement, plate_spacing, require_positive_quantity
from ..commands.NcArtifacts import collect_nc_artifacts
import adsk.core, adsk.fusion, adsk.cam, traceback

import json
import os
import re
import shutil
import time

import requests
from typing import Optional

from ..commands.SetupGenerator import SetupGenerator
from ..commands.MultiImport import importFiles
from ..commands.NewNCProgram import export
from ..commands.DeleteToolpaths import DeleteToolpaths
from ..commands.AutoArrange import AutoArrange
from ..commands.TabPlacement import ConfigureTabs
from ..config import (
    BASE_URL,
    FINAL_PATH,
    FUSION_DATA_PROJECT_NAME,
    FUSION_DROP_FOLDER_PATH,
    INITIAL_PATH,
    RUNNER_ID,
    TEMP_PATH,
    TOOLS_PATH,
)
from .dropFolder import resolve_drop_folder
from .importPlate import clear_design_nuke
from .job_status import ensure_completion_response, send_job_error
from .localCamAssets import load_local_tool_library_json, resolve_local_post_processor
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


def _normalize_assignments(payload: dict) -> list[dict]:
    def normalize_quantity(value) -> int:
        if value is None:
            return 1
        if isinstance(value, dict):
            for key in ("count", "qty", "quantity", "value", "n"):
                if key in value:
                    return normalize_quantity(value.get(key))
            total = 0
            for v in value.values():
                try:
                    total += int(v)
                except Exception:
                    pass
            return total or 1
        try:
            return int(value)
        except Exception:
            return 1

    assignments = payload.get("assignments")
    if isinstance(assignments, list):
        normalized = []
        for assignment in assignments:
            if not isinstance(assignment, dict):
                continue
            part_id = (
                assignment.get("part_id")
                or assignment.get("partId")
                or assignment.get("name")
            )
            if part_id is None:
                continue
            normalized.append(
                {
                    "part_id": part_id,
                    "quantity": normalize_quantity(assignment.get("quantity", 1)),
                    "step_file_url": assignment.get("step_file_url"),
                    "fusion_file_name": assignment.get("fusion_file_name"),
                }
            )
        return normalized

    parts = payload.get("parts")
    if not isinstance(parts, list):
        return []

    normalized = []
    for part in parts:
        if not isinstance(part, dict):
            continue
        part_id = part.get("part_id") or part.get("partId") or part.get("name")
        if part_id is None:
            continue
        normalized.append(
            {
                "part_id": part_id,
                "quantity": normalize_quantity(part.get("quantity", 1)),
                "step_file_url": part.get("step_file_url"),
            }
        )
    return normalized


def _get(payload: dict, *keys: str, default=None):
    for key in keys:
        if key in payload:
            return payload[key]
    return default


def _download_part_file(session: requests.Session, part_id: str, step_file_url: str) -> str:
    """Download the claim response's signed STEP URL to Fusion's import folder."""
    if not step_file_url:
        raise ValueError(f"Part {part_id} is missing a STEP file URL")
    os.makedirs(INITIAL_PATH, exist_ok=True)
    destination = os.path.join(INITIAL_PATH, f"{part_id}.step")
    response = session.get(step_file_url, timeout=30)
    response.raise_for_status()
    with open(destination, "wb") as output:
        output.write(response.content)
    return destination


def start(data, session):
    app = adsk.core.Application.get()
    ui = app.userInterface
    # Computed before the try block so it's always available in the except
    # handler below, however early a failure happens - job_id is required
    # on every /api/fusion-runner call now (see job_status.py).
    job_id = str(data.get("id", "unknown"))
    try:
        payload = data.get("payload")
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

        # Clear design but don't nuke CAM (we're creating a new file)
        clear_design_nuke(design)
        time.sleep(1.0)

        raw_assignments = payload.get('assignments')
        if not isinstance(raw_assignments, list):
            raise ValueError('Plate job requires an assignment list')
        for assignment in raw_assignments:
            require_positive_quantity(assignment.get('quantity'))
        assignments = _normalize_assignments(payload)
        if not assignments:
            raise ValueError("Plate job has no nested parts with STEP files")
        step_paths = []
        for assignment in assignments:
            part_id = str(assignment["part_id"])
            step_paths.append(
                _download_part_file(session, part_id, assignment.get("step_file_url"))
            )
        importFiles(
            step_paths,
            [assignment.get("quantity", 1) for assignment in assignments],
        )

        # Plate dimensions: /api/fusion-runner's claim response already
        # resolves these server-side from fusion_plates (see
        # buildJobPayload() in src/routes/api/fusion-runner/+server.js) and
        # embeds them flat in payload - no separate /api/plates/{id} fetch
        # needed (that endpoint never existed on this app). Falls back to
        # payload-provided or default values only if the server genuinely
        # couldn't resolve the plate (buildJobPayload() returns a payload
        # missing these keys rather than failing the whole claim).
        length = float(_get(payload, "length", default=24))
        width = float(_get(payload, "width", default=48))
        true_depth = float(_get(payload, "true_depth", "trueDepth", default=0.125))

        occurrences = list(design.rootComponent.allOccurrences)
        spacing = plate_spacing((data.get('cam_tools') or {}).get('diameter'))
        arrange = AutoArrange(length, width, object_spacing=spacing)
        require_complete_arrangement(arrange, occurrences)

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

        # The claim response already joins these records. Keep the Runner
        # offline after a claim: the old /api/tools, /api/materials, and
        # /api/machines endpoints were never part of this application.
        machine = data.get("cam_machines") or {}
        material = data.get("cam_materials") or {}
        machine_name = machine.get("name") or _get(payload, "machine")
        material_name = material.get("name") or _get(payload, "material")
        machine_post_processor_path = resolve_local_post_processor(data)
        # Direct instruction: Lexan/polycarbonate plate jobs should use the
        # team's real, hand-tuned "new router metal sheet" template (feeds,
        # speeds, and other cut settings someone with machine knowledge
        # already vetted for sheet stock) instead of the generic plate
        # template every other material uses.
        is_lexan = "lexan" in (material_name or "").lower() or "polycarb" in (material_name or "").lower()
        template_filename = (
            "971-real/new router metal sheet (shopsabre only!!).f3dhsm-template"
            if is_lexan
            else "Plates.f3dhsm-template"
        )
        template_path = os.path.join(
            os.path.dirname(__file__), f"../templates/{template_filename}"
        )

        _tool_info, tool_json_path = load_local_tool_library_json(data, TOOLS_PATH)
        patched_template = os.path.join(
            TOOLS_PATH, f"Plates_job{job_id}.f3dhsm-template"
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
        if patch_info.get("bore_fallback"):
            app.log(f"Bore fallback: {patch_info.get('bore_fallback')}")
        template_path = patched_template

        # Category thickness (nominal part thickness, for the offset
        # calculation true_depth - thickness) - same server-resolved payload
        # field as length/width/true_depth above.
        thickness = float(
            _get(
                payload,
                "thickness",
                default=_get(payload, "true_depth", "trueDepth", default=0.125),
            )
        )

        SetupGenerator(
            machine_name or _get(payload, "machine"),
            true_depth,
            material_name or _get(payload, "material"),
            thickness,
            template_path=template_path,
        )
        try:
            ConfigureTabs()
        except Exception:
            app.log("TabPlacement failed:\n{}".format(traceback.format_exc()))
        DeleteToolpaths()

        total_machining_time = None
        try:
            cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
            cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
            if cam:
                total_machining_time = _total_machining_time(cam)
        except Exception:
            app.log("Failed to compute machining time:\n{}".format(traceback.format_exc()))

        plate_id = str(_get(payload, "plate_id", "plateId", default="cam_plate"))

        # Save the document to the configured AutoCAM drop folder
        try:
            data_project, autocam_drop_folder = resolve_drop_folder(
                app, FUSION_DATA_PROJECT_NAME, FUSION_DROP_FOLDER_PATH
            )

            # Prefer a user-typed name (fusion_parts.fusion_file_name, set on
            # the Parts tab) over the default Plate<plate_id>Job<job_id> -
            # the latter is real but unreadable in Fusion's Data Panel (both
            # plate_id and job_id are UUIDs). Uses the first assigned part's
            # name since a plate's saved document is one file regardless of
            # how many parts are nested onto it; falls back to the old
            # scheme when no assignment set one.
            custom_name = None
            for assignment in assignments:
                candidate = assignment.get("fusion_file_name")
                if candidate:
                    custom_name = re.sub(r"\s+", "", str(candidate))
                    break
            doc_name = custom_name or f"Plate{plate_id}Job{job_id}"
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

        export_dir = os.path.join(FINAL_PATH, plate_id)
        try:
            shutil.rmtree(export_dir)
        except FileNotFoundError:
            pass

        export(plate_id, machine_post_processor_path)

        # Preserve each file emitted by Fusion's configured post byte-for-byte.
        # Each setup is posted as one ordered program; independent setup/WCS
        # programs remain separate downloads.
        nc_files = collect_nc_artifacts(export_dir)
        shutil.rmtree(export_dir, ignore_errors=True)

        completion_data = {
            "jobId": job_id,
            "runnerId": RUNNER_ID,
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
            f"Plate {plate_id} job {job_id} completion upload",
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
