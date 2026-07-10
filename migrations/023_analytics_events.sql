-- Аналитика поведения пользователей: просмотры экранов + ключевые точки
-- флоу (добавление в корзину, начало оформления, оформленный заказ) —
-- для воронки конверсии, топа экранов и пути конкретной сессии/пользователя.
--
-- session_id генерируется на фронте (crypto.randomUUID()) при каждом
-- открытии Mini App и живёт только в памяти вкладки — одна "сессия" здесь
-- буквально означает одно открытие приложения, не более того.
--
-- event_type намеренно TEXT без CHECK — тот же подход, что у status/category
-- в остальной схеме; ключевые значения: 'screen_view', 'add_to_cart',
-- 'checkout_start', 'order_placed'.
--
-- Применить: node migrations/apply.js 023_analytics_events.sql

CREATE TABLE IF NOT EXISTS analytics_events (
  id SERIAL PRIMARY KEY,
  user_id BIGINT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  screen_name TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at);
