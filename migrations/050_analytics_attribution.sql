-- Источник трафика (UTM) и расширение аналитики событий.
--
-- Три отдельных вещи, которые нужны вместе, поэтому одной миграцией:
--
-- 1. Атрибуция сессии в analytics_events. Колонками, а не в metadata JSONB:
--    по ним фильтруются воронка и список сессий в админке — это и есть весь
--    смысл сбора UTM. Заполняются ТОЛЬКО в строке события 'app_opened',
--    в остальных остаются NULL: атрибуция — свойство сессии, а не каждого
--    её события, дублировать её в каждую строку незачем.
--
-- 2. Долговременная атрибуция человека в users. Дубль сессионной, но
--    переживающий сессии. ВАЖНО: строка в users создаётся только при первом
--    заказе или входе по телефону, поэтому у посетителя, который посмотрел
--    и ушёл, её нет вовсе — источником истины по «откуда пришли» остаётся
--    analytics_events, а эти колонки нужны для отчётов «по клиентам».
--
-- 3. start_attributions — перехват payload из диплинка на стороне бота.
--    Telegram присылает боту "/start <payload>" РАНЬШЕ, чем пользователь
--    нажмёт кнопку и откроется Mini App, и payload в этот момент больше
--    нигде не всплывёт: инлайн-кнопка web_app до сих пор вела на голый
--    MINI_APP_URL, а initDataUnsafe.start_param заполняется только при
--    открытии по прямой ссылке Mini App (t.me/бот/приложение?startapp=…),
--    которых продукт нигде не генерирует. Из-за этого реферальные ссылки
--    вида ?start=ref_КОД фактически не работали. Теперь payload и
--    пробрасывается в URL кнопки, и сохраняется здесь — как запасной путь,
--    если приложение откроют позже и другим способом.
--
-- Применить: node migrations/apply.js 050_analytics_attribution.sql

BEGIN;

ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS utm_source   TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
ALTER TABLE analytics_events ADD COLUMN IF NOT EXISTS utm_medium   TEXT;

-- Частичный: непустой источник есть только у app_opened рекламных сессий,
-- то есть у малой доли строк — полный индекс был бы почти весь из NULL.
CREATE INDEX IF NOT EXISTS idx_analytics_events_utm_source
  ON analytics_events (utm_source) WHERE utm_source IS NOT NULL;

-- Воронка считает COUNT(DISTINCT session_id) по паре (event_type, диапазон
-- дат) — до сих пор по event_type индекса не было вовсе, при 14 шагах это
-- 14 проходов по таблице на каждое открытие дашборда.
CREATE INDEX IF NOT EXISTS idx_analytics_events_type_created
  ON analytics_events (event_type, created_at);

ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_source          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_campaign        TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS utm_medium          TEXT;
-- 'ad' | 'referral' | 'direct' — без CHECK, тот же подход, что у
-- status/category в остальной схеме.
ALTER TABLE users ADD COLUMN IF NOT EXISTS acquisition_channel TEXT;
-- Первое открытие Mini App. created_at фиксирует момент создания строки,
-- то есть первый заказ/вход — это заметно позже первого визита.
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_seen_at       TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS start_attributions (
  -- Один человек — одна актуальная атрибуция: повторный переход по свежей
  -- ссылке перезаписывает прежнюю (та же логика, что у реферального кода в
  -- referralCode.js — последняя открытая ссылка важнее предыдущей).
  telegram_id   BIGINT PRIMARY KEY,
  payload       TEXT,
  utm_source    TEXT,
  utm_campaign  TEXT,
  utm_medium    TEXT,
  referral_code TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
