-- Миграция 002: каталог наград за баллы
-- Идемпотентна: безопасно запускать повторно.

BEGIN;

CREATE TABLE IF NOT EXISTS rewards (
  id          SERIAL       PRIMARY KEY,
  title       TEXT         NOT NULL,
  description TEXT,
  emoji       TEXT,
  points_cost INTEGER      NOT NULL CHECK (points_cost > 0),
  is_active   BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;
