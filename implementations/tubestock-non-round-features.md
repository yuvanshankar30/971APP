# Tube stock: cutting shapes that are not round holes

Design for letting tube stock AutoCAM cut slots, keyways and other
non-circular wall features. Nothing here is implemented yet.

## What happens today

`extractTubeFeaturesFromMeshes` refuses them outright:

> A feature on this tube isn't round (radius varies 17% around its boundary)
> - likely a slot, keyway, or other non-circular cutout that indexed
> round-hole drilling can't represent.

That is the error the `test` job in the jobs list failed with.

## The useful part: the geometry is already there

The refusal is not a gap in extraction. `stepProfile.js` around line 875
already does all the work:

1. It finds every closed boundary loop on a wall.
2. It sorts them by area and treats the largest as the wall's own outline.
3. Every remaining loop is a feature.
4. For each feature it computes a centroid, a mean radius, and the maximum
   deviation from that radius. If the deviation exceeds
   `MAX_HOLE_RADIUS_VARIATION` (0.15) it throws.

So a slot's outline is **already extracted as a polygon** and then discarded.
Supporting non-round features does not need new STEP work. It needs that
polygon carried through instead of thrown away, and a contour toolpath
instead of a drill cycle.

## What has to change

**1. Classify instead of refusing.** Replace the throw with a branch. A loop
whose radius deviation is under the threshold stays a hole, described by a
centre and a diameter exactly as now. Anything else becomes a profile,
described by its polygon in the same wall coordinates holes already use
(`position` along the tube, `lateralOffset` across the face). The threshold
stops being a rejection test and becomes the thing that tells the two apart.

**2. Emit a contour rather than a plunge.** `generateTubestockGcode` walks
holes and emits a plunge per hole. A profile needs a contoured pass at
depth, which is what `routing.js` already does for sheets. Two pieces there
are directly reusable and should be reused rather than reimplemented:

- `offsetPolygon(points, distance)` for cutter compensation, so the cut
  lands on the line rather than centred on it.
- `cornerFeedScale(prev, cur, next)` for slowing into corners.

What is *not* reusable is routing's depth model. A sheet is cut in
step-downs to a target depth with tabs holding the part in place. A tube
wall is thin enough to go through in one pass, and there is nothing to hold
a slug in - it falls into the tube. That difference needs deciding, not
assuming (see open questions).

**3. Simulate it.** The simulator draws drilled holes into wall boxes. A
profile is a swept cut, closer to what the routing heightmap already does.
Per-face simulation lands first, so this can build on it.

## What this does not cover

Anything requiring the cutter to reach a wall it cannot see from above. The
operator turns the tube by hand and each face is cut in its own setup, so a
feature that spans a corner between two faces is out of scope. It should
keep the refusal it has now, with a message that says why rather than
"isn't round".

## Open questions

1. **Through the wall, or a pocket?** A through slot and a pocket floored
   partway into the wall are different toolpaths, and only one of them can
   reuse the wall-thickness depth from #255. Which is actually wanted?
2. **What happens to the slug?** Cutting a closed profile through a wall
   frees the material inside it, and inside a tube it drops into the cavity
   rather than staying put. Is that acceptable, or does it need tabs the way
   sheet parts do?
3. **Cutter fit.** A slot narrower than the end mill cannot be cut at all,
   and one only slightly wider leaves no room to compensate. Refuse it, or
   cut what fits and report the difference?
4. **Order.** Should profiles be cut before or after the holes on the same
   face? Cutting a large opening first can leave the wall flexing under a
   later drill.

## Related work

- #256 runs tube stock in G55, the fixture's own work offset.
- #257 numbers faces by clock position.
- #258 gives Install NGC a per-face file list.
- #259 lets the simulator show one face at a time - the natural place for
  profile simulation to build on.
- #260 adds the tube cutoff line geometry, which is itself a non-round
  profile cut on a tube wall. Whatever contouring lands here should be what
  the cutoff uses, rather than two separate paths to the same G-code.
