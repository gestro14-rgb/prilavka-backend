-- Миграция 003: обмен баллов на награды
-- Идемпотентна: безопасно запускать повторно.

BEGIN;

CREATE TABLE IF NOT EXISTS user_rewards (
  id          SERIAL       PRIMARY KEY,
  telegram_id BIGINT       NOT NULL REFERENCES users(telegram_id),
  reward_id   INTEGER      NOT NULL REFERENCES rewards(id),
  status      TEXT         NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'used')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMIT;
