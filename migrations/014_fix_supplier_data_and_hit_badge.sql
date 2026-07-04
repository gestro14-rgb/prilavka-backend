-- Точечное обновление данных о поставщиках (убираем вымышленные имена и
-- эмодзи-лица) и переносим бейдж "Хит" с экзотического набора на борщевой.
-- Никак не затрагивает reviews/deliveries/admins — только products.
-- (Автораннера миграций нет — применить вручную: psql ... -f 014_fix_supplier_data_and_hit_badge.sql)

UPDATE products SET suppliers = '[
  {"category": "vegetables", "categoryLabel": "Овощи для борща", "region": "Краснодарский край"},
  {"category": "greens", "categoryLabel": "Зелень и капуста", "region": "Ставропольский край"}
]'::jsonb WHERE id = 'borsch';

UPDATE products SET suppliers = '[
  {"category": "vegetables", "categoryLabel": "Овощи и томаты", "region": "Краснодарский край"},
  {"category": "greens", "categoryLabel": "Зелень и лук", "region": "Ставропольский край"},
  {"category": "fruits", "categoryLabel": "Яблоки и фрукты", "region": "Крым"}
]'::jsonb WHERE id = 'week';

UPDATE products SET suppliers = '[
  {"category": "fruits", "categoryLabel": "Тропические фрукты", "region": "Вьетнам, Эквадор"}
]'::jsonb WHERE id = 'exotic';

UPDATE products SET suppliers = '[
  {"category": "vegetables", "categoryLabel": "Овощи и томаты", "region": "Краснодарский край"}
]'::jsonb WHERE id = 'tomato';

UPDATE products SET suppliers = '[
  {"category": "vegetables", "categoryLabel": "Овощи и морковь", "region": "Краснодарский край"}
]'::jsonb WHERE id = 'carrot';

UPDATE products SET suppliers = '[
  {"category": "greens", "categoryLabel": "Зелень и салаты", "region": "Ставропольский край"}
]'::jsonb WHERE id = 'greens';

UPDATE products SET suppliers = '[
  {"category": "fruits", "categoryLabel": "Фрукты и груши", "region": "Крым"}
]'::jsonb WHERE id = 'apple';

UPDATE products SET suppliers = '[
  {"category": "vegetables", "categoryLabel": "Овощи и картофель", "region": "Краснодарский край"}
]'::jsonb WHERE id = 'potato';

-- Бейдж "Хит недели": borsch получает его, exotic его теряет (без замены
-- на другую непроверенную метку).
UPDATE products SET badge_type = 'hit', badge_label = 'Хит' WHERE id = 'borsch';
UPDATE products SET badge_type = NULL, badge_label = NULL WHERE id = 'exotic';
