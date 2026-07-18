-- Закупочная цена товара — вход для расчёта рекомендуемой цены (см.
-- migrations/032_pricing_settings.sql и pricingCalc.js в админке).
-- Nullable: у уже заведённых товаров её никто не укажет задним числом,
-- расчётный блок в ProductForm просто не показывается, пока поле пустое.
--
-- Применить: node migrations/apply.js 033_product_purchase_price.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS purchase_price NUMERIC;
