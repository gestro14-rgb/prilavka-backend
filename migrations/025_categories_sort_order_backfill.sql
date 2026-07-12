-- categories.sort_order существует с самого начала (schema.sql) и уже
-- применяется в ORDER BY (/api/catalog, /api/admin/categories), но никогда
-- не заполнялся осмысленно через API — INSERT из админки либо не передавал
-- sortOrder, либо все строки могли осесть с одинаковым значением (DEFAULT 0).
-- При равенстве sort_order порядок между такими строками не гарантирован
-- Postgres-ом и может незаметно измениться при переиндексации/передеплое.
--
-- Явно фиксируем текущий видимый порядок (проверен через живой публичный
-- /api/catalog: Все → Наборы → Овощи → Фрукты → Зелень) как sort_order —
-- порядок для пользователей не меняется, просто перестаёт зависеть от
-- случайности. Шаг 10 — чтобы позже можно было вставить категорию между
-- существующими, не перенумеровывая все подряд.
-- "Все" не строка в этой таблице — это синтетическая запись, которую
-- сервер добавляет в начало списка в коде (server.js), поэтому её тут нет.
--
-- Применить: node migrations/apply.js 025_categories_sort_order_backfill.sql

UPDATE categories SET sort_order = 10 WHERE id = 'bundles';
UPDATE categories SET sort_order = 20 WHERE id = 'vegetables';
UPDATE categories SET sort_order = 30 WHERE id = 'fruits';
UPDATE categories SET sort_order = 40 WHERE id = 'greens';
