from ..commands.GroupingValidation import (
    require_complete_arrangement,
    require_grouping_mode_matches_assignments,
    plate_spacing,
    require_positive_quantity,
)
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
from .job_status import ensure_completion_response, send_job_error
from .localCamAssets import load_local_tool_library_json, resolve_local_post_processor
from .templateTools import patch_cam_template_with_tool_libraries, disable_geometry_dependent_leads


def _select_plate_template_path(machine_name: Optional[str], material_name: Optional[str]) -> str:
    """Picks the richer, real-machine-exported template for metal/polycarbonate
    jobs on a machine that has one, falling back to the generic
    Plates.f3dhsm-template otherwise.

    Direct instruction, verified against cam_machines before wiring this up
    (two real machines, not one "the router"): "UNC Router" (controller
    linuxcnc, 971_emc.cps) is the old router - metal/Lexan jobs there use
    templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-template.
    "New Router" (controller wincnc per its current DB row, though its own
    filename says "shopsabre only!!" - see the separate GitHub issue
    flagging that controller value as likely wrong) is the new router -
    metal/Lexan jobs there use templates/971-real/new router metal sheet
    (shopsabre only!!).f3dhsm-template. Some richer templates (e.g.
    countersink) are flagged by the user as new-router-only; this function
    only handles the one mapping actually requested (metal/Lexan by
    machine), not a general per-template machine-compatibility system.

    Materials outside metal/polycarbonate (SRPP, MDF, acrylic, wood,
    Delrin, nylon) keep using the generic Plates.f3dhsm-template - nobody
    has asked for a richer template for those yet, and guessing one would
    risk the exact "guessed wrong Fusion internals" failure mode this
    project has hit before.
    """
    base_dir = os.path.dirname(__file__)
    fallback = os.path.join(base_dir, "../templates/Plates.f3dhsm-template")

    material = (material_name or "").strip().lower()
    is_metal_or_lexan = (
        "aluminum" in material
        or "aluminium" in material
        or "6061" in material
        or "lexan" in material
        or "polycarb" in material
        or ("poly" in material and "propylene" not in material)
    )
    if not is_metal_or_lexan:
        return fallback

    machine = (machine_name or "").strip().lower()
    if machine == "unc router":
        candidate = os.path.join(
            base_dir, "../templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-template"
        )
    elif machine == "new router":
        candidate = os.path.join(
            base_dir,
            "../templates/971-real/new router metal sheet (shopsabre only!!).f3dhsm-template",
        )
    else:
        # An unrecognized machine name - don't guess, use the generic
        # template rather than silently picking one of the two above.
        return fallback

    return candidate if os.path.isfile(candidate) else fallback


# None of adsk.cam.Operation's actual attributes expose a per-operation
# time (no machiningTime/cycleTime/toolpathTime/toolpathStatistics on the
# real API - a prior version of this function probed for those names
# speculatively and always fell through to None, so total_machining_time
# was silently never populated). adsk.cam.CAM.getMachiningTime() is the
# real, confirmed-live API behind Fusion's own "Machining Time" dialog.
# Rapid feed matches the shop's actual router rapid (30000 mm/min ==
# 50 cm/s, the unit getMachiningTime expects); toolChangeTime is a rough
# shop estimate, not measured.
_MACHINING_TIME_RAPID_CM_PER_SEC = 50.0
_MACHINING_TIME_TOOL_CHANGE_SEC = 15.0


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    ops = adsk.core.ObjectCollection.create()
    for setup in cam.setups:
        for operation in setup.operations:
            if getattr(operation, "isSuppressed", False):
                continue
            if hasattr(operation, "isToolpathValid") and not operation.isToolpathValid:
                continue
            ops.add(operation)
    if ops.count == 0:
        return None
    try:
        mt = cam.getMachiningTime(
            ops, 100, _MACHINING_TIME_RAPID_CM_PER_SEC, _MACHINING_TIME_TOOL_CHANGE_SEC
        )
    except Exception:
        return None
    return mt.machiningTime


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


# How little material may be left standing between two separate cuts before
# it's worth warning about, in cm (~1/16in). Not a machining rule anyone has
# published - chosen as the same order as the thinnest sheet this shop routes,
# on the reasoning that a wall thinner than the stock itself has no chance of
# staying put. Anton plate's own worst case measured 0.043in, well under this.
_MINIMUM_WALL_CM = 0.15


