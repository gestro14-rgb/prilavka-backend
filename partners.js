// Партнёрская программа: партнёрский кабинет и админские ручки.
//
// Вынесено из server.js отдельным модулем, а не дописано в конец: монолит и
// так 5900 строк. Полного разбиения на роутеры при этом не делаю — это была
// бы отдельная задача с другим радиусом поражения.
//
// Зависимости приходят параметром, а не импортом из server.js: иначе два
// файла импортировали бы друг друга. Тот же query/pool и те же самые
// resolveUser/requireAuth, что у остального API — своей авторизации у
// партнёрки нет и быть не должно.
import express from 'express';

// ── Ссылка партнёра ──────────────────────────────────────────────────────
//
// Префикс p_ рядом с уже занятыми ref_ (реферальная программа клиент→клиент)
// и u_ (utm-метки) — см. parseStartPayload в server.js. Голые токены
// оставлены свободными намеренно, под то, что появится позже.
export const PARTNER_START_PREFIX = 'p_';

// Разбирает payload диплинка в slug партнёра. null — это не партнёрская
// ссылка, и это нормальный случай, а не ошибка.
export function parsePartnerStartPayload(payload) {
  if (!payload || typeof payload !== 'string') return null;
  const m = /^p_([a-z0-9][a-z0-9_-]{1,31})$/i.exec(payload.trim());
  return m ? m[1].toLowerCase() : null;
}

// Slug нормализуем к тому же виду, что проверяет CHECK в миграции 061:
// нижний регистр, латиница/цифры/подчёркивание/дефис, первый символ —
// буква или цифра. Кириллица и пробелы из имени превращаются в дефисы, а не
// молча выбрасываются: «Анна Петрова» иначе дала бы пустой slug.
export function normalizeSlug(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32);
}

export function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9_-]{1,31}$/.test(slug) && !/^(ref_|u_|p_)/.test(slug);
}

