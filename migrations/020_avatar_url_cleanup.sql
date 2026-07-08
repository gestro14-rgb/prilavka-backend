-- avatar_url раньше хранил полный URL Telegram Bot API с боевым токеном
-- бота, отдававшимся всем через публичные /api/reviews и /api/catalog.
-- Теперь колонка хранит только file_id (не протухает, не содержит секретов),
-- резолвится в картинку через прокси-эндпоинт /api/avatar/:fileId.
-- Обнуляем скомпрометированные значения — старые полные URL узнаются по
-- префиксу "http", чистый file_id так не начинается.
-- Применить: node migrations/apply.js 020_avatar_url_cleanup.sql

UPDATE reviews SET avatar_url = NULL WHERE avatar_url LIKE 'http%';
