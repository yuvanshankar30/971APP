-- New Router is the ShopSabre Pro 408. Keep existing production profiles in
-- sync with the Runner's machine-level post-processor safety invariant.
UPDATE public.cam_machines
SET post_processor = 'shopsabre.cps',
    controller = 'wincnc',
    gcode_extension = 'tap'
WHERE name = 'New Router'
  AND (
    post_processor IS DISTINCT FROM 'shopsabre.cps'
    OR controller IS DISTINCT FROM 'wincnc'
    OR gcode_extension IS DISTINCT FROM 'tap'
  );
