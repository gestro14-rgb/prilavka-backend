-- Браузерная авторизация по телефону+SMS (вне Telegram) — до этой миграции
-- users.telegram_id был единственным PRIMARY KEY, у пользователя без
-- Telegram (вошедшего только по телефону) не было бы способа существовать
-- в этой таблице вообще. Вводим суррогатный id, telegram_id и phone
-- становятся независимыми nullable-полями (хотя бы одно обязано быть
-- заполнено — см. users_identity_check).
--
-- Ключевая сложность: на telegram_id как PK ссылаются FK у
-- users.referred_by_id, referral_rewards.referrer_id/referred_id,
-- user_rewards.telegram_id (миграции 001, 003). Postgres не даёт снять
-- PRIMARY KEY, пока эти FK ссылаются на колонку — но FK может ссылаться
-- на любую колонку с UNIQUE-ограничением, не только на PK. План: сначала
-- явный UNIQUE на telegram_id (FK переключаются на него автоматически),
-- потом снимаем старый PK и ставим новый на id. Существующие FK не
-- переопределяются вообще — просто продолжают работать.
--
-- Применить: node migrations/apply.js 028_users_phone_auth.sql

BEGIN;

-- 1. Суррогатный PK + телефон.
ALTER TABLE users ADD COLUMN IF NOT EXISTS id BIGSERIAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 2. UNIQUE на telegram_id ДО снятия старого PK.
ALTER TABLE users ADD CONSTRAINT users_telegram_id_key UNIQUE (telegram_id);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_pkey;
ALTER TABLE users ADD PRIMARY KEY (id);
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

-- 3. Партиционный уникальный индекс на phone — как idx_reviews_order_product
--    в миграции 021: уникально только там, где реально заполнено.
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_key ON users (phone) WHERE phone IS NOT NULL;

-- 4. Пользователь обязан быть идентифицируем хоть как-то.
ALTER TABLE users ADD CONSTRAINT users_identity_check
  CHECK (telegram_id IS NOT NULL OR phone IS NOT NULL);

-- 5. Бэкфилл телефона из заказов — только там, где номер однозначно
--    принадлежит одному telegram_id (иначе рискуем присвоить чужой
--    телефон — например, если два человека когда-то ввели один номер).
--    Неоднозначные телефоны остаются NULL без потери данных.
WITH candidate AS (
  SELECT telegram_user_id, phone
  FROM orders
  WHERE telegram_user_id IS NOT NULL AND phone IS NOT NULL AND phone <> ''
  GROUP BY telegram_user_id, phone
),
unambiguous AS (
  SELECT phone, MIN(telegram_user_id) AS telegram_user_id
  FROM candidate
  GROUP BY phone
  HAVING COUNT(DISTINCT telegram_user_id) = 1
)
UPDATE users u SET phone = ua.phone
FROM unambiguous ua
WHERE u.telegram_id = ua.telegram_user_id AND u.phone IS NULL;

-- 6. Короткоживущие коды подтверждения — отдельная таблица, не users.
CREATE TABLE IF NOT EXISTS phone_verification_codes (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_verification_codes_phone_idx ON phone_verification_codes (phone);

-- 7. orders.telegram_user_id и user_rewards.telegram_id (NOT NULL) требуют
--    именно telegram-id — у телефонных пользователей его нет. Добавляем
--    универсальный user_id (nullable, не ломает существующие строки) рядом
--    с уже существующими колонками — их не трогаем, старый Telegram-код
--    (уведомления, реферальная программа) продолжает работать как есть.
--    Дальше все НОВЫЕ заказы/обмены наград всегда пишут user_id — сервер
--    после этой задачи всегда знает req.userId для любого способа входа.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);
ALTER TABLE user_rewards ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id);

-- user_rewards.telegram_id был NOT NULL (миграция 003) — для телефонного
-- пользователя (без telegram_id) INSERT при обмене баллов упал бы.
ALTER TABLE user_rewards ALTER COLUMN telegram_id DROP NOT NULL;
ALTER TABLE user_rewards ADD CONSTRAINT user_rewards_identity_check
  CHECK (user_id IS NOT NULL OR telegram_id IS NOT NULL);

UPDATE orders o SET user_id = u.id
FROM users u
WHERE o.telegram_user_id = u.telegram_id AND o.user_id IS NULL;

UPDATE user_rewards ur SET user_id = u.id
FROM users u
WHERE ur.telegram_id = u.telegram_id AND ur.user_id IS NULL;

COMMIT;
