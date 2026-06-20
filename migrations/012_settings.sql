CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT
);

INSERT INTO settings (key, value, description) VALUES
  ('min_order_total',          '1990',       'Минимальная сумма заказа (₽)'),
  ('points_percent',           '5',          'Процент баллов от суммы заказа (%)'),
  ('referral_points_reward',   '100',        'Баллы за первый заказ приглашённого друга'),
  ('referral_discount',        '200',        'Скидка по реферальному коду (₽)'),
  ('max_points_spend_percent', '30',         'Макс. % суммы заказа для оплаты баллами'),
  ('default_slot',             '18:00–21:00','Стандартное время доставки');
