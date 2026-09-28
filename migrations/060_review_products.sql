-- Один пользовательский отзыв = одна строка в reviews.
--
-- Было (миграция 021): reviews хранила по строке на КАЖДЫЙ товар заказа.
-- Текст, имя, район, фото, аватар и теги дублировались в каждой строке, и
-- один отзыв о четырёх товарах существовал как четыре независимых отзыва:
-- админка показывала четыре кнопки «Опубликовать», а опубликованные строки
-- давали четыре копии одного текста на Главной и в общем фиде.
--
-- Стало: reviews — сам отзыв (текст/имя/район/фото/аватар/теги/статус), а
-- связь с товарами и ОЦЕНКА КАЖДОГО ТОВАРА живут в review_products. Оценки
-- по товарам реально бывают разные (POST /api/orders/:id/review принимает
-- items: [{productId, stars}]), поэтому stars обязана быть на связи, а не на
-- отзыве. reviews.stars остаётся общей оценкой отзыва — её показывает лента
-- и по ней считается гистограмма.
--
-- Миграция идемпотентна: связи вставляются ON CONFLICT DO NOTHING, а слияние
-- групп выполняется только там, где ещё осталось больше одной строки.

-- ── 1. Резервная копия ───────────────────────────────────────────────────
-- Полный слепок reviews ДО слияния. Откат = восстановить из этой таблицы;
-- она намеренно не удаляется в конце миграции.
CREATE TABLE IF NOT EXISTS reviews_backup_060 AS TABLE reviews;

-- ── 2. Связь отзыв ↔ товар ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS review_products (
  review_id  INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  product_id TEXT    NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- Оценка ИМЕННО этого товара в этом отзыве. Именно она идёт в рейтинг
  -- карточки товара, а не общая reviews.stars.
  stars      INTEGER NOT NULL DEFAULT 5 CHECK (stars BETWEEN 1 AND 5),
  PRIMARY KEY (review_id, product_id)
);

-- Рейтинг и список отзывов запрашиваются по товару — это горячее направление.
CREATE INDEX IF NOT EXISTS idx_review_products_product ON review_products (product_id);

-- ── 3. Перенос существующих отзывов ──────────────────────────────────────
DO $$
DECLARE
  g RECORD;
  survivor INTEGER;
  merged_status TEXT;
  merged_stars INTEGER;
BEGIN
  -- Группа = один пользовательский отзыв: один заказ, один автор. Отзывы без
  -- order_id (заведённые в админке руками) группировать не по чему — они
  -- уже одиночные и остаются как есть.
  FOR g IN
    SELECT order_id, telegram_user_id, array_agg(id ORDER BY id) AS ids
      FROM reviews
     WHERE order_id IS NOT NULL
     GROUP BY order_id, telegram_user_id
  LOOP
    survivor := g.ids[1];

    -- Связи со ВСЕМИ товарами группы и оценка каждого из них.
    INSERT INTO review_products (review_id, product_id, stars)
    SELECT survivor, r.product_id, r.stars
      FROM reviews r
     WHERE r.id = ANY(g.ids) AND r.product_id IS NOT NULL
    ON CONFLICT (review_id, product_id) DO NOTHING;

    -- Голоса «полезно» переносим на выживший ДО удаления строк: у
    -- review_helpful_votes стоит ON DELETE CASCADE, и после DELETE их бы
    -- просто не стало. Один пользователь мог проголосовать за две строки
    -- одной группы — после слияния это один голос, поэтому DO NOTHING.
    INSERT INTO review_helpful_votes (review_id, user_id, created_at)
    SELECT survivor, v.user_id, v.created_at
      FROM review_helpful_votes v
     WHERE v.review_id = ANY(g.ids) AND v.review_id <> survivor
    ON CONFLICT (review_id, user_id) DO NOTHING;

    -- Статус группы: опубликован, если опубликована хотя бы одна строка.
    -- Текст во всех строках группы один и тот же, а публикация модерирует
    -- именно текст — значит он уже одобрен. Правило выбрано владельцем
    -- проекта 2026-09-28 из трёх вариантов; консервативная альтернатива
    -- («published только если все») сняла бы с витрины оба живых отзыва.
    SELECT CASE WHEN bool_or(status = 'published') THEN 'published' ELSE min(status) END
      INTO merged_status
      FROM reviews WHERE id = ANY(g.ids);

    -- Общая оценка отзыва — среднее по его товарам, округлённое. Пока
    -- оценки одинаковые, это та же цифра; когда разойдутся, лента покажет
    -- честное среднее, а карточка товара — свою оценку из review_products.
    SELECT GREATEST(1, LEAST(5, ROUND(AVG(stars))::int))
      INTO merged_stars
      FROM reviews WHERE id = ANY(g.ids);

    UPDATE reviews r SET
      status        = merged_status,
      stars         = merged_stars,
      helpful_count = (SELECT COALESCE(SUM(helpful_count), 0) FROM reviews x WHERE x.id = ANY(g.ids)),
      -- Текст/фото/аватар в группе одинаковые, но берём первое непустое:
      -- если у выжившего поле пустое, а у соседней строки заполнено,
      -- потерять его при слиянии нельзя.
      text          = COALESCE(r.text,      (SELECT x.text      FROM reviews x WHERE x.id = ANY(g.ids) AND x.text      IS NOT NULL ORDER BY x.id LIMIT 1)),
      image_url     = COALESCE(r.image_url, (SELECT x.image_url FROM reviews x WHERE x.id = ANY(g.ids) AND x.image_url IS NOT NULL ORDER BY x.id LIMIT 1)),
      avatar_url    = COALESCE(r.avatar_url,(SELECT x.avatar_url FROM reviews x WHERE x.id = ANY(g.ids) AND x.avatar_url IS NOT NULL ORDER BY x.id LIMIT 1)),
      -- Товары отзыва теперь в review_products. Колонку не удаляем: она
      -- остаётся опорой для отката из reviews_backup_060.
      product_id    = NULL
    WHERE r.id = survivor;

    DELETE FROM reviews WHERE id = ANY(g.ids) AND id <> survivor;
  END LOOP;
END $$;

-- ── 4. Уникальность ──────────────────────────────────────────────────────
-- Было «один отзыв на пару (заказ, товар)» — теперь один отзыв на заказ.
DROP INDEX IF EXISTS idx_reviews_order_product;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_order_id
  ON reviews (order_id) WHERE order_id IS NOT NULL;
