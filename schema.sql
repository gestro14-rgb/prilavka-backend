-- Схема базы данных "Прилавка"

-- Категории товаров
CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Товары
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price INTEGER NOT NULL,
  weight TEXT NOT NULL,
  emoji TEXT NOT NULL,
  bg TEXT NOT NULL,
  category TEXT NOT NULL REFERENCES categories(id),
  badge_type TEXT,
  badge_label TEXT,
  composition JSONB NOT NULL DEFAULT '[]',
  suppliers JSONB NOT NULL DEFAULT '[]',
  pricing JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отзывы (для главной страницы)
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  area TEXT NOT NULL,
  stars INTEGER NOT NULL DEFAULT 5,
  text TEXT NOT NULL,
  emoji TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Последние доставки (для главной страницы)
CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  emoji TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

-- Администраторы (для админки)
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Зоны доставки (полигоны на карте)
-- coordinates: массив точек [[lat, lng], [lat, lng], ...] — задаёт замкнутый многоугольник
CREATE TABLE IF NOT EXISTS delivery_zones (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  coordinates JSONB NOT NULL DEFAULT '[]',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  items JSONB NOT NULL DEFAULT '[]',
  total INTEGER NOT NULL,
  delivery_date JSONB,
  delivery_slot TEXT,
  address_street TEXT,
  address_details JSONB,
  comment TEXT,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payment_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'new',
  promo_code TEXT,
  discount_amount INTEGER NOT NULL DEFAULT 0,
  telegram_user_id BIGINT,
  telegram_username TEXT,
  telegram_first_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Промокоды
-- discount_type: 'fixed' (скидка в рублях) или 'percent' (скидка в процентах)
CREATE TABLE IF NOT EXISTS promo_codes (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'fixed',
  discount_value INTEGER NOT NULL,
  min_order_total INTEGER NOT NULL DEFAULT 0,
  is_used BOOLEAN NOT NULL DEFAULT false,
  used_at TIMESTAMPTZ,
  used_by_telegram_id BIGINT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
