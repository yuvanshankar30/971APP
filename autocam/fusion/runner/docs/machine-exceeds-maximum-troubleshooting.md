# "Program exceeds machine maximum on X" (or Z)

A real error LinuxCNC/AXIS gives when loading or running a generated
`.ngc` file, reported (and root-caused) multiple times against the actual
UNC Router this session. Recording what it actually meant each time,
since none of the real causes were a G-code generation bug, despite the
error appearing to point at the file.

## It is very rarely about the G-code's own coordinate span

Every time this came up, the file's own X/Y/Z coordinate range (min to
max) was checked directly and was modest - typically under 15 inches of
total travel in any axis, nowhere near what should exceed a real router's
travel on its own. Don't start by assuming the toolpath itself is
oversized or corrupted; check the real cause first (below), and only
suspect the G-code if the coordinate range itself is actually huge or
implausible for the part in question.

To check a file's coordinate range directly:
```bash
python3 -c "
import re
xs, ys, zs = [], [], []
with open('/path/to/file.ngc') as f:
    for line in f:
        for axis, arr in (('X', xs), ('Y', ys), ('Z', zs)):
            m = re.search(axis + r'(-?[\d.]+)', line)
            if m: arr.append(float(m.group(1)))
print('X:', min(xs), 'to', max(xs))
print('Y:', min(ys), 'to', max(ys))
print('Z:', min(zs), 'to', max(zs))
"
```
Also worth checking while at it: exactly one `%` at the very start and
end of the file (not in the middle - see the "bad character % used" note
below), and that `G91`/`G91.1` isn't accidentally putting X/Y/Z moves
into incremental mode (G91.1 alone only affects arc I/J/K, not linear
moves - that's normal and expected).

## The real cause, seen twice: the machine's G54 offset was parked far from home

LinuxCNC checks the *absolute machine coordinate* a move would reach -
work-offset position (`G54 X/Y/Z`, visible in AXIS's DRO panel) **plus**
however far the program's own coordinates ask it to travel from there.
The G-code's own span looking reasonable doesn't matter if the work
offset itself already puts the origin most of the way to the end of the
machine's real travel.

Concretely seen: `G54 X` showing `58.6333`, then later `53.0027` -
tens of inches from machine home, on a program whose own X span was only
~8-12 inches. `58 + 8 ≈ 66`, comfortably past a router table that
doesn't actually have that much X travel from home.

**Fix:** jog to the actual physical corner of the *current* stock and
re-touch-off (Touch Off button in AXIS, per axis) there - not wherever a
previous, unrelated setup happened to be touched off. After touching off,
confirm the DRO's `G54 X/Y/Z` actually changed to something small/sane
before loading or running anything - if it doesn't move, something more
is wrong (see below).

## A related but distinct symptom: "joint N following error"

Seen alongside (and sometimes instead of) the exceeds-maximum message.
This is LinuxCNC saying a servo/stepper's actual position doesn't match
where it was commanded to be, within tolerance - it does **not** mean the
same thing as exceeds-maximum, even though both can show up around the
same failed run.

The specific case seen this session traced to **the machine not being
homed** - without homing, there's no real reference for where each axis
actually is, so position tracking (and by extension, any check that
depends on knowing real machine position) becomes unreliable. AXIS itself
flags this directly: `Can't issue MDI command when not homed`.

**Fix:** run the homing sequence before doing anything else. Homing is
lost on every E-stop, power cycle, or software restart - it has to be
redone each time, it is not a one-time setup step.

## "Bad character % used" - a different, code-level bug (already fixed)

Not a machine/setup issue - this one really was a real bug in how this
app builds a plate's G-code. A plate with more than one toolpath/tool
group (e.g. a drill pass and a separate profile pass) used to get each
tool's separately-posted `.ngc` file concatenated together with `\n\n`,
but each individual posted file carries its **own** leading and trailing
`%` program delimiter - so the combined file ended up with `%` in the
middle, which the interpreter correctly rejects (`%` is only valid as the
very first and very last line of a program). Fixed in `camPlate.py`
(strips each file's own `%` lines before joining, adds exactly one pair
back around the whole combined program) - if this reappears, that fix
regressed, it is not a new instance of the same machine-setup problem
above.

## Quick diagnostic order

1. Check the file's own coordinate range (script above) - is it actually
   plausible for the part? If wildly implausible, that's a real
   generation bug, look there first.
2. If the range is reasonable: check `G54 X/Y/Z` in AXIS's DRO. Does it
   reflect a fresh touch-off on the *current* stock, or a leftover value
   from something else? Re-touch-off if in doubt.
3. Check the machine is actually homed (not just powered on) - re-home if
   it's been E-stopped, power-cycled, or the software restarted since the
   last homing.
4. Only after 1-3 are ruled out, suspect the actual generated G-code
   (WCS orientation, origin placement, or a real post-processing bug) -
   see `queueing-fusion-jobs.md`'s gotchas for the WCS-orientation issues
   already found and fixed this session.
