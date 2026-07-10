-- Пищевая ценность на 100 г — опциональное поле товара, для блока на
-- странице товара (под "Куда уходит цена"). Опциональное: ADD COLUMN без
-- NOT NULL/DEFAULT, существующие товары остаются с nutrition = NULL, блок
-- на фронте просто не рендерится, пока данные не заполнены.
--
-- Форма JSON: {"calories": 23, "protein": 1.1, "fat": 0.2, "carbs": 3.9}
-- (значения на 100 г продукта).
--
-- Применить: node migrations/apply.js 022_product_nutrition.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS nutrition JSONB;
