-- Переработка приоритета целевой маржи (см. pricingCalc.js): вместо уровня
-- "категория" (migrations/037) — три уровня:
--   индивидуальная маржа товара → маржа подкатегории → глобальная
--   default_margin_percent из pricing_settings.
-- У товара без subcategory_id (поле необязательное) уровень подкатегории
-- просто пропускается.
--
-- categories.target_margin_percent УДАЛЯЕТСЯ, а не остаётся мёртвым: поле,
-- которое админ заполнил, а расчёт молча игнорирует — ловушка. Значения не
-- переносятся на подкатегории: у категории их несколько с разной экономикой,
-- автоперенос был бы догадкой.
--
-- Применить: node migrations/apply.js 038_margin_priority_rework.sql

ALTER TABLE subcategories ADD COLUMN IF NOT EXISTS target_margin_percent NUMERIC CHECK (target_margin_percent >= 0);

-- Для акционных товаров и исключений — переопределяет и подкатегорию, и
-- глобальную настройку. 0 — валидное значение ("продаём по себестоимости"),
-- "не задано" — только NULL.
ALTER TABLE products ADD COLUMN IF NOT EXISTS individual_margin_percent NUMERIC CHECK (individual_margin_percent >= 0);

ALTER TABLE categories DROP COLUMN IF EXISTS target_margin_percent;
