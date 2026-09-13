from ..commands.GroupingValidation import (
    require_complete_arrangement,
    require_grouping_mode_matches_assignments,
    plate_spacing,
    require_positive_quantity,
    PlateFitError,
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
from ..commands.Orientation import orient_plate_pocket_side_up
from ..commands.TabPlacement import ConfigureTabs, DEFAULT_MAX_TABS, DEFAULT_MIN_TABS
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
from .templateTools import patch_cam_template_with_tool_libraries, disable_geometry_dependent_leads


def _select_plate_template_path(machine_name: Optional[str]) -> str:
    """Picks the richer, real-machine-exported template for the machine
    being cut on, falling back to the generic Plates.f3dhsm-template only
    when the machine itself isn't one of the two known routers.

    Direct instruction, verified against cam_machines before wiring this up
    (two real machines, not one "the router"): "UNC Router" (controller
    linuxcnc, 971_emc.cps) is the old router - jobs there use
    templates/971-real/(DEPRECATED)971 Metal Sheet.f3dhsm-template.
    "New Router" (controller wincnc per its current DB row, though its own
    filename says "shopsabre only!!" - see the separate GitHub issue
    flagging that controller value as likely wrong) is the new router -
    jobs there use templates/971-real/new router metal sheet (shopsabre
    only!!).f3dhsm-template. Some richer templates are
    flagged by the user as new-router-only; this function only handles the
    one mapping actually requested (which template a given machine uses),
    not a general per-template machine-compatibility system.

    This USED to gate the rich template on material - metal/Lexan only,
    every other material (SRPP, MDF, acrylic, wood, Delrin, nylon) fell
    back to the generic Plates.f3dhsm-template. That fallback's own
    operations are named "256Drill", "2D Contour2 (9)", "Pocket1 (2)" and
    "Suppress" - none of which match DeleteToolpaths' routing rules (which
    key off "through"/"circular"/group_tabs naming), so no real geometry
    was ever assigned to them. Confirmed live: a real SRPP plate came out
    with a single stray bore and nothing else, while the identical part
    queued as aluminum machined every feature correctly.

    All materials now get this same rich, machine-proven operation set.
    Correct per-material feeds/speeds are NOT this function's job - they
    already come from patch_cam_template_with_tool_libraries below, which
    was already being called for the aluminum path this function used to
    special-case, and picks a REVIEWED preset from the checked-in tool
    library by material name (_choose_preset in templateTools.py), raising
    rather than guessing if that material has no reviewed preset. Every
    real router material in cam_materials already has one (confirmed by
    reading the checked-in 971-outside-plate.tools library directly:
    Aluminum 6061, Polycarbonate (Lexan), SRPP, Acrylic, MDF, Baltic Birch
    Plywood, Delrin (Acetal), Nylon), so removing this gate is what lets
    that already-correct, already-proven mechanism actually run for them -
    it could never be reached while non-metal materials were routed to the
    generic template's unrecognized operation names instead.
    """
    base_dir = os.path.dirname(__file__)
    fallback = os.path.join(base_dir, "../templates/Plates.f3dhsm-template")

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


def _total_machining_time(cam: adsk.cam.CAM) -> Optional[float]:
    return total_machining_time(cam, adsk.core.ObjectCollection.create)


def _report_grown_plate(app, session: requests.Session, plate_id: str, length: float, width: float) -> None:
    """Persists a plate size AutoArrange had to grow to fit a part, so the
    next job queued against this same plate starts from the larger size
    instead of growing again from scratch every time. Best-effort: a plate
    that already generated valid G-code this run must not be failed over a
    bookkeeping request that didn't need to succeed for the job itself.
    """
    try:
        response = session.post(
            f"{BASE_URL}/api/fusion-runner",
            params={"action": "grow-plate"},
            json={"plateId": plate_id, "runnerId": RUNNER_ID, "length": length, "width": width},
            timeout=30,
        )
        if not response.ok and app:
            app.log(f"Failed to persist grown plate size: HTTP {response.status_code} {response.text}")
    except Exception as exc:  # noqa: BLE001 - best-effort by design, see docstring
        if app:
            app.log(f"Failed to persist grown plate size: {exc}")


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


def _apply_snapshot_part_names(data: dict, assignments: list[dict], occurrences) -> None:
    """Restore human-readable part names after STEP import.

    Downloaded files are intentionally stored under their part UUID, so the
    importer's default component name is opaque.  The immutable job snapshot
    is the authoritative place to recover the operator-facing name.
    """
    snapshot_assignments = ((data.get('params') or {}).get('fusionPlateSnapshot') or {}).get('assignments') or []
    names_by_part_id = {
        str(item.get('part_id')): str(item.get('name'))
        for item in snapshot_assignments
        if isinstance(item, dict) and item.get('part_id') and item.get('name')
    }
    names = []
    for assignment in assignments:
        name = names_by_part_id.get(str(assignment['part_id']))
        if not name:
            continue
        names.extend([name] * int(assignment['quantity']))
    if len(names) != len(occurrences):
        return
    for occurrence, name in zip(occurrences, names):
        try:
            occurrence.component.name = name
        except Exception:
            pass


def _get(payload: dict, *keys: str, default=None):
    for key in keys:
        if key in payload:
            return payload[key]
    return default


def _resolve_tab_count_override(payload: dict, log):
    """An operator can force an exact tab count for this job instead of
    the perimeter-based automatic target (TabPlacement._tab_count_for_
    perimeter) - returns None (stay automatic, this job's existing
    default) when nothing was set.

    Clamped to [DEFAULT_MIN_TABS, DEFAULT_MAX_TABS] - the same range the
    automatic system already treats as reasonable - server-side too (see
    jobPayload.js), but re-checked here rather than trusting a single
    layer: "cannot be too much" is a real constraint (this session's own
    over-tabbing incident), not just a UI hint. A malformed value falls
    back to automatic rather than raising - the caller's own try/except
    around ConfigureTabs would otherwise turn one bad value into zero
    tabs for the whole job, a much worse outcome than ignoring it.

    The caller passes min_tabs=max_tabs=this value to ConfigureTabs,
    forcing every body in the job to exactly that count, overriding the
    per-body perimeter scaling entirely - that is what "set the amount
    of tabs" means once an operator has taken explicit manual control.
    """
    raw_value = _get(payload, "tab_count")
    if raw_value is None:
        return None
    try:
        return max(DEFAULT_MIN_TABS, min(DEFAULT_MAX_TABS, int(raw_value)))
    except (TypeError, ValueError):
        log(f"Ignoring invalid tab_count override '{raw_value}': using the automatic default instead")
        return None


# How little material may be left standing between two separate cuts before
# it's worth warning about, in cm (~1/16in). Not a machining rule anyone has
# published - chosen as the same order as the thinnest sheet this shop routes,
# on the reasoning that a wall thinner than the stock itself has no chance of
# staying put. Anton plate's own worst case measured 0.043in, well under this.
_MINIMUM_WALL_CM = 0.15


# A job with a genuinely broken template could otherwise report one warning
# per operation and fill the row with near-identical text. Enough to see the
# pattern; the Runner's own log still has every one of them.
_MAX_OPERATION_WARNINGS = 10


def _operation_warnings(app, cam) -> list:
    """Every surviving operation's own Fusion-reported warning, as job
    warnings.

    Fusion raises real, non-fatal warnings on operations that still report
    isToolpathValid=True and still post successfully - the operation just
    quietly machines less than it should. Issue #316 is exactly this: "One or
    more pockets were not machined because they are too small to be reached
    with given ramping constraints" appears only in Fusion's own Text
    Commands log on the machine that ran the job, so some small pocket or
    corner silently doesn't get cut and nothing anywhere in the web UI says
    so.

    Only operations that survived DeleteToolpaths' cleanup are read - an
    operation that was removed for having no applicable geometry isn't a
    warning about this part, and the empty-toolpath warnings that drive that
    cleanup would otherwise be reported as if they were.

    Deliberately best-effort for the same reason as _coverage_warnings
    below: a diagnostic must never fail a job whose G-code is fine.
    """
    warnings = []
    try:
        for setup in cam.setups:
            for operation in setup.operations:
                if len(warnings) >= _MAX_OPERATION_WARNINGS:
                    warnings.append(
                        "More operations reported warnings than are listed here - "
                        "see the Runner's own log for the rest."
                    )
                    return warnings
                try:
                    text = str(operation.warning or "").strip()
                    name = str(operation.name or "operation")
                except Exception:
                    continue
                if not text:
                    continue
                # Collapse Fusion's own trailing newlines into one line so
                # the warning reads cleanly in a table cell.
                text = " ".join(text.split())
                warnings.append(f"Fusion reported on '{name}': {text}")
    except Exception as exc:  # noqa: BLE001 - see docstring
        app.log(f"Operation-warning check could not run: {exc}")
    return warnings


def _require_release_contour(cam) -> None:
    """Raise if the one operation that actually releases the part(s) from
    stock did not survive DeleteToolpaths.

    group_tabs=true marks exactly one contour2d operation per setup - the
    outer release cut TabPlacement.py configures manual tabs on (see that
    module's own docstring). DeleteToolpaths prunes any operation whose
    toolpath came out invalid, this one included if tab placement left it
    with no valid geometry - confirmed live as a real incident: a job
    posted G-code with every hole machined and the release cut silently
    missing, reported "completed" with zero warnings, because nothing
    anywhere checked that this specific operation survived. A part that
    is never actually cut free of its stock is not a completed job - fail
    here, immediately after DeleteToolpaths runs, instead of only ever
    finding out at the machine.

    cam may be None (the CAM product failed to resolve) - nothing to
    check in that case, and camPlate.py's own machining-time computation
    already treats a missing cam the same way.
    """
    if cam is None:
        return
    for setup in cam.setups:
        for op in setup.operations:
            if op.strategy != "contour2d":
                continue
            group_tabs_param = op.parameters.itemByName("group_tabs")
            if group_tabs_param is None:
                continue
            try:
                is_release = str(group_tabs_param.expression).strip().lower() == "true"
            except Exception:
                is_release = False
            if is_release:
                return
    raise RuntimeError(
        "No release-contour operation (group_tabs=true) survived toolpath "
        "generation - the part(s) would never actually separate from "
        "stock. Check the Runner's log for TabPlacement/DeleteToolpaths "
        "output explaining why this operation's toolpath came out invalid."
    )


def _require_through_hole_for_finishing_pass(cam) -> None:
    """Raise if a setup has a Shape Through Finishing Pass with no matching
    Shape Through Hole roughing operation, or vice versa - the pairing is
    required in both directions.

    A Shape Through Finishing Pass (contour2d) just follows the boundary
    line of a through-cut shape - it never clears the shape's interior.
    That's the roughing operations' job (Shape Through Hole / Small Shape
    Through Hole / Shape Through Hole big endmill, all adaptive2d - see
    DeleteToolpaths.py's through_shape_ops split). A finishing pass with
    no roughing partner in the same setup is physically meaningless on
    its own: nothing ever cleared the interior it's tracing the edge of.
    Symmetrically, a roughing pass with no finishing partner leaves the
    boundary it just roughed un-cleaned. Direct instruction: a Shape
    Through Finishing Pass can only exist if there is a Shape Through
    Hole, and vice versa - neither is ever valid alone.

    The name/strategy filter below is deliberately identical to
    DeleteToolpaths.py's own through_shape_ops filter (see that module -
    "through" in the name, "circular" excluded so dedicated round-hole
    bore/pocket2d ops never get swept in here, strategy != "bore") so this
    checks the exact same operation set that module assigns chains to.
    Kept as a duplicate rather than imported from there, same reason
    _require_release_contour doesn't import DeleteToolpaths.py either -
    that module imports Fusion's runtime-only `adsk` package at import
    time, so this file (and its tests) can't pull the filter in directly.
    If DeleteToolpaths.py's own filter ever changes, update this one to
    match.

    Checked per setup, same as _require_release_contour: the pairing is
    per-setup, not a document-wide count that could let one setup's spare
    roughing op quietly cover another setup's missing one.

    Presence of both isn't the whole story either - direct instruction:
    the Shape Through Hole roughing operation(s) must have the SAME
    geometry selection as the finishing pass, not just exist somewhere in
    the same setup. DeleteToolpaths.py builds both from the same shared
    chain pool per setup (finishing gets every chain, roughing gets that
    same pool split by which tool can reach each one - see its own
    through_chain_assignments), so the union of every roughing tier's
    edges equals the finishing pass's edges exactly in the success case;
    this only ever fires when a chain assignment partially failed (e.g.
    one roughing tier's geometry write raised and was swallowed, or
    picked up an edge the finishing pass doesn't have) and left the two
    selections disagreeing. Compared via each edge's entityToken and its
    ChainSelection direction/open state - Fusion can hand back a different
    Python wrapper object for the same underlying edge on repeated property
    access, so identity/`==` on the raw BRepEdge is not reliable within a
    single script run. Direction is part of the selection contract too: the
    same edge with opposite compensation can cut the wrong side.

    Geometry is only compared when it can actually be read (a real
    ChainSelection with getCurveSelections()) - a missing/unreadable
    selection is a "can't tell" for this coverage check, not a "no
    coverage" false positive, and is left for the presence check above
    and DeleteToolpaths' own isToolpathValid cleanup to catch instead.

    cam may be None (the CAM product failed to resolve) - nothing to
    check in that case, same as _require_release_contour.
    """
    if cam is None:
        return

    def _edge_tokens(op):
        param_name = "contours" if op.strategy == "contour2d" else "pockets"
        try:
            param = op.parameters.itemByName(param_name)
            if param is None:
                return None
            value = param.value
            if not hasattr(value, "getCurveSelections"):
                return None
            tokens = set()
            for chain in value.getCurveSelections():
                chain_state = (
                    bool(getattr(chain, "isOpen", False)),
                    bool(getattr(chain, "isReverted", False)),
                )
                for edge in getattr(chain, "inputGeometry", None) or []:
                    token = getattr(edge, "entityToken", None)
                    tokens.add((token if token is not None else edge, *chain_state))
            return tokens
        except Exception:
            return None

    for setup in cam.setups:
        through_shape_ops = [
            op
            for op in setup.operations
            if "through" in str(op.name).lower()
            and "circular" not in str(op.name).lower()
            and op.strategy != "bore"
        ]
        if not through_shape_ops:
            continue
        finishing_ops = [op for op in through_shape_ops if op.strategy == "contour2d"]
        roughing_ops = [op for op in through_shape_ops if op.strategy != "contour2d"]
        if bool(finishing_ops) != bool(roughing_ops):
            missing = "Shape Through Hole roughing operation" if finishing_ops else "Shape Through Finishing Pass"
            present = "Shape Through Finishing Pass" if finishing_ops else "Shape Through Hole roughing operation"
            raise RuntimeError(
                f"A {present} survived toolpath generation with no "
                f"matching {missing} in the same setup - the two only "
                "ever exist together. Check the Runner's log for why the "
                "missing operation isn't in the template or was pruned "
                "by DeleteToolpaths for an invalid toolpath."
            )
        if not finishing_ops:
            continue
        finishing_edges = set()
        roughing_edges = set()
        readable = True
        for op in finishing_ops + roughing_ops:
            tokens = _edge_tokens(op)
            if tokens is None:
                readable = False
                break
            (finishing_edges if op.strategy == "contour2d" else roughing_edges).update(tokens)
        if readable and finishing_edges != roughing_edges:
            raise RuntimeError(
                "A Shape Through Finishing Pass's geometry selection does "
                "not exactly match its Shape Through Hole roughing "
                "operation(s) in the same setup. Check the Runner's log "
                "for a partial chain-assignment failure in "
                "DeleteToolpaths."
            )


def _require_pocket_finishing_pass_pairing(cam) -> None:
    """Raise if a setup has a Shape Pocket with no matching Shape Pocket
    Finishing Pass, or vice versa - the same direct instruction as
    _require_through_hole_for_finishing_pass, applied to pockets: "a
    pocket through should always be accompanied by a pocket finishing
    pass."

    Shape Pocket (adaptive2d) clears a recessed floor's interior; Shape
    Pocket Finishing Pass (contour2d) just follows its boundary. Neither
    is meaningful alone - a finishing pass with nothing that cleared the
    floor it traces, or a roughing pass whose floor was never finished.

    Structurally identical to _require_through_hole_for_finishing_pass
    (per-setup presence check in both directions, then an exact
    entityToken-based geometry match) - kept as its own function rather
    than a shared parameterized helper for the same isolated-testing
    reason that function's own docstring gives for not importing
    DeleteToolpaths.py: whatever calls this needs to stay loadable by
    slicing this file's source without pulling in a shared helper defined
    outside whatever range gets sliced.

    Name filter: "pocket" in the name, "circular" excluded so the
    template's own dedicated round-pocket operation (">.3 Circular
    Pocket", pocket2d, its own hole-recognition machinery) never gets
    swept in here - matches DeleteToolpaths.py's _POCKET_STRATEGIES
    handling of that operation as a separate, dedicated case.

    cam may be None (the CAM product failed to resolve) - nothing to
    check in that case, same as the through-hole guard.
    """
    if cam is None:
        return

    def _edge_tokens(op):
        param_name = "contours" if op.strategy == "contour2d" else "pockets"
        try:
            param = op.parameters.itemByName(param_name)
            if param is None:
                return None
            value = param.value
            if not hasattr(value, "getCurveSelections"):
                return None
            tokens = set()
            for chain in value.getCurveSelections():
                for edge in getattr(chain, "inputGeometry", None) or []:
                    token = getattr(edge, "entityToken", None)
                    tokens.add(token if token is not None else edge)
            return tokens
        except Exception:
            return None

    for setup in cam.setups:
        pocket_ops = [
            op
            for op in setup.operations
            if "pocket" in str(op.name).lower() and "circular" not in str(op.name).lower()
        ]
        if not pocket_ops:
            continue
        finishing_ops = [op for op in pocket_ops if op.strategy == "contour2d"]
        roughing_ops = [op for op in pocket_ops if op.strategy != "contour2d"]
        if bool(finishing_ops) != bool(roughing_ops):
            missing = "Shape Pocket roughing operation" if finishing_ops else "Shape Pocket Finishing Pass"
            present = "Shape Pocket Finishing Pass" if finishing_ops else "Shape Pocket roughing operation"
            raise RuntimeError(
                f"A {present} survived toolpath generation with no "
                f"matching {missing} in the same setup - the two only "
                "ever exist together. Check the Runner's log for why the "
                "missing operation isn't in the template or was pruned "
                "by DeleteToolpaths for an invalid toolpath."
            )
        if not finishing_ops:
            continue
        finishing_edges = set()
        roughing_edges = set()
        readable = True
        for op in finishing_ops + roughing_ops:
            tokens = _edge_tokens(op)
            if tokens is None:
                readable = False
                break
            (finishing_edges if op.strategy == "contour2d" else roughing_edges).update(tokens)
        if readable and finishing_edges != roughing_edges:
            raise RuntimeError(
                "A Shape Pocket Finishing Pass's geometry selection does "
                "not exactly match its Shape Pocket roughing operation(s) "
                "in the same setup. Check the Runner's log for a partial "
                "chain-assignment failure in DeleteToolpaths."
            )


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
    # Declared before the try, alongside job_id, for the same reason: the
    # cleanup in the finally block below needs these however far the job
    # actually got before failing (or never even downloading a part).
    step_paths = []
    patched_template_path = None
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
        for assignment in assignments:
            part_id = str(assignment["part_id"])
            step_paths.append(
                _download_part_file(session, part_id, assignment.get("step_file_url"))
            )
        importFiles(
            step_paths,
            [assignment.get("quantity", 1) for assignment in assignments],
        )

        # Select the broad side that contains blind-pocket openings before
        # nesting.  The old area-only choice favored the larger plain back,
        # then Arrange could preserve that wrong side all the way into CAM.
        # Do this before AutoArrange so its face-up constraint keeps pockets
        # accessible to the setup and PocketRecognitionSelection.
        for occurrence in design.rootComponent.allOccurrences:
            orient_plate_pocket_side_up(occurrence)

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
        _apply_snapshot_part_names(data, assignments, occurrences)

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
        multi_tool_mode = isinstance(payload, dict) and payload.get("multi_tool_mode") is True

        # Loaded ahead of plate_spacing below (moved earlier from its
        # original position, right before patch_cam_template_with_tool_libraries)
        # because multi-tool mode has no single cam_tools row to read a
        # spacing diameter from at all - see that block's own comment.
        _tool_info, tool_json_path = load_local_tool_library_json(data, TOOLS_PATH)

        # Plate spacing needs a real cutting-tool diameter to keep parts
        # clear of each other. Single-tool mode has exactly one (the
        # joined cam_tools row); multi-tool mode deliberately has no
        # single selection at all (tool_id is null - see jobPayload.js's
        # resolveLoadedToolItems), so fall back to the largest loaded
        # endmill in the library file just written above - the same tool
        # toolPlanning.py's own diameter-first ranking will pick for
        # roughing, so spacing stays consistent with what actually cuts.
        # Confirmed live: the original single-tool-only lookup crashed
        # every multi-tool job outright (TypeError: float() argument must
        # be a string or a real number, not 'NoneType').
        spacing_diameter = (data.get('cam_tools') or {}).get('diameter')
        if spacing_diameter is None:
            with open(tool_json_path, encoding="utf-8") as tool_json_file:
                loaded_entries = (json.load(tool_json_file) or {}).get("data") or []
            endmill_diameters = [
                diameter for diameter in (
                    (entry.get("geometry") or {}).get("DC")
                    for entry in loaded_entries
                    if isinstance(entry, dict) and "end mill" in str(entry.get("type") or "").lower()
                )
                if isinstance(diameter, (int, float))
            ]
            spacing_diameter = max(endmill_diameters) if endmill_diameters else None
        spacing = plate_spacing(spacing_diameter)
        requested_length, requested_width = length, width
        try:
            arrange, length, width = AutoArrange(length, width, object_spacing=spacing)
        except RuntimeError as error:
            if 'ARRANGE_ERROR_NO_ROOM' not in str(error):
                raise
            raise PlateFitError(
                f'Fusion could not fit every selected part on the {length:.2f} x '
                f'{width:.2f}in plate. Select larger stock or reduce the group.'
            ) from error
        require_complete_arrangement(arrange, occurrences)
        if length > requested_length or width > requested_width:
            _report_grown_plate(app, session, _get(payload, "plate_id", "plateId", default="cam_plate"), length, width)

        # The claim response already joins these records. Keep the Runner
        # offline after a claim: the old /api/tools, /api/materials, and
        # /api/machines endpoints were never part of this application.
        machine = data.get("cam_machines") or {}
        material = data.get("cam_materials") or {}
        machine_name = machine.get("name") or _get(payload, "machine")
        material_name = material.get("name") or _get(payload, "material")
        machine_post_processor_path = resolve_local_post_processor(data)
        template_path = _select_plate_template_path(machine_name)

        patched_template = os.path.join(
            TOOLS_PATH, f"Plates_job{job_id}.f3dhsm-template"
        )
        patched_template_path = patched_template
        patch_info = patch_cam_template_with_tool_libraries(
            template_path,
            patched_template,
            [tool_json_path],
            material_name=material_name,
            filter_guids=filter_guids,
            multi_tool_mode=multi_tool_mode,
        )
        if patch_info.get("tool_plan"):
            app.log(f"Tool plan: {patch_info['tool_plan']}")
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
            tab_count_override = _resolve_tab_count_override(payload, app.log)
            if tab_count_override is not None:
                app.log(f"Using operator-specified tab count: {tab_count_override}")
                ConfigureTabs(
                    min_tabs=tab_count_override,
                    max_tabs=tab_count_override,
                    object_spacing_in=spacing,
                )
            else:
                ConfigureTabs(object_spacing_in=spacing)
        except Exception:
            # A release contour without verified tabs can free a part during
            # machining. Do not log and post it anyway.
            app.log("TabPlacement failed:\n{}".format(traceback.format_exc()))
            raise RuntimeError("Could not configure safe holding tabs for the release contour")
        DeleteToolpaths()

        # Bound before the try below runs, not just assigned inside it -
        # _coverage_warnings/_operation_warnings further down read `cam`
        # unconditionally, outside this try. If resolving the CAM product
        # itself raised, `cam` was never assigned and those later calls
        # crashed with a bare NameError on an otherwise-successful job
        # (G-code already posted, export_dir already cleaned up).
        cam = None
        try:
            cam_product = app.activeDocument.products.itemByProductType("CAMProductType")
            cam = adsk.cam.CAM.cast(cam_product) if cam_product else None
        except Exception:
            app.log("Failed to resolve the CAM product after DeleteToolpaths:\n{}".format(traceback.format_exc()))

        _require_release_contour(cam)
        _require_through_hole_for_finishing_pass(cam)
        _require_pocket_finishing_pass_pairing(cam)

        total_machining_time = None
        if cam:
            try:
                total_machining_time = _total_machining_time(cam)
            except Exception:
                app.log("Failed to compute machining time:\n{}".format(traceback.format_exc()))

        plate_id = str(_get(payload, "plate_id", "plateId", default="cam_plate"))

        # Save the document to the configured AutoCAM drop folder, or the
        # folder chosen at queue time (Plates tab folder-tree picker).
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
        save_new_document(doc, autocam_drop_folder, doc_name)
        app.log(f"File uploaded to {data_project.name}/{folder_path}/{doc_name}")

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

        # Fusion's own per-operation warnings, which otherwise never leave
        # the machine that ran the job (issue #316). Reported alongside the
        # coverage check rather than instead of it: the two catch different
        # things - Fusion knows when it declined to machine something, the
        # coverage check catches the cases where it thought everything was
        # fine and the program still missed a feature.
        operation_warnings = _operation_warnings(app, cam)
        for warning in operation_warnings:
            app.log(f"OPERATION: {warning}")

        job_warnings = coverage_warnings + operation_warnings

        completion_data = {
            "jobId": job_id,
            "runnerId": RUNNER_ID,
            "ncFiles": nc_files,
        }
        if job_warnings:
            completion_data["warnings"] = job_warnings
        stats = {}
        if total_machining_time is not None:
            stats["total_machining_time"] = total_machining_time
        # Auto multi-tool has no single selected tool to show in the queue -
        # this is the actual plan patch_cam_template_with_tool_libraries
        # already computed (which loaded cutters it kept vs. skipped, and
        # why), just never reported back before. Real gap: the Jobs tab
        # showed "no tool assigned" for a multi-tool job, indistinguishable
        # from a job that was queued with nothing selected at all.
        planned_guids = patch_info.get("tool_plan", {}).get("endmill_guids")
        if multi_tool_mode and planned_guids:
            with open(tool_json_path, encoding="utf-8") as tool_json_file:
                tool_names_by_guid = {
                    entry.get("guid"): entry.get("description")
                    for entry in (json.load(tool_json_file) or {}).get("data") or []
                    if isinstance(entry, dict) and entry.get("guid")
                }
            stats["toolPlan"] = {
                "reason": patch_info["tool_plan"].get("reason"),
                "tools": [
                    {"guid": guid, "name": tool_names_by_guid.get(guid) or guid}
                    for guid in planned_guids
                ],
            }
        if stats:
            completion_data["stats"] = stats

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
        if resp is not None and resp.ok:
            app.log("Job Completed")
        # Deliberately does not close the document once the job completes -
        # every job already creates and activates its own brand-new
        # document at the top of start() (see new_doc.activate() above), so
        # a document left open from a prior job is never mistaken for "the"
        # active document by a later one. Matches camTube.py's own tube
        # jobs, which stopped closing for the same reason plus a real,
        # confirmed live upload-timing bug closing raced.

        try:
            ui.workspaces.itemById("FusionSolidEnvironment").activate()
        except Exception:
            pass

    except PlateFitError as error:
        if app:
            app.log(f"Plate fit failed: {error}")
        send_job_error(session, job_id, str(error))
    except Exception:
        if app:
            app.log("Failed:\n{}".format(traceback.format_exc()))
        send_job_error(session, job_id, traceback.format_exc())
    finally:
        # Live-confirmed real leak, not theoretical: neither of these was
        # ever cleaned up anywhere, on any path (success or failure).
        # Checked directly against a real Runner install after ~200 real
        # jobs - 233 patched templates (42MB) in TOOLS_PATH, 113 downloaded
        # STEP files (20MB) in INITIAL_PATH, every single one from a job
        # that finished (or failed) long ago. TEMP_PATH's own name already
        # says these are meant to be transient per-job scratch files, not a
        # permanent cache - matches how FINAL_PATH's export_dir is already
        # cleaned up after a job's real output is durably saved elsewhere.
        # Best-effort: a cleanup failure must never mask the job's own
        # real outcome, which every branch above has already reported.
        for path in [*step_paths, patched_template_path]:
            if not path:
                continue
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
            except Exception as cleanup_error:
                if app:
                    app.log(f"Could not remove temporary job file '{path}': {cleanup_error}")
