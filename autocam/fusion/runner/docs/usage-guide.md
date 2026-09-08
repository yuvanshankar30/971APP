# Using Fusion CAM

This is about the web page - the Parts/Plates/Job Queue tabs at
`/autocam/fusion`. For installing the Runner add-in in Fusion 360 itself,
see the [Setup Guide](/autocam/fusion/setup) instead.

## Parts

A part is stock you'll eventually need cut - a name, a material/thickness,
and how many you need. Adding a part here doesn't cut anything by itself;
it just puts it on the list so it can be assigned to a plate later.

Each part shows three numbers:

- **Needed total** - how many you're planning to make, in total.
- **Still need a plate** - how many of those haven't been assigned to a
  plate yet.
- **Already on a plate** - how many are assigned and waiting to be (or
  already have been) cut.

Editing the quantity changes the **total**. If some are already assigned to
a plate, you can't drop the total below that count - unassign them from the
plate first.

## Plates

A plate is one sheet of stock. Assign parts to it (matching material and
thickness), then queue a Fusion job to nest and cut them.

When Fusion lays parts out on a plate, it leaves a gap between them sized
to the cutting tool - enough that the tool doesn't clip a neighboring part
mid-cut, but no more than that, so you're not wasting material. This is
automatic; you don't need to leave your own margin when assigning parts.

## Grouping jobs

By default, each part on a plate becomes its own Fusion job. **Grouping**
instead combines several parts into one job: one Fusion document, one set
of tool changes, one G-code file per operation covering all the grouped
parts. Pick 2 or more parts in the Plates tab and queue them together as a
group.

Use grouping when the parts share a tool and material - it cuts down on
tool changes and setup time compared to running each part as a separate
job. The Job Queue tab tags a job "Grouped" when it covers more than one
part.

## Holding Tabs

The release contour uses manual `0.6in x 0.15in` tabs on straight outer
edges only. Tabs are placed only where the setup has stock behind that edge;
rounded edges and void-facing sides are excluded. Larger stock-backed sides
receive additional evenly spaced manual points, while smaller parts reduce
tab dimensions only when their geometry requires it.

## Job Queue

Each row is one Fusion job, from queued through completed (or failed).

- **Queued** - waiting for a Runner (a Fusion 360 instance running the
  add-in) to pick it up.
- **Claimed** - a Runner has it and is about to start.
- **Processing** - actively running in Fusion right now.
- **Completed** - G-code is ready to download.
- **Failed** - something went wrong; click the error to see what.

Completed jobs show a **machining time** - roughly how long the job takes
to cut, based on the toolpath and a typical rapid-move speed. It's an
estimate, not a stopwatch reading: actual time on the machine depends on
things like feed overrides and how the operator runs the job, so treat it
as a ballpark for comparing jobs, not a promise.

## Tube Stock and Stock Categories

**Tube Stock** is direct-to-CAM: add one STEP-backed tube, then use the
page-level **Send to Fusion CAM** action while the Tube Stock tab is open to
choose the tube, router, tool, and material. It is not mounted to a plate and
it is not grouped with other tubes. The material is required so the Runner can
select the reviewed feeds, speeds, and template for that stock.

For rectangular box tube, one queued tube job creates four manually indexed
Fusion setups: Side 12, Side 3, Side 6, and Side 9. Fusion posts one NC file
for each side that actually contains machining; an unfeatured side stays as a
visible setup but does not produce a blank program. Rotate the physical tube
to match each posted side and re-zero Z before machining it. Holes and cutouts
break through the near wall only, never across the hollow tube into the far
wall. The Tube Cutoff operation is not automatically posted yet because a safe
cutoff needs an explicit finished length and fixture reference.

Stock Categories are the material + thickness combinations parts and
plates get matched against (e.g. "Polycarbonate (Lexan) - 0.0625\""). Add a
category before adding parts or plates that need it.
