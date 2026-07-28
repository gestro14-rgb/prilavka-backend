-- Управляемые из админки иконки статичных мест интерфейса. Раньше эмодзи
-- (или в двух случаях — линейная SVG-иконка из Icons.jsx) были зашиты прямо
-- в JSX; теперь админ может подменить их картинкой через ImageUploadField,
-- не трогая код.
--
-- fallback_emoji — что показывать, если картинка не загружена. Для
-- profile_section_address и profile_section_orders сейчас в интерфейсе не
-- эмодзи, а линейные SVG-иконки IconPin/IconBag (общая иконка-библиотека
-- приложения) — их нельзя положить в TEXT-колонку, поэтому fallback_emoji
-- для них NULL, а запасной вариант — сама SVG-иконка, зашитая на фронте как
-- проп fallback у SectionIcon (см. prilavka-app/src/SectionIcon.jsx).
--
-- Применить: node migrations/apply.js 039_ui_icons.sql

CREATE TABLE IF NOT EXISTS ui_icons (
  key TEXT PRIMARY KEY,
  image_url TEXT,
  fallback_emoji TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO ui_icons (key, fallback_emoji) VALUES
  ('profile_section_other', '⚙️'),
  ('profile_section_delivery', '🚚'),
  ('profile_section_contacts', '💬'),
  ('profile_section_address', NULL),
  ('profile_section_orders', NULL)
ON CONFLICT (key) DO NOTHING;
