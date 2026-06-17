CREATE TABLE IF NOT EXISTS delivery_schedule (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL UNIQUE,
  is_available BOOLEAN NOT NULL DEFAULT true,
  slot TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
