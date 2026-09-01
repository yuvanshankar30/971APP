-- cam_materials only had the 4 materials someone had manually added through
-- the AutoCAM "Materials & Tools" UI (Aluminum 6061, Baltic Birch Plywood,
-- Delrin (Acetal), Polycarbonate (Lexan)) - every other material already
-- used elsewhere in the app (src/lib/stock.json's real stock catalog, shown
-- on the manufacturing/create-part pages) had no matching row here, so it
-- couldn't be selected for an AutoCAM job. Backfills the rest so the same
-- set of materials is selectable in both places.
insert into cam_materials (name, enabled)
select v.name, true
from (values
  ('Steel'),
  ('SRPP'),
  ('Wood'),
  ('ABS'),
  ('Nylon'),
  ('Onyx'),
  ('PAHT-CF'),
  ('PETG'),
  ('PLA')
) as v(name)
where not exists (
  select 1 from cam_materials m where m.name = v.name
);