// ── Модуль ───────────────────────────────────────────────────────────────
//
// getBotUsername — функция, а не строка: username бота выясняется асинхронно
// через getMe уже после старта, и захваченное значение протухло бы.
export function createPartnerRoutes({ query, pool, resolveUser, requireAuth, getBotUsername }) {
  const router = express.Router();

  const referralLink = (slug) =>
    `https://t.me/${getBotUsername()}?start=${PARTNER_START_PREFIX}${slug}`;

  // Наружу партнёру — только то, что он и так про себя знает. Условия
  // начислений, внутренние id клиентов и служебные поля сюда не попадают.
  const toPartnerDTO = (row) => ({
    id: row.id,
    name: row.name,
    username: row.telegram_username || null,
    referralSlug: row.referral_slug,
    referralLink: referralLink(row.referral_slug),
    status: row.status,
  });

  // ── Статистика ─────────────────────────────────────────────────────────
  //
  // Один запрос вместо четырёх: заказы приведённых клиентов достаются через
  // связь partner_referrals → users → orders, без partner_id в orders.
  //
  // Отменённые заказы исключены везде, где речь про «сделал заказ»: клиент,
  // чей единственный заказ отменён, не считается ни активным, ни принёсшим
  // заказ. Для самого факта привлечения это неважно — он уже случился.
  const STATS_SQL = `
    WITH refs AS (
      SELECT pr.customer_id
        FROM partner_referrals pr
       WHERE pr.partner_id = $1 AND pr.status = 'active'
    ),
    ord AS (
      SELECT o.user_id, o.id, o.total, o.created_at
        FROM orders o
        JOIN refs ON refs.customer_id = o.user_id
       WHERE o.status <> 'cancelled'
    )
    SELECT
      (SELECT COUNT(*)::int FROM refs)                                AS customers,
      (SELECT COUNT(DISTINCT user_id)::int FROM ord)                  AS customers_with_order,
      (SELECT COUNT(*)::int FROM ord)                                 AS orders_count,
      (SELECT COALESCE(SUM(total), 0)::int FROM ord)                  AS orders_total,
      COALESCE((SELECT SUM(amount)::int FROM partner_transactions
                 WHERE partner_id = $1 AND status IN ('available', 'paid')), 0) AS earned,
      COALESCE((SELECT SUM(amount)::int FROM partner_transactions
                 WHERE partner_id = $1 AND status = 'available'), 0)  AS available,
      COALESCE((SELECT SUM(amount)::int FROM partner_transactions
                 WHERE partner_id = $1 AND status = 'pending'), 0)    AS pending
  `;

  async function loadStats(partnerId) {
    const r = await query(STATS_SQL, [partnerId]);
    const s = r.rows[0];
    return {
      customers: s.customers,
      customersWithOrder: s.customers_with_order,
      orders: s.orders_count,
      ordersTotal: s.orders_total,
      earned: s.earned,
      available: s.available,
      pending: s.pending,
    };
  }

  // ── Атрибуция ──────────────────────────────────────────────────────────
  //
  // Вызывается из /telegram-webhook, когда пришёл /start p_<slug>. Возвращает
  // партнёра, если ссылка партнёрская и валидная, иначе null — вызывающая
  // сторона по этому признаку решает, показывать ли кнопку кабинета.
  //
  // Ничего не бросает наружу: сорванная атрибуция не должна мешать человеку
  // начать пользоваться ботом.
  async function attributeReferral(payload, telegramUserId) {
    const slug = parsePartnerStartPayload(payload);
    if (!slug || !telegramUserId) return null;
    try {
      const pRes = await query(
        'SELECT * FROM partners WHERE lower(referral_slug) = $1',
        [slug]
      );
      const partner = pRes.rows[0];
      // Несуществующий slug — просто обычное открытие Прилавки.
      if (!partner) return null;
      // Неактивный партнёр новых клиентов не закрепляет. Уже закреплённые
      // за ним остаются — их связь трогать нельзя.
      if (partner.status !== 'active') return null;
      // Переход по собственной ссылке рефералом не является.
      if (partner.telegram_user_id != null &&
          String(partner.telegram_user_id) === String(telegramUserId)) {
        return partner;
      }

      // FIRST PARTNER WINS: DO NOTHING оставляет существующую связь как есть,
      // кем бы ни был новый партнёр. Повторный переход по той же ссылке тоже
      // сюда попадает и тоже ничего не меняет — дубля не будет.
      await query(
        `INSERT INTO partner_referrals (partner_id, telegram_user_id, customer_id, source)
         VALUES ($1, $2, (SELECT id FROM users WHERE telegram_id = $2), 'start_link')
         ON CONFLICT (telegram_user_id) DO NOTHING`,
        [partner.id, telegramUserId]
      );
      return partner;
    } catch (e) {
      console.error('attributeReferral:', e);
      return null;
    }
  }

  // Достраивает customer_id, когда строка пользователя наконец появилась.
  // Вызывается из upsertUser. Связь к этому моменту уже создана в /start.
  async function linkCustomer(telegramUserId, customerId) {
    if (!telegramUserId || !customerId) return;
    try {
      await query(
        `UPDATE partner_referrals SET customer_id = $2, updated_at = now()
          WHERE telegram_user_id = $1 AND customer_id IS NULL`,
        [telegramUserId, customerId]
      );
    } catch (e) {
      console.error('linkCustomer:', e);
    }
  }

  // Активный партнёр по Telegram-id — нужен и /start (вторая кнопка), и
  // middleware ниже.
  async function findActivePartnerByTelegramId(telegramUserId) {
    if (!telegramUserId) return null;
    const r = await query(
      "SELECT * FROM partners WHERE telegram_user_id = $1 AND status = 'active'",
      [telegramUserId]
    );
    return r.rows[0] || null;
  }

  // ── Доступ ─────────────────────────────────────────────────────────────
  //
  // Личность — из resolveUser (проверенная подпись initData или JWT), а не из
  // тела запроса. Обычный покупатель получает 403 и ничего больше: ни
  // подсказки, что партнёрка существует, ни чужих данных.
  async function requirePartner(req, res, next) {
    try {
      const partner = await findActivePartnerByTelegramId(req.telegramId);
      if (!partner) return res.status(403).json({ error: 'Нет доступа' });
      req.partner = partner;
      next();
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  }

  // ── Кабинет партнёра ───────────────────────────────────────────────────

  // Единственная ручка, которую зовёт не-партнёр: по ней мини-апп решает,
  // показывать ли вход в кабинет. Поэтому здесь 200 + isPartner:false, а не
  // 403 — это не отказ в доступе, а ответ на вопрос.
  router.get('/me', resolveUser, async (req, res) => {
    try {
      const partner = await findActivePartnerByTelegramId(req.telegramId);
      if (!partner) return res.json({ isPartner: false });
      res.json({ isPartner: true, partner: toPartnerDTO(partner) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  router.get('/dashboard', resolveUser, requirePartner, async (req, res) => {
    try {
      res.json({ partner: toPartnerDTO(req.partner), stats: await loadStats(req.partner.id) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  router.get('/stats', resolveUser, requirePartner, async (req, res) => {
    try {
      const stats = await loadStats(req.partner.id);
      // Помесячный ряд для простых столбиков на экране статистики. Считаем
      // по заказам приведённых клиентов: начислений пока нет, а показать
      // пустой график — хуже, чем показать реальную активность.
      const series = await query(
        `SELECT to_char(date_trunc('month', o.created_at), 'YYYY-MM') AS month,
                COUNT(*)::int AS orders,
                COALESCE(SUM(o.total), 0)::int AS total
           FROM orders o
           JOIN partner_referrals pr ON pr.customer_id = o.user_id
          WHERE pr.partner_id = $1 AND pr.status = 'active' AND o.status <> 'cancelled'
            AND o.created_at > now() - interval '6 months'
          GROUP BY 1 ORDER BY 1`,
        [req.partner.id]
      );
      res.json({ stats, series: series.rows });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  router.get('/transactions', resolveUser, requirePartner, async (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    try {
      const r = await query(
        `SELECT id, type, amount, status, description, order_id, customer_id, created_at
           FROM partner_transactions WHERE partner_id = $1
          ORDER BY id DESC LIMIT $2 OFFSET $3`,
        [req.partner.id, limit + 1, offset]
      );
      const hasMore = r.rows.length > limit;
      res.json({
        transactions: r.rows.slice(0, limit).map((t) => ({
          id: t.id,
          type: t.type,
          amount: t.amount,
          status: t.status,
          description: t.description,
          orderId: t.order_id,
          // Клиента партнёр видит только обезличенно: ни имени, ни телефона,
          // ни адреса, ни username. Номер — это users.id, он и так не
          // персональные данные, но больше ничего отдавать нельзя.
          customerLabel: t.customer_id ? `Клиент №${t.customer_id}` : null,
          createdAt: t.created_at,
        })),
        hasMore,
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  // Заявка на выплату. Сумму назначает сервер, а не клиент: запросить больше
  // доступного нельзя в принципе, потому что запрашиваемого числа в запросе
  // просто нет.
  router.post('/payout-request', resolveUser, requirePartner, async (req, res) => {
    try {
      const { available } = await loadStats(req.partner.id);
      if (available <= 0) {
        return res.status(400).json({ error: 'Пока нет доступных средств' });
      }
      const r = await query(
        `INSERT INTO partner_payout_requests (partner_id, amount) VALUES ($1, $2)
         RETURNING id, amount, status, requested_at`,
        [req.partner.id, available]
      );
      res.status(201).json(r.rows[0]);
    } catch (e) {
      // Частичный уникальный индекс не даёт завести второй незакрытый запрос.
      if (e.code === '23505') {
        return res.status(409).json({ error: 'Заявка на выплату уже создана' });
      }
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  // ── Админские ручки ────────────────────────────────────────────────────
  const adminRouter = express.Router();

  // Админу — с агрегатами, но без N+1: статистика по всем партнёрам считается
  // одним запросом с LEFT JOIN LATERAL.
  adminRouter.get('/', requireAuth, async (req, res) => {
    const { status, q } = req.query;
    const params = [];
    const where = [];
    if (status === 'active' || status === 'inactive') {
      params.push(status);
      where.push(`p.status = $${params.length}`);
    }
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      where.push(`(lower(p.name) LIKE $${params.length}
                OR lower(coalesce(p.telegram_username, '')) LIKE $${params.length}
                OR lower(p.referral_slug) LIKE $${params.length})`);
    }
    try {
      const r = await query(
        `SELECT p.*, s.*
           FROM partners p
           LEFT JOIN LATERAL (
             SELECT
               (SELECT COUNT(*)::int FROM partner_referrals pr
                 WHERE pr.partner_id = p.id AND pr.status = 'active') AS customers,
               (SELECT COUNT(*)::int FROM orders o
                  JOIN partner_referrals pr ON pr.customer_id = o.user_id
                 WHERE pr.partner_id = p.id AND pr.status = 'active'
                   AND o.status <> 'cancelled') AS orders_count,
               COALESCE((SELECT SUM(amount)::int FROM partner_transactions t
                 WHERE t.partner_id = p.id AND t.status IN ('available','paid')), 0) AS earned,
               COALESCE((SELECT SUM(amount)::int FROM partner_transactions t
                 WHERE t.partner_id = p.id AND t.status = 'available'), 0) AS available
           ) s ON true
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY p.id DESC`,
        params
      );
      res.json(r.rows.map(toAdminPartnerDTO));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  function toAdminPartnerDTO(row) {
    return {
      id: row.id,
      name: row.name,
      telegramUserId: row.telegram_user_id != null ? String(row.telegram_user_id) : null,
      telegramUsername: row.telegram_username || null,
      referralSlug: row.referral_slug,
      referralLink: referralLink(row.referral_slug),
      status: row.status,
      createdAt: row.created_at,
      customers: row.customers ?? 0,
      orders: row.orders_count ?? 0,
      earned: row.earned ?? 0,
      available: row.available ?? 0,
    };
  }

  adminRouter.post('/', requireAuth, async (req, res) => {
    const { name, telegramUsername, telegramUserId, referralSlug, status } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Укажите имя партнёра' });
    }
    const username = String(telegramUsername || '').trim().replace(/^@/, '') || null;
    const slug = normalizeSlug(referralSlug || username || name);
    if (!isValidSlug(slug)) {
      return res.status(400).json({
        error: 'Ссылка: 2–32 символа, латиница, цифры, _ и -, без префиксов ref_, u_, p_',
      });
    }
    const tgId = telegramUserId != null && String(telegramUserId).trim()
      ? String(telegramUserId).trim() : null;
    if (tgId !== null && !/^\d+$/.test(tgId)) {
      return res.status(400).json({ error: 'Telegram user ID — только цифры' });
    }
    try {
      const r = await query(
        `INSERT INTO partners (name, telegram_username, telegram_user_id, referral_slug, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [String(name).trim(), username, tgId, slug,
         status === 'inactive' ? 'inactive' : 'active']
      );
      res.status(201).json(toAdminPartnerDTO(r.rows[0]));
    } catch (e) {
      if (e.code === '23505') {
        const field = e.constraint === 'idx_partners_telegram_user_id'
          ? 'Партнёр с таким Telegram ID уже есть'
          : 'Такая ссылка уже занята';
        return res.status(409).json({ error: field });
      }
      if (e.code === '23514') {
        return res.status(400).json({ error: 'Недопустимая ссылка' });
      }
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  adminRouter.get('/:id', requireAuth, async (req, res) => {
    try {
      const r = await query('SELECT * FROM partners WHERE id = $1', [req.params.id]);
      const partner = r.rows[0];
      if (!partner) return res.status(404).json({ error: 'Партнёр не найден' });
      res.json({ ...toAdminPartnerDTO(partner), stats: await loadStats(partner.id) });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  adminRouter.patch('/:id', requireAuth, async (req, res) => {
    const { name, telegramUsername, telegramUserId, referralSlug, status } = req.body || {};
    const sets = [];
    const params = [];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: 'Укажите имя партнёра' });
      set('name', String(name).trim());
    }
    if (telegramUsername !== undefined) {
      set('telegram_username', String(telegramUsername || '').trim().replace(/^@/, '') || null);
    }
    if (telegramUserId !== undefined) {
      const tgId = String(telegramUserId || '').trim() || null;
      if (tgId !== null && !/^\d+$/.test(tgId)) {
        return res.status(400).json({ error: 'Telegram user ID — только цифры' });
      }
      set('telegram_user_id', tgId);
    }
    if (referralSlug !== undefined) {
      const slug = normalizeSlug(referralSlug);
      if (!isValidSlug(slug)) {
        return res.status(400).json({
          error: 'Ссылка: 2–32 символа, латиница, цифры, _ и -, без префиксов ref_, u_, p_',
        });
      }
      set('referral_slug', slug);
    }
    if (status !== undefined) {
      if (status !== 'active' && status !== 'inactive') {
        return res.status(400).json({ error: 'Статус: active или inactive' });
      }
      set('status', status);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Нечего менять' });

    params.push(req.params.id);
    try {
      const r = await query(
        `UPDATE partners SET ${sets.join(', ')}, updated_at = now()
          WHERE id = $${params.length} RETURNING *`,
        params
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'Партнёр не найден' });
      res.json(toAdminPartnerDTO(r.rows[0]));
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Ссылка или Telegram ID уже заняты' });
      if (e.code === '23514') return res.status(400).json({ error: 'Недопустимая ссылка' });
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  // Клиенты партнёра. Админ видит их в том же объёме, что и в разделе
  // «Клиенты» существующей админки — ограничение на персональные данные
  // касается только партнёрского UI.
  adminRouter.get('/:id/referrals', requireAuth, async (req, res) => {
    try {
      const r = await query(
        `SELECT pr.id, pr.telegram_user_id, pr.customer_id, pr.referred_at, pr.status,
                u.first_name, u.username, u.phone,
                COUNT(o.id) FILTER (WHERE o.status <> 'cancelled')::int AS orders_count,
                COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0)::int AS orders_total,
                MIN(o.created_at) FILTER (WHERE o.status <> 'cancelled') AS first_order_at
           FROM partner_referrals pr
           LEFT JOIN users u ON u.id = pr.customer_id
           LEFT JOIN orders o ON o.user_id = pr.customer_id
          WHERE pr.partner_id = $1
          GROUP BY pr.id, u.first_name, u.username, u.phone
          ORDER BY pr.referred_at DESC`,
        [req.params.id]
      );
      res.json(r.rows.map((x) => ({
        id: x.id,
        telegramUserId: String(x.telegram_user_id),
        customerId: x.customer_id != null ? String(x.customer_id) : null,
        name: x.first_name || null,
        username: x.username || null,
        phone: x.phone || null,
        referredAt: x.referred_at,
        firstOrderAt: x.first_order_at,
        orders: x.orders_count,
        ordersTotal: x.orders_total,
        status: x.status,
      })));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  adminRouter.get('/:id/transactions', requireAuth, async (req, res) => {
    try {
      const r = await query(
        `SELECT id, type, amount, status, description, order_id, customer_id, created_at
           FROM partner_transactions WHERE partner_id = $1 ORDER BY id DESC LIMIT 200`,
        [req.params.id]
      );
      res.json(r.rows.map((t) => ({
        id: t.id, type: t.type, amount: t.amount, status: t.status,
        description: t.description, orderId: t.order_id,
        customerId: t.customer_id != null ? String(t.customer_id) : null,
        createdAt: t.created_at,
      })));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  adminRouter.get('/:id/payouts', requireAuth, async (req, res) => {
    try {
      const r = await query(
        `SELECT id, amount, status, requested_at, processed_at, admin_comment
           FROM partner_payout_requests WHERE partner_id = $1 ORDER BY id DESC`,
        [req.params.id]
      );
      res.json(r.rows.map((p) => ({
        id: p.id, amount: p.amount, status: p.status,
        requestedAt: p.requested_at, processedAt: p.processed_at,
        adminComment: p.admin_comment,
      })));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  });

  return { router, adminRouter, attributeReferral, linkCustomer, findActivePartnerByTelegramId };
}
