import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { pool, query } from './db.js';
import { v2 as cloudinary } from 'cloudinary';
import multer from 'multer';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const YANDEX_GEOCODER_API_KEY = process.env.YANDEX_GEOCODER_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
// Публичный URL мини-приложения — для web_app-кнопки в пуше "оставьте отзыв".
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://prilavka-app-production.up.railway.app';

const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERRAL_CODE_LENGTH = 6;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// Write-through settings cache — loaded once at startup, updated on admin PUT.
// Hardcoded defaults serve as fallback until DB is read.
let settingsCache = {
  min_order_total:          '1990',
  points_percent:           '5',
  referral_points_reward:   '100',
  referral_discount:        '200',
  max_points_spend_percent: '30',
  default_slot:             '18:00–21:00',
  review_photo_points:      '50',
};

async function loadSettings() {
  try {
    const result = await query('SELECT key, value FROM settings');
    if (result.rows.length > 0) {
      settingsCache = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
    }
  } catch (e) {
    console.error('Failed to load settings from DB, using defaults:', e.message);
  }
}

function getSetting(key) {
  return settingsCache[key];
}

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
    imageUrl: row.image_url || null,
    isBundle: row.is_bundle ?? false,
    subcategoryId: row.subcategory_id ?? null,
  };
}

function toBundleItemDTO(row) {
  return {
    id: row.id,
    itemName: row.item_name,
    itemEmoji: row.item_emoji,
    alternatives: row.alternatives,
    isRemovable: row.is_removable,
    sortOrder: row.sort_order,
  };
}

