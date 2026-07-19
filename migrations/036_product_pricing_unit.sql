-- Единица закупки для модуля ценообразования (см. pricingCalc.js):
--   'piece' — закупочная цена (purchase_price) используется как есть;
--   'kg'    — закупочная цена вводится ЗА КИЛОГРАММ, эффективная закупка
--             упаковки = purchase_price × weight_kg.
--
-- weight_kg — структурированный вес упаковки В КГ, вводится вручную и
-- используется ТОЛЬКО при pricing_unit = 'kg'. Существующее текстовое поле
-- products.weight ("700 г", "1 пучок", "3 шт (~400 г)") — витринное описание
-- для покупателя; парсить из него число ненадёжно ("1 пучок" числа не
-- содержит вовсе), поэтому оно намеренно не трогается и остаётся чисто
-- отображением.
--
-- Применить: node migrations/apply.js 036_product_pricing_unit.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS pricing_unit TEXT NOT NULL DEFAULT 'piece' CHECK (pricing_unit IN ('kg', 'piece'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_kg NUMERIC CHECK (weight_kg > 0);
