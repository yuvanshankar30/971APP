"""Lathe CAM workflow: downloads a turning part's STEP file, runs the
appropriate handler (HandleSpacer.py or HandleHexShaft.py, chosen by the
job's own camType), and posts G-code back - the same claim/import/generate/
export/complete shape camTube.py's start() uses for box tube stock, adapted
for turning's own two real differences from that pipeline:

- No cutter-compensated template exists for a hex shaft the way
  Tubestock(with Cutter Comp).f3dhsm-template does for tube stock, and
  HandleHexShaft.py builds its own operations from raw API calls instead -
  so there is no template-tool-library patch step for it, only a generic
  turning tool loaded straight from Fusion's own bundled sample library
  (see _load_generic_turning_tools). Spacer CAM's own template already
  carries a real tool baked into its XML (exported live from a hand-built
  reference setup), so it needs no tool library step at all.
- A hex shaft with a groove at each end produces two Setups, not one -
  export()'s own one-program-per-setup behavior (see NewNCProgram.py)
  already handles that without any tube-style per-face naming scheme.
"""

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
from ..commands.HandleSpacer import handleSpacer
from ..commands.HandleHexShaft import handleHexShaft
from ..commands.OperationDiagnostics import failed_operations, operation_warnings
from ..config import (
    BASE_URL,
    FINAL_PATH,
    FUSION_DATA_PROJECT_NAME,
    FUSION_DROP_FOLDER_PATH,
    INITIAL_PATH,
    RUNNER_ID,
)
from .dropFolder import resolve_drop_folder
from .job_status import ensure_completion_response, send_job_error
from .localCamAssets import resolve_local_post_processor
from .machiningTime import total_machining_time
from .saveDocument import save_new_document
from ..commands.NcArtifacts import collect_nc_artifacts

_SPACER_TEMPLATE_PATH = os.path.join(
    os.path.dirname(__file__), "../templates/971-real/Spacer Turning.f3dhsm-template"
)
# Direct instruction: "use generic tools for now, then we can configure them
# later" - this app's own cam_tools catalog describes mill/router bits, so
# there is nothing meaningful to offer an operator to pick from yet. Fusion
# ships this library with every install; it is not something this Runner
# provides or manages.
_TURNING_SAMPLE_LIBRARY_NAME = "Turning Tools (Inch)"


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    return total_machining_time(cam, adsk.core.ObjectCollection.create)


def _tool_by_type(lib, wanted_type):
    for i in range(lib.count):
        tool = lib.item(i)
        type_param = tool.parameters.itemByName("tool_type")
        if type_param is not None and type_param.value.value == wanted_type:
            return tool
    return None


def _load_generic_turning_tools(cam: adsk.cam.CAM) -> None:
    """Populate this document's own tool library with a generic turning and
    grooving tool, straight from Fusion's bundled sample library - what
    HandleHexShaft.py's own _tool_by_type lookup needs to find before it can
    build any operation at all. Spacer CAM never calls this: its template
    already carries a real tool from the reference setup it was exported
    from.
    """
    tool_libraries = adsk.cam.CAMManager.get().libraryManager.toolLibraries
    root_url = tool_libraries.urlByLocation(adsk.cam.LibraryLocations.Fusion360LibraryLocation)
    sample_url = next(
        (u for u in tool_libraries.childAssetURLs(root_url) if _TURNING_SAMPLE_LIBRARY_NAME in u.toString()),
        None,
    )
    if sample_url is None:
        raise RuntimeError(
            f"Fusion's own '{_TURNING_SAMPLE_LIBRARY_NAME}' sample tool library is unavailable"
        )
    sample_library = tool_libraries.toolLibraryAtURL(sample_url)
    general_tool = _tool_by_type(sample_library, "turning general")
    groove_tool = _tool_by_type(sample_library, "turning grooving")
    if general_tool is None or groove_tool is None:
        raise RuntimeError(
            f"'{_TURNING_SAMPLE_LIBRARY_NAME}' is missing a general or grooving turning tool"
        )
    document_library = cam.documentToolLibrary
    document_library.add(general_tool)
    document_library.add(groove_tool)


def _generate_turning_toolpaths(cam: adsk.cam.CAM) -> None:
    for i in range(cam.setups.count):
        cam.generateToolpath(cam.setups.item(i))
    deadline = time.time() + 180
    while True:
        still_generating = any(
            operation.isGenerating
            for i in range(cam.setups.count)
            for operation in cam.setups.item(i).operations
        )
        if not still_generating:
            break
        if time.time() >= deadline:
            raise TimeoutError("Fusion did not finish generating turning toolpaths")
        adsk.doEvents()
        time.sleep(0.2)
    # See camTube.py's own _generate_tube_toolpaths for why this check exists
    # at all: "generation completed" is not the same claim as "every
    # operation has a real toolpath".
    failed = failed_operations(cam)
    if failed:
        raise RuntimeError(
            "Turning CAM produced no valid toolpath for: {}".format(", ".join(failed))
        )


def _get(payload: dict, *keys: str, default=None):
    for key in keys:
        if key in payload:
            return payload[key]
    return default


def _download_turning_part_file(
    session: requests.Session, turning_part_id: str, step_file_url: str, dest_dir: str
) -> str:
    """Same reasoning as camTube.py's _download_box_tube_file - the URL is
    already a signed Supabase Storage URL from the claim response's payload.
    """
    os.makedirs(dest_dir, exist_ok=True)
    app = adsk.core.Application.get()
    app.log(f"Downloading turning part STEP file from URL: {step_file_url}")
    out_path = os.path.join(dest_dir, f"{turning_part_id}.step")
    response = requests.get(step_file_url, timeout=30)
    response.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(response.content)
    return out_path


