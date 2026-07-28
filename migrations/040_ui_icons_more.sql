-- Расширение ui_icons (см. 039_ui_icons.sql) — ещё 9 управляемых мест:
-- индикатор адреса на Главной, две строки в разделе "Прочее" Профиля,
-- иконка внутри карточки адреса в Профиле, и 5 строк на странице About.
--
-- home_address_indicator сейчас вообще не эмодзи, а чистая CSS-точка
-- (span с background, без текстового содержимого) — фолбэка в виде эмодзи
-- для неё нет, поэтому fallback_emoji = NULL, а запасной вариант — сама эта
-- точка, зашитая на фронте как проп fallback у SectionIcon (см.
-- prilavka-app/src/Home.jsx).
--
-- Применить: node migrations/apply.js 040_ui_icons_more.sql

INSERT INTO ui_icons (key, fallback_emoji) VALUES
  ('home_address_indicator', NULL),
  ('profile_row_write_to_us', '💬'),
  ('profile_row_about', '🌿'),
  ('profile_address_card_icon', '🏠'),
  ('about_row_delivery_zone', '📍'),
  ('about_row_delivery_time', '🕒'),
  ('about_row_packaging', '📦'),
  ('about_row_payment', '💳'),
  ('about_row_telegram_contact', '✈️')
ON CONFLICT (key) DO NOTHING;
