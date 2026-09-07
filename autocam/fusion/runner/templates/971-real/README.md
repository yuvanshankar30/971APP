# Real team templates

These are the team's actual Fusion CAM templates from the team's
`Documents/Template` folder. `camPlate.py` currently selects two of them for
metal/polycarbonate jobs: the deprecated 971 Metal Sheet template for the UNC
Router and the explicitly ShopSabre-only template for the New Router. Other
machine/material combinations use the generic `../Plates.f3dhsm-template`.
`camTube.py` still uses `../boxtubes.f3dhsm-template`.

Confirmed by reading the XML directly - `<description>` tags reference
"971 Main Bit", the tool used by this Runner.

## What's here

| File | Status / intended purpose |
| --- | --- |
| `Tubestock(with Cutter Comp).f3dhsm-template` | Box-tube CAM, current - maps to the `boxtubes` slot |
| `(DEPRECATED)971 Tubestock Template.f3dhsm-template` | Superseded by the one above - kept for reference only, marked deprecated by whoever named it |
| `(DEPRECATED)971 Metal Sheet.f3dhsm-template` | Current UNC Router metal/polycarbonate mapping despite the historical filename; replace only after a reviewed successor is validated |
| `(DEPRECATED)971 Metal Sheet 2.f3dhsm-template` | Historical alternate, not selected by the Runner |
| `(DEPRECATED)971 Thick Sheet.f3dhsm-template` | Historical thick-sheet template, not selected by the Runner |
| `971 Thick Sheet (Cutter Comp).f3dhsm-template` | Plate CAM, thick sheet stock |
| `Metal Sheet with Cutter Comp.f3dhsm-template` | Plate CAM, metal sheet |
| `971 0.1875 in. Endmill Wood Template.f3dhsm-template` | Plate CAM, wood, 0.1875" tool |
| `971 0.25 in. Endmill Wood Template.f3dhsm-template` | Plate CAM, wood, 0.25" tool |
| `new router metal sheet (shopsabre only!!).f3dhsm-template` | Plate CAM, metal - **ShopSabre (New Router) only, per the filename's own warning** - do not use on the UNC Router |
| `2D Adaptive For Mill.f3dhsm-template` | Standalone milling-operation template, not selected automatically |
| `2D Contour.f3dhsm-template` | Standalone contour-operation template, not selected automatically |
| `Router Drill.f3dhsm-template` | Standalone router drilling template, not selected automatically |
| `countersink.f3dhsm-template` / `router countersink.f3dhsm-template` | Countersink operation templates, not full plate setups |
| `bumper foam.f3dhsm-template` | Plate CAM, foam stock |
| `test.f3dhsm-template` | Test/reference asset only; never select for production |

## Why only reviewed mappings are wired

Unlike box tubes (one clear real template), **there are several real plate
templates here for different material/tool/machine combinations** - picking
the wrong one as "the" default `Plates.f3dhsm-template` risks running the
wrong feeds/speeds or the wrong tool against real material. That's a real
CAM engineering call, not something to guess from a filename - see
`autocam/fusion/runner/docs/cam-engineering-plan.md`.

`camPlate.py` has explicit machine/material routing for the two mappings above.
That is deliberately not a filename-driven auto-selector: every additional
mapping needs CAM review so an attractive filename cannot silently choose the
wrong feeds, tool or controller. Templates are still patched with the selected
tool library at runtime by `templateTools.py`.

## Also still needed (see the runner's own README)

The Runner reads the selected tool's checked-in `.tools` archive through
`cam_tools.fusion_tool_library_file`, extracts `tools.json`, and patches the
template locally. It likewise resolves `cam_machines.post_processor` to the
committed `971_emc.cps` or `shopsabre.cps` file; no unsupported web lookup is
required after a job has been claimed.
