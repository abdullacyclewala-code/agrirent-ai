-- Run AFTER schema.sql. Seeds taxonomy tables from src/data/taxonomy.json.

insert into public.taxonomy_crops (id, label, icon) values
  ('cotton','Cotton','☁️'),
  ('wheat','Wheat','🌾'),
  ('sugarcane','Sugarcane','🎋'),
  ('rice','Rice / Paddy','🌱'),
  ('soybean','Soybean','🫘'),
  ('groundnut','Groundnut','🥜'),
  ('maize','Maize','🌽'),
  ('onion','Onion','🧅'),
  ('tur','Tur / Pigeon Pea','🌿'),
  ('gram','Gram / Chickpea','🫛')
on conflict (id) do nothing;

insert into public.taxonomy_operations (id, label, desc) values
  ('ploughing','Ploughing','Turn and loosen soil before sowing'),
  ('tilling','Tilling','Break up and mix soil for planting'),
  ('harrowing','Harrowing','Smooth and level tilled soil'),
  ('sowing','Sowing / Seeding','Plant seeds at right depth & spacing'),
  ('spraying','Spraying','Apply pesticide, herbicide or fertiliser'),
  ('harvesting','Harvesting','Cut and collect the ready crop'),
  ('threshing','Threshing','Separate grain from stalks/husks'),
  ('transportation','Transportation','Move produce from field to market'),
  ('land_leveling','Land Leveling','Flatten field surface for irrigation'),
  ('irrigation','Irrigation','Water the field efficiently')
on conflict (id) do nothing;

insert into public.taxonomy_equipment_types (id, label) values
  ('tractor','Tractor'),
  ('rotavator','Rotavator'),
  ('cultivator','Cultivator'),
  ('harvester','Harvester (Combine)'),
  ('seed_drill','Seed Drill'),
  ('sprayer','Sprayer'),
  ('thresher','Thresher'),
  ('trailer','Trailer'),
  ('plough','Plough (Disc/Mould Board)'),
  ('leveler','Leveler')
on conflict (id) do nothing;

insert into public.taxonomy_compatibility (equipment_type, operations, crops, hp_ranges) values
  ('tractor', array['ploughing','tilling','harrowing','sowing','transportation','land_leveling'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":10,"min_hp":35,"max_hp":50},{"max_acres":999,"min_hp":50,"max_hp":90}]'::jsonb),
  ('rotavator', array['tilling','harrowing'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":999,"min_hp":35,"max_hp":75}]'::jsonb),
  ('cultivator', array['tilling','harrowing'],
    array['cotton','wheat','soybean','groundnut','maize','gram'],
    '[{"max_acres":999,"min_hp":35,"max_hp":60}]'::jsonb),
  ('harvester', array['harvesting'],
    array['wheat','rice','sugarcane','maize','soybean'],
    '[{"max_acres":999,"min_hp":90,"max_hp":150}]'::jsonb),
  ('seed_drill', array['sowing'],
    array['wheat','soybean','groundnut','maize','gram','tur'],
    '[{"max_acres":999,"min_hp":35,"max_hp":55}]'::jsonb),
  ('sprayer', array['spraying'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":999,"min_hp":0,"max_hp":50}]'::jsonb),
  ('thresher', array['threshing'],
    array['wheat','rice','soybean','gram','tur'],
    '[{"max_acres":999,"min_hp":35,"max_hp":60}]'::jsonb),
  ('trailer', array['transportation'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":999,"min_hp":0,"max_hp":90}]'::jsonb),
  ('plough', array['ploughing'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":999,"min_hp":35,"max_hp":75}]'::jsonb),
  ('leveler', array['land_leveling'],
    array['cotton','wheat','sugarcane','rice','soybean','groundnut','maize','onion','tur','gram'],
    '[{"max_acres":999,"min_hp":35,"max_hp":75}]'::jsonb)
on conflict do nothing;
