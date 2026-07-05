-- Экран отзыва после заказа (7b): отзыв теперь привязывается к конкретному
-- заказу (раньше — один отзыв на пользователя навсегда), плюс теги причин/
-- впечатлений и отметка "предложили оставить отзыв, отложили".
--
-- Модерация уже была: колонка reviews.status ('pending'/'published' —
-- миграция 006) — переиспользуем её как is_approved-гейт, отдельное поле не
-- нужно. Все новые отзывы (включая 1-3 звезды) создаются со status='pending'
-- и не попадают в публичную выдачу (WHERE status = 'published' в /api/catalog)
-- пока админ не одобрит.
--
-- Применить: node migrations/apply.js 017_review_screen.sql

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id);
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]';

-- Один отзыв на заказ (частичный индекс — старые/сидовые отзывы без order_id
-- не участвуют в уникальности).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_order_id ON reviews (order_id) WHERE order_id IS NOT NULL;

-- "Позже" на баннере/пуше — не показывать повторно в тот же день для этого заказа.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_dismissed_at TIMESTAMPTZ;

INSERT INTO settings (key, value, description) VALUES
  ('review_photo_points', '100', 'Баллы за отзыв с фото после заказа')
ON CONFLICT (key) DO NOTHING;
