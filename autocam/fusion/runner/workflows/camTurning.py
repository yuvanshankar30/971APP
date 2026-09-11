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

import hashlib
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

# Fusion's own bundled Haas turning post (haas_turning.cps) requires the
# program name to be a bare integer from 1-9999 - its own onOpen calls
# getAsInt(programName) and rejects anything outside that range ("Program
# number is out of range"), confirmed live: export()'s default naming
# (the turning part's own UUID, fine for every other post this pipeline
# uses) failed that check outright on a real posted job. The separate,
# older non-Fusion turning pipeline (autocam/turning.js) already reserves
# O1000 on this same physical machine, and autocam/tubestock.js reserves
# O1002 and up - this range is chosen clear of those. HAAS TL-1 (was "971
# Lathe") is the only turning-capable machine today, so applying this
# unconditionally to every turning job (not just ones that happen to
# resolve to the Haas post) is safe for now; a future non-Haas turning
# machine would need this revisited.
_HAAS_PROGRAM_NUMBER_RANGE_START = 4000
# One less than the post's own true upper bound (9999) - a two-setup job
# posts base and base+1, so the base itself must leave room for +1 without
# spilling past 9999.
_HAAS_PROGRAM_NUMBER_RANGE_END = 9998


def _haas_program_number_base(job_id: str) -> int:
    """A per-job base program number, not a fixed constant. Confirmed live:
    every turning job posting under the identical O4000 (and O4001 for a
    two-ended shaft) meant two different queued jobs produced identically-
    named G-code files - an operator who doesn't explicitly reload/verify
    before hitting cycle start could silently run a stale, previously-
    loaded program against completely different stock. Derived
    deterministically from the job's own id (the SAME job retried gets the
    SAME number - not meaningful to vary run-to-run - but two DIFFERENT
    jobs get different numbers with overwhelming probability) via a stable
    hash reduced into the range this post's own onOpen actually accepts.
    """
    span = _HAAS_PROGRAM_NUMBER_RANGE_END - _HAAS_PROGRAM_NUMBER_RANGE_START + 1
    digest = int(hashlib.sha256(job_id.encode("utf-8")).hexdigest(), 16)
    return _HAAS_PROGRAM_NUMBER_RANGE_START + (digest % span)


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    return total_machining_time(cam, adsk.core.ObjectCollection.create)


def _active_cam_product(app, doc):
    """Same reasoning and wait loop as HandleTube.py's/HandleSpacer.py's/
    HandleHexShaft.py's own _active_cam_product: a brand-new design document
    has no CAMProductType product at all until the Manufacture workspace is
    actually activated, and even then Fusion creates it asynchronously - a
    single immediate itemByProductType call right after creating/importing
    the design reliably returns None. Needed here (unlike those other
    modules, which only ever fetch their own cam product internally, after
    their own template/setup creation) because _load_generic_turning_tools
    needs a real cam product BEFORE handleHexShaft ever runs, to load tools
    into the document's tool library ahead of building any operation.
    """
    try:
        workspace = app.userInterface.workspaces.itemById("CAMEnvironment")
        if workspace:
            workspace.activate()
    except Exception:
        pass
    for _ in range(20):
        try:
            product = doc.products.itemByProductType("CAMProductType")
        except RuntimeError:
            product = None
        cam = adsk.cam.CAM.cast(product) if product else None
        if cam:
            return cam
        adsk.doEvents()
        time.sleep(0.1)
    raise RuntimeError(
        "Fusion did not create a CAM product after activating Manufacture; "
        "verify the Manufacturing extension is available."
    )


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

        cam = _active_cam_product(app, doc)

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
        # CAM-browser order) - see NewNCProgram.export's own docstring.
        # Explicit numeric names (see _haas_program_number_base) rather than
        # export()'s own UUID-based default - a two-ended hex shaft's two
        # setups get consecutive numbers instead of that default's "-2"
        # suffix, and different JOBS get different numbers from each other
        # too, not the same fixed base every time.
        program_number_base = _haas_program_number_base(job_id)
        setup_program_names = [
            str(program_number_base + i) for i in range(cam.setups.count)
        ]
        posted_program_names = export(turning_part_id, machine_post_processor_path, setup_program_names)

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
