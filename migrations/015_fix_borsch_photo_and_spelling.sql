-- Набор для борща: убираем фото, которое не соответствует составу
-- (авокадо/лимон/редис/болгарский перец вместо свёклы/моркови/картофеля/
-- капусты/лука) — до тех пор, пока не будет загружено подходящее фото,
-- карточка показывает только текст состава.
-- Также чиним букву «ё»: «Свекла» → «Свёкла» в составе набора.
-- Применить вручную: psql ... -f 015_fix_borsch_photo_and_spelling.sql

UPDATE products SET image_url = NULL WHERE id = 'borsch';

UPDATE products
SET composition = replace(composition::text, '"Свекла"', '"Свёкла"')::jsonb
WHERE id = 'borsch' AND composition::text LIKE '%"Свекла"%';
