# Queueing Fusion CAM jobs (for AI agents / scripts)

How to queue a `plate:cam` milling job against the Fusion Runner directly
via the database, bypassing the `/autocam/fusion` web UI. Written for
another AI session (or a script) that needs to test the pipeline without
clicking through the UI each time - this is exactly the workflow used
throughout this app's own development.

Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (service role - needed
to upload to the `manufacturing-files` bucket and insert rows without a
browser session) available as env vars, e.g. `node --env-file=.env
your-script.mjs`.

## The data model

A plate job needs, in this order:

1. **`fusion_part_categories`** row - a (material, thickness) pair. Check
   for an existing one before creating a new one:
   ```sql
   select fpc.id as category_id, fpc.thickness, cm.name, cm.id as material_id
   from fusion_part_categories fpc
   join cam_materials cm on cm.id = fpc.material_id
   where cm.name ilike '%<material>%';
   ```
2. **`fusion_parts`** row - one physical part, tied to a category, with a
   STEP file uploaded to the `manufacturing-files` storage bucket
   (`step_file_name` points at it). `quantity`/`original_quantity` track
   how many are unassigned vs. total - see `fusionCam.js`'s own doc
   comments if creating parts through code that also needs the nesting
   quantity math right; for a one-off test job neither matters much.
3. **`fusion_plates`** row - the stock the part gets nested onto. Same
   category as the part. **Must be comfortably larger than the part's
   actual footprint** - `AutoArrange` (the nesting step) throws
   `ARRANGE_ERROR_NO_ROOM` if the plate is too tight, and it needs room
   for the 0.5in stock margin on top of the part's own bounding box, not
   just the part's exact size.
4. **`fusion_part_category_assignments`** row - nests the part onto the
   plate (`plate_id`, `part_id`, `category_id`, `quantity`).
5. **`cam_jobs`** row - the actual queued job:
   ```js
   {
     name: 'Plate CAM: <descriptive name>',
     source_type: 'upload',
     operation_type: 'milling',
     params: { fusionJobKind: 'plate:cam', plateId, boxTubeId: null, singleToolMode: false },
     material_id, tool_id, machine_id,
     status: 'queued',
     requested_by: <a real user id - see below>,
     part_id: null   // only set for box-tube jobs, plates leave this null
   }
   ```

A Runner polling `/api/fusion-runner` claims it, opens the STEP file in a
fresh Fusion document, applies the CAM template, generates toolpaths, and
posts G-code back to `cam_jobs.gcode` - poll `cam_jobs.status` until
`completed` or `failed` (3s interval is plenty; a plate job usually takes
10-30s once claimed).

## Known-good reference IDs (this Supabase project)

Re-verify before trusting these blindly - a category, tool, or plate can
be deleted between sessions (this happened at least once already this
project's history).

| What | ID |
|---|---|
| UNC Router (`cam_machines`) | `517ba89c-7167-4415-b6fd-cfc7be1e59e1` |
| 0.1575in Flat End Mill (`cam_tools`, 1 flute) | `60ef32c0-d76d-4549-a4a6-3cf4a7aee115` |
| Aluminum 6061 @ 0.25in (`fusion_part_categories`) | `ec177f74-28e2-4edb-828c-bdd6b0002bba` |
| Aluminum 6061 (`cam_materials`) | `819af897-16d3-4f22-9e01-d0be32fd23ad` |
| Polycarbonate (Lexan) @ 0.0625in (`fusion_part_categories`) | `72fb0575-8f14-47dc-aece-978adcfe3b69` |
| Polycarbonate (Lexan) (`cam_materials`) | `19dd55bf-f4f2-4740-8e19-6dbc8d17fd2b` |

`requested_by` needs a real row in `auth.users`/the app's user table -
reuse an existing account's id rather than inventing one (a foreign key
violation is the usual symptom of skipping this).

## Minimal script

