-- "Старая" цена для маркетингового зачёркивания (было/стало) — см.
-- PriceTag.jsx в prilavka-app. NULL = не показываем ничего зачёркнутого
-- (не 0/пусто — явное отсутствие скидки). Фронт также сверяет
-- old_price > price перед показом, так что val <= price сам по себе не
-- ломает вид, просто игнорируется — валидацию строже здесь не делаем.
--
-- Применить: node migrations/apply.js 043_product_old_price.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS old_price NUMERIC;
