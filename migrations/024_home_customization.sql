-- Редактируемое содержимое Главной страницы — без правки кода.
--
-- 1) products.home_image_url — отдельная картинка для блока "Готовые наборы"
--    на Главной, независимая от products.image_url (карточка/страница
--    товара). Пусто → на Главной используется image_url как раньше.
--
-- 2) deliveries.image_url — фото для "Последние доставки". Пусто → эмодзи
--    как раньше (существующие записи не ломаются).
--
-- 3) home_product_shelves — ручная подборка + порядок товаров для витрин
--    "Хиты недели" (shelf='hits') и "Сейчас в сезоне" (shelf='seasonal').
--    Один товар не может быть добавлен в одну и ту же витрину дважды
--    (UNIQUE). ON DELETE CASCADE — удалённый товар сам вычищается из всех
--    витрин, не оставляя висячих ссылок.
--    Пустая витрина (нет строк с данным shelf) — НЕ ошибка и не "сломанная
--    Главная": фронт в этом случае возвращается к прежнему автоподбору по
--    badge_type ('hit'/'eco'/'seasonal'), см. Home.jsx. Ручная подборка
--    имеет приоритет только когда в ней есть хотя бы один товар.
--
-- 4) settings: заголовок/подзаголовок блока "Сейчас в сезоне" — тот же
--    общий механизм key/value, что и остальные настройки.
--
-- Применить: node migrations/apply.js 024_home_customization.sql

ALTER TABLE products ADD COLUMN IF NOT EXISTS home_image_url TEXT;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS image_url TEXT;

CREATE TABLE IF NOT EXISTS home_product_shelves (
  id SERIAL PRIMARY KEY,
  shelf TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shelf, product_id)
);

CREATE INDEX IF NOT EXISTS idx_home_product_shelves_shelf ON home_product_shelves (shelf, sort_order);

INSERT INTO settings (key, value, description) VALUES
  ('home_seasonal_title',    'Сейчас в сезоне', 'Заголовок блока «Сейчас в сезоне» на Главной'),
  ('home_seasonal_subtitle', '',                'Подзаголовок блока «Сейчас в сезоне» на Главной (необязательно)')
ON CONFLICT (key) DO NOTHING;
