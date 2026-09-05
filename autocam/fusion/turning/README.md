# Fusion turning CAM foundation

Tracking issue: [#331](https://github.com/frc971/spartanshub/issues/331).
This is an experimental, callable foundation. It is not registered with the
Runner, does not insert jobs, and produces no G-code.

## Haas TL-1 target

The prototype is pinned to the team's **Haas TL-1**, controller `haas`, and
**HAAS Turning** post family. `machine.py` requires the future reviewed local
asset name `haas_tl1_turning.cps`; that file is not bundled or validated yet.
The planner rejects `971_emc.cps`, LinuxCNC, ShopSabre, and Haas milling posts.
The repository identifies `971_emc.cps` as the UNC router post, not a lathe post.

The example uses automatic turret tool changes because `autocam/turning.js`
documents the team's TL-1 as equipped with a turret ATC. Verify the real machine
configuration before enabling output. The older database seed labels 971 Lathe
`linuxcnc` even though its description says Haas TL-1; do not inherit that legacy
controller value when wiring this feature into the catalog. No production
machine record is changed by this prototype.

Haas control generation, actual spindle limit, installed turret configuration,
post properties and X diameter mode remain machine-specific release checks.
The spindle limit in the example is synthetic, not a verified machine limit.
Autodesk's [turning workflow](https://help.autodesk.com/cloudhelp/ENU/Fusion-CAM/files/MFG-OVERVIEW-TURNING-WORKFLOW.htm)
identifies the HAAS Turning post family for this workflow.

## First slice and design decisions

Start with one round-stock part, one chuck setup, and facing plus external
roughing/finishing. Require explicit stock diameter/length, grip length,
clearance from the chuck, front allowance, machine, tool library, post, spindle
limit, and tool-change mode. The existing `autocam/turning.js` remains the
working synchronous turning path.

There are three plausible implementation approaches:

1. Generate every operation procedurally. This offers flexible geometry handling
   but puts every operation parameter, insert orientation, and holder decision
   into new automation at once.
2. Apply a reviewed turning template to explicit stock/WCS/tool inputs. This is
   the recommended next slice: capture a known-good lathe setup and make its
   variable inputs explicit before broadening strategy coverage.
3. Reuse milling or plate jobs for turning. Reject this: plate arrangement,
   milling tools, and milling postprocessors do not describe a lathe setup.

The foundation uses `TurningOperation` to create an empty setup around a supplied
solid. It leaves stock/WCS and all operations for manual configuration. Declared
part dimensions are checked against declared stock; actual solid dimensions,
rotational symmetry, holder reach, and orientation are not automatically verified.
A length check alone does not establish safe chuck engagement.

## Run the planning prototype

From the repository root:

```sh
python3 -m autocam.fusion.turning.plan autocam/fusion/turning/example.json
python3 -m unittest discover -s autocam/fusion/turning/tests -v
```

The example is synthetic. Its machine record ID and tool-library name are
placeholders; its required Haas post asset has not yet been supplied. Its spindle
limit is not a recommendation for any real lathe.
The output contains the exposed stock length, required exposed length, radial
stock allowance, planned operations, and unresolved setup tasks. It always says
`readyForGeneration: false` and is deliberately not a `cam_jobs` insert payload.

Length fields are inches. `partDiameter` and `stockDiameter` are diameters;
`radialStockAllowance` is a radius difference. This avoids carrying the existing
pure-JS generator's internal radius-coordinate convention into a lathe post
without an explicit conversion. Metric, hex stock, multiple parts, threading,
grooving, part-off, and second setups are rejected or outside the contract.

Inside a development Fusion session, a caller may invoke
`prepare_turning_setup(cam, body, spec)` from `setup.py`, supplying a single solid
already imported and oriented for the intended spindle axis. This creates an
empty, clearly named DRAFT turning setup only. The return value contains the
setup and the plan; there is no generation, NC program, or post-processing call.
No active document or production job is selected automatically.

## Queue integration before enabling the feature

Add an engine discriminator such as `cam_engine = 'fusion'` and an explicit
Runner capability such as `turning`, rather than disguising turning as milling.
The current Fusion endpoint claims milling rows only; the synchronous generator
already owns turning. Update both claim paths and test isolation before enabling
`turning:cam`. Preserve reviewed inputs in immutable snapshots, drawing on
[grouping PR #329](https://github.com/frc971/spartanshub/pull/329).

Follow-ups tracked in #331: real lathe/tool/post selection, fixture and WCS
mapping, template parameterization, toolpath generation futures and error checks,
operator review, and Fusion simulation with stock/fixtures/holders. The team's
TL-1 turret configuration needs reviewed tool numbers, offsets, and change moves. Radius/diameter X mode,
spindle clamp, units, and feeds must be verified in the actual post output.

The draft intentionally does not close #331. Live Fusion execution and a
multi-session queue test are required later; current setup tests use mocks.

## Autodesk API references

- [Turning workflow sample](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Turning_Workflow_API_Sample_Sample.htm): illustrates turning setup/operation APIs. It does not certify this team's machine/tool/post configuration.
- [Setup operation type](https://help.autodesk.com/cloudhelp/ENU/Fusion-360-API/files/Setup_operationType.htm): distinguishes turning from milling setups.
