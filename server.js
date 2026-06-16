import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { pool, query } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

const REFERRAL_DISCOUNT = 200;
const REFERRAL_POINTS_REWARD = 100;
const POINTS_PERCENT = 0.05;
const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 6;

// ============================================================
// Вспомогательные функции
// ============================================================

function toProductDTO(row) {
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    weight: row.weight,
    emoji: row.emoji,
    bg: row.bg,
    category: row.category,
    badge: row.badge_type
      ? { type: row.badge_type, label: row.badge_label }
      : null,
    composition: row.composition,
    suppliers: row.suppliers,
    pricing: row.pricing,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}

// Middleware: проверка JWT-токена администратора
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Недействительный или просроченный токен' });
  }
}

// Геокодирование адреса через Яндекс Geocoder HTTP API.
// Возвращает { lat, lng, formatted } или null, если адрес не найден.
async function geocodeAddress(address) {
  if (!YANDEX_GEOCODER_API_KEY) {
    throw new Error('YANDEX_GEOCODER_API_KEY не настроен на сервере');
  }
  const url = new URL('https://geocode-maps.yandex.ru/1.x/');
  url.searchParams.set('apikey', YANDEX_GEOCODER_API_KEY);
  url.searchParams.set('geocode', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('results', '1');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Геокодер вернул ошибку: ${res.status}`);
  }
  const data = await res.json();
  const member = data?.response?.GeoObjectCollection?.featureMember;
  if (!member || member.length === 0) return null;

  const geoObject = member[0].GeoObject;
  const [lngStr, latStr] = geoObject.Point.pos.split(' ');
  return {
    lat: parseFloat(latStr),
    lng: parseFloat(lngStr),
    formatted: geoObject.metaDataProperty?.GeocoderMetaData?.text || address,
  };
}

// Проверка "точка внутри многоугольника" (алгоритм ray-casting).
// polygon — массив точек [[lat, lng], ...], point — {lat, lng}.
function isPointInPolygon(point, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > point.lng !== yj > point.lng &&
      point.lat < ((xj - xi) * (point.lng - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function generateReferralCode() {
  let code = '';
  for (let i = 0; i < REFERRAL_CODE_LENGTH; i++) {
    code += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
  }
  return code;
}

// Создаёт запись пользователя или обновляет имя при повторном обращении.
// Генерирует уникальный реферальный код при первом создании.
async function upsertUser(telegramId, username, firstName) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const result = await query(
        `INSERT INTO users (telegram_id, username, first_name, referral_code)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (telegram_id) DO UPDATE SET
           username = EXCLUDED.username,
           first_name = EXCLUDED.first_name,
           updated_at = now()
         RETURNING *`,
        [telegramId, username || null, firstName || null, code]
      );
      return result.rows[0];
    } catch (e) {
      if (e.code === '23505' && e.detail?.includes('referral_code')) continue;
      throw e;
    }
  }
  throw new Error('Не удалось сгенерировать уникальный реферальный код');
}

// Отправляет сообщение в произвольный Telegram-чат через Bot API.
async function sendTelegramMessageToChat(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage failed:', res.status, body);
    }
  } catch (e) {
    console.error('Telegram sendMessage error:', e);
  }
}

// Отправляет уведомление администратору (в TELEGRAM_ADMIN_CHAT_ID).
function sendTelegramMessage(text) {
  return sendTelegramMessageToChat(TELEGRAM_ADMIN_CHAT_ID, text);
}

const ORDER_STATUS_NOTIFICATIONS = {
  in_progress: (id) => `🥗 Ваш заказ #${id} готовится!`,
  delivered:   (id) => `✅ Заказ #${id} доставлен. Спасибо!`,
  cancelled:   (id) => `❌ Заказ #${id} отменён. Свяжитесь с нами если вопросы.`,
};

// Формирует читаемое текстовое сообщение о новом заказе для уведомления в Telegram.
function formatOrderNotification(order) {
  const lines = [];
  lines.push(`🧺 <b>Новый заказ ${'#' + order.id}</b>`);
  lines.push('');

  if (Array.isArray(order.items)) {
    for (const item of order.items) {
      lines.push(`• ${item.title} × ${item.qty} — ${item.sum?.toLocaleString('ru-RU')} ₽`);
    }
  }
  lines.push('');
  lines.push(`<b>Итого: ${Number(order.total).toLocaleString('ru-RU')} ₽</b>`);
  if (order.promo_code && order.discount_amount) {
    lines.push(`🎁 Промокод ${order.promo_code} (−${Number(order.discount_amount).toLocaleString('ru-RU')} ₽)`);
  }
  lines.push('');

  if (order.delivery_date || order.delivery_slot) {
    const dateStr = order.delivery_date ? `${order.delivery_date.day || ''} ${order.delivery_date.date || ''}`.trim() : '';
    lines.push(`📅 ${[dateStr, order.delivery_slot].filter(Boolean).join(', ')}`);
  }

  if (order.address_street) {
    lines.push(`📍 ${order.address_street}`);
  }

  if (order.address_details) {
    const d = order.address_details;
    const detailParts = [
      d.entrance && `подъезд ${d.entrance}`,
      d.floor && `этаж ${d.floor}`,
      d.apartment && `кв. ${d.apartment}`,
      d.intercom && `домофон ${d.intercom}`,
    ].filter(Boolean);
    if (detailParts.length > 0) {
      lines.push(detailParts.join(', '));
    }
    if (d.comment) {
      lines.push(`💬 ${d.comment}`);
    }
  }

  if (order.comment) {
    lines.push(`💬 Комментарий к заказу: ${order.comment}`);
  }

  lines.push('');
  const paymentLabel = order.payment_method === 'cash' ? 'При получении (наличные/карта курьеру)' : 'Онлайн';
  lines.push(`💳 Оплата: ${paymentLabel}`);

  if (order.telegram_first_name || order.telegram_username) {
    const who = [order.telegram_first_name, order.telegram_username ? `@${order.telegram_username}` : null]
      .filter(Boolean)
      .join(' ');
    lines.push(`👤 ${who}`);
  }

  return lines.join('\n');
}

// ============================================================
// Публичные маршруты (используются мини-приложением)
// ============================================================

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});


