-- Отдельное человекочитаемое поле slug — можно свободно переименовывать после
-- создания товара, не трогая products.id.
--
-- products.id остаётся неизменным навсегда: на него ссылаются реальные FK
-- (reviews.product_id, набор_состав.product_id, home_product_shelves.product_id
-- — причём у последних двух ON DELETE CASCADE, но ON UPDATE NO ACTION по
-- умолчанию, т.к. в migration 010/024 он не был указан отдельно) и JSON-снимок
-- orders.items[].id, который вообще не обновляется каскадом (JSONB, не FK) —
-- на нём держится проверка права на отзыв (server.js: orderProductIds).
-- Переименование id задним числом либо упадёт с ошибкой внешнего ключа, либо
-- тихо разойдётся со старыми заказами. slug — safe-паттерн: тот же принцип,
-- что и суррогатный users.id в migration 028 (изменяемое человекочитаемое
-- поле отдельно от неизменной опоры для связей).
--
-- Только внутреннее/админское поле — публичный роутинг prilavka-app по нему
-- не строится, id в URL остаётся как есть.
--
-- Применить: node migrations/apply.js 030_product_slug.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;

-- Бэкфилл существующих товаров: slug = текущий id (уже был человекочитаемым
-- слагом на момент создания).
UPDATE products SET slug = id WHERE slug IS NULL;

-- Уникальность — как и у id, чтобы не было двух товаров с одинаковым slug.
CREATE UNIQUE INDEX IF NOT EXISTS products_slug_key ON products (slug);
