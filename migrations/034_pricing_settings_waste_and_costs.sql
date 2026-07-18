-- Дополнения к модулю ценообразования:
-- 1) waste_percent — средний % товара, который портится/списывается
--    непроданным (актуально для скоропорта). Входит в себестоимость
--    проданной единицы — см. pricingCalc.js (Cw = (закупка+упаковка)/(1-w)).
-- 2) Постоянные расходы теперь вводятся тремя отдельными числами (аренда/
--    зарплаты/прочее) вместо одной суммы fixed_costs_monthly — так виднее
--    ошибку ввода, легче поменять одну статью. Сумма считается на чтении
--    (toPricingSettingsDTO в server.js), отдельной колонкой не хранится —
--    не дублируем то же число в двух местах, чтобы не рассинхронизировалось.
--
-- Существующее значение fixed_costs_monthly (если уже было заполнено)
-- переносится в other_costs_monthly, а не обнуляется. IF-обёртка ниже
-- делает файл безопасным для повторного запуска — на второй прогон колонки
-- уже нет, блок молча пропускается.
--
-- Применить: node migrations/apply.js 034_pricing_settings_waste_and_costs.sql

ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS waste_percent NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS rent_monthly NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS salary_monthly NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS other_costs_monthly NUMERIC NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pricing_settings' AND column_name = 'fixed_costs_monthly'
  ) THEN
    UPDATE pricing_settings SET other_costs_monthly = fixed_costs_monthly;
    ALTER TABLE pricing_settings DROP COLUMN fixed_costs_monthly;
  END IF;
END $$;
