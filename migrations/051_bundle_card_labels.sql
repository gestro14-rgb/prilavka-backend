-- Короткая ситуативная подпись для витринных карточек наборов (задача 10
-- воронки: "На 1-2 человека — на несколько дней" вместо "Набор семейный на
-- неделю (3-4 чел)").
--
-- Три НОВЫХ поля, а не переименование title/weight: title используется в
-- чеке заказа, поиске каталога и истории "Уже заказывали" (Profile) — там
-- нужна точность, а не короткая витринная форма. weight — вес в кг для
-- админки/логистики, семантически другое поле. card_emoji — тоже отдельно
-- от существующего emoji (тот — заглушка-иконка на случай отсутствия фото).
--
-- Все три nullable, без дефолта: пусто → фронт показывает title/weight, как
-- до этой миграции (см. toProductDTO в server.js). Заполняются точечно
-- через админку только для наборов (category='bundles') — для остального
-- каталога это поле не имеет смысла и останется NULL всегда.
--
-- Применить: node migrations/apply.js 051_bundle_card_labels.sql

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS card_emoji    TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS card_title    TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS card_subtitle TEXT;

COMMIT;
