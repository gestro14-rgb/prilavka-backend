-- Условие "на какой по счёту заказ действует промокод".
--
-- Храним не перечислением ('first_order'/'repeat_order'/...), а парой границ
-- на номер заказа — селект в админке остаётся тем же, но в базе нет
-- рассогласованных состояний вида "условие 'любой заказ', но N = 5",
-- и проверка сводится к одному выражению вместо разбора вариантов:
--
--   Без ограничения    → NULL, NULL
--   Только первый      → NULL, 1
--   Только повторный   → 2,    NULL
--   Первые N заказов   → NULL, N
--
-- Бонусом становятся выразимы "только 3-й заказ" (3, 3) и "с 5-го и далее"
-- (5, NULL) — админка их пока не предлагает, но данные и валидация готовы.
-- Существующие промокоды получают NULL/NULL, то есть ведут себя ровно как
-- до миграции.
--
-- Применить: node migrations/apply.js 044_promo_order_condition.sql

BEGIN;

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS min_order_number INTEGER;
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_order_number INTEGER;

-- Границы должны быть осмысленными: номер заказа считается с единицы, а
-- перевёрнутый диапазон (min > max) не выполним ни при каком заказе — такой
-- промокод молча не сработал бы ни разу, лучше не дать его создать.
ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_order_number_range_check;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_order_number_range_check
  CHECK (
    (min_order_number IS NULL OR min_order_number >= 1)
    AND (max_order_number IS NULL OR max_order_number >= 1)
    AND (min_order_number IS NULL OR max_order_number IS NULL
         OR min_order_number <= max_order_number)
  );

-- Номер заказа считается как COUNT(*) по orders.user_id — до сих пор такой
-- запрос делался только в /api/me/stats (раз на открытие профиля), теперь
-- будет на каждую проверку промокода в корзине. Индекса на user_id не было
-- вообще, хотя колонка появилась ещё в миграции 028.
CREATE INDEX IF NOT EXISTS orders_user_id_idx ON orders (user_id);

COMMIT;