```js
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const STEP_PATH = '/path/to/part.step';
const CATEGORY_ID = '...';   // fusion_part_categories.id
const MATERIAL_ID = '...';   // cam_materials.id (same material as the category)
const TOOL_ID = '...';
const MACHINE_ID = '...';
const REQUESTED_BY = '...';  // a real user id

const stepFileName = `${Date.now()}_part_fusion.step`;
await supabase.storage.from('manufacturing-files')
  .upload(stepFileName, readFileSync(STEP_PATH), { contentType: 'model/step' });

const { data: part } = await supabase.from('fusion_parts').insert({
  name: 'test part', quantity: 0, original_quantity: 1,
  category_id: CATEGORY_ID, step_file_name: stepFileName, created_by: REQUESTED_BY,
}).select().single();

const { data: plate } = await supabase.from('fusion_plates').insert({
  name: 'test plate', width: 16, length: 16, true_depth: 0.25, category_id: CATEGORY_ID,
}).select().single(); // size generously - see AutoArrange note above

await supabase.from('fusion_part_category_assignments').upsert(
  { category_id: CATEGORY_ID, plate_id: plate.id, part_id: part.id, quantity: 1 },
  { onConflict: 'plate_id,part_id' }
);

const { data: job } = await supabase.from('cam_jobs').insert({
  name: 'Plate CAM: test', source_type: 'upload', operation_type: 'milling',
  params: { fusionJobKind: 'plate:cam', plateId: plate.id, boxTubeId: null },
  material_id: MATERIAL_ID, tool_id: TOOL_ID, machine_id: MACHINE_ID,
  status: 'queued', requested_by: REQUESTED_BY, part_id: null,
}).select().single();

console.log(job.id); // poll cam_jobs.status for this id
```

## Retrieving the result

```js
const { data } = await supabase.from('cam_jobs')
  .select('status, errors, warnings, gcode, gcode_file_name').eq('id', jobId).single();
```

`gcode` is the full combined G-code text (all toolpath files concatenated
with `%\n...\n%\n` wrapping the whole thing - see `camPlate.py`'s own
comment on why multiple files get concatenated rather than kept
separate). To put it in the Manufacturing Files tab, upload it straight
to the `manufacturing-drive` bucket:

```js
await supabase.storage.from('manufacturing-drive')
  .upload(`gcode/<name>.ngc`, new Blob([data.gcode], { type: 'text/plain' }),
    { upsert: true, contentType: 'text/plain' });
```

## Gotchas learned the hard way

- **New Router single-tool jobs must say so explicitly.** Set
  `params.singleToolMode: true` only with an endmill selected in `tool_id`.
  The queue and Runner both reject drills/countersinks in this mode, and the
  Runner restricts the extracted Fusion library to that selected tool rather
  than silently adding drilling operations from the same library. Multi-tool
  and countersink jobs remain hardware-gated; do not hand-author one.

- **The Fusion add-in caches its own already-imported Python modules.**
  Editing `autocam/fusion/runner/**/*.py` (or `.tools` tool libraries) and
  copying the change into the installed add-in
  (`~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/SpartanRoboticsAutoCAM/`
  on macOS) does **not** take effect until Fusion is fully quit and
  relaunched - a plain Stop/Run of the add-in is not enough. Queuing a
  job right after an edit without a restart will silently run the old
  code with no error - the only way to tell is checking the actual
  resulting behavior (or, for WCS-orientation-style changes, reading the
  live document's parameters back and checking they match what the
  edited script should have set).
- **Box-point corner labels (`'top 1'`, `'bottom 2'`, ...) don't map to a
  fixed physical corner.** The label Fusion shows for a given corner
  changes depending on the setup's current flip/orientation state, and
  apparently even between separate documents of the same part. Don't
  reason about which label should mean which corner - set it and read
  back the resulting origin position and axis directions numerically
  against the actual bounding box.
- **A plate must be sized generously larger than the part**, not just
  bigger - `AutoArrange` needs room for the stock margin on top of the
  part's own footprint, and throws `ARRANGE_ERROR_NO_ROOM` if it's too
  tight.
- **`cam.postProcess()` can fail with `RuntimeError: 3 : Initialization
  fails`**, most often on the very first toolpath posted in a run, before
  background toolpath generation has caught up
  (`NewNCProgram.py`'s `_post_process_with_retry` already retries this a
  few times). If it fails on every attempt across multiple fresh job
  runs rather than intermittently, that's a different, real problem
  (e.g. a CAM template built for a different machine/post-processor) -
  don't just keep retrying blindly.
- **Feed rate safety**: don't force every motion type (plunge, ramp,
  cutting, retract) to the same feed rate. A plunge move is much more
  aggressive per unit of feed than a horizontal cut (full tool engagement
  straight down), and setting it to the cutting feed rate tore straight
  through stock on a real cut. Keep plunge/ramp feeds a fraction of the
  cutting feed (this tool library's presets already do this - see
  `autocam/fusion/runner/tools/*.tools`'s `start-values.presets` entries
  for the actual ratios used per material).
