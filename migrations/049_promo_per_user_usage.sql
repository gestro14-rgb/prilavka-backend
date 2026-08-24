-- Одноразовость промокода — на пару (промокод + клиент), а не на весь код.
--
-- До сих пор одноразовость выражалась единственным флагом promo_codes.is_used:
-- первый же клиент, применивший код, "сжигал" его для всех остальных. Для
-- именных кодов (ОЛЬГА, АННА, …), которые раздаются лично конкретным людям,
-- это и есть задуманное поведение. Для массового приветственного кода
-- (ПРИВЕТ из баннера на Главной) — нет: его должен применить каждый новый
-- клиент по одному разу.
--
-- Поэтому вводим два вида кода и таблицу применений:
--
--   usage_type = 'once_global'   — прежнее поведение, один раз на весь код.
--                                  Это значение по умолчанию, поэтому все 11
--                                  существующих кодов после миграции ведут
--                                  себя ровно как до неё, ничего не переключая.
--   usage_type = 'once_per_user' — код общий, но каждому клиенту достаётся
--                                  один раз.
--
-- Ключ применения — user_id, а НЕ telegram_id, хотя код и раздаётся в
-- Telegram. Причины две, и обе делают telegram_id непригодным:
--   1. У входа по телефону telegram_id нет вовсе (тот же довод, по которому
--      countUserOrders в server.js считает заказы по user_id, — см.
--      комментарий там же и миграцию 028).
--   2. UNIQUE в Postgres не ограничивает строки, где ключ NULL: уникальность
--      по (promo_code_id, telegram_id) для телефонных клиентов не сработала
--      бы вообще, и код стал бы для них бесконечно применимым — ровно та
--      дыра, которую эта миграция закрывает.
-- telegram_id храним рядом справочно, как promo_codes.used_by_telegram_id.
--
-- Применить: node migrations/apply.js 049_promo_per_user_usage.sql

BEGIN;

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS usage_type TEXT NOT NULL DEFAULT 'once_global';

ALTER TABLE promo_codes DROP CONSTRAINT IF EXISTS promo_codes_usage_type_check;
ALTER TABLE promo_codes ADD CONSTRAINT promo_codes_usage_type_check
  CHECK (usage_type IN ('once_global', 'once_per_user'));

CREATE TABLE IF NOT EXISTS promo_code_uses (
  id            SERIAL PRIMARY KEY,
  promo_code_id INTEGER NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  user_id       BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Справочно, для разбора кампании: у телефонного входа его нет.
  telegram_id   BIGINT,
  -- ON DELETE SET NULL, а не CASCADE: удаление заказа не должно возвращать
  -- клиенту право применить код заново.
  order_id      INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  used_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Собственно то, ради чего таблица: один клиент не может применить один и
-- тот же код дважды. Это же ограничение — последний рубеж против гонки двух
-- одновременно оформляемых заказов, которую проверка в приложении пропустит
-- (обе успевают прочитать "ещё не применял" до первой записи).
CREATE UNIQUE INDEX IF NOT EXISTS promo_code_uses_code_user_key
  ON promo_code_uses (promo_code_id, user_id);

-- Отдельный индекс под "применял ли этот клиент этот код" не нужен: запрос
-- идёт ровно по паре (promo_code_id, user_id) и обслуживается уникальным
-- индексом выше. Выборке "кто применял этот код" хватает его же префикса.

-- Задел на прошлое: если к моменту прогона какой-то код уже был сожжён через
-- is_used, переносим этот факт в новую таблицу, чтобы история не потерялась
-- при возможном последующем переводе кода в once_per_user. На момент написания
-- миграции таких кодов нет (все 11 с is_used = false) — вставка не сделает
-- ничего и нужна на случай позднего или повторного прогона.
INSERT INTO promo_code_uses (promo_code_id, user_id, telegram_id, used_at)
SELECT p.id, u.id, p.used_by_telegram_id, COALESCE(p.used_at, now())
FROM promo_codes p
JOIN users u ON u.telegram_id = p.used_by_telegram_id
WHERE p.is_used = true AND p.used_by_telegram_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- ПРИВЕТ — единый приветственный код, на который ведёт баннер на Главной:
-- его применяет каждый новый клиент. Именные коды и СОСЕД остаются
-- once_global и этой строкой не затрагиваются.
UPDATE promo_codes SET usage_type = 'once_per_user' WHERE code = 'ПРИВЕТ';

COMMIT;
