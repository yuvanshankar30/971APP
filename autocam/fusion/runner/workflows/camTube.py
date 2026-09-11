import adsk.core, adsk.fusion, adsk.cam, traceback

import json
import os
import re
import shutil
import time

import requests
from typing import Optional

from ..commands.MultiImport import importFiles
from ..commands.NewNCProgram import export
from ..commands.HandleTube import handleTube
from ..commands.OperationDiagnostics import failed_operations, operation_warnings
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
from .job_status import ensure_completion_response, send_job_error
from .localCamAssets import load_local_tool_library_json, resolve_local_post_processor
from .machiningTime import total_machining_time
from .saveDocument import save_new_document
from ..commands.NcArtifacts import collect_nc_artifacts
from .templateTools import patch_cam_template_with_tool_libraries


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    return total_machining_time(cam, adsk.core.ObjectCollection.create)


def _generate_tube_toolpaths(cam: adsk.cam.CAM) -> None:
    """Generate the face-scoped setups without invoking plate cleanup logic."""
    future = cam.generateAllToolpaths(True)
    deadline = time.time() + 180
    while not future.isGenerationCompleted:
        if time.time() >= deadline:
            raise TimeoutError("Fusion did not finish generating box-tube toolpaths")
        adsk.doEvents()
        time.sleep(0.2)
    # "Generation completed" is not the same claim as "every operation has a
    # real toolpath" - confirmed live: right after handleTube() creates
    # operations, every one of them briefly shows Fusion's own "not yet
    # generated" state (an orange icon in the browser, not an error) until
    # this function's own wait above resolves it. A genuine failure - an
    # operation Fusion could not compute anything for at all - would
    # otherwise silently reach export/post with nothing real to post for
    # that feature. Fail the whole job outright instead; see
    # OperationDiagnostics.failed_operations's own docstring.
    failed = failed_operations(cam)
    if failed:
        raise RuntimeError(
            "Box-tube CAM produced no valid toolpath for: {}".format(", ".join(failed))
        )


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
    # Declared before the try, alongside job_id, for the same reason: the
    # cleanup in the finally block below needs these however far the job
    # actually got before failing (or never even downloading the tube).
    step_path = None
    patched_template_path = None
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
            step_path = _download_box_tube_file(session, box_tube_id, step_file_url, INITIAL_PATH)
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

        # The claim response already joins these records. Keep the Runner
        # offline after a claim: the old /api/tools, /api/materials, and
        # /api/machines endpoints were never part of this application.
        machine = data.get("cam_machines") or {}
        material = data.get("cam_materials") or {}
        machine_name = machine.get("name") or _get(payload, "machine")
        material_name = material.get("name") or _get(payload, "material")
        machine_post_processor_path = resolve_local_post_processor(data)
        # This is the reviewed, cutter-compensated tube-stock template. The
        # older generic boxtubes template is retained as an archive only: it
        # has stale drill/contour operations and cannot represent the real
        # Shape Through / Side 12-3-6-9 workflow.
        template_path = os.path.join(
            os.path.dirname(__file__),
            "../templates/971-real/Tubestock(with Cutter Comp).f3dhsm-template",
        )

        _tool_info, tool_json_path = load_local_tool_library_json(data, TOOLS_PATH)
        patched_template = os.path.join(
            TOOLS_PATH, f"Tubestock_job{job_id}.f3dhsm-template"
        )
        patched_template_path = patched_template
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

        box_tube_id = str(_get(payload, "box_tube_id", default="cam_tube"))
        face_program_names = handleTube(
            template_path,
            program_base_name="Tube{}Job{}".format(box_tube_id, job_id),
        )

        cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
        cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
        if not cam:
            raise RuntimeError("No CAM product available after creating box-tube setups")
        _generate_tube_toolpaths(cam)
        job_warnings = operation_warnings(app, cam)
        for warning in job_warnings:
            app.log("OPERATION: {}".format(warning))

        total_machining_time = None
        try:
            total_machining_time = _total_machining_time(cam)
        except Exception:
            app.log("Failed to compute machining time:\n{}".format(traceback.format_exc()))

        # The shared Send to Fusion AutoCAM dialog provides the same saved
        # document controls for plates and tube stock. Honor them here too;
        # older queued jobs retain the readable-but-unique default.
        custom_name = _get(payload, "fusion_file_name")
        doc_name = re.sub(r"\s+", "", str(custom_name)) if custom_name else f"Tube{box_tube_id}Job{job_id}"
        folder_path = _get(payload, "fusion_folder_path") or FUSION_DROP_FOLDER_PATH

        # Save failure is a job failure. Reporting completed CAM while its
        # requested Fusion document is absent leaves no editable source of truth.
        data_project, autocam_drop_folder = resolve_drop_folder(
            app, FUSION_DATA_PROJECT_NAME, folder_path
        )
        save_new_document(doc, autocam_drop_folder, doc_name)
        app.log(f"File uploaded to {data_project.name}/{folder_path}/{doc_name}")

        export_dir = os.path.join(FINAL_PATH, box_tube_id)
        try:
            shutil.rmtree(export_dir)
        except FileNotFoundError:
            pass

        posted_program_names = export(
            box_tube_id, machine_post_processor_path, face_program_names
        )

        # Preserve each Fusion-posted setup program byte-for-byte and keep
        # independent setup/WCS programs as separate downloads.
        nc_files = collect_nc_artifacts(export_dir)
        if len(nc_files) != len(posted_program_names):
            raise RuntimeError(
                "Fusion posted {} tube programs for {} active face setups; refusing a partial tube job".format(
                    len(nc_files), len(posted_program_names)
                )
            )
        shutil.rmtree(export_dir, ignore_errors=True)

        completion_data = {
            "jobId": job_id,
            "runnerId": RUNNER_ID,
            "ncFiles": nc_files,
        }
        completion_data["stats"] = {
            "facePrograms": [
                {"label": "Side {}".format(name.rsplit("-side-", 1)[-1]), "programName": name}
                for name in posted_program_names
            ],
        }
        if job_warnings:
            completion_data["warnings"] = job_warnings
        if total_machining_time is not None:
            completion_data["stats"]["total_machining_time"] = total_machining_time

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
        if resp is not None and resp.ok:
            app.log("Job Completed")

        # Real, confirmed live bug this deliberately does NOT close the
        # document for: tube-stock uploads are slow enough that Fusion's own
        # cloud sync is still finishing well after saveAs() (and even this
        # completion POST) returns - closing right away raced that sync and
        # left the file missing/stale in the Data Panel folder for a while.
        # camPlate.py's own plate jobs stopped closing too, for the same
        # not-mistaken-for-the-active-document reason - see its start().
        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
        except Exception:
            pass

    except Exception:
        if app:
            app.log("Failed:\n{}".format(traceback.format_exc()))
        send_job_error(session, job_id, traceback.format_exc())
    finally:
        # See camPlate.py's matching cleanup for the full reasoning - the
        # same real leak, confirmed live, applies here: neither the
        # downloaded STEP file nor the patched template was ever cleaned
        # up on any path. Best-effort: a cleanup failure must never mask
        # the job's own real outcome, already reported above.
        for path in (step_path, patched_template_path):
            if not path:
                continue
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except Exception as cleanup_error:
                if app:
                    app.log(f"Could not remove temporary job file '{path}': {cleanup_error}")
