# Reference post-processors and example output

Not executed by this app. These are the team's real Fusion 360 CAM
post-processor configs and one real Fusion-cammed output file, kept here as
ground truth for what G-code this app's own generators (`routing.js`,
`tubestock.js`) need to stay compatible with - the actual machine controllers
in the shop, not a generic assumption about "LinuxCNC" or "WinCNC" from their
public manuals.

- **`971_emc.cps`** - the UNC router's post-processor. Targets "Enhanced
  Machine Controller" (EMC = the old name for LinuxCNC). This is the
  `controller: 'linuxcnc'` (default) dialect in `routing.js`/`tubestock.js`.
- **`shopsabre.cps`** - the shop's newer ShopSabre router's post-processor.
  Targets WinCNC. This is the `controller: 'wincnc'` dialect.
- **`__fixtures__/1001-fusion-example.ngc`** - a real program Fusion actually
  generated through `971_emc.cps` (confirmed LinuxCNC/UNC-router output, not
  synthetic) - used to cross-check header sequence, decimal precision, and
  code usage against what this app's own LinuxCNC-dialect output does.

Both `.cps` files are plain JavaScript (Autodesk's post-processor API -
`createFormat`, `writeBlock`, `onSection`, etc.) that Fusion 360 itself runs
to turn a toolpath into G-code text. This app's generators don't run this
script or import from it - they emit G-code text directly - so treat these
as a specification to read, not a library to call. When adding or changing
what G-code this app emits for either dialect, grep the relevant `.cps` for
the actual G/M-code the real post-processor uses before guessing from a
generic manual (see the dialect comments at the top of `routing.js` and
`tubestock.js`, and `routing.test.js`'s "controller dialect" describe block).

Confirmed facts from these files (as of 2026-09-03), corrected once against
prior assumptions here that turned out to be wrong:

- **G54-G59 work offsets ARE standard stored work offsets on the real
  WinCNC/ShopSabre machine** (`shopsabre.cps` `onSection`: `workOffset > 1`
  picks `G54` + n, same as a LinuxCNC/Fanuc control) - not head-selection
  codes, and not something requiring a manual G92 jog-and-zero every run.
  This app's WinCNC output used to avoid G54 entirely on the opposite (wrong)
  assumption; fixed to select G54 (routing.js) / G55 (tubestock.js, same
  dedicated-fixture-offset reasoning as the LinuxCNC path) like every
  Fusion-cammed job on the same machine already does.
- Comment delimiters are `[...]` on WinCNC (`shopsabre.cps` `settings.comments.prefix/suffix`)
  and `(...)` on LinuxCNC/EMC (`971_emc.cps` `formatComment`) - matches this
  app's existing dialect handling.
- WinCNC never emits `G21` for metric - only `G20` (inch) or `G22` (mm)
  (`shopsabre.cps` `onOpen`) - matches this app's existing G21-avoidance.
- `M30` is used for program end on the LinuxCNC/EMC path (confirmed in the
  real Fusion output, `1001-fusion-example.ngc`'s last line) but never
  appears in `shopsabre.cps`'s `onClose` - matches this app's existing
  per-dialect M30 handling.
