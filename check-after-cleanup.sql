-- Проверка состояния после очистки. Только SELECT, безопасно в любой момент.
-- Запуск: node run-sql.js check-after-cleanup.sql
SELECT 'orders'            AS таблица, COUNT(*)::bigint AS значение FROM orders
UNION ALL SELECT 'reviews',            COUNT(*) FROM reviews
UNION ALL SELECT 'referral_rewards',   COUNT(*) FROM referral_rewards
UNION ALL SELECT 'user_rewards',       COUNT(*) FROM user_rewards
UNION ALL SELECT 'analytics_events',   COUNT(*) FROM analytics_events
UNION ALL SELECT 'users (остались)',   COUNT(*) FROM users
UNION ALL SELECT 'сумма баллов',       COALESCE(SUM(points), 0) FROM users
UNION ALL SELECT 'отзывы без order_id', COUNT(*) FROM reviews WHERE order_id IS NULL
UNION ALL SELECT 'промокоды сгоревшие', COUNT(*) FROM promo_codes WHERE is_used = true;