function toReviewDTO(row) {
  return {
    name: row.name,
    area: row.area,
    stars: row.stars,
    text: row.text,
    emoji: row.emoji,
    imageUrl: row.image_url || null,
    avatarUrl: row.avatar_url || null,
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

const fmtOrderId = (id) => '#' + String(id).padStart(4, '0');

const ORDER_STATUS_NOTIFICATIONS = {
  in_progress: (id) => `🥗 Ваш заказ ${fmtOrderId(id)} готовится!`,
  courier:     (id) => `🛵 Курьер уже едет к вам! Ожидайте в ближайшее время.`,
  delivered:   (id) => `✅ Заказ ${fmtOrderId(id)} доставлен. Спасибо!`,
  cancelled:   (id) => `❌ Заказ ${fmtOrderId(id)} отменён. Свяжитесь с нами если вопросы.`,
};

// Формирует читаемое текстовое сообщение о новом заказе для уведомления в Telegram.
function formatOrderNotification(order) {
  const lines = [];
  lines.push(`🧺 <b>Новый заказ ${'#' + String(order.id).padStart(4, '0')}</b>`);
  lines.push('');

  let subtotal = 0;
  if (Array.isArray(order.items)) {
    for (const item of order.items) {
      subtotal += Number(item.sum) || 0;
      lines.push(`• ${item.title} × ${item.qty} — ${(Number(item.sum) || 0).toLocaleString('ru-RU')} ₽`);
    }
  }
  lines.push('');

  // Разбивка сходится: товары − скидка = итог. Строку скидки показываем для
  // любой скидки (промокод / баллы / реферал), а не только промокода.
  const discount = Number(order.discount_amount) || 0;
  if (discount > 0) {
    lines.push(`Товары: ${subtotal.toLocaleString('ru-RU')} ₽`);
    const discountLabel = order.promo_code ? `Скидка (промокод ${order.promo_code})` : 'Скидка';
    lines.push(`${discountLabel}: −${discount.toLocaleString('ru-RU')} ₽`);
  }
  lines.push(`<b>Итого: ${Number(order.total).toLocaleString('ru-RU')} ₽</b>`);
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

  if (order.leave_at_door) {
    lines.push(`🚪 Оставить у двери`);
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

  if (order.phone) {
    lines.push(`📞 ${order.phone}`);
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

// Публичный список активных районов доставки для мини-приложения
app.get('/api/districts', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, name, sort_order FROM districts WHERE is_active = true ORDER BY sort_order ASC, id ASC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


// Весь каталог

// Весь каталог (категории + товары + отзывы + доставки) — то, что раньше было в products.js
app.get('/api/catalog', async (req, res) => {
  try {
    const [categoriesRes, subcatsRes, productsRes, reviewsRes, deliveriesRes, compositionsRes] = await Promise.all([
      query('SELECT * FROM categories ORDER BY sort_order ASC'),
      query('SELECT * FROM subcategories ORDER BY category_id, sort_order ASC'),
      query(`SELECT p.* FROM products p
             LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
             WHERE p.is_active = true
             ORDER BY sc.sort_order ASC NULLS LAST, p.title ASC`),
      // Новые сверху. У reviews нет created_at — id (SERIAL) монотонно растёт
      // с вставкой, так что id DESC надёжно даёт порядок "новые первые".
      query("SELECT * FROM reviews WHERE status = 'published' ORDER BY id DESC"),
      query('SELECT * FROM deliveries ORDER BY sort_order ASC'),
      query('SELECT * FROM набор_состав ORDER BY product_id, sort_order'),
    ]);

    const compositionsByProduct = {};
    for (const row of compositionsRes.rows) {
      if (!compositionsByProduct[row.product_id]) compositionsByProduct[row.product_id] = [];
      compositionsByProduct[row.product_id].push(toBundleItemDTO(row));
    }

    res.json({
      categories: [{ id: 'all', label: 'Все' }, ...categoriesRes.rows.map((c) => ({ id: c.id, label: c.label }))],
      subcategories: subcatsRes.rows.map((sc) => ({
        id: sc.id,
        category_id: sc.category_id,
        name: sc.name,
        slug: sc.slug,
        sort_order: sc.sort_order,
      })),
      products: productsRes.rows.map((row) => ({
        ...toProductDTO(row),
        bundleComposition: compositionsByProduct[row.id] ?? null,
      })),
      reviews: reviewsRes.rows.map(toReviewDTO),
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

// Полный список одобренных отзывов с пагинацией — для страницы /reviews
// ("Все отзывы"). /api/catalog отдаёт их же, но без пагинации — там это
// нормально, пока Home показывает только первые 4.
app.get('/api/reviews', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    // Берём на 1 больше лимита — если пришло больше, значит есть следующая страница.
    const result = await query(
      "SELECT * FROM reviews WHERE status = 'published' ORDER BY id DESC LIMIT $1 OFFSET $2",
      [limit + 1, offset]
    );
    const hasMore = result.rows.length > limit;
    res.json({ reviews: result.rows.slice(0, limit).map(toReviewDTO), hasMore });
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
    phone,
    comment,
    paymentMethod,
    telegramUser,
    promoCode,
    referralCode,
    pointsToSpend,
    leaveAtDoor,
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0 || total == null) {
    return res.status(400).json({ error: 'Укажите items и total' });
  }

  const minOrderTotal = Number(getSetting('min_order_total'));
  if (total < minOrderTotal) {
    return res.status(400).json({ error: `Минимальная сумма заказа — ${minOrderTotal.toLocaleString('ru-RU')} ₽` });
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
            discountAmount = Number(getSetting('referral_discount'));
            finalTotal = Math.max(0, total - discountAmount);
            appliedReferral = referrer;
          }
        }
      }
    }

    // Применяем баллы (только если нет промокода и есть авторизованный пользователь)
    let pointsSpent = 0;
    if (!appliedPromo && !appliedReferral && pointsToSpend > 0 && telegramUser?.id) {
      const maxByPercent = Math.floor(total * (Number(getSetting('max_points_spend_percent')) / 100));
      const allowed = Math.min(pointsToSpend, maxByPercent);
      if (allowed > 0) {
        const balanceRes = await query('SELECT points FROM users WHERE telegram_id = $1', [telegramUser.id]);
        const balance = balanceRes.rows[0]?.points ?? 0;
        pointsSpent = Math.min(allowed, balance);
        if (pointsSpent > 0) {
          discountAmount += pointsSpent;
          finalTotal = Math.max(0, finalTotal - pointsSpent);
        }
      }
    }

    // Проверяем pending-награду и добавляем в состав заказа как бесплатный товар
    let pendingReward = null;
    try {
      const prRes = await query(
        `SELECT ur.id AS user_reward_id, r.title, r.emoji
         FROM user_rewards ur
         JOIN rewards r ON ur.reward_id = r.id
         WHERE ur.telegram_id = $1 AND ur.status = 'pending'
         LIMIT 1`,
        [telegramUser?.id || 0]
      );
      pendingReward = prRes.rows[0] || null;
    } catch (e) {
      // Таблица user_rewards может не существовать до миграции — не блокируем заказ
    }
    const orderItems = pendingReward
      ? [...items, { title: pendingReward.title, emoji: pendingReward.emoji || '🎁', qty: 1, sum: 0, isReward: true }]
      : items;

    const result = await query(
      `INSERT INTO orders
        (items, total, delivery_date, delivery_slot, address_street, address_details, phone, comment, payment_method, promo_code, discount_amount, telegram_user_id, telegram_username, telegram_first_name, referral_code, leave_at_door)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        JSON.stringify(orderItems),
        finalTotal,
        JSON.stringify(deliveryDate || null),
        deliverySlot || null,
        addressStreet || null,
        addressDetails ? JSON.stringify(addressDetails) : null,
        phone || null,
        comment || null,
        paymentMethod === 'cash' ? 'cash' : 'online',
        appliedPromo ? appliedPromo.code : null,
        discountAmount,
        telegramUser?.id || null,
        telegramUser?.username || null,
        telegramUser?.firstName || null,
        appliedReferral ? appliedReferralCode : null,
        leaveAtDoor === true,
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

    // Списываем баллы после успешного создания заказа
    if (pointsSpent > 0 && telegramUser?.id) {
      await query(
        'UPDATE users SET points = GREATEST(0, points - $1), updated_at = now() WHERE telegram_id = $2',
        [pointsSpent, telegramUser.id]
      );
    }

    // Помечаем pending-награду как использованную
    if (pendingReward && telegramUser?.id) {
      try {
        await query("UPDATE user_rewards SET status = 'used' WHERE id = $1", [pendingReward.user_reward_id]);
      } catch (e) {
        console.error('Ошибка пометки награды:', e);
      }
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
      phone: phone || null,
      comment,
      leave_at_door: order.leave_at_door,
      payment_method: order.payment_method,
      telegram_first_name: order.telegram_first_name,
      telegram_username: order.telegram_username,
      promo_code: order.promo_code,
      discount_amount: order.discount_amount,
    });
    sendTelegramMessage(notification);

    res.status(201).json({ id: order.id, status: order.status, total: finalTotal, discount: discountAmount, pointsSpent });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Публичная отмена заказа клиентом — только статус new, не старше 5 минут.
// Принимает telegramUserId для проверки принадлежности заказа.
app.post('/api/orders/:id/cancel', async (req, res) => {
  const orderId = req.params.id;
  const { telegramUserId } = req.body || {};

  if (!telegramUserId) {
    return res.status(400).json({ error: 'Укажите telegramUserId' });
  }

  try {
    const result = await query('SELECT * FROM orders WHERE id = $1', [orderId]);
    const order = result.rows[0];

    if (!order) {
      return res.status(404).json({ error: 'Заказ не найден' });
    }

    if (String(order.telegram_user_id) !== String(telegramUserId)) {
      return res.status(403).json({ error: 'Нет доступа к этому заказу' });
    }

    if (order.status !== 'new') {
      return res.status(409).json({ error: 'Заказ уже обрабатывается и не может быть отменён' });
    }

    const ageMs = Date.now() - new Date(order.created_at).getTime();
    if (ageMs > 5 * 60 * 1000) {
      return res.status(409).json({ error: 'Время отмены истекло' });
    }

    await query(
      "UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1",
      [orderId]
    );

    sendTelegramMessage(
      `❌ Заказ #${order.id} отменён клиентом` +
      (order.telegram_first_name || order.telegram_username
        ? ` (${[order.telegram_first_name, order.telegram_username ? '@' + order.telegram_username : null].filter(Boolean).join(' ')})`
        : '')
    );

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Публичный просмотр заказа по id — только владелец (проверяем по telegramUserId в query).
app.get('/api/orders/:id', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { telegramUserId } = req.query;

  if (!telegramUserId || isNaN(orderId)) {
    return res.status(400).json({ error: 'Укажите telegramUserId' });
  }

  try {
    const result = await query(
      `SELECT o.id, o.status, o.items, o.total, o.discount_amount, o.delivery_date, o.delivery_slot,
              o.address_street, o.address_details, o.phone, o.comment, o.payment_method, o.leave_at_door,
              o.created_at, o.telegram_user_id, (r.id IS NOT NULL) AS has_review
       FROM orders o
       LEFT JOIN reviews r ON r.order_id = o.id
       WHERE o.id = $1`,
      [orderId]
    );
    const order = result.rows[0];

    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (String(order.telegram_user_id) !== String(telegramUserId)) {
      return res.status(403).json({ error: 'Нет доступа к этому заказу' });
    }

    res.json({
      id: order.id,
      status: order.status,
      items: order.items,
      total: order.total,
      discountAmount: order.discount_amount || 0,
      deliveryDate: order.delivery_date,
      deliverySlot: order.delivery_slot,
      addressStreet: order.address_street,
      addressDetails: order.address_details,
      phone: order.phone,
      comment: order.comment,
      leaveAtDoor: order.leave_at_door || false,
      paymentMethod: order.payment_method,
      createdAt: order.created_at,
      hasReview: order.has_review,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Пресет эмодзи для отзывов от клиентов (назначается случайно)
const REVIEW_EMOJIS = ['😊', '🌿', '🥕', '🧺', '👍'];

// Загрузка фото отзыва (публично, без admin-авторизации — отзывы оставляют
// обычные покупатели). Тот же multer + Cloudinary, что и у админского
// /api/admin/upload-image, просто без requireAuth и в отдельной папке.
app.post('/api/reviews/upload-photo', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const stream = cloudinary.uploader.upload_stream(
    { folder: 'prilavka/reviews', resource_type: 'image' },
    (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        return res.status(500).json({ error: 'Ошибка загрузки на Cloudinary' });
      }
      res.json({ url: result.secure_url });
    },
  );
  stream.end(req.file.buffer);
});

// Отправка отзыва по конкретному заказу (экран 7b). Один отзыв на заказ —
// повторная попытка получит 409 (см. уникальный индекс idx_reviews_order_id).
// Все отзывы создаются со status='pending' (публикуются только после
// модерации в админке — see /api/catalog: WHERE status = 'published').
app.post('/api/orders/:id/review', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { telegramUserId, firstName, area, stars, tags, text, photoUrl } = req.body || {};
  const starsNum = Math.min(5, Math.max(1, Number(stars) || 0));
  if (!telegramUserId || isNaN(orderId) || !starsNum) {
    return res.status(400).json({ error: 'Укажите telegramUserId, orderId и stars' });
  }
  try {
    const orderRes = await query(
      "SELECT id, telegram_user_id, status FROM orders WHERE id = $1",
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Заказ не найден' });
    if (String(order.telegram_user_id) !== String(telegramUserId)) {
      return res.status(403).json({ error: 'Нет доступа к этому заказу' });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Отзыв можно оставить только для доставленного заказа' });
    }

    const emoji = REVIEW_EMOJIS[Math.floor(Math.random() * REVIEW_EMOJIS.length)];
    const avatarUrl = await getTelegramAvatarUrl(telegramUserId);
    let review;
    try {
      const insertRes = await query(
        `INSERT INTO reviews (name, area, stars, text, emoji, status, telegram_user_id, order_id, tags, image_url, avatar_url)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          (firstName || 'Клиент').trim(),
          (area || '').trim() || 'Москва',
          starsNum,
          (text || '').trim() || null,
          emoji,
          telegramUserId,
          orderId,
          JSON.stringify(Array.isArray(tags) ? tags : []),
          photoUrl || null,
          avatarUrl,
        ]
      );
      review = insertRes.rows[0];
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'Вы уже оставляли отзыв по этому заказу' });
      throw e;
    }

    // +N баллов — только за отзыв с фото (см. миграцию 017).
    let pointsAwarded = 0;
    if (photoUrl) {
      pointsAwarded = Number(getSetting('review_photo_points')) || 0;
      if (pointsAwarded > 0) {
        await query(
          'UPDATE users SET points = points + $1, updated_at = now() WHERE telegram_id = $2',
          [pointsAwarded, telegramUserId]
        );
      }
    }

    res.status(201).json({ id: review.id, pointsAwarded });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// "Позже" на баннере/пуше отзыва — не предлагать повторно в тот же день для этого заказа.
app.post('/api/orders/:id/review-dismiss', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { telegramUserId } = req.body || {};
  if (!telegramUserId || isNaN(orderId)) {
    return res.status(400).json({ error: 'Укажите telegramUserId' });
  }
  try {
    const result = await query(
      `UPDATE orders SET review_dismissed_at = now()
       WHERE id = $1 AND telegram_user_id = $2 RETURNING id`,
      [orderId, telegramUserId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Заказ не найден' });
    res.json({ ok: true });
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
// hasReview/reviewDismissedAt — чтобы главная и профиль сами решали, показывать
// ли баннер/пуш "оставьте отзыв" для конкретного заказа (без отдельного запроса).
app.get('/api/users/:telegramId/orders', async (req, res) => {
  const { telegramId } = req.params;
  if (!telegramId || telegramId === '0') return res.json([]);
  try {
    const result = await query(
      `SELECT o.id, o.total, o.status, o.created_at, o.items, o.delivery_date, o.delivery_slot,
              o.review_dismissed_at, (r.id IS NOT NULL) AS has_review
       FROM orders o
       LEFT JOIN reviews r ON r.order_id = o.id
       WHERE o.telegram_user_id = $1
       ORDER BY o.created_at DESC
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
      hasReview: o.has_review,
      reviewDismissedAt: o.review_dismissed_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Текущий баланс баллов пользователя — лёгкий эндпоинт для корзины.
app.get('/api/users/:telegramId/balance', async (req, res) => {
  const { telegramId } = req.params;
  if (!telegramId || telegramId === '0') return res.json({ points: 0 });
  try {
    const result = await query('SELECT points FROM users WHERE telegram_id = $1', [telegramId]);
    res.json({ points: result.rows[0]?.points ?? 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Pending-награда пользователя (если есть) — для корзины и профиля.
app.get('/api/users/:telegramId/pending-reward', async (req, res) => {
  const { telegramId } = req.params;
  if (!telegramId || telegramId === '0') return res.json(null);
  try {
    const result = await query(
      `SELECT ur.id AS user_reward_id, ur.reward_id, r.title, r.emoji, r.description
       FROM user_rewards ur
       JOIN rewards r ON ur.reward_id = r.id
       WHERE ur.telegram_id = $1 AND ur.status = 'pending'
       LIMIT 1`,
      [telegramId]
    );
    res.json(result.rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обменять баллы на награду (транзакция: проверить баланс → списать → создать user_rewards).
app.post('/api/users/:telegramId/redeem-reward', async (req, res) => {
  const { telegramId } = req.params;
  const { rewardId } = req.body || {};
  if (!telegramId || telegramId === '0') return res.status(400).json({ error: 'Требуется авторизация' });
  if (!rewardId) return res.status(400).json({ error: 'Укажите rewardId' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const rewardRes = await client.query('SELECT * FROM rewards WHERE id = $1 AND is_active = true', [rewardId]);
    const reward = rewardRes.rows[0];
    if (!reward) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Награда не найдена или недоступна' });
    }

    const pendingRes = await client.query(
      "SELECT id FROM user_rewards WHERE telegram_id = $1 AND status = 'pending'",
      [telegramId]
    );
    if (pendingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'У вас уже есть активная награда — добавьте заказ, чтобы получить её' });
    }

    const userRes = await client.query('SELECT points FROM users WHERE telegram_id = $1', [telegramId]);
    const userRow = userRes.rows[0];
    if (!userRow) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    if (userRow.points < reward.points_cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Недостаточно баллов' });
    }

    await client.query(
      'UPDATE users SET points = points - $1, updated_at = now() WHERE telegram_id = $2',
      [reward.points_cost, telegramId]
    );

    await client.query(
      "INSERT INTO user_rewards (telegram_id, reward_id, status) VALUES ($1, $2, 'pending')",
      [telegramId, rewardId]
    );

    await client.query('COMMIT');
    res.json({ ok: true, pointsLeft: userRow.points - reward.points_cost });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
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
      discount: Number(getSetting('referral_discount')),
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
// Загрузка изображений через Cloudinary
// ============================================================

app.post('/api/admin/upload-image', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const stream = cloudinary.uploader.upload_stream(
    { folder: 'prilavka', resource_type: 'image' },
    (error, result) => {
      if (error) {
        console.error('Cloudinary upload error:', error);
        return res.status(500).json({ error: 'Ошибка загрузки на Cloudinary' });
      }
      res.json({ url: result.secure_url });
    },
  );
  stream.end(req.file.buffer);
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
    const [productRes, compositionRes] = await Promise.all([
      query('SELECT * FROM products WHERE id = $1', [req.params.id]),
      query('SELECT * FROM набор_состав WHERE product_id = $1 ORDER BY sort_order', [req.params.id]),
    ]);
    if (!productRes.rows[0]) return res.status(404).json({ error: 'Товар не найден' });
    res.json({
      ...toProductDTO(productRes.rows[0]),
      bundleComposition: compositionRes.rows.map(toBundleItemDTO),
    });
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
        (id, title, price, weight, emoji, bg, category, badge_type, badge_label, composition, suppliers, pricing, is_active, sort_order, image_url, is_bundle, subcategory_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
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
        p.imageUrl || null,
        p.isBundle === true,
        p.subcategoryId || null,
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
        image_url = $14,
        is_bundle = $15,
        subcategory_id = $16,
        updated_at = now()
       WHERE id = $17`,
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
        p.imageUrl !== undefined ? (p.imageUrl || null) : (cur.image_url || null),
        p.isBundle !== undefined ? p.isBundle === true : cur.is_bundle,
        p.subcategoryId !== undefined ? (p.subcategoryId || null) : (cur.subcategory_id || null),
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
// Состав набора (набор_состав) — CRUD для админки
// ============================================================

// Список позиций состава товара-набора
app.get('/api/admin/products/:id/composition', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT * FROM набор_состав WHERE product_id = $1 ORDER BY sort_order, id',
      [req.params.id]
    );
    res.json(result.rows.map(toBundleItemDTO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Добавить позицию в состав
app.post('/api/admin/products/:id/composition', requireAuth, async (req, res) => {
  const { itemName, itemEmoji, alternatives, isRemovable, sortOrder } = req.body || {};
  if (!itemName) return res.status(400).json({ error: 'itemName обязателен' });
  try {
    const productCheck = await query('SELECT id FROM products WHERE id = $1', [req.params.id]);
    if (!productCheck.rows[0]) return res.status(404).json({ error: 'Товар не найден' });

    const result = await query(
      `INSERT INTO набор_состав (product_id, item_name, item_emoji, alternatives, is_removable, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        req.params.id,
        itemName,
        itemEmoji || '',
        JSON.stringify(Array.isArray(alternatives) ? alternatives : []),
        isRemovable !== false,
        sortOrder ?? 0,
      ]
    );
    res.status(201).json(toBundleItemDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить позицию состава
app.put('/api/admin/products/:id/composition/:itemId', requireAuth, async (req, res) => {
  const { itemName, itemEmoji, alternatives, isRemovable, sortOrder } = req.body || {};
  try {
    const existing = await query(
      'SELECT * FROM набор_состав WHERE id = $1 AND product_id = $2',
      [req.params.itemId, req.params.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Позиция не найдена' });
    const cur = existing.rows[0];

    const result = await query(
      `UPDATE набор_состав SET
        item_name = $1, item_emoji = $2, alternatives = $3, is_removable = $4, sort_order = $5, updated_at = now()
       WHERE id = $6 AND product_id = $7 RETURNING *`,
      [
        itemName ?? cur.item_name,
        itemEmoji !== undefined ? itemEmoji : cur.item_emoji,
        alternatives !== undefined ? JSON.stringify(alternatives) : JSON.stringify(cur.alternatives),
        isRemovable !== undefined ? isRemovable !== false : cur.is_removable,
        sortOrder !== undefined ? sortOrder : cur.sort_order,
        req.params.itemId,
        req.params.id,
      ]
    );
    res.json(toBundleItemDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить позицию состава
app.delete('/api/admin/products/:id/composition/:itemId', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM набор_состав WHERE id = $1 AND product_id = $2',
      [req.params.itemId, req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Позиция не найдена' });
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
// Админские маршруты — подкатегории
// ============================================================

app.get('/api/admin/subcategories', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM subcategories ORDER BY category_id, sort_order ASC');
    res.json(result.rows.map((sc) => ({
      id: sc.id,
      name: sc.name,
      categoryId: sc.category_id,
      slug: sc.slug,
      sortOrder: sc.sort_order,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/subcategories', requireAuth, async (req, res) => {
  const { name, categoryId, sortOrder } = req.body || {};
  if (!name || !String(name).trim() || !categoryId) {
    return res.status(400).json({ error: 'Укажите name и categoryId' });
  }
  try {
    const slug = String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-]/gi, '');
    const result = await query(
      'INSERT INTO subcategories (name, category_id, slug, sort_order) VALUES ($1, $2, $3, $4) RETURNING *',
      [String(name).trim(), categoryId, slug, Number(sortOrder) || 0]
    );
    const sc = result.rows[0];
    res.status(201).json({ id: sc.id, name: sc.name, categoryId: sc.category_id, slug: sc.slug, sortOrder: sc.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/subcategories/:id', requireAuth, async (req, res) => {
  const { name, sortOrder } = req.body || {};
  try {
    const existing = await query('SELECT * FROM subcategories WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Подкатегория не найдена' });
    const cur = existing.rows[0];
    const newName = name !== undefined ? String(name).trim() : cur.name;
    const newSlug = name !== undefined
      ? newName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-]/gi, '')
      : cur.slug;
    const result = await query(
      'UPDATE subcategories SET name = $1, slug = $2, sort_order = $3, updated_at = now() WHERE id = $4 RETURNING *',
      [newName, newSlug, sortOrder !== undefined ? Number(sortOrder) : cur.sort_order, req.params.id]
    );
    const sc = result.rows[0];
    res.json({ id: sc.id, name: sc.name, categoryId: sc.category_id, slug: sc.slug, sortOrder: sc.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/subcategories/:id', requireAuth, async (req, res) => {
  try {
    const productsRes = await query('SELECT COUNT(*)::int AS count FROM products WHERE subcategory_id = $1', [req.params.id]);
    if ((productsRes.rows[0]?.count || 0) > 0) {
      return res.status(409).json({ error: 'Нельзя удалить подкатегорию: в ней есть товары' });
    }
    const result = await query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Подкатегория не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — районы доставки
// ============================================================

app.get('/api/admin/districts', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM districts ORDER BY sort_order ASC, id ASC');
    res.json(result.rows.map((d) => ({
      id: d.id, name: d.name, sortOrder: d.sort_order, isActive: d.is_active,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/districts', requireAuth, async (req, res) => {
  const { name, sortOrder } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Укажите название района' });
  }
  try {
    const result = await query(
      'INSERT INTO districts (name, sort_order) VALUES ($1, $2) RETURNING *',
      [String(name).trim(), Number(sortOrder) || 0]
    );
    const d = result.rows[0];
    res.status(201).json({ id: d.id, name: d.name, sortOrder: d.sort_order, isActive: d.is_active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/districts/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM districts WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Район не найден' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
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
        phone: o.phone || null,
        comment: o.comment,
        paymentMethod: o.payment_method,
        paymentStatus: o.payment_status,
        status: o.status,
        promoCode: o.promo_code,
        referralCode: o.referral_code,
        discountAmount: o.discount_amount,
        telegramUsername: o.telegram_username,
        telegramFirstName: o.telegram_first_name,
        leaveAtDoor: o.leave_at_door || false,
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
              [Number(getSetting('referral_points_reward')), referrer.telegram_id]
            );

            const referredRes = cur.telegram_user_id
              ? await query('SELECT telegram_id FROM users WHERE telegram_id = $1', [cur.telegram_user_id])
              : { rows: [] };
            const referredId = referredRes.rows[0]?.telegram_id;

            if (referredId) {
              await query(
                'INSERT INTO referral_rewards (referrer_id, referred_id, order_id, points_awarded) VALUES ($1,$2,$3,$4)',
                [referrer.telegram_id, referredId, o.id, Number(getSetting('referral_points_reward'))]
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
      const pointsToAward = Math.floor(Number(o.total) * (Number(getSetting('points_percent')) / 100));
      if (pointsToAward > 0) {
        try {
          const balanceBefore = await query(
            'SELECT points FROM users WHERE telegram_id = $1',
            [o.telegram_user_id]
          );
          const oldPoints = balanceBefore.rows[0]?.points ?? 0;

          await query(
            'UPDATE users SET points = points + $1, updated_at = now() WHERE telegram_id = $2',
            [pointsToAward, o.telegram_user_id]
          );

          const newPoints = oldPoints + pointsToAward;

          // Уведомление при пересечении порога: новый баланс >= стоимость награды, старый — нет
          const rewardRes = await query(
            `SELECT title, points_cost FROM rewards
             WHERE is_active = true AND points_cost <= $1 AND points_cost > $2
             ORDER BY points_cost ASC LIMIT 1`,
            [newPoints, oldPoints]
          );
          if (rewardRes.rows[0]) {
            const reward = rewardRes.rows[0];
            sendTelegramMessageToChat(
              o.telegram_user_id,
              `🎁 У вас ${newPoints} баллов — достаточно для получения награды «${reward.title}»! Откройте приложение чтобы забрать её.`
            );
          }
        } catch (e) {
          console.error('Ошибка начисления баллов за заказ:', e);
        }
      }
    }

    // Уведомляем пользователя о смене статуса (fire-and-forget)
    if (status && status !== cur.status && o.telegram_user_id && ORDER_STATUS_NOTIFICATIONS[status]) {
      sendTelegramMessageToChat(o.telegram_user_id, ORDER_STATUS_NOTIFICATIONS[status](o.id));
    }

    // Приглашение оставить отзыв при переходе в "delivered" (fire-and-forget)
    if (status === 'delivered' && cur.status !== 'delivered' && o.telegram_user_id) {
      sendReviewInvite(o.telegram_user_id, o.id).catch((e) =>
        console.error('sendReviewInvite error:', e)
      );
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
// Админские маршруты — отзывы
// ============================================================

app.get('/api/admin/reviews', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM reviews ORDER BY id DESC');
    res.json(result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      area: r.area,
      stars: r.stars,
      text: r.text,
      emoji: r.emoji,
      sortOrder: r.sort_order,
      imageUrl: r.image_url || null,
      status: r.status || 'published',
      telegramUserId: r.telegram_user_id || null,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/reviews', requireAuth, async (req, res) => {
  const { name, area, stars, text, emoji, sortOrder, imageUrl } = req.body || {};
  if (!name || !area || !text || !emoji) {
    return res.status(400).json({ error: 'Обязательные поля: name, area, text, emoji' });
  }
  try {
    const result = await query(
      `INSERT INTO reviews (name, area, stars, text, emoji, sort_order, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, area, Number(stars) || 5, text, emoji, Number(sortOrder) || 0, imageUrl || null]
    );
    const r = result.rows[0];
    res.status(201).json({ id: r.id, name: r.name, area: r.area, stars: r.stars, text: r.text, emoji: r.emoji, sortOrder: r.sort_order, imageUrl: r.image_url || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/reviews/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM reviews WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Отзыв не найден' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.patch('/api/admin/reviews/:id', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'Укажите status' });
  try {
    const result = await query(
      'UPDATE reviews SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Отзыв не найден' });
    const r = result.rows[0];
    res.json({ id: r.id, status: r.status });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Админские маршруты — последние доставки
// ============================================================

app.get('/api/admin/deliveries', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM deliveries ORDER BY sort_order ASC, id ASC');
    res.json(result.rows.map((d) => ({
      id: d.id,
      emoji: d.emoji,
      title: d.title,
      text: d.text,
      sortOrder: d.sort_order,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/deliveries', requireAuth, async (req, res) => {
  const { emoji, title, text, sortOrder } = req.body || {};
  if (!emoji || !title || !text) {
    return res.status(400).json({ error: 'Обязательные поля: emoji, title, text' });
  }
  try {
    const result = await query(
      `INSERT INTO deliveries (emoji, title, text, sort_order)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [emoji, title, text, Number(sortOrder) || 0]
    );
    const d = result.rows[0];
    res.status(201).json({ id: d.id, emoji: d.emoji, title: d.title, text: d.text, sortOrder: d.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/deliveries/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM deliveries WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
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
// Админские маршруты — статистика
// ============================================================

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const [
      revenueRes,
      statusCountsRes,
      usersCountRes,
      topProductsRes,
      revenueByDayRes,
    ] = await Promise.all([
      query(`
        SELECT COALESCE(SUM(total), 0)::int AS total_revenue
        FROM orders WHERE status = 'delivered'
      `),
      query(`
        SELECT status, COUNT(*)::int AS count
        FROM orders
        GROUP BY status
      `),
      query(`SELECT COUNT(*)::int AS count FROM users`),
      query(`
        SELECT
          item->>'title' AS title,
          SUM((item->>'qty')::int) AS total_qty
        FROM orders, jsonb_array_elements(items) AS item
        WHERE status != 'cancelled'
          AND (item->>'isReward')::boolean IS NOT TRUE
        GROUP BY item->>'title'
        ORDER BY total_qty DESC
        LIMIT 5
      `),
      query(`
        SELECT
          TO_CHAR(DATE(created_at AT TIME ZONE 'Europe/Moscow'), 'YYYY-MM-DD') AS day,
          SUM(total)::int AS revenue
        FROM orders
        WHERE status = 'delivered'
          AND created_at >= now() - INTERVAL '7 days'
        GROUP BY DATE(created_at AT TIME ZONE 'Europe/Moscow')
        ORDER BY day ASC
      `),
    ]);

    const statusCounts = {};
    for (const row of statusCountsRes.rows) {
      statusCounts[row.status] = row.count;
    }

    res.json({
      totalRevenue: revenueRes.rows[0].total_revenue,
      ordersByStatus: statusCounts,
      usersCount: usersCountRes.rows[0].count,
      topProducts: topProductsRes.rows.map((r) => ({
        title: r.title,
        totalQty: Number(r.total_qty),
      })),
      revenueByDay: revenueByDayRes.rows.map((r) => ({
        day: r.day,
        revenue: r.revenue,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Расписание доставки
// ============================================================

// Строит массив YYYY-MM-DD для N дней начиная с сегодня (по МСК).
function buildDateRange(days) {
  const result = [];
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    result.push(d.toISOString().slice(0, 10));
  }
  return result;
}

// Мерджит записи из БД с дефолтами для заданного диапазона дат.
function mergeSchedule(dates, rows) {
  const byDate = {};
  for (const r of rows) {
    byDate[r.date.toISOString().slice(0, 10)] = r;
  }
  return dates.map((date) => {
    const r = byDate[date];
    return {
      id: r?.id ?? null,
      date,
      isAvailable: r ? r.is_available : true,
      slot: r?.slot || getSetting('default_slot'),
      note: r?.note || null,
    };
  });
}

// Публичный: ближайшие 7 дней расписания доставки
app.get('/api/delivery-schedule', async (req, res) => {
  try {
    const dates = buildDateRange(7);
    const result = await query(
      `SELECT id, date, is_available, slot, note
       FROM delivery_schedule
       WHERE date = ANY($1::date[])`,
      [dates]
    );
    res.json(mergeSchedule(dates, result.rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Админ: те же 7 дней (с id для редактирования)
app.get('/api/admin/delivery-schedule', requireAuth, async (req, res) => {
  try {
    const dates = buildDateRange(7);
    const result = await query(
      `SELECT id, date, is_available, slot, note
       FROM delivery_schedule
       WHERE date = ANY($1::date[])`,
      [dates]
    );
    res.json(mergeSchedule(dates, result.rows));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Upsert переопределения для конкретной даты
app.post('/api/admin/delivery-schedule', requireAuth, async (req, res) => {
  const { date, isAvailable, slot, note } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Укажите date в формате YYYY-MM-DD' });
  }
  if (typeof isAvailable !== 'boolean') {
    return res.status(400).json({ error: 'isAvailable должен быть boolean' });
  }
  try {
    const result = await query(
      `INSERT INTO delivery_schedule (date, is_available, slot, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (date) DO UPDATE SET
         is_available = EXCLUDED.is_available,
         slot = EXCLUDED.slot,
         note = EXCLUDED.note,
         updated_at = now()
       RETURNING id, date, is_available, slot, note`,
      [date, isAvailable, slot || null, note || null]
    );
    const r = result.rows[0];
    res.json({
      id: r.id,
      date: r.date.toISOString().slice(0, 10),
      isAvailable: r.is_available,
      slot: r.slot || getSetting('default_slot'),
      note: r.note || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удалить переопределение (дата возвращается к дефолту)
app.delete('/api/admin/delivery-schedule/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM delivery_schedule WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Telegram-бот: сбор отзывов через long polling
// ============================================================

// Универсальный вызов Bot API. Возвращает result или null при ошибке.
async function botRequest(method, body) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data.ok ? data.result : null;
  } catch (e) {
    console.error(`botRequest ${method} error:`, e);
    return null;
  }
}

// Пытается получить URL аватарки пользователя из Telegram (для карточки
// отзыва на главной). Берём самый маленький доступный размер фото — для
// круглого аватара 26px незачем тянуть 640x640. Best-effort: null при любой
// ошибке (нет фото, бот не может достучаться и т.д.) — тогда карточка
// покажет заглушку с инициалом.
async function getTelegramAvatarUrl(telegramUserId) {
  try {
    const photos = await botRequest('getUserProfilePhotos', { user_id: telegramUserId, limit: 1 });
    const fileId = photos?.photos?.[0]?.[0]?.file_id;
    if (!fileId) return null;
    const file = await botRequest('getFile', { file_id: fileId });
    return file?.file_path ? `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}` : null;
  } catch (e) {
    console.error('getTelegramAvatarUrl error:', e);
    return null;
  }
}

// Отправляет пуш "оставьте отзыв" с кнопкой, открывающей экран отзыва прямо
// в мини-приложении (web_app-кнопка — Bot API 6.1+, работает в любом чате
// с ботом без регистрации домена в BotFather).
// Не отправляет повторно, если отзыв на этот заказ уже есть.
async function sendReviewInvite(telegramId, orderId) {
  const existing = await query('SELECT 1 FROM reviews WHERE order_id = $1 LIMIT 1', [orderId]);
  if (existing.rows.length > 0) return;

  await botRequest('sendMessage', {
    chat_id: telegramId,
    text: `🙏 Спасибо за заказ ${fmtOrderId(orderId)}! Как вам доставка?`,
    reply_markup: {
      inline_keyboard: [[
        { text: 'Оценить заказ', web_app: { url: `${MINI_APP_URL}/review/${orderId}` } },
      ]],
    },
  });
}

// ============================================================
// Админские маршруты — настройки
// ============================================================

app.get('/api/admin/settings', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT key, value, description FROM settings ORDER BY key');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/settings/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body || {};
  if (value == null || String(value).trim() === '') {
    return res.status(400).json({ error: 'Укажите value' });
  }
  try {
    const result = await query(
      'UPDATE settings SET value = $1 WHERE key = $2 RETURNING key, value, description',
      [String(value).trim(), key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Настройка не найдена' });
    }
    settingsCache[key] = String(value).trim();
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Запуск сервера
// ============================================================

loadSettings().catch((e) => console.error('loadSettings error:', e));

app.listen(PORT, () => {
  console.log(`Прилавка API запущен на порту ${PORT}`);
});
