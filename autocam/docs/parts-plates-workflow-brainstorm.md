# Brainstorm: do we need separate Parts and Plates tabs?

Direct request from the user, after #446 (every material now uses the same
rich CAM template): "we really only need one tab for both." This expands on
the framing already filed in #448 with a concrete look at what merging would
actually touch, so implementation has something to start from. **This is a
brainstorm document only - no code changes here, and #448 stays open to
track the actual implementation decision.**

## What each tab owns today

**Parts** (`PartsTab.svelte`, `fusion_parts`)
- A named part: quantity, category (thickness/material), STEP file.
- Can be linked to a manufacturing request (`parts` table); when linked, the
  part's STEP file now has to match the request's STEP file (#453).
- View CAD / Install CAD actions, both operating on the part's own STEP file.
- No concept of "where does this get cut" - a part just exists, nested or not.

**Plates** (`PlatesTab.svelte`, `fusion_plates`)
- A stock-sized sheet in a given material/thickness category.
- Parts get nested onto a plate via `assignPartToPlate`
  (`fusion_part_category_assignments`, `plate_id` + `part_id` + `quantity`).
- Owns the actual CAM job lifecycle for milling: `plate:arrange` (nesting
  layout) and `plate:cam` (toolpath generation) job kinds key off
  `plateId`, not any single part.
- Rename, delete, queue-for-CAM actions all live here.

**The split in one sentence:** a part is "what to cut," a plate is "what
it gets cut from and the job that cuts it." They're two views onto what is,
physically, one object once nesting happens - stock with parts on it.

## Why the split exists (or at least, why it's not obviously wrong)

- **A part can exist before it has anywhere to be cut from.** Someone can
  define a part's geometry/quantity/STEP file before a plate exists in that
  material/thickness, especially while nesting hasn't been decided yet.
- **A plate can hold several parts, and a part isn't 1:1 with a plate.**
  `fusion_part_category_assignments` is a many-to-many join with its own
  `quantity` - the CAM job is keyed to the plate because the toolpath is
  computed for everything nested on it together, not part by part.
- **Box tubes already have an analogous but separate workflow**
  (`BoxTubesTab.svelte`, `fusion_box_tubes`) that doesn't go through plates
  at all - tube stock is linear, not sheet-nested, so whatever the Parts/
  Plates merge becomes, it should not assume it needs to also absorb tubes.

## What a merged single tab could look like

Two shapes seem plausible; neither is a strong enough recommendation to
call an implementation choice by itself:

1. **Part-centric list, plate assignment inline.** One table of parts, each
   row showing its current plate/nesting status (unassigned / nested on
   plate X / queued / cam'd) with an inline action to assign or reassign a
   plate. Plate CRUD (create a new stock sheet, rename, delete) becomes a
   secondary action reachable from that same view rather than its own tab.
   Closest to how PartsTab already works today, extended with plate state.

2. **Plate-centric list, parts nested inside each row.** One table of
   plates (the CAM-relevant unit, since jobs are keyed to `plateId`
   already), each expandable to show/add/remove its nested parts inline.
   Closest to how PlatesTab already works today, extended with part
   creation.

Given the CAM job (the thing that actually produces machine output) is
already keyed to `plateId` not `partId`, (2) requires less rework of the
job-queueing code; (1) matches the mental model of "I have a part, where
does it go" better for someone adding new work. Worth deciding with the
user rather than guessing here.

## What has to move either way

- **Standalone parts with no plate yet** need an explicit "unassigned"
  state in whichever view wins - today this is implicit (a `fusion_parts`
  row with no matching `fusion_part_category_assignments` row).
- **The View CAD / Install CAD actions** (#435, this session's Parts-tab
  addition) are part-level, not plate-level - they'd need to stay reachable
  per-part inside whichever merged view is chosen.
- **The linked-manufacturing-request STEP file sync** (#453) is also
  part-level and needs to keep working the same way regardless of tab shape.
- **Existing `fusion_parts`/`fusion_plates` rows** need no schema migration
  for either shape above - both are UI-layer reorganizations of the same
  two tables and the same `fusion_part_category_assignments` join; this is
  a client-side merge, not a data model change.
- **Deep links** - `initialManufacturingPartId` (passed into `PartsTab`
  today so a manufacturing request can jump straight to its linked part)
  and `onViewPlates`/`viewMatchingPlates` (the existing Parts -> Plates
  cross-navigation in `+page.svelte`) both need an equivalent entry point
  into whatever the merged tab becomes.

## Recommendation

Lean toward shape (2) (plate-centric, parts nested inline) since it avoids
touching the job-queueing code at all and only changes how parts are
created/edited within that view - but this is a brainstorm, not a decision.
Next step is picking one of the two shapes (or a third option) with the
user before writing any implementation, per #448.
