CREATE TABLE IF NOT EXISTS districts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO districts (name, sort_order) VALUES
  ('Теплый Стан',       1),
  ('Коньково',          2),
  ('Ясенево',           3),
  ('Новоясеневская',    4),
  ('Беляево',           5),
  ('Генерала Тюленева', 6),
  ('Тютчевская',        7),
  ('Тропарево',         8),
  ('Коммунарка',        9)
ON CONFLICT DO NOTHING;