def _coverage_warnings(app, cam, nc_files) -> list:
    """Compares the posted program against the part's own CAD geometry and
    returns a warning per real problem found - an internal feature with no
    toolpath over it, or a program that never cuts deep enough to break
    through the material.

    Deliberately best-effort: a failure to run this check must never fail a
    job whose G-code is otherwise fine, so everything is wrapped and a
    diagnostic that can't run just reports that it couldn't.
    """
    try:
        import base64
        import importlib.util
        import os

        from ..commands.DeleteToolpaths import _bottom_face

        spec = importlib.util.spec_from_file_location(
            "featureCoverage", os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools/featureCoverage.py")
        )
        coverage = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(coverage)

        design = adsk.fusion.Design.cast(
            app.activeDocument.products.itemByProductType("DesignProductType")
        )
        if design is None:
            return ["Coverage self-check skipped: no Design product to compare against."]

        program_text = ""
        for nc_file in nc_files or []:
            try:
                program_text += base64.b64decode(nc_file["contentBase64"]).decode("utf-8", "replace")
                program_text += "\n"
            except Exception:
                continue
        if not program_text.strip():
            return ["Coverage self-check skipped: posted programs could not be read back."]

        cut_loops = coverage.gcode_loops(program_text)
        warnings = []
        for occurrence in design.rootComponent.allOccurrences:
            if occurrence.bRepBodies.count == 0:
                continue
            body = occurrence.bRepBodies.item(0)
            cad_loops = coverage.internal_loop_extents(body, _bottom_face)
            if not cad_loops:
                continue
            _text, detail = coverage.report(cad_loops, cut_loops)
            for entry in detail["uncut"]:
                loop = entry["cad"]
                warnings.append(
                    "A {} internal feature at ({:.3f}, {:.3f})in, {:.3f}x{:.3f}in, has no toolpath "
                    "covering it - it will not be machined.".format(
                        "round" if loop["circular"] else "profile",
                        loop["cx"] / 2.54,
                        loop["cy"] / 2.54,
                        (loop["max_x"] - loop["min_x"]) / 2.54,
                        (loop["max_y"] - loop["min_y"]) / 2.54,
                    )
                )

            box = body.boundingBox
            passes, deepest, required = coverage.breakthrough_check(
                program_text, box.minPoint.z, box.maxPoint.z
            )
            if not passes:
                warnings.append(
                    "This program's deepest cut ({:.4f}in) never reaches the material bottom "
                    "({:.4f}in) - nothing will be cut all the way through.".format(
                        (deepest or 0) / 2.54, required / 2.54
                    )
                )

        # How thin a wall this part's own geometry leaves between two separate
        # cuts, given the tool actually being used. Nothing about the
        # selections is wrong when this fires - both operations cut exactly
        # what they should - but the material left standing between them can
        # still be too fragile to survive, and rendered it looks identical to
        # a wrongly-selected chain (two cuts appearing to merge into one),
        # which is exactly the confusion this is here to end.
        try:
            tool_diameter_cm = None
            for setup in cam.setups:
                for operation in setup.operations:
                    parameter = operation.tool.parameters.itemByName("tool_diameter")
                    if parameter is not None:
                        tool_diameter_cm = parameter.value.value
                        break
                if tool_diameter_cm:
                    break
            if tool_diameter_cm:
                programs = []
                for nc_file in nc_files or []:
                    try:
                        programs.append(
                            (nc_file.get("name", "?"), base64.b64decode(nc_file["contentBase64"]).decode("utf-8", "replace"))
                        )
                    except Exception:
                        continue
                for i in range(len(programs)):
                    for j in range(i + 1, len(programs)):
                        ok, wall, _closest = coverage.thin_wall_check(
                            programs[i][1], programs[j][1], tool_diameter_cm, _MINIMUM_WALL_CM
                        )
                        if not ok and wall is not None:
                            warnings.append(
                                "Only {:.4f}in of material is left between the cuts in '{}' and '{}' "
                                "(minimum {:.4f}in) - these features sit too close together for a "
                                "{:.4f}in tool, and that wall is likely to break out.".format(
                                    wall / 2.54,
                                    programs[i][0],
                                    programs[j][0],
                                    _MINIMUM_WALL_CM / 2.54,
                                    tool_diameter_cm / 2.54,
                                )
                            )
        except Exception:
            app.log("Thin-wall self-check failed to run:\n{}".format(traceback.format_exc()))

        return warnings
    except Exception:
        app.log("Coverage self-check failed to run:\n{}".format(traceback.format_exc()))
        return ["Coverage self-check could not run - see the Runner log."]


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

        # Clear design but don't nuke CAM (we're creating a new file).
        # Deferred (not module-level) import: importPlate.py imports
        # _download_part_file from this module at ITS OWN module level, so
        # a module-level import here forms a genuine circular import -
        # SpartanRoboticsAutoCAM.py's own top-level import of importPlate
        # would fail immediately on a fresh add-in load ("cannot import
        # name 'clear_design_nuke' from partially initialized module"),
        # since importPlate.py is still mid-load (hasn't defined
        # clear_design_nuke yet) at the exact moment this module tries to
        # import it back. Confirmed directly: a real fresh Fusion restart
        # hit exactly this error. Deferring to call time works because by
        # then both modules have finished loading.
        from .importPlate import clear_design_nuke

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
        require_grouping_mode_matches_assignments(assignments, _get(payload, "grouping_mode"))
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
        template_path = _select_plate_template_path(machine_name, material_name)

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

        leads_disabled = disable_geometry_dependent_leads(template_path)
        if leads_disabled:
            app.log(f"Disabled geometry-dependent leads for: {leads_disabled}")

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

        # Save the document to the configured AutoCAM drop folder, or the
        # folder chosen at queue time (Plates tab folder-tree picker).
        try:
            folder_path = _get(payload, "fusion_folder_path") or FUSION_DROP_FOLDER_PATH
            data_project, autocam_drop_folder = resolve_drop_folder(
                app, FUSION_DATA_PROJECT_NAME, folder_path
            )

            # Prefer a name typed at queue time (payload.fusion_file_name -
            # the Plates tab filename field) over a per-part name
            # (fusion_parts.fusion_file_name, set on the Parts tab) over the
            # default Plate<plate_id>Job<job_id> - the last is real but
            # unreadable in Fusion's Data Panel (both plate_id and job_id
            # are UUIDs). The per-part fallback uses the first assigned
            # part's name since a plate's saved document is one file
            # regardless of how many parts are nested onto it.
            custom_name = _get(payload, "fusion_file_name")
            if not custom_name:
                for assignment in assignments:
                    candidate = assignment.get("fusion_file_name")
                    if candidate:
                        custom_name = candidate
                        break
            doc_name = re.sub(r"\s+", "", str(custom_name)) if custom_name else f"Plate{plate_id}Job{job_id}"
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

        # A completed job with zero output files is a silent failure, not a
        # success - real case observed live: export() and postProcess() ran
        # without raising, but export_dir ended up empty (Fusion state left
        # over from unrelated concurrent activity in the same session), and
        # this job would otherwise have reported "completed" with nothing
        # to download. Same principle as NewNCProgram.py's own posting
        # retries - a failure has to surface as one, not get reported as
        # success just because nothing else went wrong along the way.
        if not nc_files:
            raise RuntimeError(
                "Fusion produced no NC files for this job - nothing was posted. "
                "Check the Runner's log for what postProcess actually did."
            )

        # Self-check the posted output against the part's own CAD geometry
        # before calling this job done. Every "a feature silently didn't get
        # machined" bug this pipeline has hit was invisible to the checks that
        # already existed - the operation reported a valid toolpath, carried
        # the right number of chains, and raised no warning, while the real
        # G-code either never covered that feature or never cut deep enough to
        # break through it. The only thing that reliably distinguishes those
        # cases is comparing the actual posted program against the actual
        # model, which is what this does. Reported as job warnings rather than
        # raised: the G-code is real and may still be worth running, but
        # nobody should have to open the simulation and eyeball it to find out
        # a cutout is missing.
        coverage_warnings = _coverage_warnings(app, cam, nc_files)
        for warning in coverage_warnings:
            app.log(f"COVERAGE: {warning}")

        completion_data = {
            "jobId": job_id,
            "runnerId": RUNNER_ID,
            "ncFiles": nc_files,
        }
        if coverage_warnings:
            completion_data["warnings"] = coverage_warnings
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
        # Left open on purpose - direct instruction to remove the earlier
        # "close it and return to Fusion's Start screen between jobs"
        # behavior. Whoever's watching a job run can now inspect the real
        # finished document (setups, operations, generated toolpaths)
        # immediately, without Fusion clearing it out from under them.

    except Exception:
        if app:
            app.log("Failed:\n{}".format(traceback.format_exc()))
        send_job_error(session, job_id, traceback.format_exc())
