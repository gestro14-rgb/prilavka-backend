-- Флаг "товар является набором с кастомизируемым составом"
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT false;

-- Состав набора: нормализованные позиции для кастомизации в мини-приложении.
-- Отдельно от products.composition (JSONB), который используется для ценовой разбивки.
CREATE TABLE IF NOT EXISTS набор_состав (
  id          SERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  item_name   TEXT NOT NULL,
  item_emoji  VARCHAR(8) NOT NULL DEFAULT '',
  alternatives JSONB NOT NULL DEFAULT '[]',
  is_removable BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_набор_состав_product_id ON набор_состав (product_id, sort_order);
