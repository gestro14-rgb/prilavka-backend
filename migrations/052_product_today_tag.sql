-- Цветная плашка-тег для секции «Сегодня особенно хорошее 🍓» на Главной:
-- короткое утверждение о вкусе или текстуре конкретного товара («Сладкая!»,
-- «Хрустящие», «Мягкие»).
--
-- Два НОВЫХ поля, а не переиспользование badge_type/badge_label/badge_color:
-- бейдж — это статус товара в ассортименте (Хит / Выгодно / Чаще берут), с
-- фиксированным списком типов и своим местом поверх фото. Тег — про сам
-- продукт, и оси независимы: черешня может быть одновременно «Хит» и
-- «Сладкая!». Складывать их в одно поле значило бы заставлять админа
-- выбирать между двумя разными сообщениями.
--
-- tag_color хранит ИМЯ ПРЕСЕТА ('green' | 'orange' | 'ochre' | 'berry'), а не
-- hex — прямой урок badge_color: туда за годы налили произвольных тёмно-
-- зелёных оттенков, пилюли на карточках стали выглядеть по-разному, и фронт
-- в итоге вынужден это поле игнорировать (см. комментарий в Badge.jsx).
-- Пресет фронт разворачивает в пару фон/текст из палитры (см. TAG_COLORS в
-- ProductCard.jsx), поэтому палитра остаётся целой при любом содержимом
-- колонки. Пусто или неизвестное значение → 'green'.
--
-- Оба поля nullable, без дефолта: пусто → у товара нет тега и в секции он
-- не участвует (ровно как пустой home_video_url означает «набор не в hero»).
--
-- Секцию курирует существующая таблица home_product_shelves со
-- shelf = 'special' — той же ручкой, что уже управляет «Сейчас в сезоне»
-- (shelf='seasonal') и «Хитами недели» (shelf='hits'), новой таблицы не
-- нужно. Пустая подборка — не ошибка: фронт сам возьмёт все активные товары
-- не-наборы с непустым tag_label (см. specialProducts в Home.jsx).
--
-- Применить: node migrations/apply.js 052_product_today_tag.sql

BEGIN;

ALTER TABLE products ADD COLUMN IF NOT EXISTS tag_label TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tag_color TEXT;

-- Заголовок секции — тем же механизмом settings, что и «Сейчас в сезоне»
-- (migrations/024), чтобы менять его можно было без деплоя.
INSERT INTO settings (key, value, description) VALUES
  ('home_special_title', 'Сегодня особенно хорошее 🍓', 'Заголовок блока «Сегодня особенно хорошее» на Главной')
ON CONFLICT (key) DO NOTHING;

-- Стартовые теги. Каждый — цитата из описания САМОГО товара (products.
-- composition), а не придуманный копирайт: «Сладкая!» стоит у черешни,
-- потому что в её описании написано «с медовой сладостью». Утверждений,
-- которые нельзя проверить по данным, здесь нет намеренно — в частности
-- «Только привезли»: это про логистику конкретного дня, такой тег админ
-- ставит руками тогда, когда это правда.
--
-- WHERE tag_label IS NULL — миграция идемпотентна не только по DDL:
-- повторный прогон не затрёт тег, который к тому времени поправили руками
-- в админке.
UPDATE products SET tag_label = 'Сладкая!',   tag_color = 'berry'  WHERE id = 'chereshnya-1782676306030'      AND tag_label IS NULL;
UPDATE products SET tag_label = 'Медовые',    tag_color = 'ochre'  WHERE id = 'abrikosy-1782676305987'         AND tag_label IS NULL;
UPDATE products SET tag_label = 'Хрустящие',  tag_color = 'green'  WHERE id = 'ogurtsy-lukhovitskie-1782676306082' AND tag_label IS NULL;
UPDATE products SET tag_label = 'Сочная',     tag_color = 'orange' WHERE id = 'morkov-1782676064392'           AND tag_label IS NULL;
UPDATE products SET tag_label = 'Мягкие',     tag_color = 'ochre'  WHERE id = 'baklazhany-nezhnye-1782676064116' AND tag_label IS NULL;
UPDATE products SET tag_label = 'Хрустящий',  tag_color = 'green'  WHERE id = 'salat-romano-1782676064105'      AND tag_label IS NULL;
UPDATE products SET tag_label = 'Сладкие',    tag_color = 'berry'  WHERE id = 'pomidor-sort-paradayz-1782676064331' AND tag_label IS NULL;
UPDATE products SET tag_label = 'Без горечи', tag_color = 'green'  WHERE id = 'luk-yaltinskiy-1782676063988'    AND tag_label IS NULL;

COMMIT;
