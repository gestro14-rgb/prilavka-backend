-- У наград (rewards) не было поля под фото — RewardCard.jsx (prilavka-app)
-- всегда рендерил emoji-заглушку, потому что показывать было больше нечего,
-- не потому что код игнорировал реальные данные. image_url — тот же паттерн,
-- что уже есть у products (004), reviews (005), deliveries (024): nullable,
-- emoji остаётся как обязательный fallback на карточке, пока фото не загружено.
--
-- Применить: node migrations/apply.js 029_reward_image.sql

ALTER TABLE rewards ADD COLUMN IF NOT EXISTS image_url TEXT;
