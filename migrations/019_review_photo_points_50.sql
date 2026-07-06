-- Снижаем награду за отзыв с фото со 100 до 50 баллов.
-- Применить: node migrations/apply.js 019_review_photo_points_50.sql

UPDATE settings SET value = '50' WHERE key = 'review_photo_points';
