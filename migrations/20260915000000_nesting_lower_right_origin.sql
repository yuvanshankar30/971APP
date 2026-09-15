-- Direct instruction: nesting_placements.x used to be measured from the
-- sheet's lower-LEFT corner (0 <= x <= width_in). Confirmed against real
-- JProg (jprog/Display/Screen.java's actualScreenToSheet + jprog/SheetHandler/
-- Sheet.java's negative-width draw() translate) that the shop's actual
-- convention - and the physical corner operators zero the machine at - is
-- the sheet's lower-RIGHT corner (-width_in <= x <= 0). This is a pure
-- coordinate-origin translation (x_new = x_old - width_in), not a mirror:
-- every placement's position relative to the sheet's own edges is unchanged,
-- only the number used to label it shifts. Y (0 <= y <= height_in, bottom
-- edge to top edge) is unaffected.
--
-- Idempotent against a re-run: after a successful run every placement has
-- x <= 0, so the `x > 0` guard naturally matches nothing on a second
-- application. The one narrow exception is a placement sitting at exactly
-- the old convention's x = 0 (its left edge) - it is indistinguishable from
-- a placement already migrated to sit at the new convention's x = 0 (its
-- right edge) and is deliberately left alone rather than guessed at.
UPDATE public.nesting_placements np
SET x = np.x - ns.width_in
FROM public.nesting_cuts nc
JOIN public.nesting_sheets ns ON ns.id = nc.sheet_id
WHERE np.cut_id = nc.id
  AND np.x > 0;
