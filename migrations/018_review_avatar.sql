-- Аватар из Telegram для карточки отзыва на главной (getUserProfilePhotos).
-- Применить: node migrations/apply.js 018_review_avatar.sql

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS avatar_url TEXT;
