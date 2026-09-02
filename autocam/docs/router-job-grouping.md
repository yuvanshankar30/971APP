# Router Job Grouping

## Scope

AutoCAM can combine two or more **completed router jobs** into one reviewed
G-code program for a shared sheet of stock. It deliberately does not support
turning, tube stock, Fusion CAM, failed jobs, or incomplete jobs. A grouped
program has its own database record and never replaces the source job files.

Jobs must share a machine profile, end mill, and material. This prevents a
single program from silently changing feed, spindle, controller dialect, or
cutter geometry between parts.

## Placement and clearance

`autocam/nesting.js` measures the real XY material-removing envelope from each
completed program, excluding rapids and coordinates in comments, and uses
deterministic first-fit-decreasing shelf packing. The packer keeps a
configurable stock edge margin and a conservative cut-path clearance:

```
clearance = end-mill diameter + (2 * tolerance allowance)
```

The stock edge margin is measured from the **edge of the cut**, not the cutter
centerline. Internally the packer reserves `edge margin + cutter radius` around
the centerline envelope. The grouped-program header prints both values so an
operator can verify clamp placement against the same geometry the packer used.

The envelope approach is intentionally conservative for irregular parts: it
does not pack one part into an empty concavity of another. This costs some
material but makes the placement simple to inspect and guarantees that the
combined cutter paths cannot overlap. Polygon nesting and rotation are future
work, not implied behavior.

## G-code generation

`autocam/groupedGcode.js` translates absolute `X` and `Y` motion words for each
source program to its saved placement. It leaves comment text and WinCNC's
`G04 X<seconds>` dwell word untouched. Relative `I` and `J` arc centers are not
modified, so translated arcs remain correct. It removes each source program's
setup/end block, inserts safe-height moves between parts, and emits one shared
spindle/setup block and one program end.

The group must be reviewed in AutoCAM's 3D toolpath simulator before cutting.
The group view intentionally omits CAD viewing because there is no single CAD
file for a grouped program; source jobs retain their normal CAD actions.

## Data and UI

`cam_job_groups` stores the stock, tolerance, generated program, project ID,
and setup; `cam_job_group_items` stores each source job and exact offset.
`/api/cam-groups` creates and reads groups using the signed-in user's RLS
identity. `/autocam` exposes Group Jobs and View Groups, a Project ID filter,
and a green grouped link in individual job rows. `/manufacture` shows the same
green Grouped status next to AutoCAM completed and links back to the group.
