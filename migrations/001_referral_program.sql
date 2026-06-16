-- Миграция 001: реферальная программа
-- Применять на production-БД, где уже есть таблицы:
--   categories, products, reviews, deliveries, admins,
--   delivery_zones, orders, promo_codes
--
-- Миграция идемпотентна: безопасно запускать повторно.
-- Порядок важен: users → orders (ALTER) → referral_rewards (FK на обе).

BEGIN;

-- 1. Таблица пользователей
--    Создаётся лениво при первом обращении к профилю (upsert в /api/users/:id/stats).
CREATE TABLE IF NOT EXISTS users (
  telegram_id   BIGINT       PRIMARY KEY,
  username      TEXT,
  first_name    TEXT,
  referral_code TEXT         UNIQUE NOT NULL,
  referred_by_id BIGINT      REFERENCES users(telegram_id),
  points        INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 2. Поле referral_code в orders
--    NULL — заказ оформлен без кода приглашения.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS referral_code TEXT;

-- 3. Лог начислений баллов за рефералов
--    UNIQUE (order_id) исключает двойное начисление при повторной смене статуса.
CREATE TABLE IF NOT EXISTS referral_rewards (
  id             SERIAL       PRIMARY KEY,
  referrer_id    BIGINT       NOT NULL REFERENCES users(telegram_id),
  referred_id    BIGINT       NOT NULL REFERENCES users(telegram_id),
  order_id       INTEGER      NOT NULL UNIQUE REFERENCES orders(id),
  points_awarded INTEGER      NOT NULL,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;
