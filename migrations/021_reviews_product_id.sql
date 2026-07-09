-- Отзывы на конкретный товар, а не только на заказ целиком. Заказ хранится
-- как JSONB (orders.items), но каждый item уже содержит id товара
-- (см. CartContext.jsx: placeOrder → items[].id), поэтому product_id можно
-- проставлять при сохранении отзыва без отдельной таблицы order_items.
--
-- product_id — TEXT (products.id — TEXT PRIMARY KEY, не INTEGER).
--
-- Старый индекс idx_reviews_order_id (миграция 017) разрешал ровно один
-- отзыв на заказ — теперь один заказ может дать несколько отзывов (по
-- одному на товар), поэтому уникальность переносится на пару
-- (order_id, product_id). Легаси-отзывы без product_id (негативные 1-3★,
-- общие по заказу) под это ограничение не попадают.
--
-- Применить: node migrations/apply.js 021_reviews_product_id.sql

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS product_id TEXT REFERENCES products(id);

DROP INDEX IF EXISTS idx_reviews_order_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_order_product
  ON reviews (order_id, product_id)
  WHERE order_id IS NOT NULL AND product_id IS NOT NULL;
