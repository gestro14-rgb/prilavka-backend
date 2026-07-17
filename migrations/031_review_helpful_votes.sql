-- Счётчик "Полезно" на отзывах: раньше кнопка была декоративной.
-- Голоса храним отдельной таблицей (кто и когда голосовал) + денормализованный
-- счётчик на reviews.helpful_count, чтобы не JOIN'ить review_helpful_votes на
-- каждое чтение списка отзывов. Уникальный индекс (review_id, user_id) не
-- даёт проголосовать дважды — вставка второго голоса просто игнорируется
-- (ON CONFLICT DO NOTHING) на уровне эндпоинта.
--
-- Применить: node migrations/apply.js 031_review_helpful_votes.sql

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS helpful_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS review_helpful_votes (
  id SERIAL PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_helpful_votes_review_user
  ON review_helpful_votes (review_id, user_id);