// Весь каталог

// Весь каталог (категории + товары + отзывы + доставки) — то, что раньше было в products.js
app.get('/api/catalog', async (req, res) => {
  try {
    const [categoriesRes, productsRes, reviewsRes, deliveriesRes] = await Promise.all([
      query('SELECT * FROM categories ORDER BY sort_order ASC'),
      query('SELECT * FROM products WHERE is_active = true ORDER BY sort_order ASC, created_at ASC'),
      query('SELECT * FROM reviews ORDER BY sort_order ASC'),
      query('SELECT * FROM deliveries ORDER BY sort_order ASC'),
    ]);

    res.json({
      categories: [{ id: 'all', label: 'Все' }, ...categoriesRes.rows.map((c) => ({ id: c.id, label: c.label }))],
      products: productsRes.rows.map(toProductDTO),
      reviews: reviewsRes.rows.map((r) => ({
        name: r.name,
        area: r.area,
        stars: r.stars,
        text: r.text,
        emoji: r.emoji,
      })),
      deliveries: deliveriesRes.rows.map((d) => ({
        emoji: d.emoji,
        title: d.title,
        text: d.text,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Проверка зоны доставки
// ============================================================

// Принимает { address } (текстовый адрес) или { lat, lng } (координаты, например с геолокации).
// Геокодирует адрес при необходимости, затем проверяет попадание в зоны доставки.
app.post('/api/check-zone', async (req, res) => {
  const { address, lat, lng } = req.body || {};

  try {
    let point;
    let formattedAddress = address;

    if (typeof lat === 'number' && typeof lng === 'number') {
      point = { lat, lng };
    } else if (address && address.trim()) {
      const geocoded = await geocodeAddress(address.trim());
      if (!geocoded) {
        return res.json({ inZone: false, found: false, message: 'Адрес не найден' });
      }
      point = { lat: geocoded.lat, lng: geocoded.lng };
      formattedAddress = geocoded.formatted;
    } else {
      return res.status(400).json({ error: 'Укажите address или lat/lng' });
    }

    const zonesRes = await query('SELECT * FROM delivery_zones WHERE is_active = true');
    let matchedZone = null;
    for (const zone of zonesRes.rows) {
      if (isPointInPolygon(point, zone.coordinates)) {
        matchedZone = zone;
        break;
      }
    }

    res.json({
      inZone: Boolean(matchedZone),
      found: true,
      address: formattedAddress,
      zone: matchedZone ? matchedZone.label : null,
      point,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Ошибка сервера' });
  }
});

// ============================================================
// Заказы
// ============================================================

// Вычисляет размер скидки в рублях для промокода и заданной суммы заказа.
function computeDiscount(promo, total) {
  if (promo.discount_type === 'percent') {
    return Math.floor((total * promo.discount_value) / 100);
  }
  return Math.min(promo.discount_value, total);
}

// Проверяет промокод и возвращает размер скидки, не списывая его.
// Используется в корзине для предпросмотра скидки до оформления заказа.
app.post('/api/promo/check', async (req, res) => {
  const { code, total } = req.body || {};
  if (!code || !String(code).trim()) {
    return res.status(400).json({ error: 'Укажите промокод' });
  }
  try {
    const result = await query('SELECT * FROM promo_codes WHERE code = $1', [String(code).trim().toUpperCase()]);
    const promo = result.rows[0];
    if (!promo) {
      return res.json({ valid: false, message: 'Промокод не найден' });
    }
    if (promo.is_used) {
      return res.json({ valid: false, message: 'Промокод уже использован' });
    }
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'Промокод истёк' });
    }
    if (promo.min_order_total && total != null && total < promo.min_order_total) {
      return res.json({
        valid: false,
        message: `Промокод действует от ${promo.min_order_total.toLocaleString('ru-RU')} ₽`,
      });
    }
    const discount = computeDiscount(promo, total || 0);
    res.json({
      valid: true,
      discountType: promo.discount_type,
      discountValue: promo.discount_value,
      discount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать заказ (из мини-приложения). Сохраняет в базу и присылает уведомление в Telegram.
app.post('/api/orders', async (req, res) => {
  const {
    items,
    total,
    deliveryDate,
    deliverySlot,
    addressStreet,
    addressDetails,
    comment,
    paymentMethod,
    telegramUser,
    promoCode,
    referralCode,
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0 || total == null) {
    return res.status(400).json({ error: 'Укажите items и total' });
  }

  if (promoCode && referralCode) {
    return res.status(400).json({ error: 'Нельзя использовать промокод и реферальный код одновременно' });
  }

  try {
    let appliedPromo = null;
    let appliedReferral = null;
    let discountAmount = 0;
    let finalTotal = total;
    let appliedReferralCode = null;

    // Применяем промокод (одноразовый, из таблицы promo_codes)
    if (promoCode && String(promoCode).trim()) {
      const promoRes = await query('SELECT * FROM promo_codes WHERE code = $1', [String(promoCode).trim().toUpperCase()]);
      const promo = promoRes.rows[0];
      if (promo && !promo.is_used && (!promo.expires_at || new Date(promo.expires_at) >= new Date())) {
        if (!promo.min_order_total || total >= promo.min_order_total) {
          discountAmount = computeDiscount(promo, total);
          finalTotal = Math.max(0, total - discountAmount);
          appliedPromo = promo;
        }
      }
    }

    // Применяем реферальный код (только если нет промокода и это первый заказ)
    if (!appliedPromo && referralCode && String(referralCode).trim()) {
      appliedReferralCode = String(referralCode).trim().toUpperCase();
      const referrerRes = await query('SELECT * FROM users WHERE referral_code = $1', [appliedReferralCode]);
      const referrer = referrerRes.rows[0];

      if (referrer) {
        const tid = telegramUser?.id;

        // Защита от самореферала
        if (tid && String(referrer.telegram_id) === String(tid)) {
          return res.status(400).json({ error: 'Нельзя использовать свой реферальный код' });
        }

        // Скидка только на первый заказ
        if (tid) {
          const prevRes = await query(
            'SELECT COUNT(*)::int AS count FROM orders WHERE telegram_user_id = $1',
            [tid]
          );
          if ((prevRes.rows[0]?.count || 0) === 0) {
            discountAmount = REFERRAL_DISCOUNT;
            finalTotal = Math.max(0, total - discountAmount);
            appliedReferral = referrer;
          }
        }
      }
    }

    const result = await query(
      `INSERT INTO orders
        (items, total, delivery_date, delivery_slot, address_street, address_details, comment, payment_method, promo_code, discount_amount, telegram_user_id, telegram_username, telegram_first_name, referral_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        JSON.stringify(items),
        finalTotal,
        JSON.stringify(deliveryDate || null),
        deliverySlot || null,
        addressStreet || null,
        addressDetails ? JSON.stringify(addressDetails) : null,
        comment || null,
        paymentMethod === 'cash' ? 'cash' : 'online',
        appliedPromo ? appliedPromo.code : null,
        discountAmount,
        telegramUser?.id || null,
        telegramUser?.username || null,
        telegramUser?.firstName || null,
        appliedReferral ? appliedReferralCode : null,
      ]
    );

    const order = result.rows[0];

    // Промокод одноразовый — помечаем использованным сразу после успешного создания заказа.
    if (appliedPromo) {
      await query(
        'UPDATE promo_codes SET is_used = true, used_at = now(), used_by_telegram_id = $1 WHERE id = $2',
        [telegramUser?.id || null, appliedPromo.id]
      );
    }

    // Записываем, кто пригласил пользователя (только если referred_by_id ещё не стоит).
    if (appliedReferral && telegramUser?.id) {
      await query(
        'UPDATE users SET referred_by_id = $1, updated_at = now() WHERE telegram_id = $2 AND referred_by_id IS NULL',
        [appliedReferral.telegram_id, telegramUser.id]
      );
    }

    // Уведомление в Telegram — не блокирует ответ клиенту, если не настроено или упало
    const notification = formatOrderNotification({
      id: order.id,
      items,
      total: finalTotal,
      delivery_date: deliveryDate,
      delivery_slot: deliverySlot,
      address_street: addressStreet,
      address_details: addressDetails,
      comment,
      payment_method: order.payment_method,
      telegram_first_name: order.telegram_first_name,
      telegram_username: order.telegram_username,
      promo_code: order.promo_code,
      discount_amount: order.discount_amount,
    });
    sendTelegramMessage(notification);

    res.status(201).json({ id: order.id, status: order.status, total: finalTotal, discount: discountAmount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Уровни программы лояльности по количеству заказов.
// Каждый уровень задаёт минимальное число заказов, начиная с которого он действует.
const LOYALTY_LEVELS = [
  { threshold: 0, label: 'Новый сосед', emoji: '🌱' },
  { threshold: 1, label: 'Сосед', emoji: '🏡' },
  { threshold: 3, label: 'Постоянный гость', emoji: '🌿' },
  { threshold: 6, label: 'Друг Прилавки', emoji: '💚' },
  { threshold: 10, label: 'Легенда района', emoji: '🌟' },
];

// Возвращает текущий уровень и сведения о следующем (если есть) по числу заказов.
function getLoyaltyLevel(ordersCount) {
  let current = LOYALTY_LEVELS[0];
  let currentThreshold = LOYALTY_LEVELS[0].threshold;
  let next = null;
  for (let i = 0; i < LOYALTY_LEVELS.length; i++) {
    if (ordersCount >= LOYALTY_LEVELS[i].threshold) {
      current = LOYALTY_LEVELS[i];
      currentThreshold = LOYALTY_LEVELS[i].threshold;
      next = LOYALTY_LEVELS[i + 1] || null;
    }
  }
  const ordersToNext = next ? next.threshold - ordersCount : 0;
  return {
    label: current.label,
    emoji: current.emoji,
    currentThreshold,
    next: next ? { label: next.label, emoji: next.emoji, threshold: next.threshold, ordersToNext } : null,
  };
}

// Статистика пользователя: уровень лояльности, эко-счётчик, реферальный код и баллы.
// При каждом вызове делает upsert пользователя (создаёт запись и код если нет).
// Принимает username и firstName как query-параметры для сохранения имени.
app.get('/api/users/:telegramId/stats', async (req, res) => {
  const telegramId = req.params.telegramId;
  const { username, firstName } = req.query;

  if (!telegramId || telegramId === '0') {
    return res.json({
      ordersCount: 0,
      level: getLoyaltyLevel(0),
      eco: { packagingSaved: 0, co2SavedKg: 0 },
      referralCode: null,
      points: 0,
      referralsCount: 0,
    });
  }

  try {
    const [userRecord, ordersRes] = await Promise.all([
      upsertUser(telegramId, username, firstName),
      query('SELECT COUNT(*)::int AS count FROM orders WHERE telegram_user_id = $1', [telegramId]),
    ]);

    const ordersCount = ordersRes.rows[0]?.count || 0;
    const level = getLoyaltyLevel(ordersCount);
    const eco = {
      packagingSaved: ordersCount * 4,
      co2SavedKg: Math.round(ordersCount * 0.5 * 10) / 10,
    };

    const referralsRes = await query(
      'SELECT COUNT(*)::int AS count FROM users WHERE referred_by_id = $1',
      [telegramId]
    );

    res.json({
      ordersCount,
      level,
      eco,
      referralCode: userRecord.referral_code,
      points: userRecord.points,
      referralsCount: referralsRes.rows[0]?.count || 0,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Последние 10 заказов пользователя по telegram_user_id — для истории в профиле.
app.get('/api/users/:telegramId/orders', async (req, res) => {
  const { telegramId } = req.params;
  if (!telegramId || telegramId === '0') return res.json([]);
  try {
    const result = await query(
      `SELECT id, total, status, created_at, items, delivery_date, delivery_slot
       FROM orders
       WHERE telegram_user_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [telegramId]
    );
    res.json(result.rows.map((o) => ({
      id: o.id,
      total: o.total,
      status: o.status,
      createdAt: o.created_at,
      items: o.items,
      deliveryDate: o.delivery_date,
      deliverySlot: o.delivery_slot,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Валидация реферального кода перед оформлением заказа.
// Проверяет: существование кода, самореферал, первый ли заказ у пользователя.
app.get('/api/referral/:code', async (req, res) => {
  const code = req.params.code.trim().toUpperCase();
  const { telegramId } = req.query;

  try {
    const referrerRes = await query('SELECT * FROM users WHERE referral_code = $1', [code]);
    const referrer = referrerRes.rows[0];

    if (!referrer) {
      return res.json({ valid: false, message: 'Реферальный код не найден' });
    }

    if (telegramId && String(referrer.telegram_id) === String(telegramId)) {
      return res.json({ valid: false, message: 'Нельзя использовать свой код' });
    }

    if (telegramId && telegramId !== '0') {
      const prevRes = await query(
        'SELECT COUNT(*)::int AS count FROM orders WHERE telegram_user_id = $1',
        [telegramId]
      );
      if ((prevRes.rows[0]?.count || 0) > 0) {
        return res.json({ valid: false, message: 'Реферальный код действует только для первого заказа' });
      }
    }

    res.json({
      valid: true,
      referrerName: referrer.first_name || referrer.username || 'Пользователь',
      discount: REFERRAL_DISCOUNT,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Авторизация администратора
// ============================================================

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Укажите логин и пароль' });
  }
  try {
    const result = await query('SELECT * FROM admins WHERE username = $1', [username]);
    const admin = result.rows[0];
    if (!admin) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }
    const token = jwt.sign({ sub: admin.id, username: admin.username }, JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({ token, username: admin.username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Проверка токена (используется фронтендом для определения, авторизован ли админ)
app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ username: req.admin.username });
});

// ============================================================
// Админские маршруты — товары (CRUD)
// ============================================================

// Список всех товаров (включая неактивные) — для админки
app.get('/api/admin/products', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM products ORDER BY sort_order ASC, created_at ASC');
    res.json(result.rows.map(toProductDTO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Один товар по id
app.get('/api/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Товар не найден' });
    res.json(toProductDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать товар
app.post('/api/admin/products', requireAuth, async (req, res) => {
  const p = req.body || {};
  if (!p.id || !p.title || p.price == null || !p.category) {
    return res.status(400).json({ error: 'Обязательные поля: id, title, price, category' });
  }
  try {
    await query(
      `INSERT INTO products
        (id, title, price, weight, emoji, bg, category, badge_type, badge_label, composition, suppliers, pricing, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        p.id,
        p.title,
        p.price,
        p.weight || '',
        p.emoji || '🛒',
        p.bg || 'linear-gradient(135deg, #F4F7F2, #fff)',
        p.category,
        p.badge?.type || null,
        p.badge?.label || null,
        JSON.stringify(p.composition || []),
        JSON.stringify(p.suppliers || []),
        JSON.stringify(p.pricing || []),
        p.isActive !== false,
        p.sortOrder || 0,
      ]
    );
    const result = await query('SELECT * FROM products WHERE id = $1', [p.id]);
    res.status(201).json(toProductDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Товар с таким id уже существует' });
    }
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить товар
app.put('/api/admin/products/:id', requireAuth, async (req, res) => {
  const p = req.body || {};
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Товар не найден' });
    const cur = existing.rows[0];

    await query(
      `UPDATE products SET
        title = $1,
        price = $2,
        weight = $3,
        emoji = $4,
        bg = $5,
        category = $6,
        badge_type = $7,
        badge_label = $8,
        composition = $9,
        suppliers = $10,
        pricing = $11,
        is_active = $12,
        sort_order = $13,
        updated_at = now()
       WHERE id = $14`,
      [
        p.title ?? cur.title,
        p.price ?? cur.price,
        p.weight ?? cur.weight,
        p.emoji ?? cur.emoji,
        p.bg ?? cur.bg,
        p.category ?? cur.category,
        p.badge ? p.badge.type : (p.badge === null ? null : cur.badge_type),
        p.badge ? p.badge.label : (p.badge === null ? null : cur.badge_label),
        p.composition !== undefined ? JSON.stringify(p.composition) : JSON.stringify(cur.composition),
        p.suppliers !== undefined ? JSON.stringify(p.suppliers) : JSON.stringify(cur.suppliers),
        p.pricing !== undefined ? JSON.stringify(p.pricing) : JSON.stringify(cur.pricing),
        p.isActive ?? cur.is_active,
        p.sortOrder ?? cur.sort_order,
        req.params.id,
      ]
    );
    const result = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    res.json(toProductDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить товар
app.delete('/api/admin/products/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM products WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Товар не найден' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — категории
// ============================================================

app.get('/api/admin/categories', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM categories ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/categories', requireAuth, async (req, res) => {
  const { id, label, sortOrder } = req.body || {};
  if (!id || !label) return res.status(400).json({ error: 'Укажите id и label' });
  try {
    await query('INSERT INTO categories (id, label, sort_order) VALUES ($1,$2,$3)', [
      id,
      label,
      sortOrder || 0,
    ]);
    res.status(201).json({ id, label, sort_order: sortOrder || 0 });
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(409).json({ error: 'Категория с таким id уже существует' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/categories/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM categories WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Категория не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    if (e.code === '23503') {
      return res.status(409).json({ error: 'Нельзя удалить категорию: в ней есть товары' });
    }
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — зоны доставки
// ============================================================

// Список всех зон (включая неактивные) — для админки
app.get('/api/admin/delivery-zones', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM delivery_zones ORDER BY id ASC');
    res.json(
      result.rows.map((z) => ({
        id: z.id,
        label: z.label,
        coordinates: z.coordinates,
        isActive: z.is_active,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать зону доставки (полигон)
app.post('/api/admin/delivery-zones', requireAuth, async (req, res) => {
  const { label, coordinates, isActive } = req.body || {};
  if (!label || !Array.isArray(coordinates) || coordinates.length < 3) {
    return res.status(400).json({ error: 'Укажите label и coordinates (минимум 3 точки)' });
  }
  try {
    const result = await query(
      `INSERT INTO delivery_zones (label, coordinates, is_active) VALUES ($1, $2, $3) RETURNING *`,
      [label, JSON.stringify(coordinates), isActive !== false]
    );
    const z = result.rows[0];
    res.status(201).json({ id: z.id, label: z.label, coordinates: z.coordinates, isActive: z.is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить зону доставки
app.put('/api/admin/delivery-zones/:id', requireAuth, async (req, res) => {
  const { label, coordinates, isActive } = req.body || {};
  try {
    const existing = await query('SELECT * FROM delivery_zones WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Зона не найдена' });
    const cur = existing.rows[0];

    const result = await query(
      `UPDATE delivery_zones SET label = $1, coordinates = $2, is_active = $3, updated_at = now()
       WHERE id = $4 RETURNING *`,
      [
        label ?? cur.label,
        coordinates !== undefined ? JSON.stringify(coordinates) : JSON.stringify(cur.coordinates),
        isActive ?? cur.is_active,
        req.params.id,
      ]
    );
    const z = result.rows[0];
    res.json({ id: z.id, label: z.label, coordinates: z.coordinates, isActive: z.is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить зону доставки
app.delete('/api/admin/delivery-zones/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM delivery_zones WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Зона не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — заказы
// ============================================================

// Список заказов (новые сверху)
app.get('/api/admin/orders', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200');
    res.json(
      result.rows.map((o) => ({
        id: o.id,
        items: o.items,
        total: o.total,
        deliveryDate: o.delivery_date,
        deliverySlot: o.delivery_slot,
        addressStreet: o.address_street,
        addressDetails: o.address_details,
        comment: o.comment,
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        status: o.status,
        promoCode: o.promo_code,
        referralCode: o.referral_code,
        discountAmount: o.discount_amount,
        telegramUsername: o.telegram_username,
        telegramFirstName: o.telegram_first_name,
        createdAt: o.created_at,
      }))
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить статус заказа (например, "в работе", "доставлен", "отменён").
// При переходе в "delivered" начисляет баллы рефереру (если заказ по реферальному коду).
app.put('/api/admin/orders/:id', requireAuth, async (req, res) => {
  const { status, paymentStatus } = req.body || {};
  try {
    const existing = await query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Заказ не найден' });
    const cur = existing.rows[0];

    const result = await query(
      `UPDATE orders SET status = $1, payment_status = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [status ?? cur.status, paymentStatus ?? cur.payment_status, req.params.id]
    );
    const o = result.rows[0];

    // Начисляем баллы рефереру при переходе в статус "delivered"
    if (status === 'delivered' && cur.status !== 'delivered' && cur.referral_code) {
      try {
        const referrerRes = await query('SELECT telegram_id FROM users WHERE referral_code = $1', [cur.referral_code]);
        const referrer = referrerRes.rows[0];

        if (referrer) {
          const alreadyRewarded = await query('SELECT 1 FROM referral_rewards WHERE order_id = $1', [o.id]);

          if (alreadyRewarded.rows.length === 0) {
            await query(
              'UPDATE users SET points = points + $1, updated_at = now() WHERE telegram_id = $2',
              [REFERRAL_POINTS_REWARD, referrer.telegram_id]
            );

            const referredRes = cur.telegram_user_id
              ? await query('SELECT telegram_id FROM users WHERE telegram_id = $1', [cur.telegram_user_id])
              : { rows: [] };
            const referredId = referredRes.rows[0]?.telegram_id;

            if (referredId) {
              await query(
                'INSERT INTO referral_rewards (referrer_id, referred_id, order_id, points_awarded) VALUES ($1,$2,$3,$4)',
                [referrer.telegram_id, referredId, o.id, REFERRAL_POINTS_REWARD]
              );
            }
          }
        }
      } catch (e) {
        console.error('Ошибка начисления реферальных баллов:', e);
      }
    }

    // Начисляем баллы покупателю за доставленный заказ (5% от суммы, округление вниз)
    if (status === 'delivered' && cur.status !== 'delivered' && o.telegram_user_id) {
      const pointsToAward = Math.floor(Number(o.total) * POINTS_PERCENT);
      if (pointsToAward > 0) {
        try {
          await query(
            'UPDATE users SET points = points + $1, updated_at = now() WHERE telegram_id = $2',
            [pointsToAward, o.telegram_user_id]
          );
        } catch (e) {
          console.error('Ошибка начисления баллов за заказ:', e);
        }
      }
    }

    // Уведомляем пользователя о смене статуса (fire-and-forget)
    if (status && status !== cur.status && o.telegram_user_id && ORDER_STATUS_NOTIFICATIONS[status]) {
      sendTelegramMessageToChat(o.telegram_user_id, ORDER_STATUS_NOTIFICATIONS[status](o.id));
    }

    res.json({ id: o.id, status: o.status, paymentStatus: o.payment_status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — промокоды
// ============================================================

function toPromoDTO(row) {
  return {
    id: row.id,
    code: row.code,
    discountType: row.discount_type,
    discountValue: row.discount_value,
    minOrderTotal: row.min_order_total,
    isUsed: row.is_used,
    usedAt: row.used_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

// Список всех промокодов (новые сверху)
app.get('/api/admin/promo-codes', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM promo_codes ORDER BY created_at DESC');
    res.json(result.rows.map(toPromoDTO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать промокод
app.post('/api/admin/promo-codes', requireAuth, async (req, res) => {
  const { code, discountType, discountValue, minOrderTotal, expiresAt } = req.body || {};
  if (!code || !String(code).trim() || !discountValue) {
    return res.status(400).json({ error: 'Укажите код и размер скидки' });
  }
  const type = discountType === 'percent' ? 'percent' : 'fixed';
  try {
    const result = await query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_total, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [
        String(code).trim().toUpperCase(),
        type,
        discountValue,
        minOrderTotal || 0,
        expiresAt || null,
      ]
    );
    res.status(201).json(toPromoDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(409).json({ error: 'Такой промокод уже существует' });
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить промокод
app.delete('/api/admin/promo-codes/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM promo_codes WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Промокод не найден' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — пользователи (реферальная программа)
// ============================================================

// Список всех пользователей с баллами и статистикой рефералов
app.get('/api/admin/users', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT
        u.telegram_id,
        u.username,
        u.first_name,
        u.referral_code,
        u.points,
        u.created_at,
        (SELECT COUNT(*)::int FROM users r WHERE r.referred_by_id = u.telegram_id) AS referrals_count,
        (SELECT COUNT(*)::int FROM orders o WHERE o.telegram_user_id = u.telegram_id) AS orders_count
      FROM users u
      ORDER BY u.created_at DESC
    `);
    res.json(result.rows.map((u) => ({
      telegramId: u.telegram_id,
      username: u.username,
      firstName: u.first_name,
      referralCode: u.referral_code,
      points: u.points,
      referralsCount: u.referrals_count,
      ordersCount: u.orders_count,
      createdAt: u.created_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Корректировка баллов пользователя (delta может быть отрицательным)
app.patch('/api/admin/users/:telegramId/points', requireAuth, async (req, res) => {
  const { delta } = req.body || {};
  if (delta == null || typeof delta !== 'number' || !Number.isInteger(delta)) {
    return res.status(400).json({ error: 'Укажите delta (целое число)' });
  }
  try {
    const result = await query(
      `UPDATE users SET points = GREATEST(0, points + $1), updated_at = now()
       WHERE telegram_id = $2 RETURNING telegram_id, points`,
      [delta, req.params.telegramId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({ telegramId: result.rows[0].telegram_id, points: result.rows[0].points });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Награды
// ============================================================

// Активные награды для мини-приложения
app.get('/api/rewards', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, title, description, emoji, points_cost FROM rewards WHERE is_active = true ORDER BY points_cost ASC'
    );
    res.json(result.rows.map((r) => ({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, pointsCost: r.points_cost,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Все награды для админки
app.get('/api/admin/rewards', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, title, description, emoji, points_cost, is_active, created_at FROM rewards ORDER BY created_at DESC'
    );
    res.json(result.rows.map((r) => ({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, pointsCost: r.points_cost,
      isActive: r.is_active, createdAt: r.created_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать награду
app.post('/api/admin/rewards', requireAuth, async (req, res) => {
  const { title, description, emoji, pointsCost, isActive } = req.body || {};
  if (!title || !pointsCost || typeof pointsCost !== 'number' || pointsCost <= 0) {
    return res.status(400).json({ error: 'Укажите title и pointsCost (> 0)' });
  }
  try {
    const result = await query(
      `INSERT INTO rewards (title, description, emoji, points_cost, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, description, emoji, points_cost, is_active, created_at`,
      [title, description || null, emoji || null, pointsCost, isActive !== false]
    );
    const r = result.rows[0];
    res.status(201).json({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, pointsCost: r.points_cost,
      isActive: r.is_active, createdAt: r.created_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить награду (в т.ч. переключить is_active)
app.patch('/api/admin/rewards/:id', requireAuth, async (req, res) => {
  const { title, description, emoji, pointsCost, isActive } = req.body || {};
  const fields = [];
  const vals = [];
  let i = 1;
  if (title !== undefined)      { fields.push(`title = $${i++}`);       vals.push(title); }
  if (description !== undefined){ fields.push(`description = $${i++}`); vals.push(description); }
  if (emoji !== undefined)      { fields.push(`emoji = $${i++}`);       vals.push(emoji); }
  if (pointsCost !== undefined) { fields.push(`points_cost = $${i++}`); vals.push(pointsCost); }
  if (isActive !== undefined)   { fields.push(`is_active = $${i++}`);   vals.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: 'Нет полей для обновления' });
  vals.push(req.params.id);
  try {
    const result = await query(
      `UPDATE rewards SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, title, description, emoji, points_cost, is_active`,
      vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Награда не найдена' });
    const r = result.rows[0];
    res.json({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, pointsCost: r.points_cost, isActive: r.is_active,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить награду
app.delete('/api/admin/rewards/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM rewards WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Награда не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Запуск сервера
// ============================================================

app.listen(PORT, () => {
  console.log(`Прилавка API запущен на порту ${PORT}`);
});
