-- Условия вознаграждения партнёра: сколько за первый заказ, сколько за
-- повторные и как долго действует привязка клиента.
--
-- Поля кладутся прямо в partners, а не в отдельную таблицу: связь строго
-- 1:1, а версионирование условий не нужно — сумма ложится СНИМКОМ в
-- partner_transactions.amount в момент начисления, поэтому изменение правил
-- физически не может пересчитать уже начисленное. Отдельная таблица
-- versioning добавила бы join к каждому начислению ради свойства, которое
-- модель уже обеспечивает.
--
-- Миграция 061 завела две заготовки под эти же условия (first_order_reward,
-- repeat_order_percent). Они всюду NULL и ничем не читаются, поэтому здесь
-- ПЕРЕИМЕНОВЫВАЮТСЯ в итоговые имена, а не дублируются новыми колонками:
-- два набора полей под одно и то же — это два источника истины.

-- ── Вознаграждение за первый заказ ───────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'partners' AND column_name = 'first_order_reward')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'partners' AND column_name = 'first_order_reward_amount') THEN
    ALTER TABLE partners RENAME COLUMN first_order_reward TO first_order_reward_amount;
  END IF;
END $$;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS first_order_reward_amount NUMERIC(12,2);
-- Заготовка была INTEGER и вся из NULL: приводим тип и закрываем пустоты
-- нулём ДО NOT NULL, иначе ALTER упадёт на существующих строках.
ALTER TABLE partners ALTER COLUMN first_order_reward_amount TYPE NUMERIC(12,2);
UPDATE partners SET first_order_reward_amount = 0 WHERE first_order_reward_amount IS NULL;
ALTER TABLE partners ALTER COLUMN first_order_reward_amount SET DEFAULT 0;
ALTER TABLE partners ALTER COLUMN first_order_reward_amount SET NOT NULL;

-- ── Вознаграждение за повторные заказы ───────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'partners' AND column_name = 'repeat_order_percent')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'partners' AND column_name = 'repeat_reward_value') THEN
    ALTER TABLE partners RENAME COLUMN repeat_order_percent TO repeat_reward_value;
  END IF;
END $$;

ALTER TABLE partners ADD COLUMN IF NOT EXISTS repeat_reward_value NUMERIC(12,2);
ALTER TABLE partners ALTER COLUMN repeat_reward_value TYPE NUMERIC(12,2);
UPDATE partners SET repeat_reward_value = 0 WHERE repeat_reward_value IS NULL;
ALTER TABLE partners ALTER COLUMN repeat_reward_value SET DEFAULT 0;
ALTER TABLE partners ALTER COLUMN repeat_reward_value SET NOT NULL;

-- 'percentage' — repeat_reward_value читается как проценты от суммы заказа,
-- 'fixed' — как рубли за каждый повторный заказ. Значение одно, смысл задаёт
-- тип: две отдельные колонки пришлось бы держать взаимно пустыми.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS repeat_reward_type TEXT;
UPDATE partners SET repeat_reward_type = 'percentage' WHERE repeat_reward_type IS NULL;
ALTER TABLE partners ALTER COLUMN repeat_reward_type SET DEFAULT 'percentage';
ALTER TABLE partners ALTER COLUMN repeat_reward_type SET NOT NULL;

-- ── Срок действия привязки ───────────────────────────────────────────────
-- NULL = без ограничения. Это не «не заполнено»: ноль здесь был бы
-- бессмысленным (привязка, истекающая мгновенно), поэтому CHECK требует > 0.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS attribution_duration_months INTEGER;

-- ── Выключатель ──────────────────────────────────────────────────────────
-- По умолчанию ВЫКЛЮЧЕНО. Партнёр, заведённый до этой миграции, не должен
-- внезапно начать получать деньги оттого, что появилась механика: условия
-- сначала настраивают руками, потом включают.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS reward_enabled BOOLEAN;
UPDATE partners SET reward_enabled = false WHERE reward_enabled IS NULL;
ALTER TABLE partners ALTER COLUMN reward_enabled SET DEFAULT false;
ALTER TABLE partners ALTER COLUMN reward_enabled SET NOT NULL;

-- ── Ограничения ──────────────────────────────────────────────────────────
-- Добавляются отдельно и идемпотентно: ADD CONSTRAINT IF NOT EXISTS в
-- Postgres нет, поэтому проверяем по pg_constraint.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_first_order_reward_amount_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_first_order_reward_amount_check
      CHECK (first_order_reward_amount >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_repeat_reward_type_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_repeat_reward_type_check
      CHECK (repeat_reward_type IN ('percentage', 'fixed'));
  END IF;
  -- Процент ограничен сотней на уровне БД, а не только формы: 500% с
  -- опечатки увели бы партнёру больше, чем стоит заказ.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_repeat_reward_value_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_repeat_reward_value_check
      CHECK (repeat_reward_value >= 0
             AND (repeat_reward_type <> 'percentage' OR repeat_reward_value <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'partners_attribution_duration_check') THEN
    ALTER TABLE partners ADD CONSTRAINT partners_attribution_duration_check
      CHECK (attribution_duration_months IS NULL OR attribution_duration_months > 0);
  END IF;
END $$;

-- Старые CHECK от заготовок 061 больше не на что смотреть — их колонки
-- переименованы, а условия заменены проверками выше.
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_first_order_reward_check;
ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_repeat_order_percent_check;
