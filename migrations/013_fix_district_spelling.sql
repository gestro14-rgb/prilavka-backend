-- Исправляем букву «ё» в названиях районов для существующих БД.
-- (Автораннера миграций нет — применить вручную: psql ... -f 013_fix_district_spelling.sql)

UPDATE districts SET name = 'Тёплый Стан' WHERE name = 'Теплый Стан';
UPDATE districts SET name = 'Тропарёво'   WHERE name = 'Тропарево';

-- Отзывы и «последние доставки», если хранятся в таблицах.
UPDATE reviews SET area = 'Тёплый Стан' WHERE area = 'Теплый Стан';
UPDATE reviews SET area = 'Тропарёво'   WHERE area = 'Тропарево';
