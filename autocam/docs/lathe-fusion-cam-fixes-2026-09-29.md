# Fusion lathe CAM (hex shaft and spacer): what was wrong and how it is set up now

Scope: `autocam/fusion/runner/commands/HandleHexShaft.py`,
`ChuckFixture.py`, `HandleSpacer.py`, `workflows/camTurning.py`, and the
bundled `postprocessors/haas_turning.cps`, for the Haas TL-1.

## Fixed

- **Z axis direction.** The WCS pointed +Z into the chuck. Lathe convention
  (Fusion's default turning WCS, the Haas post, `autocam/inprocess/turning.js`)
  is +Z out of the tip, part at negative Z. The origin is now `model front`
  and the code checks it landed on the measured tip.
- **Left-hand tool.** The sample "Turning Tools (Inch)" library lists
  `CNMT Left Hand` before `CNMT Right Hand`; taking the first general tool gave
  a mirrored insert for a cut toward the chuck (odd Z tip reference, a sloped
  neck path, gouge highlight in simulation). The right-hand insert is selected
  by description.
- **Tools and cutting data.** Both sample tools were turret number 0 (invalid
  `T0`, no change to the groover). Now T1 (turning) and T2 (grooving). The
  0.125in grooving insert is resized to the modeled ~0.039in groove. Surface
  speed 150 SFM, spindle cap 2000 rpm, feeds from the Spacer template
  (0.005 rough / 0.003 finish and face / 0.002 groove and part-off ipr).
  Safe Z is 0.1in ahead of the tip.
- **Groove suppression** on roughing/finishing so the general insert does not
  follow the groove the groove operation owns.
- **Part-off.** The last setup ends with a Part operation (grooving tool) at the
  finished part's back end, offset 0.01in into the excess so the blade cannot
  sever the groove end lip. The earlier Face-plus-Part on the excess is not
  restored: it machined away a real snap-ring groove.
- **Post.** `haas_turning.cps` clamp is 2000 rpm and the tailstock output
  (`M22`) is off by default. The Runner now re-copies the bundled post into
  Fusion's Posts folder when it differs, instead of only when missing. A
  hand-made duplicate in that folder with the same `description` can still win
  the description match; delete it.

## Internal shaft (third lathe CAM type)

Hex bar stock with a plain round journal turned on each end (turned to the
hex's inscribed diameter over a short length) and no grooves.
`HandleInternalShaft.py` is its entry point; it shares
`HandleHexShaft.build_shaft_setups` with the hex shaft (same hex-prism stock,
WCS, tools, chuck and last-setup part-off) and differs only in the end feature:
the journal cylinder is detected instead of a groove, the length of that
journal is the neck-turning span, and there is no Single Groove operation.
Verified live on `Internal Shaft - Part 1.step` (0.5in hex, 5.63in, 0.313in
journals): 3 operations per end plus the part-off on the last setup, all valid.
The `fusion_turning_parts.cam_type` check constraint needs
`migrations/20260929_fusion_internal_shaft.sql` before an internal shaft part
can be saved.

## Stock and tailstock chosen at queue time

The queue dialog and the New Turning Stock form take optional stock
dimensions: spacer OD, ID (tube stock) and length; hex and internal shafts
across-flats and bar length; and a tailstock length for all. Blank fields are
derived from the STEP file (`StockMath.py`: auto OD is the part OD plus 1/16in
rounded up to 1/16in, replacing Fusion's round-up to the next 10mm). They drive
the CAM: the stock itself, how much material is carried behind the part, the
chuck position, and whether a Drill is still needed for pre-bored tube stock. A
set bar length and a set tailstock length must agree; a hex bar that does not
match the part's across-flats is refused. Saved defaults live on
`fusion_turning_parts` (`migrations/20260929_fusion_turning_stock.sql`).

## Chuck and jaws

No vendor STEP is bundled or available to fetch, so `ChuckFixture.py` builds an
approximate 8in body plus three 1in jaws (constants at the top of that file;
measure the real chuck and adjust) and binds them as each setup's fixture.
Hex shaft seats the jaws on alternate hex flats of the excess; Spacer puts the
jaw tips on the template's own `chuckFront` plane over the stock radius.

Two Fusion behaviours drive the shape of that code:

- Chuck solids in the same component as the stock and model are folded into the
  stock's radial extent in the CAM kernel job (46mm or 127mm instead of 7.3mm),
  whether or not they are bound as the fixture, so roughing cut air for minutes.
  They are built in their own `Chuck` component.
- Adding bodies before a setup's WCS is read made Fusion resolve the WCS Z axis
  wrong, so chucks are added after all setups exist.

## Inspecting a toolpath without posting

After `cam.generateToolpath`, Fusion writes each kernel operation's input to
`.../Neutron/Fusion360CAM/<pid>-<n>/operation<N>.ironjob` in its temp folder
(contour, axial and radial stock limits, cutter profile). `cam.getMachiningTime`
gives per-operation time and feed distance: a neck pass on 0.089in should take
a couple of seconds; minutes means the kernel is cutting air.

## Not verified

- G-code from the part-off build has not been posted and read; the previous
  build's G-code was read and the fixes above are aimed at it.
- Chuck dimensions, the 2000 rpm limit, and whether the TL-1 has a tailstock or
  chip conveyor (`M31`/`M33` are still emitted) are unconfirmed.
- Setup 2 carries its own 1.5in excess on the opposite side from setup 1's, which
  cannot be one physical bar unless the part is parted between setups.
