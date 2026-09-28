-- Партнёрская программа: партнёр делится ссылкой, приведённый клиент
-- закрепляется за ним навсегда, по его заказам позже начисляется
-- вознаграждение.
--
-- Финансовая формула (300 ₽ за первый заказ, % с повторных) СОЗНАТЕЛЬНО не
-- включена: схема готова её принять, но ни одна строка partner_transactions
-- автоматически пока не создаётся. Поля под условия начислений заведены в
-- partners и в UI не показываются, пока не используются.
--
-- Деньги везде целые рубли — как orders.total и products.price в остальном
-- проекте. Заводить копейки только здесь значило бы держать два разных
-- представления денег в одной базе.

-- ── Партнёры ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  -- Telegram-аккаунт партнёра. Nullable: админ заводит партнёра по имени и
  -- username, а числовой id может узнать позже. Пока он пустой, партнёр
  -- существует и его ссылка работает — недоступен только личный кабинет
  -- (GET /api/partner/me сопоставляет именно по этому полю).
  telegram_user_id BIGINT,
  telegram_username TEXT,
  -- Короткий токен ссылки без префикса: в t.me/<бот>?start=p_anna здесь
  -- лежит "anna". Префикс p_ добавляется при сборке ссылки и снимается при
  -- разборе — хранить его в каждой строке незачем.
  referral_slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  -- Условия начислений на будущее. NULL = «правило ещё не задано», и это не
  -- то же самое, что 0: ноль был бы осознанным «не платим».
  first_order_reward INTEGER CHECK (first_order_reward IS NULL OR first_order_reward >= 0),
  repeat_order_percent NUMERIC CHECK (repeat_order_percent IS NULL OR repeat_order_percent >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Тот же алфавит, что разрешает Telegram в start-payload ([A-Za-z0-9_-],
  -- до 64 символов), плюс нижний регистр. Префиксы ref_ и u_ запрещены
  -- явно: их уже занимают реферальная программа клиент→клиент и utm-метки
  -- (см. parseStartPayload в server.js), и пересечение сделало бы разбор
  -- payload неоднозначным.
  CONSTRAINT partners_referral_slug_format CHECK (
    referral_slug ~ '^[a-z0-9][a-z0-9_-]{1,31}$'
    AND referral_slug !~ '^(ref_|u_|p_)'
  )
);

-- Регистр в slug не значащий: Anna и anna — одна и та же ссылка.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_referral_slug ON partners (lower(referral_slug));
-- Частичный: незаполненный telegram_user_id не должен конфликтовать с другим
-- таким же незаполненным.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_telegram_user_id
  ON partners (telegram_user_id) WHERE telegram_user_id IS NOT NULL;

-- ── Закрепление клиента за партнёром ─────────────────────────────────────
-- Ключ — telegram_user_id, а НЕ users.id, и это принципиально: переход по
-- ссылке приходит в /start, когда строки в users ещё обычно нет (она
-- появляется при первом открытии приложения или заказе). Ровно по той же
-- причине в проекте уже есть start_attributions с ключом telegram_id.
-- customer_id дозаполняется, как только пользователь появится.
CREATE TABLE IF NOT EXISTS partner_referrals (
  id SERIAL PRIMARY KEY,
  -- RESTRICT, а не CASCADE: партнёра не удаляют, его переводят в inactive.
  -- История приведённых клиентов не должна исчезать вместе с ним.
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  telegram_user_id BIGINT NOT NULL,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'start_link',
  referred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_order_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- FIRST PARTNER WINS живёт здесь, в ограничении БД, а не в коде: повторный
-- переход по чужой ссылке упирается в уникальность и ничего не перезаписывает,
-- даже если логика выше однажды ошибётся.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_referrals_telegram_user_id
  ON partner_referrals (telegram_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_referrals_customer_id
  ON partner_referrals (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_partner_referrals_partner_id ON partner_referrals (partner_id);

-- ── Начисления ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partner_transactions (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  customer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  type TEXT NOT NULL CHECK (type IN (
    'referral_first_order', 'repeat_order', 'manual_adjustment', 'payout', 'correction'
  )),
  -- Знаковая: выплата и отрицательная корректировка уменьшают баланс.
  -- Баланс = сумма строк, а не отдельно хранимое число, которое пришлось бы
  -- держать согласованным.
  amount INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'available', 'paid', 'cancelled')),
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_transactions_partner_id ON partner_transactions (partner_id);
CREATE INDEX IF NOT EXISTS idx_partner_transactions_order_id ON partner_transactions (order_id);
-- Защита от двойного начисления по одному заказу — тот же приём, что у
-- referral_rewards.order_id в реферальной программе клиент→клиент. Ручные
-- корректировки и выплаты под него не попадают: у них order_id пустой.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_transactions_order_type
  ON partner_transactions (order_id, type) WHERE order_id IS NOT NULL;

-- ── Запросы на выплату ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS partner_payout_requests (
  id SERIAL PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE RESTRICT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'paid', 'rejected')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  admin_comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_partner_payout_requests_partner_id
  ON partner_payout_requests (partner_id);
-- Второй незакрытый запрос копил бы двойную сумму к выплате.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_payout_requests_open
  ON partner_payout_requests (partner_id) WHERE status IN ('requested', 'approved');
