import adsk.core, adsk.fusion, adsk.cam, traceback

import json
import os
import shutil
import time

import requests
from typing import Optional

from ..commands.SetupGenerator import SetupGenerator
from ..commands.MultiImport import importFiles
from ..commands.NewNCProgram import export
from ..commands.DeleteToolpaths import DeleteToolpaths
from ..commands.AutoArrange import AutoArrange
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
from .importPlate import clear_design_nuke
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
            }
        )
    return normalized


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

    # Determine file extension from URL or default to .cps
    file_ext = ".cps"
    # if "." in url.split("?")[0]:
    #     file_ext = "." + url.split("?")[0].split(".")[-1]

    out_path = os.path.join(dest_dir, f"machine_{machine_id}{file_ext}")
    if not os.path.exists(out_path):
        content = requests.get(url, timeout=30).content
        with open(out_path, "wb") as f:
            f.write(content)

    return info, out_path


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

        assignments = _normalize_assignments(payload)
        importFiles(
            [
                os.path.join(INITIAL_PATH, f"{child['part_id']}.step")
                for child in assignments
            ],
            [child.get("quantity", 1) for child in assignments],
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

        AutoArrange(length, width)

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

        try:
            machine_id_int = int(machine_id) if machine_id is not None else None
        except Exception:
            machine_id_int = None

        material_name = None
        machine_name = None
        machine_post_processor_path = None
        template_path = os.path.join(
            os.path.dirname(__file__), "../templates/Plates.f3dhsm-template"
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

        # If the chosen libraries don't contain every required tool, allow fallbacks.
        if tool_ids and machine_id_int is not None:
            try:
                if tool_list_cache is None:
                    resp = session.get(f"{BASE_URL}/api/tools", timeout=30)
                    resp.raise_for_status()
                    tool_list_cache = resp.json()
                    if isinstance(tool_list_cache, dict) and isinstance(
                        tool_list_cache.get("data"), list
                    ):
                        tool_list_cache = tool_list_cache["data"]

                material_ids_hint = []
                # Get material_ids from first tool library
                if tool_library_paths:
                    try:
                        first_tool_info, _ = _download_tool_library_json(
                            session, tool_ids[0], dest_dir=TOOLS_PATH
                        )
                        if isinstance(first_tool_info, dict) and isinstance(
                            first_tool_info.get("material_ids"), list
                        ):
                            material_ids_hint = first_tool_info.get("material_ids")
                            try:
                                material_ids_hint = [
                                    int(x) for x in material_ids_hint if x is not None
                                ]
                            except Exception:
                                material_ids_hint = []
                        else:
                            material_ids_hint = []
                    except Exception:
                        pass

                seen_ids = set(tool_ids)
                if isinstance(tool_list_cache, list):
                    for lib in tool_list_cache:
                        if not isinstance(lib, dict):
                            continue
                        lib_id = lib.get("id")
                        if lib_id is None:
                            continue
                        try:
                            lib_id_int = int(lib_id)
                        except Exception:
                            continue
                        if lib_id_int in seen_ids:
                            continue

                        machine_ids = lib.get("machine_ids") or []
                        try:
                            machine_ids = [int(x) for x in machine_ids]
                        except Exception:
                            machine_ids = []
                        if machine_id_int not in machine_ids:
                            continue

                        if material_ids_hint:
                            lib_material_ids = lib.get("material_ids") or []
                            try:
                                lib_material_ids = [int(x) for x in lib_material_ids]
                            except Exception:
                                lib_material_ids = []
                            if not set(material_ids_hint).intersection(
                                lib_material_ids
                            ):
                                continue

                        _, extra_path = _download_tool_library_json(
                            session, lib_id_int, dest_dir=TOOLS_PATH
                        )
                        tool_library_paths.append(extra_path)
                        seen_ids.add(lib_id_int)
            except Exception:
                app.log(
                    "Failed to add fallback tool libraries:\n{}".format(
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
                    f"Plates_tool{tool_ids_str}_machine{machine_id_int}.f3dhsm-template",
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

            # Save the document with Plate<plate_id>Job<job_id> format
            doc_name = f"Plate{plate_id}Job{job_id}"
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

        export(plate_id, machine_id_int)

        # cam_jobs.gcode is a single text column (matches turning/routing's
        # one-file-per-job model), not a zip bundle like upstream's
        # /api/jobs/complete accepted - a real difference in the job model,
        # not just a URL change. A Fusion CAM template CAN legitimately
        # export more than one NC file per plate (one per setup/WCS) -
        # concatenated here with a clear per-file boundary comment (matching
        # this app's own HEADER_WARNING-style G-code comment conventions -
        # see autocam/turning.js) as an honest MVP behavior, not a verified
        # design: whether per-file (not concatenated) storage actually
        # matters in practice needs a real multi-setup plate job tested
        # against a real Fusion 360 template, which this environment can't do.
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
            "gcodeFileName": f"{plate_id}.ngc",
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
