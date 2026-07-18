-- Настройки модуля ценообразования (админка → "Ценообразование") — одна
-- строка глобальных бизнес-параметров для расчёта рекомендуемой цены и
-- цены безубыточности по каждому товару (см. ProductForm.jsx / pricingCalc.js).
-- Отдельная таблица, а не общая settings (key/value TEXT) — здесь значения
-- всегда numeric и используются в арифметике на каждый ввод в форме
-- товара, парсить строки на каждый расчёт не хочется.
--
-- Применить: node migrations/apply.js 032_pricing_settings.sql

CREATE TABLE IF NOT EXISTS pricing_settings (
  id SERIAL PRIMARY KEY,
  fixed_costs_monthly NUMERIC NOT NULL DEFAULT 0,
  planned_sales_monthly INTEGER NOT NULL DEFAULT 0,
  packaging_cost_per_unit NUMERIC NOT NULL DEFAULT 0,
  acquiring_percent NUMERIC NOT NULL DEFAULT 0,
  default_margin_percent NUMERIC NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Гарантируем ровно одну строку (singleton) через уникальный индекс на
-- константном выражении — стандартный приём для settings-таблиц в Postgres,
-- вставка второй строки упрётся в конфликт индекса.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_settings_singleton ON pricing_settings ((true));

INSERT INTO pricing_settings (fixed_costs_monthly, planned_sales_monthly, packaging_cost_per_unit, acquiring_percent, default_margin_percent)
SELECT 0, 0, 0, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM pricing_settings);
