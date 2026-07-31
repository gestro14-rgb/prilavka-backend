-- ================================================================
-- ОЧИСТКА ТЕСТОВЫХ ДАННЫХ ПЕРЕД ЗАПУСКОМ. Одна транзакция. Одноразовый.
-- Запуск: railway ssh --service prilavka-backend
--         node run-sql.js cleanup-test-data.sql
--
-- Через веб-интерфейс Railway (Postgres → Data) НЕ выполняется: он
-- оборачивает введённое в собственный SELECT ... LIMIT, отчего
-- многооператорный скрипт падает с "syntax error at or near LIMIT".
--
-- Проверено на настоящем Postgres (PGlite) на копии схемы: штатный
-- прогон, появление нового заказа, срабатывание защиты, отказ FK.
--
-- Порядок продиктован схемой: reviews.order_id и referral_rewards.order_id
-- ссылаются на orders БЕЗ ON DELETE CASCADE, поэтому заказы удаляются
-- ПОСЛЕ своих зависимостей — иначе ошибка 23503.
--
-- Пользователей (users) НЕ удаляем: иначе вернувшиеся люди создадутся
-- заново и придёт повторное "Новый пользователь".
--
-- Везде id BETWEEN 1 AND 47, а не "все подряд": если между составлением
-- списка и запуском появится НАСТОЯЩИЙ заказ, он получит id 48+ и
-- уцелеет. Ниже стоит защита, которая остановит скрипт, если картина
-- в таблице изменилась.
-- ================================================================

BEGIN;

CREATE TEMP TABLE cleanup_log (n serial, шаг text, затронуто bigint) ON COMMIT DROP;

-- ---------- ЗАЩИТА ----------
-- Если заказов с id 1..47 не ровно 47 — данные изменились с момента
-- сверки, и весь скрипт откатывается, ничего не удалив.
DO $$
DECLARE
  n_target int;
  n_new    int;
BEGIN
  SELECT COUNT(*) INTO n_target FROM orders WHERE id BETWEEN 1 AND 47;
  IF n_target <> 47 THEN
    RAISE EXCEPTION
      'Остановлено: ожидали 47 заказов с id 1..47, найдено %. Данные изменились — пересверьте перед удалением.',
      n_target;
  END IF;

  SELECT COUNT(*) INTO n_new FROM orders WHERE id > 47;
  IF n_new > 0 THEN
    RAISE NOTICE 'Внимание: % заказ(ов) с id > 47 — они НЕ удаляются (считаем настоящими).', n_new;
  END IF;
END $$;

-- ---------- 1. Голоса "полезный отзыв" ----------
-- Формально уходят каскадом вместе с отзывами (ON DELETE CASCADE),
-- удаляем явно только чтобы число попало в отчёт.
WITH d AS (
  DELETE FROM review_helpful_votes
  WHERE review_id IN (SELECT id FROM reviews WHERE order_id BETWEEN 1 AND 47)
  RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '1. review_helpful_votes', COUNT(*) FROM d;

-- ---------- 2. Отзывы по удаляемым заказам ----------
WITH d AS (
  DELETE FROM reviews WHERE order_id BETWEEN 1 AND 47 RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '2. reviews (по order_id)', COUNT(*) FROM d;

-- ---------- 3. Реферальные начисления ----------
WITH d AS (
  DELETE FROM referral_rewards WHERE order_id BETWEEN 1 AND 47 RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '3. referral_rewards', COUNT(*) FROM d;

-- ---------- 4. Сами заказы ----------
WITH d AS (
  DELETE FROM orders WHERE id BETWEEN 1 AND 47 RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '4. orders', COUNT(*) FROM d;

-- ---------- 5. Обменянные награды ----------
-- Обменивались за тестовые баллы, которые ниже обнуляются, — иначе
-- остаются "выданными в долг". Таблица на orders не ссылается.
WITH d AS (
  DELETE FROM user_rewards RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '5. user_rewards (все)', COUNT(*) FROM d;

-- ---------- 6. Аналитика целиком ----------
-- DELETE, а не TRUNCATE: даёт число строк для отчёта и не берёт
-- ACCESS EXCLUSIVE lock на таблицу, в которую прямо сейчас пишет
-- работающее приложение.
WITH d AS (
  DELETE FROM analytics_events RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '6. analytics_events (все)', COUNT(*) FROM d;

-- ---------- 7. Баллы в ноль ----------
-- Сами строки users НЕ трогаем — только баланс.
WITH u AS (
  UPDATE users SET points = 0, updated_at = now() WHERE points <> 0 RETURNING 1
)
INSERT INTO cleanup_log (шаг, затронуто) SELECT '7. users: points -> 0', COUNT(*) FROM u;

-- ---------- ЧТО ОСТАЛОСЬ (скрипт это НЕ трогает) ----------
INSERT INTO cleanup_log (шаг, затронуто)
SELECT '⚠ отзывы без order_id (ВИДНЫ покупателям)', COUNT(*)
FROM reviews WHERE order_id IS NULL AND status = 'published';

INSERT INTO cleanup_log (шаг, затронуто)
SELECT '⚠ промокоды, сгоревшие на тестах', COUNT(*)
FROM promo_codes WHERE is_used = true;

INSERT INTO cleanup_log (шаг, затронуто)
SELECT 'осталось заказов (настоящие, id > 47)', COUNT(*) FROM orders;

INSERT INTO cleanup_log (шаг, затронуто)
SELECT 'пользователей сохранено', COUNT(*) FROM users;

-- ---------- ОТЧЁТ ПЕРЕД КОММИТОМ ----------
SELECT шаг, затронуто FROM cleanup_log ORDER BY n;

COMMIT;
