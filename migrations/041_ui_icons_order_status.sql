-- Расширение ui_icons (см. 039_ui_icons.sql, 040_ui_icons_more.sql) — иконки
-- статуса в строке заказа на экране "Мои заказы" в Профиле: галочка для
-- доставленных заказов и сумка для активных.
--
-- Оба сейчас не эмодзи, а линейные SVG-иконки (IconCheck/IconBag) — как и
-- profile_section_address/orders, fallback_emoji = NULL, запасной вариант —
-- сама SVG-иконка, зашитая на фронте как проп fallback у SectionIcon (см.
-- prilavka-app/src/Profile.jsx, orderRowIcon()).
--
-- Применить: node migrations/apply.js 041_ui_icons_order_status.sql

INSERT INTO ui_icons (key, fallback_emoji) VALUES
  ('profile_order_status_delivered', NULL),
  ('profile_order_status_active', NULL)
ON CONFLICT (key) DO NOTHING;