def start(data, session):
    app = adsk.core.Application.get()
    ui = app.userInterface
    job_id = str(data.get("id", "unknown"))
    step_path = None
    try:
        app.log("Starting turning CAM workflow...")
        app.log(f"Job data: {json.dumps(data)}")

        payload = data.get("payload") or {}
        if not isinstance(payload, dict):
            payload = {}

        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
            adsk.doEvents()
        except Exception:
            pass

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

        turning_part_id = _get(payload, "turning_part_id")
        if turning_part_id is None:
            raise ValueError("Payload missing required 'turning_part_id'")
        turning_part_id = str(turning_part_id)

        cam_type = _get(payload, "cam_type")
        if cam_type not in ("spacer", "hexShaft"):
            raise ValueError(f"Payload has an unsupported 'cam_type': {cam_type!r}")

        step_file_url = _get(payload, "step_file_url")
        if not step_file_url:
            raise ValueError("Payload missing required 'step_file_url'")
        try:
            step_path = _download_turning_part_file(session, turning_part_id, step_file_url, INITIAL_PATH)
        except Exception:
            app.log("Failed to download turning part file:\n{}".format(traceback.format_exc()))
            raise

        importFiles(
            [os.path.join(INITIAL_PATH, f"{turning_part_id}.step")],
            [1],
        )

        machine = data.get("cam_machines") or {}
        machine_post_processor_path = resolve_local_post_processor(data)

        tailstock_length_in_raw = _get(payload, "tailstock_length_in")
        tailstock_length_in = (
            float(tailstock_length_in_raw) if tailstock_length_in_raw not in (None, "") else None
        )

        cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
        cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
        if not cam:
            raise RuntimeError("No CAM product available after creating turning setup")

        if cam_type == "spacer":
            result = handleSpacer(_SPACER_TEMPLATE_PATH, tailstock_length_in)
            stats_geometry = {
                "spacerOd": result["spacerOd"],
                "spacerId": result["spacerId"],
                "spacerLength": result["spacerLength"],
                "hasHole": result["hasHole"],
                "tailstockLength": result["tailstockLength"],
            }
        else:
            _load_generic_turning_tools(cam)
            result = handleHexShaft(tailstock_length_in)
            stats_geometry = {
                "acrossFlats": result["acrossFlats"],
                "shaftLength": result["shaftLength"],
                "neckDiameter": result["neckDiameter"],
                "tailstockLength": result["tailstockLength"],
                "ends": result["ends"],
            }

        _generate_turning_toolpaths(cam)
        job_warnings = operation_warnings(app, cam)
        for warning in job_warnings:
            app.log("OPERATION: {}".format(warning))

        total_time = None
        try:
            total_time = _total_machining_time(cam)
        except Exception:
            app.log("Failed to compute machining time:\n{}".format(traceback.format_exc()))

        custom_name = _get(payload, "fusion_file_name")
        doc_name = re.sub(r"\s+", "", str(custom_name)) if custom_name else f"Turning{turning_part_id}Job{job_id}"
        folder_path = _get(payload, "fusion_folder_path") or FUSION_DROP_FOLDER_PATH

        data_project, autocam_drop_folder = resolve_drop_folder(
            app, FUSION_DATA_PROJECT_NAME, folder_path
        )
        save_new_document(doc, autocam_drop_folder, doc_name)
        app.log(f"File uploaded to {data_project.name}/{folder_path}/{doc_name}")

        export_dir = os.path.join(FINAL_PATH, turning_part_id)
        try:
            shutil.rmtree(export_dir)
        except FileNotFoundError:
            pass

        # One program per Setup (Face->Rough->Finish->Groove[->Part], in
        # CAM-browser order) - see NewNCProgram.export's own docstring. A
        # two-ended hex shaft's second setup is auto-suffixed "-2" there;
        # no per-setup names need to be passed in.
        posted_program_names = export(turning_part_id, machine_post_processor_path)

        nc_files = collect_nc_artifacts(export_dir)
        if len(nc_files) != len(posted_program_names):
            raise RuntimeError(
                "Fusion posted {} turning programs for {} active setups; refusing a partial turning job".format(
                    len(nc_files), len(posted_program_names)
                )
            )
        shutil.rmtree(export_dir, ignore_errors=True)

        completion_data = {
            "jobId": job_id,
            "runnerId": RUNNER_ID,
            "ncFiles": nc_files,
        }
        completion_data["stats"] = {"camType": cam_type, **stats_geometry}
        if job_warnings:
            completion_data["warnings"] = job_warnings
        if total_time is not None:
            completion_data["stats"]["total_machining_time"] = total_time

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
            f"Turning {turning_part_id} job {job_id} completion upload",
        )
        if resp is not None and resp.ok:
            app.log("Job Completed")

        # Deliberately does not close the document - see camTube.py's own
        # start() for the confirmed-live race with Fusion's cloud sync this
        # avoids.
        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
        except Exception:
            pass

    except Exception:
        if app:
            app.log("Failed:\n{}".format(traceback.format_exc()))
        send_job_error(session, job_id, traceback.format_exc())
    finally:
        if step_path:
            try:
                os.remove(step_path)
            except FileNotFoundError:
                pass
            except Exception as cleanup_error:
                if app:
                    app.log(f"Could not remove temporary STEP file {step_path}: {cleanup_error}")
