# Text to NGC Converter (point-list input)

## Goal

Let a shop member type or paste a plain list of coordinates - not
already-valid G-code, a simple point list - and get back a real,
LinuxCNC-checked `.ngc` file, without writing G-code syntax by hand or
going through the full STEP-upload AutoCAM pipeline for a one-off job.

This is a design only. It does not add a parser, a generator module, or
UI code.

## Current baseline (already shipped, unaffected)

`/manufacture/gcode-converter` (merged) already covers half of "text to
NGC": paste **raw G-code text**, `autocam/gcodeLint.js`'s `lintGcode()`
checks it against LinuxCNC's real load-time rules (nested/unclosed
comments, illegal characters, valueless words, over-length lines),
`repairGcodeComments()` fixes malformed comments on export, and the
result downloads as `.ngc`. That mode is unchanged by this proposal.

What it does not help with: someone who has a list of positions -
drill locations off a print, points read off a caliper, a hole pattern
copied from a spreadsheet - and wants a program generated from them, not
validated from something they already wrote by hand. Hand-writing G-code
for even a simple hole pattern is exactly the error-prone process
`gcodeLint.js` and `gcodeComments.js` already exist to catch failures
of after the fact; this proposal is about not needing to hand-write it
in the first place for the simple case.

## Proposed scope

Add a second input mode to the existing converter page - a mode toggle
above the textarea, defaulting to "Raw G-code" (today's only behavior,
unchanged for anyone not using the new mode) with "Point list" as the
second option.

### Point-list syntax

One row per point, plain text, typeable without a reference sheet open:

```
# a line starting with # is a comment, blank lines are ignored
X1.5 Y2.0            rapid to X1.5 Y2.0 at safe height, plunge to the
                      configured cut depth, retract - the common case,
                      least typing
X1.5 Y2.0 Z-0.2       an explicit Z overrides the configured cut depth
                      for this one point only
G0 X0 Y0              an explicit G0/G1 prefix on a row forces rapid or
                      linear motion for that row, skipping the
                      plunge/retract pattern entirely
```

Two page-level motion modes, chosen once for the whole list rather than
per row (a per-row toggle would defeat the "typeable without a reference
sheet" goal):

- **Drill points** (default) - each row is a hole: rapid to XY at safe
  height, plunge to depth, retract. Matches a hole list, the most common
  real source for this.
- **Connect the dots** - each row is a linear move (G1) from the
  previous point; the first point is a rapid (G0) to start. For tracing
  a simple polyline.

### Reused, not rebuilt

- `lintGcode()` / `repairGcodeComments()` from `autocam/gcodeLint.js` -
  the *generated* program still goes through the exact same LinuxCNC
  check and export path the raw-G-code mode already uses. This feature
  only changes how the G-code text gets produced, never how it is
  checked or exported.
- The page's existing file-name input, Export button, and results
  panel - shared unchanged between both modes.

### New module: `autocam/textToGcode.js`

A pure function pair, no UI logic, unit-testable the same way every
other generator in `autocam/` already is (see `tubestock.js`,
`routing.js`):

```js
export function parsePointList(text)
  -> { points: [{ x, y, z: number|null, motion: 'auto'|'G0'|'G1' }],
       errors: [{ line, message }] }

export function pointListToGcode(points, {
  mode: 'drill' | 'connect', safeZ, cutDepth, feedRate, units
}) -> string
```

Parse errors are collected per line - the same "report by line number,
don't silently drop the bad row" pattern `gcodeLint.js` already
established - and shown in the UI before generation is attempted, not
discovered only after export.

## UI changes

- Mode toggle ("Raw G-code" / "Point list") above the textarea.
- In "Point list" mode: the left panel becomes the point-list input
  (inline per-line parse errors shown alongside it); a small settings
  row for safe height, cut depth, feed rate, units, and the
  drill/connect toggle; the right panel still shows the LinuxCNC check,
  now run against the *generated* program instead of the pasted one.
- "Raw G-code" mode is untouched.

## Test plan (once implemented)

- Parser: blank lines, comment lines, malformed rows (missing X,
  non-numeric value, unrecognized motion prefix), duplicate points.
- Generator: drill mode emits one plunge/retract per point at the
  configured depth; connect mode emits a continuous G1 chain seeded by
  one rapid; an explicit per-row G0/G1 prefix is honored over the
  page-level mode.
- Every generated program passes `lintGcode()` with zero errors - the
  same safety net the raw-G-code mode already has, and the reason this
  reuses that module rather than emitting text directly.
- Round-trip: paste a small point list, generate, switch to "Raw
  G-code" mode with the result loaded, and confirm it reports clean -
  the generator's own output must never trip the checker it feeds into.

## Open questions

- Exact column syntax: space-separated `X.. Y..` as sketched above, or
  should comma-separated values also be accepted (a spreadsheet paste is
  a plausible real source for a coordinate list)?
- Should "Point list" mode support arcs (I/J), or is straight-line/drill
  motion enough for the actual use case behind this request?
- Default units: does this need a G20/G21 toggle, or is inches-only
  sufficient (the raw-G-code mode never had to answer this, since pasted
  text already states its own units)?
- Do safe height and cut depth belong as page-level fields only, as
  sketched here, or should a row be able to override them individually
  beyond the single-point Z override already in the syntax?
- Is "Point list" the right name for the mode toggle, or does the team
  have an existing term for this kind of input?

## Related

Builds directly on `/manufacture/gcode-converter` and reuses
`autocam/gcodeLint.js` / `autocam/gcodeComments.js` unchanged. See also
`autocam/routingLinuxcnc.test.js` and `autocam/gcodeInterpreter.js` for
the existing pattern of checking generated output against both this
app's own rules and a real independent interpreter - any new generator
here should get the same treatment before being considered done, not
just a "the UI it renders looked fine" check.
