-- Целевая маржа на уровне категории — двухуровневый приоритет маржи в
-- расчёте рекомендуемой цены (см. pricingCalc.js): маржа категории, если
-- задана, иначе глобальная default_margin_percent из pricing_settings.
-- Третьего уровня (индивидуальная маржа товара) сознательно нет.
--
-- NULL — у категории нет своей маржи, для её товаров действует глобальная.
--
-- Применить: node migrations/apply.js 037_category_target_margin.sql

ALTER TABLE categories ADD COLUMN IF NOT EXISTS target_margin_percent NUMERIC CHECK (target_margin_percent >= 0);
