# Real team templates - staged, not yet wired in

These are the team's actual Fusion CAM templates (from the team's own
`Documents/Template` folder), copied here for safekeeping. They are **not
yet referenced by any Runner code** - `camPlate.py`/`camTube.py` still point
at `../Plates.f3dhsm-template` and `../boxtubes.f3dhsm-template` one level
up, which are still Valor 6800's own originals (their tool naming, e.g.
"6061Al Onsrud End Mill" - not ours).

Confirmed real (not Valor's) by reading the XML directly - `<description>`
tags reference "971 Main Bit", not Valor's tool names.

## What's here

| File | Best guess at purpose (from filename - not verified in Fusion) |
| --- | --- |
| `Tubestock(with Cutter Comp).f3dhsm-template` | Box-tube CAM, current - maps to the `boxtubes` slot |
| `(DEPRECATED)971 Tubestock Template.f3dhsm-template` | Superseded by the one above - kept for reference only, marked deprecated by whoever named it |
| `971 Thick Sheet (Cutter Comp).f3dhsm-template` | Plate CAM, thick sheet stock |
| `Metal Sheet with Cutter Comp.f3dhsm-template` | Plate CAM, metal sheet |
| `971 0.1875 in. Endmill Wood Template.f3dhsm-template` | Plate CAM, wood, 0.1875" tool |
| `971 0.25 in. Endmill Wood Template.f3dhsm-template` | Plate CAM, wood, 0.25" tool |
| `new router metal sheet (shopsabre only!!).f3dhsm-template` | Plate CAM, metal - **ShopSabre (New Router) only, per the filename's own warning** - do not use on the UNC Router |
| `countersink.f3dhsm-template` | A specific operation/feature template, not a full plate setup |
| `bumper foam.f3dhsm-template` | Plate CAM, foam stock |

## Why nothing was wired up automatically

Unlike box tubes (one clear real template), **there are several real plate
templates here for different material/tool/machine combinations** - picking
the wrong one as "the" default `Plates.f3dhsm-template` risks running the
wrong feeds/speeds or the wrong tool against real material. That's a real
CAM engineering call, not something to guess from a filename - see
`autocam/fusion/runner/docs/cam-engineering-plan.md`.

The current single-template-per-job-type architecture
(`Plates.f3dhsm-template` / `boxtubes.f3dhsm-template`, dynamically patched
with the right tool library at runtime via `templateTools.py`) also assumes
ONE template per job type - it does not yet have a concept of "pick a
template based on the job's machine/material," which real use here needs
given the ShopSabre-only template above. That routing logic doesn't exist
yet and would need to be added to `camPlate.py`.

## Also still needed (see the runner's own README)

`camPlate.py`'s `_download_tool_library_json` / `_first_material_name` call
`GET {BASE_URL}/api/tools/{id}` and `GET {BASE_URL}/api/materials` -
**neither endpoint exists yet in this app.** A real tool library now exists
too (`autocam/fusion/runner/tools/971-outside-plate.tools` - the "971 Main
Bit", 0.1575" carbide flat end mill, real presets) but nothing serves it to
the Runner over HTTP yet.
