-- Сторис-карточки на Главной — горизонтальная лента над блоком "Честная
-- цена": обложка + иконка play + длительность видео + опциональный бейдж
-- статуса, заголовок и цена под картинкой.
--
-- Видео и обложки лежат в S3-совместимом хранилище Selectel (бакет
-- prilavka-stories, публичный на чтение), НЕ в Cloudinary как остальные
-- картинки проекта: видео тяжёлое, гонять его через бэкенд-прокси
-- (/api/admin/upload-image) незачем — админка грузит файл напрямую в S3 по
-- presigned PUT-ссылке, а сюда попадает уже готовый публичный URL.
--
-- product_id — опциональная связь с товаром: на Главной сейчас не
-- используется (тап по карточке — заглушка), пригодится на странице
-- просмотра видео. ON DELETE SET NULL, а не CASCADE: удаление товара не
-- должно молча уносить снятое видео — карточка останется, просто без
-- привязки.
--
-- duration_seconds заполняется вручную в админке — автоопределение
-- длительности на бэкенде требует ffmpeg, на этом шаге его не делаем.
--
-- cover_image_url/video_url nullable: карточку можно создать до того, как
-- загрузятся файлы (загрузка идёт отдельным шагом после создания записи).
--
-- Применить: node migrations/apply.js 047_story_cards.sql

CREATE TABLE IF NOT EXISTS story_cards (
  id               SERIAL PRIMARY KEY,
  title            TEXT NOT NULL,
  price_label      TEXT NOT NULL DEFAULT '',
  cover_image_url  TEXT,
  video_url        TEXT,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  badge_text       TEXT,
  product_id       TEXT REFERENCES products(id) ON DELETE SET NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Публичная выборка на Главной — всегда "активные, по sort_order".
CREATE INDEX IF NOT EXISTS idx_story_cards_active ON story_cards (is_active, sort_order);
