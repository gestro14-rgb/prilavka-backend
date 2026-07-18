import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
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
// Suggest API — отдельный от Geocoder сервис в кабинете Яндекса, свой ключ
// (геокодер-ключ им не подходит). Автоподсказки при вводе адреса.
const YANDEX_SUGGEST_API_KEY = process.env.YANDEX_SUGGEST_API_KEY || '';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';
// Публичный URL мини-приложения — для web_app-кнопки в пуше "оставьте отзыв".
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://prilavka-app-production.up.railway.app';
// Публичный URL этого API — куда Telegram будет слать апдейты вебхуком.
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || 'https://prilavka-backend-production.up.railway.app';
// Секрет вебхука — генерируется при каждом старте и тут же регистрируется в
// setWebhook, поэтому не нужно хранить его отдельно между рестартами.
const TELEGRAM_WEBHOOK_SECRET = crypto.randomBytes(32).toString('hex');

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
    // Свободно переименовываемый человекочитаемый идентификатор — независим
    // от id (см. migration 030), который остаётся неизменным опорой для
    // reviews/набор_состав/home_product_shelves и orders.items (JSON-снимок).
    slug: row.slug || row.id,
    title: row.title,
    price: row.price,
    weight: row.weight,
    emoji: row.emoji,
    bg: row.bg,
    category: row.category,
    badge: row.badge_type
      ? { type: row.badge_type, label: row.badge_label, color: row.badge_color || null }
      : null,
    composition: row.composition,
    suppliers: row.suppliers,
    pricing: row.pricing,
    isActive: row.is_active,
    // "Разобрали" (DESIGN.md §4.1) — отдельно от isActive: товар остаётся
    // в каталоге, просто в особом визуальном состоянии (см. ProductCard.jsx).
    inStock: row.in_stock,
    sortOrder: row.sort_order,
    imageUrl: row.image_url || null,
    // Отдельная картинка для блока "Готовые наборы" на Главной — независима
    // от imageUrl (карточка/страница товара). Пусто → фронт сам берёт imageUrl.
    homeImageUrl: row.home_image_url || null,
    isBundle: row.is_bundle ?? false,
    subcategoryId: row.subcategory_id ?? null,
    nutrition: row.nutrition ?? null,
  };
}

// purchase_price — закупочная цена, вход для модуля ценообразования.
// Намеренно НЕ в toProductDTO: это себестоимость, а toProductDTO отдаёт и
// публичный /api/catalog — админские product-роуты подмешивают поле сами.
function toAdminProductDTO(row) {
  return { ...toProductDTO(row), purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : null };
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

// votedReviewIds — Set id отзывов, за которые уже проголосовал текущий
// пользователь (см. resolveUserOptional) — пусто/не передан для анонима.
function toReviewDTO(row, votedReviewIds) {
  return {
    id: row.id,
    name: row.name,
    area: row.area,
    stars: row.stars,
    text: row.text,
    emoji: row.emoji,
    imageUrl: row.image_url || null,
    orderId: row.order_id || null,
    // avatar_url хранит только Telegram file_id (не протухает, не содержит
    // токена) — резолвится в реальную картинку через прокси-эндпоинт ниже.
    avatarUrl: row.avatar_url ? `${BACKEND_PUBLIC_URL}/api/avatar/${row.avatar_url}` : null,
    helpfulCount: row.helpful_count ?? 0,
    helpfulVotedByMe: votedReviewIds ? votedReviewIds.has(row.id) : false,
  };
}

// Множество id отзывов из reviewIds, за которые уже проголосовал userId —
// один лёгкий запрос вместо JOIN в каждом из мест, отдающих список отзывов.
async function loadHelpfulVotedIds(userId, reviewIds) {
  if (!userId || reviewIds.length === 0) return new Set();
  const result = await query(
    'SELECT review_id FROM review_helpful_votes WHERE user_id = $1 AND review_id = ANY($2)',
    [userId, reviewIds]
  );
  return new Set(result.rows.map((r) => r.review_id));
}

// Агрегат для сводки рейтинга/гистограммы/чипов-фильтров — переиспользуется
// в /api/catalog (компактная сводка на Главной) и /api/reviews (полная сводка
// на /reviews). Всегда без учёта rating/photo-фильтра запроса, иначе цифры
// на чипах менялись бы при клике по чипу.
const REVIEW_STATS_QUERY = `
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE image_url IS NOT NULL)::int AS with_photo,
    COUNT(*) FILTER (WHERE stars = 5)::int AS stars_5,
    COUNT(*) FILTER (WHERE stars = 4)::int AS stars_4,
    COUNT(*) FILTER (WHERE stars = 3)::int AS stars_3,
    COUNT(*) FILTER (WHERE stars = 2)::int AS stars_2,
    COUNT(*) FILTER (WHERE stars = 1)::int AS stars_1,
    COALESCE(AVG(stars), 0)::float AS avg_stars
  FROM reviews
  WHERE status = 'published'
`;

function toReviewStatsDTO(row) {
  return {
    total: row.total,
    withPhoto: row.with_photo,
    avgStars: Math.round(row.avg_stars * 10) / 10,
    histogram: { 5: row.stars_5, 4: row.stars_4, 3: row.stars_3, 2: row.stars_2, 1: row.stars_1 },
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

// Проверка подписи Telegram initData — алгоритм из официальной документации
// (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
// secret_key = HMAC_SHA256(<bot_token>, "WebAppData"),
// hash = HEX(HMAC_SHA256(data_check_string, secret_key)),
// data_check_string — все поля кроме hash, отсортированные по ключу, "key=value" через \n.
// Раньше сервер верил telegramId, который просто прислал клиент в теле/URL
// запроса — эта функция закрывает именно эту дыру.
const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60; // сутки — как рекомендует Telegram

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > INIT_DATA_MAX_AGE_SEC) return null;

  const userRaw = params.get('user');
  if (!userRaw) return null;
  try {
    return { user: JSON.parse(userRaw), authDate };
  } catch {
    return null;
  }
}

// Единая проверка личности для пользовательских (не админских) эндпоинтов —
// один и тот же заголовок Authorization: Bearer <токен>, но токен бывает
// двух видов: JWT нашей выдачи (телефонный вход, /api/auth/verify-code) или
// сырой Telegram initData (Mini App). JWT всегда 3 base64url-сегмента через
// точку — по этому и различаем, не по отдельному полю/пути.
const JWT_SHAPE = /^[\w-]+\.[\w-]+\.[\w-]+$/;

async function resolveUser(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  try {
    let row;
    if (JWT_SHAPE.test(token)) {
      const payload = jwt.verify(token, JWT_SECRET);
      const userRes = await query('SELECT * FROM users WHERE id = $1', [payload.sub]);
      row = userRes.rows[0];
      if (!row) return res.status(401).json({ error: 'Пользователь не найден' });
    } else {
      const verified = verifyTelegramInitData(token, TELEGRAM_BOT_TOKEN);
      if (!verified) {
        return res.status(401).json({ error: 'Недействительные данные Telegram' });
      }
      const tgUser = verified.user;
      row = await upsertUser(tgUser.id, tgUser.username, tgUser.first_name);
    }
    // req.user — полная строка (username/first_name/telegram_id/phone), не
    // только id, чтобы эндпоинтам вроде POST /api/orders не нужно было
    // делать отдельный SELECT ради имени для Telegram-уведомления и т.п.
    req.user = row;
    req.userId = row.id;
    req.telegramId = row.telegram_id;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Недействительный или просроченный токен' });
  }
}

// Как resolveUser, но для публичных GET-эндпоинтов: отсутствующий/битый
// токен не 401-ит запрос, а просто оставляет req.userId = null (аноним) —
// нужно, чтобы одна и та же выдача отзывов работала и без входа, и с ним
// (помечая helpfulVotedByMe для тех, кто уже проголосовал).
async function resolveUserOptional(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  req.userId = null;
  if (!token) return next();

  try {
    let row;
    if (JWT_SHAPE.test(token)) {
      const payload = jwt.verify(token, JWT_SECRET);
      const userRes = await query('SELECT id FROM users WHERE id = $1', [payload.sub]);
      row = userRes.rows[0];
    } else {
      const verified = verifyTelegramInitData(token, TELEGRAM_BOT_TOKEN);
      if (verified) {
        row = await upsertUser(verified.user.id, verified.user.username, verified.user.first_name);
      }
    }
    if (row) req.userId = row.id;
  } catch (e) {
    // Битый/просроченный токен на публичном эндпоинте — деградируем до
    // анонима, а не 401, чтобы список отзывов не переставал грузиться.
  }
  next();
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

// Автоподсказки при вводе адреса — Yandex Suggest API (v1/suggest), не
// путать с geocodeAddress выше: тот переводит уже готовый адрес в
// координаты, этот — достраивает варианты по неполному тексту на каждую
// пару-тройку введённых символов. types=geo — только топонимы/адреса, без
// организаций/бизнесов, которые Suggest тоже умеет отдавать.
// title — часть, которая продолжает ввод пользователя; subtitle — контекст
// (город/регион), объединяем в value — то, что реально подставится в поле.
async function suggestAddress(text) {
  if (!YANDEX_SUGGEST_API_KEY) {
    throw new Error('YANDEX_SUGGEST_API_KEY не настроен на сервере');
  }
  const url = new URL('https://suggest-maps.yandex.ru/v1/suggest');
  url.searchParams.set('apikey', YANDEX_SUGGEST_API_KEY);
  url.searchParams.set('text', text);
  url.searchParams.set('lang', 'ru_RU');
  url.searchParams.set('types', 'geo');
  url.searchParams.set('results', '5');

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Suggest API вернул ошибку: ${res.status}`);
  }
  const data = await res.json();
  const results = Array.isArray(data?.results) ? data.results : [];
  return results.map((r) => {
    const label = r.title?.text || '';
    const sublabel = r.subtitle?.text || '';
    return { label, sublabel, value: sublabel ? `${label}, ${sublabel}` : label };
  });
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
app.get('/api/catalog', resolveUserOptional, async (req, res) => {
  try {
    const [categoriesRes, subcatsRes, productsRes, reviewsRes, reviewStatsRes, deliveriesRes, compositionsRes, productRatingsRes, homeShelvesRes] = await Promise.all([
      query('SELECT * FROM categories ORDER BY sort_order ASC'),
      query('SELECT * FROM subcategories ORDER BY category_id, sort_order ASC'),
      // Группировка по подкатегории сохраняется, но внутри неё (и там, где
      // подкатегории вовсе нет — например, у "Наборы") решает sort_order
      // самого товара, а не алфавит: раньше p.sort_order здесь не
      // участвовал вообще, поэтому ручной порядок из ProductForm ни на что
      // не влиял в каталоге приложения.
      query(`SELECT p.* FROM products p
             LEFT JOIN subcategories sc ON p.subcategory_id = sc.id
             WHERE p.is_active = true
             ORDER BY sc.sort_order ASC NULLS LAST, p.sort_order ASC, p.title ASC`),
      // Новые сверху. У reviews нет created_at — id (SERIAL) монотонно растёт
      // с вставкой, так что id DESC надёжно даёт порядок "новые первые".
      query("SELECT * FROM reviews WHERE status = 'published' ORDER BY id DESC"),
      // Сводка рейтинга/гистограммы для блока отзывов на Главной (см.
      // toReviewStatsDTO) — тот же агрегат, что и в GET /api/reviews.
      query(REVIEW_STATS_QUERY),
      query('SELECT * FROM deliveries ORDER BY sort_order ASC'),
      query('SELECT * FROM набор_состав ORDER BY product_id, sort_order'),
      // Агрегат рейтинга по товару — считаем один раз здесь, а не N+1 запросом
      // на каждую карточку каталога (см. GET /api/products/:id/reviews для
      // детального списка отзывов на странице товара).
      query(
        `SELECT product_id, COUNT(*)::int AS count, AVG(stars)::float AS avg_stars
         FROM reviews WHERE status = 'published' AND product_id IS NOT NULL
         GROUP BY product_id`
      ),
      // Ручные подборки витрин Главной (см. migrations/024) — только активные
      // товары, порядок = sort_order. Пустая витрина здесь = фронт сам
      // возвращается к автоподбору по badge_type (см. Home.jsx).
      query(
        `SELECT hps.shelf, hps.product_id
         FROM home_product_shelves hps
         JOIN products p ON p.id = hps.product_id
         WHERE p.is_active = true
         ORDER BY hps.shelf, hps.sort_order ASC`
      ),
    ]);

    const votedReviewIds = await loadHelpfulVotedIds(req.userId, reviewsRes.rows.map((r) => r.id));

    const compositionsByProduct = {};
    for (const row of compositionsRes.rows) {
      if (!compositionsByProduct[row.product_id]) compositionsByProduct[row.product_id] = [];
      compositionsByProduct[row.product_id].push(toBundleItemDTO(row));
    }

    const ratingByProduct = {};
    for (const row of productRatingsRes.rows) {
      ratingByProduct[row.product_id] = { avgStars: Math.round(row.avg_stars * 10) / 10, count: row.count };
    }

    const homeShelves = {};
    for (const row of homeShelvesRes.rows) {
      if (!homeShelves[row.shelf]) homeShelves[row.shelf] = [];
      homeShelves[row.shelf].push(row.product_id);
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
        rating: ratingByProduct[row.id] ?? null,
      })),
      reviews: reviewsRes.rows.map((row) => toReviewDTO(row, votedReviewIds)),
      reviewStats: toReviewStatsDTO(reviewStatsRes.rows[0]),
      deliveries: deliveriesRes.rows.map((d) => ({
        emoji: d.emoji,
        title: d.title,
        text: d.text,
        imageUrl: d.image_url || null,
      })),
      // Ручные подборки: { hits: [productId, ...], seasonal: [productId, ...] }.
      // Заголовок/подзаголовок "Сейчас в сезоне" — из settings (редактируется
      // в админке так же, как остальные настройки).
      homeShelves,
      homeContent: {
        seasonalTitle: getSetting('home_seasonal_title') || 'Сейчас в сезоне',
        seasonalSubtitle: getSetting('home_seasonal_subtitle') || '',
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Полный список одобренных отзывов с пагинацией — для страницы /reviews
// ("Все отзывы"). /api/catalog отдаёт их же, но без пагинации — там это
// нормально, пока Home показывает только первые 4.
app.get('/api/reviews', resolveUserOptional, async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  // Опциональные фильтры чипов ("5★", "С фото") — серверные, не клиентские:
  // у списка уже есть пагинация, клиентский фильтр по уже загруженной
  // странице показывал бы неполную выборку вместо всех подходящих отзывов.
  const params = [];
  let where = "WHERE status = 'published'";
  const rating = parseInt(req.query.rating, 10);
  if (rating >= 1 && rating <= 5) {
    params.push(rating);
    where += ` AND stars = $${params.length}`;
  }
  if (req.query.photo === '1') {
    where += ' AND image_url IS NOT NULL';
  }
  // Берём на 1 больше лимита — если пришло больше, значит есть следующая страница.
  params.push(limit + 1);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;

  try {
    const [listRes, statsRes] = await Promise.all([
      query(
        `SELECT * FROM reviews ${where} ORDER BY id DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      ),
      // Сводка/гистограмма — всегда по всем отзывам, без учёта rating/photo
      // выше, иначе цифры на чипах "прыгали" бы при клике по чипу.
      query(REVIEW_STATS_QUERY),
    ]);
    const hasMore = listRes.rows.length > limit;
    const pageRows = listRes.rows.slice(0, limit);
    const votedReviewIds = await loadHelpfulVotedIds(req.userId, pageRows.map((r) => r.id));
    res.json({
      reviews: pageRows.map((row) => toReviewDTO(row, votedReviewIds)),
      hasMore,
      stats: toReviewStatsDTO(statsRes.rows[0]),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отзывы на конкретный товар — для секции "Отзывы на этот товар" в карточке
// товара (ProductDetail). Тот же toReviewDTO, что и у общего списка /api/reviews.
app.get('/api/products/:id/reviews', resolveUserOptional, async (req, res) => {
  const productId = req.params.id;
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  try {
    const [listRes, statsRes] = await Promise.all([
      query(
        "SELECT * FROM reviews WHERE product_id = $1 AND status = 'published' ORDER BY id DESC LIMIT $2 OFFSET $3",
        [productId, limit + 1, offset]
      ),
      query(
        "SELECT COUNT(*)::int AS count, COALESCE(AVG(stars), 0)::float AS avg_stars FROM reviews WHERE product_id = $1 AND status = 'published'",
        [productId]
      ),
    ]);
    const hasMore = listRes.rows.length > limit;
    const pageRows = listRes.rows.slice(0, limit);
    const votedReviewIds = await loadHelpfulVotedIds(req.userId, pageRows.map((r) => r.id));
    res.json({
      reviews: pageRows.map((row) => toReviewDTO(row, votedReviewIds)),
      hasMore,
      count: statsRes.rows[0].count,
      avgStars: Math.round(statsRes.rows[0].avg_stars * 10) / 10,
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

// Автоподсказки для поля "Улица и дом" (CheckoutAddress.jsx) — дергается с
// debounce на каждый ввод, поэтому короткий текст не гоняет внешний API зря.
// Прокси нужен, чтобы серверный YANDEX_SUGGEST_API_KEY не светился в браузере.
app.get('/api/address-suggest', async (req, res) => {
  const text = (req.query.query || '').toString().trim();
  if (text.length < 3) {
    return res.json({ suggestions: [] });
  }
  try {
    const suggestions = await suggestAddress(text);
    res.json({ suggestions });
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

// Создать заказ (из мини-приложения или браузера). Сохраняет в базу и
// присылает уведомление в Telegram. Личность — из resolveUser (JWT
// телефонного входа ИЛИ проверенный Telegram initData), не из тела запроса:
// раньше клиент присылал telegramUser напрямую и сервер верил на слово —
// значит мог начислить/списать баллы, применить промокод или отметить чужую
// pending-награду использованной от имени произвольного telegramId.
app.post('/api/orders', resolveUser, async (req, res) => {
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
    promoCode,
    referralCode,
    pointsToSpend,
    leaveAtDoor,
  } = req.body || {};
  const telegramUser = req.telegramId
    ? { id: req.telegramId, username: req.user.username, firstName: req.user.first_name }
    : null;

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

    // Применяем баллы — req.userId есть всегда (resolveUser обязателен для
    // этого эндпоинта), поэтому это уже работает и для телефонного входа,
    // не только для Telegram, как было раньше (гейт был telegramUser?.id).
    let pointsSpent = 0;
    if (!appliedPromo && !appliedReferral && pointsToSpend > 0) {
      const maxByPercent = Math.floor(total * (Number(getSetting('max_points_spend_percent')) / 100));
      const allowed = Math.min(pointsToSpend, maxByPercent);
      if (allowed > 0) {
        const balance = req.user.points ?? 0;
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
         WHERE ur.user_id = $1 AND ur.status = 'pending'
         LIMIT 1`,
        [req.userId]
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
        (items, total, delivery_date, delivery_slot, address_street, address_details, phone, comment, payment_method, promo_code, discount_amount, telegram_user_id, telegram_username, telegram_first_name, referral_code, leave_at_door, user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
        req.userId,
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
    if (pointsSpent > 0) {
      await query(
        'UPDATE users SET points = GREATEST(0, points - $1), updated_at = now() WHERE id = $2',
        [pointsSpent, req.userId]
      );
    }

    // Помечаем pending-награду как использованную
    if (pendingReward) {
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

// ============================================================
// Аналитика поведения (публично — пишет фронт мини-приложения)
// ============================================================

// Принимает одно событие аналитики. Без авторизации (обычные пользователи),
// но с базовой валидацией — sessionId и eventType обязательны, остальное
// опционально. Фронт шлёт это fire-and-forget и игнорирует любой ответ,
// поэтому ошибки здесь не должны ничего ронять — только логируются.
app.post('/api/analytics/event', async (req, res) => {
  const { sessionId, eventType, screenName, metadata, userId } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string' || !eventType || typeof eventType !== 'string') {
    return res.status(400).json({ error: 'Укажите sessionId и eventType' });
  }
  try {
    await query(
      'INSERT INTO analytics_events (user_id, session_id, event_type, screen_name, metadata) VALUES ($1, $2, $3, $4, $5)',
      [
        userId || null,
        sessionId,
        eventType,
        screenName || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    res.status(201).json({ ok: true });
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

// Отправка отзыва по заказу (экран 7b). Тело поддерживает два формата:
//  - legacy: { telegramUserId, firstName, area, stars, tags, text, photoUrl } —
//    один отзыв на заказ целиком, product_id = NULL (негативные 1-3★, где
//    претензия к заказу/доставке, а не к конкретному товару).
//  - per-product: то же самое + items: [{ productId, stars }, ...] — товаров
//    в заказе несколько, каждому своя оценка звёздами, текст/фото/теги общие.
//    Вставляется по строке в reviews на каждый productId в одной транзакции;
//    баллы за фото начисляются один раз за запрос, а не за товар.
// Один отзыв на пару (order_id, product_id) — повторная попытка получит 409
// (см. уникальный индекс idx_reviews_order_product, миграция 021).
// Все отзывы создаются со status='pending' (публикуются только после
// модерации в админке — see /api/catalog: WHERE status = 'published').
app.post('/api/orders/:id/review', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const { telegramUserId, firstName, area, stars, tags, text, photoUrl, items } = req.body || {};
  const starsNum = Math.min(5, Math.max(1, Number(stars) || 0));
  if (!telegramUserId || isNaN(orderId) || !starsNum) {
    return res.status(400).json({ error: 'Укажите telegramUserId, orderId и stars' });
  }

  let reviewRows;
  if (Array.isArray(items) && items.length > 0) {
    reviewRows = items
      .map((it) => ({
        productId: it?.productId != null ? String(it.productId) : null,
        stars: Math.min(5, Math.max(1, Number(it?.stars) || starsNum)),
      }))
      .filter((r) => r.productId);
    if (reviewRows.length === 0) {
      return res.status(400).json({ error: 'items должен содержать productId' });
    }
  } else {
    reviewRows = [{ productId: null, stars: starsNum }];
  }

  const avatarFileId = await getTelegramAvatarFileId(telegramUserId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const orderRes = await client.query(
      "SELECT id, telegram_user_id, status, items FROM orders WHERE id = $1 FOR UPDATE",
      [orderId]
    );
    const order = orderRes.rows[0];
    if (!order) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Заказ не найден' }); }
    if (String(order.telegram_user_id) !== String(telegramUserId)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Нет доступа к этому заказу' });
    }
    if (order.status !== 'delivered') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Отзыв можно оставить только для доставленного заказа' });
    }

    // productId в теле запроса должен реально входить в состав заказа —
    // не даём оставить отзыв на чужой товар от имени этого заказа.
    const orderProductIds = new Set((order.items || []).map((i) => String(i.id)));
    for (const r of reviewRows) {
      if (!orderProductIds.has(r.productId)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Товар ${r.productId} не найден в этом заказе` });
      }
    }

    const insertedIds = [];
    try {
      for (const r of reviewRows) {
        const emoji = REVIEW_EMOJIS[Math.floor(Math.random() * REVIEW_EMOJIS.length)];
        const insertRes = await client.query(
          `INSERT INTO reviews (name, area, stars, text, emoji, status, telegram_user_id, order_id, product_id, tags, image_url, avatar_url)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            (firstName || 'Клиент').trim(),
            (area || '').trim() || 'Москва',
            r.stars,
            (text || '').trim() || null,
            emoji,
            telegramUserId,
            orderId,
            r.productId,
            JSON.stringify(Array.isArray(tags) ? tags : []),
            photoUrl || null,
            avatarFileId,
          ]
        );
        insertedIds.push(insertRes.rows[0].id);
      }
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return res.status(409).json({ error: 'Вы уже оставляли отзыв по этому товару из этого заказа' });
      throw e;
    }

    // +N баллов — только за отзыв с фото, один раз за запрос (см. миграцию 017).
    let pointsAwarded = 0;
    if (photoUrl) {
      pointsAwarded = Number(getSetting('review_photo_points')) || 0;
      if (pointsAwarded > 0) {
        await client.query(
          'UPDATE users SET points = points + $1, updated_at = now() WHERE telegram_id = $2',
          [pointsAwarded, telegramUserId]
        );
      }
    }

    await client.query('COMMIT');
    res.status(201).json({ ids: insertedIds, pointsAwarded });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
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

// ============================================================
// Авторизация по телефону (браузер, вне Telegram)
// ============================================================

const SMS_RU_API_ID = process.env.SMS_RU_API_ID || '';
const VERIFICATION_CODE_TTL_SEC = 5 * 60;
const VERIFICATION_CODE_RESEND_COOLDOWN_SEC = 60;
const VERIFICATION_CODE_MAX_ATTEMPTS = 5;

// +7XXXXXXXXXX — единый формат хранения/сравнения. Достаточно строгая
// нормализация (10 цифр после кода страны) — сложные кейсы (другие страны)
// сюда пока не входят, аудитория продукта — Россия.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) {
    return '+7' + digits.slice(1);
  }
  if (digits.length === 10) return '+7' + digits;
  return null;
}

function generateVerificationCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 цифры
}

// SMS.ru HTTP API (sms.ru/api) — простой GET, JSON-ответ. Без SMS_RU_API_ID
// (ключ ещё не добавлен в Railway) код просто пишется в лог сервера — чтобы
// можно было доразработать и проверить остальной флоу до подключения
// реального провайдера, а не блокироваться на нём.
async function sendSms(phone, text) {
  if (!SMS_RU_API_ID) {
    console.log(`[SMS.ru не настроен — DEV] ${phone}: ${text}`);
    return;
  }
  const url = new URL('https://sms.ru/sms/send');
  url.searchParams.set('api_id', SMS_RU_API_ID);
  url.searchParams.set('to', phone);
  url.searchParams.set('msg', text);
  url.searchParams.set('json', '1');
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`SMS.ru: ${data.status_text || data.status_code || 'неизвестная ошибка'}`);
  }
}

// Аналог upsertUser, но по телефону — для входа без Telegram. ON CONFLICT
// нацелен на users_phone_key (миграция 028) — партиционный уникальный
// индекс, поэтому WHERE phone IS NOT NULL обязателен в самом ON CONFLICT.
async function upsertUserByPhone(phone) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    try {
      const result = await query(
        `INSERT INTO users (phone, referral_code)
         VALUES ($1, $2)
         ON CONFLICT (phone) WHERE phone IS NOT NULL DO UPDATE SET
           updated_at = now()
         RETURNING *`,
        [phone, code]
      );
      return result.rows[0];
    } catch (e) {
      if (e.code === '23505' && e.detail?.includes('referral_code')) continue;
      throw e;
    }
  }
  throw new Error('Не удалось сгенерировать уникальный реферальный код');
}

app.post('/api/auth/request-code', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Укажите корректный номер телефона' });
  }
  try {
    const recent = await query(
      `SELECT created_at FROM phone_verification_codes
       WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    const last = recent.rows[0];
    if (last && (Date.now() - new Date(last.created_at).getTime()) / 1000 < VERIFICATION_CODE_RESEND_COOLDOWN_SEC) {
      return res.status(429).json({ error: 'Код уже отправлен — попробуйте через минуту' });
    }

    const code = generateVerificationCode();
    await query(
      `INSERT INTO phone_verification_codes (phone, code, expires_at)
       VALUES ($1, $2, now() + interval '${VERIFICATION_CODE_TTL_SEC} seconds')`,
      [phone, code]
    );
    await sendSms(phone, `Код для входа в Прилавку: ${code}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось отправить код — попробуйте ещё раз' });
  }
});

app.post('/api/auth/verify-code', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  if (!phone || !code) {
    return res.status(400).json({ error: 'Укажите телефон и код' });
  }
  try {
    const result = await query(
      `SELECT * FROM phone_verification_codes
       WHERE phone = $1 AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    const row = result.rows[0];
    if (!row) {
      return res.status(400).json({ error: 'Код не найден или истёк — запросите новый' });
    }
    if (row.attempts >= VERIFICATION_CODE_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Слишком много попыток — запросите новый код' });
    }
    if (row.code !== code) {
      await query('UPDATE phone_verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return res.status(400).json({ error: 'Неверный код' });
    }

    await query('DELETE FROM phone_verification_codes WHERE phone = $1', [phone]);
    const user = await upsertUserByPhone(phone);
    const token = jwt.sign({ sub: user.id, phone: user.phone }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Статистика пользователя: уровень лояльности, эко-счётчик, реферальный код и баллы.
// Личность уже установлена resolveUser (телефонный JWT ИЛИ проверенный
// Telegram initData) — сам эндпоинт больше никого не апсертит и не
// принимает telegramId откуда-либо от клиента.
app.get('/api/me/stats', resolveUser, async (req, res) => {
  try {
    const userRecord = req.user; // resolveUser уже загрузил строку целиком
    const ordersRes = await query('SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1', [req.userId]);

    const ordersCount = ordersRes.rows[0]?.count || 0;
    const level = getLoyaltyLevel(ordersCount);
    const eco = {
      packagingSaved: ordersCount * 4,
      co2SavedKg: Math.round(ordersCount * 0.5 * 10) / 10,
    };

    // Реферальная программа остаётся Telegram-only (referred_by_id
    // по-прежнему ссылается на telegram_id, см. план) — у телефонного
    // пользователя userRecord.telegram_id будет NULL, и WHERE ... = NULL
    // в SQL корректно даёт 0 (не требует отдельной ветки).
    const referralsRes = await query(
      'SELECT COUNT(*)::int AS count FROM users WHERE referred_by_id = $1',
      [userRecord.telegram_id]
    );

    res.json({
      ordersCount,
      level,
      eco,
      referralCode: userRecord.referral_code,
      points: userRecord.points,
      referralsCount: referralsRes.rows[0]?.count || 0,
      referralPointsReward: Number(getSetting('referral_points_reward')),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Последние 10 заказов пользователя — для истории в профиле.
// hasReview/reviewDismissedAt — чтобы главная и профиль сами решали, показывать
// ли баннер/пуш "оставьте отзыв" для конкретного заказа (без отдельного запроса).
app.get('/api/me/orders', resolveUser, async (req, res) => {
  try {
    const result = await query(
      `SELECT o.id, o.total, o.status, o.created_at, o.items, o.delivery_date, o.delivery_slot,
              o.review_dismissed_at, (r.id IS NOT NULL) AS has_review
       FROM orders o
       LEFT JOIN reviews r ON r.order_id = o.id
       WHERE o.user_id = $1
       ORDER BY o.created_at DESC
       LIMIT 10`,
      [req.userId]
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
app.get('/api/me/balance', resolveUser, async (req, res) => {
  res.json({ points: req.user.points ?? 0 });
});

// Pending-награда пользователя (если есть) — для корзины и профиля.
app.get('/api/me/pending-reward', resolveUser, async (req, res) => {
  try {
    const result = await query(
      `SELECT ur.id AS user_reward_id, ur.reward_id, r.title, r.emoji, r.description
       FROM user_rewards ur
       JOIN rewards r ON ur.reward_id = r.id
       WHERE ur.user_id = $1 AND ur.status = 'pending'
       LIMIT 1`,
      [req.userId]
    );
    res.json(result.rows[0] || null);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обменять баллы на награду (транзакция: проверить баланс → списать → создать user_rewards).
app.post('/api/me/redeem-reward', resolveUser, async (req, res) => {
  const { rewardId } = req.body || {};
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
      "SELECT id FROM user_rewards WHERE user_id = $1 AND status = 'pending'",
      [req.userId]
    );
    if (pendingRes.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'У вас уже есть активная награда — добавьте заказ, чтобы получить её' });
    }

    const userRes = await client.query('SELECT points FROM users WHERE id = $1', [req.userId]);
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
      'UPDATE users SET points = points - $1, updated_at = now() WHERE id = $2',
      [reward.points_cost, req.userId]
    );

    // telegram_id — только если вход был через Telegram (req.telegramId
    // ставит resolveUser); для телефонного входа NULL, достаточно user_id
    // (user_rewards.telegram_id теперь nullable, см. миграцию 028).
    await client.query(
      "INSERT INTO user_rewards (user_id, telegram_id, reward_id, status) VALUES ($1, $2, $3, 'pending')",
      [req.userId, req.telegramId || null, rewardId]
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

// Голос "Полезно" на отзыве (транзакция: вставить голос → если реально
// вставился (не повторный) — инкрементнуть денормализованный счётчик).
// ON CONFLICT DO NOTHING на уникальном (review_id, user_id) — повторный клик
// не 400-ит, а тихо возвращает текущее состояние (alreadyVoted: true).
app.post('/api/me/reviews/:id/helpful', resolveUser, async (req, res) => {
  const reviewId = Number(req.params.id);
  if (!Number.isInteger(reviewId)) {
    return res.status(400).json({ error: 'Некорректный id отзыва' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const insertRes = await client.query(
      `INSERT INTO review_helpful_votes (review_id, user_id) VALUES ($1, $2)
       ON CONFLICT (review_id, user_id) DO NOTHING
       RETURNING id`,
      [reviewId, req.userId]
    );

    let helpfulCount;
    if (insertRes.rows.length > 0) {
      const updateRes = await client.query(
        'UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = $1 RETURNING helpful_count',
        [reviewId]
      );
      if (updateRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Отзыв не найден' });
      }
      helpfulCount = updateRes.rows[0].helpful_count;
    } else {
      const currentRes = await client.query('SELECT helpful_count FROM reviews WHERE id = $1', [reviewId]);
      if (currentRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Отзыв не найден' });
      }
      helpfulCount = currentRes.rows[0].helpful_count;
    }

    await client.query('COMMIT');
    res.json({ ok: true, helpfulCount, alreadyVoted: insertRes.rows.length === 0 });
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
    res.json(result.rows.map(toAdminProductDTO));
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
      ...toAdminProductDTO(productRes.rows[0]),
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
  // id — внутренний опорный ключ (на него ссылаются reviews/набор_состав/
  // home_product_shelves и orders.items), после создания не меняется нигде
  // в системе — поэтому здесь, а не только в подсказке формы на фронте,
  // проверяем формат: латиница, цифры, дефис, без пробелов и без кириллицы.
  if (!/^[a-z0-9-]+$/.test(p.id)) {
    return res.status(400).json({ error: 'ID должен содержать только латинские буквы, цифры и дефис, без пробелов' });
  }
  try {
    await query(
      `INSERT INTO products
        (id, slug, title, price, weight, emoji, bg, category, badge_type, badge_label, badge_color, composition, suppliers, pricing, is_active, in_stock, sort_order, image_url, is_bundle, subcategory_id, nutrition, home_image_url, purchase_price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        p.id,
        p.slug || p.id,
        p.title,
        p.price,
        p.weight || '',
        p.emoji || '🛒',
        p.bg || 'linear-gradient(135deg, #F4F7F2, #fff)',
        p.category,
        p.badge?.type || null,
        p.badge?.label || null,
        p.badge?.color || null,
        JSON.stringify(p.composition || []),
        JSON.stringify(p.suppliers || []),
        JSON.stringify(p.pricing || []),
        p.isActive !== false,
        p.inStock !== false,
        p.sortOrder || 0,
        p.imageUrl || null,
        p.isBundle === true,
        p.subcategoryId || null,
        p.nutrition ? JSON.stringify(p.nutrition) : null,
        p.homeImageUrl || null,
        p.purchasePrice != null && p.purchasePrice !== '' ? p.purchasePrice : null,
      ]
    );
    const result = await query('SELECT * FROM products WHERE id = $1', [p.id]);
    res.status(201).json(toAdminProductDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    if (e.code === '23505') {
      const field = e.constraint === 'products_slug_key' ? 'slug' : 'id';
      return res.status(409).json({ error: `Товар с таким ${field} уже существует` });
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
        badge_color = $9,
        composition = $10,
        suppliers = $11,
        pricing = $12,
        is_active = $13,
        in_stock = $14,
        sort_order = $15,
        image_url = $16,
        is_bundle = $17,
        subcategory_id = $18,
        nutrition = $19,
        home_image_url = $20,
        slug = $21,
        purchase_price = $22,
        updated_at = now()
       WHERE id = $23`,
      [
        p.title ?? cur.title,
        p.price ?? cur.price,
        p.weight ?? cur.weight,
        p.emoji ?? cur.emoji,
        p.bg ?? cur.bg,
        p.category ?? cur.category,
        p.badge ? p.badge.type : (p.badge === null ? null : cur.badge_type),
        p.badge ? p.badge.label : (p.badge === null ? null : cur.badge_label),
        p.badge ? (p.badge.color || null) : (p.badge === null ? null : cur.badge_color),
        p.composition !== undefined ? JSON.stringify(p.composition) : JSON.stringify(cur.composition),
        p.suppliers !== undefined ? JSON.stringify(p.suppliers) : JSON.stringify(cur.suppliers),
        p.pricing !== undefined ? JSON.stringify(p.pricing) : JSON.stringify(cur.pricing),
        p.isActive ?? cur.is_active,
        p.inStock ?? cur.in_stock,
        p.sortOrder ?? cur.sort_order,
        p.imageUrl !== undefined ? (p.imageUrl || null) : (cur.image_url || null),
        p.isBundle !== undefined ? p.isBundle === true : cur.is_bundle,
        p.subcategoryId !== undefined ? (p.subcategoryId || null) : (cur.subcategory_id || null),
        p.nutrition !== undefined
          ? (p.nutrition ? JSON.stringify(p.nutrition) : null)
          : (cur.nutrition ? JSON.stringify(cur.nutrition) : null),
        p.homeImageUrl !== undefined ? (p.homeImageUrl || null) : (cur.home_image_url || null),
        // slug — свободно переименовываемый идентификатор (migration 030),
        // products.id этим PUT никогда не трогает и не может.
        p.slug || cur.slug || cur.id,
        p.purchasePrice !== undefined ? (p.purchasePrice !== '' ? p.purchasePrice : null) : cur.purchase_price,
        req.params.id,
      ]
    );
    const result = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    res.json(toAdminProductDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Товар с таким slug уже существует' });
    }
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

// Полная перезапись порядка категорий — принимает order: [id, id, ...] в
// желаемой последовательности (все существующие id ровно по одному разу),
// перенумеровывает sort_order шагом 10 (см. миграцию 025 — тот же шаг, чтобы
// потом можно было вставить категорию между существующими). Переписываем
// весь список одним запросом от клиента, а не пара-от-пары своп двух строк —
// так исчезают "зависшие" одинаковые sort_order у категорий, которых это
// переупорядочивание не касалось.
app.put('/api/admin/categories/reorder', requireAuth, async (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order) || order.length === 0) {
    return res.status(400).json({ error: 'Укажите order — массив id категорий в нужном порядке' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT id FROM categories');
    const existingIds = new Set(existing.rows.map((r) => r.id));
    const isValidPermutation =
      order.length === existingIds.size &&
      new Set(order).size === order.length &&
      order.every((id) => existingIds.has(id));
    if (!isValidPermutation) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'order должен содержать все существующие категории ровно по одному разу' });
    }
    for (let i = 0; i < order.length; i++) {
      await client.query('UPDATE categories SET sort_order = $1 WHERE id = $2', [(i + 1) * 10, order[i]]);
    }
    await client.query('COMMIT');
    const result = await query('SELECT * FROM categories ORDER BY sort_order ASC');
    res.json(result.rows);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
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
  const { name, sortOrder, categoryId } = req.body || {};
  try {
    const existing = await query('SELECT * FROM subcategories WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Подкатегория не найдена' });
    const cur = existing.rows[0];
    const newName = name !== undefined ? String(name).trim() : cur.name;
    const newSlug = name !== undefined
      ? newName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-]/gi, '')
      : cur.slug;
    const result = await query(
      'UPDATE subcategories SET name = $1, slug = $2, sort_order = $3, category_id = $4, updated_at = now() WHERE id = $5 RETURNING *',
      [
        newName,
        newSlug,
        sortOrder !== undefined ? Number(sortOrder) : cur.sort_order,
        categoryId !== undefined ? categoryId : cur.category_id,
        req.params.id,
      ]
    );
    const sc = result.rows[0];
    res.json({ id: sc.id, name: sc.name, categoryId: sc.category_id, slug: sc.slug, sortOrder: sc.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление подкатегории: если к ней привязаны товары, без ?force=true
// возвращаем 409 с количеством — админка показывает подтверждение с этим
// числом. С force=true — отвязываем товары (subcategory_id → NULL) и удаляем.
app.delete('/api/admin/subcategories/:id', requireAuth, async (req, res) => {
  const force = req.query.force === 'true';
  try {
    const productsRes = await query('SELECT COUNT(*)::int AS count FROM products WHERE subcategory_id = $1', [req.params.id]);
    const count = productsRes.rows[0]?.count || 0;
    if (count > 0 && !force) {
      return res.status(409).json({ error: 'has_products', count });
    }
    if (count > 0) {
      await query('UPDATE products SET subcategory_id = NULL WHERE subcategory_id = $1', [req.params.id]);
    }
    const result = await query('DELETE FROM subcategories WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Подкатегория не найдена' });
    res.json({ ok: true, clearedCount: count });
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
    const result = await query(
      `SELECT r.*, p.title AS product_title
       FROM reviews r
       LEFT JOIN products p ON p.id = r.product_id
       ORDER BY r.id DESC`
    );
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
      productId: r.product_id || null,
      productTitle: r.product_title || null,
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
      imageUrl: d.image_url || null,
      sortOrder: d.sort_order,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/deliveries', requireAuth, async (req, res) => {
  const { emoji, title, text, imageUrl, sortOrder } = req.body || {};
  if (!emoji || !title || !text) {
    return res.status(400).json({ error: 'Обязательные поля: emoji, title, text' });
  }
  try {
    const result = await query(
      `INSERT INTO deliveries (emoji, title, text, image_url, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [emoji, title, text, imageUrl || null, Number(sortOrder) || 0]
    );
    const d = result.rows[0];
    res.status(201).json({ id: d.id, emoji: d.emoji, title: d.title, text: d.text, imageUrl: d.image_url || null, sortOrder: d.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Фото/эмодзи/текст/порядок доставки — редактируются после создания (раньше
// можно было только создать или удалить запись целиком).
app.put('/api/admin/deliveries/:id', requireAuth, async (req, res) => {
  const { emoji, title, text, imageUrl, sortOrder } = req.body || {};
  try {
    const existing = await query('SELECT * FROM deliveries WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Запись не найдена' });
    const cur = existing.rows[0];
    const result = await query(
      `UPDATE deliveries SET emoji = $1, title = $2, text = $3, image_url = $4, sort_order = $5 WHERE id = $6 RETURNING *`,
      [
        emoji ?? cur.emoji,
        title ?? cur.title,
        text ?? cur.text,
        imageUrl !== undefined ? (imageUrl || null) : cur.image_url,
        sortOrder !== undefined ? Number(sortOrder) : cur.sort_order,
        req.params.id,
      ]
    );
    const d = result.rows[0];
    res.json({ id: d.id, emoji: d.emoji, title: d.title, text: d.text, imageUrl: d.image_url || null, sortOrder: d.sort_order });
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
// Админские маршруты — витрины Главной (ручные подборки товаров)
// ============================================================

// Список товаров в подборке ?shelf=hits|seasonal, с названием товара для
// удобного отображения в админке (join, не отдельным запросом на каждую строку).
app.get('/api/admin/home-shelves', requireAuth, async (req, res) => {
  const { shelf } = req.query;
  if (!shelf) return res.status(400).json({ error: 'Укажите shelf' });
  try {
    const result = await query(
      `SELECT hps.id, hps.shelf, hps.product_id, hps.sort_order, p.title AS product_title, p.image_url AS product_image_url
       FROM home_product_shelves hps
       JOIN products p ON p.id = hps.product_id
       WHERE hps.shelf = $1
       ORDER BY hps.sort_order ASC, hps.id ASC`,
      [shelf]
    );
    res.json(result.rows.map((r) => ({
      id: r.id,
      shelf: r.shelf,
      productId: r.product_id,
      productTitle: r.product_title,
      productImageUrl: r.product_image_url || null,
      sortOrder: r.sort_order,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/home-shelves', requireAuth, async (req, res) => {
  const { shelf, productId, sortOrder } = req.body || {};
  if (!shelf || !productId) {
    return res.status(400).json({ error: 'Укажите shelf и productId' });
  }
  try {
    const result = await query(
      `INSERT INTO home_product_shelves (shelf, product_id, sort_order) VALUES ($1, $2, $3) RETURNING *`,
      [shelf, productId, Number(sortOrder) || 0]
    );
    const r = result.rows[0];
    res.status(201).json({ id: r.id, shelf: r.shelf, productId: r.product_id, sortOrder: r.sort_order });
  } catch (e) {
    console.error(e);
    if (e.code === '23505') {
      return res.status(409).json({ error: 'Этот товар уже в подборке' });
    }
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/home-shelves/:id', requireAuth, async (req, res) => {
  const { sortOrder } = req.body || {};
  try {
    const result = await query(
      'UPDATE home_product_shelves SET sort_order = $1 WHERE id = $2 RETURNING *',
      [Number(sortOrder) || 0, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Запись не найдена' });
    const r = result.rows[0];
    res.json({ id: r.id, shelf: r.shelf, productId: r.product_id, sortOrder: r.sort_order });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/home-shelves/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM home_product_shelves WHERE id = $1', [req.params.id]);
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
      'SELECT id, title, description, emoji, image_url, points_cost FROM rewards WHERE is_active = true ORDER BY points_cost ASC'
    );
    res.json(result.rows.map((r) => ({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, imageUrl: r.image_url, pointsCost: r.points_cost,
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
      'SELECT id, title, description, emoji, image_url, points_cost, is_active, created_at FROM rewards ORDER BY created_at DESC'
    );
    res.json(result.rows.map((r) => ({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, imageUrl: r.image_url, pointsCost: r.points_cost,
      isActive: r.is_active, createdAt: r.created_at,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создать награду
app.post('/api/admin/rewards', requireAuth, async (req, res) => {
  const { title, description, emoji, imageUrl, pointsCost, isActive } = req.body || {};
  if (!title || !pointsCost || typeof pointsCost !== 'number' || pointsCost <= 0) {
    return res.status(400).json({ error: 'Укажите title и pointsCost (> 0)' });
  }
  try {
    const result = await query(
      `INSERT INTO rewards (title, description, emoji, image_url, points_cost, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, description, emoji, image_url, points_cost, is_active, created_at`,
      [title, description || null, emoji || null, imageUrl || null, pointsCost, isActive !== false]
    );
    const r = result.rows[0];
    res.status(201).json({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, imageUrl: r.image_url, pointsCost: r.points_cost,
      isActive: r.is_active, createdAt: r.created_at,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Обновить награду (в т.ч. переключить is_active)
app.patch('/api/admin/rewards/:id', requireAuth, async (req, res) => {
  const { title, description, emoji, imageUrl, pointsCost, isActive } = req.body || {};
  const fields = [];
  const vals = [];
  let i = 1;
  if (title !== undefined)      { fields.push(`title = $${i++}`);       vals.push(title); }
  if (description !== undefined){ fields.push(`description = $${i++}`); vals.push(description); }
  if (emoji !== undefined)      { fields.push(`emoji = $${i++}`);       vals.push(emoji); }
  if (imageUrl !== undefined)   { fields.push(`image_url = $${i++}`);   vals.push(imageUrl || null); }
  if (pointsCost !== undefined) { fields.push(`points_cost = $${i++}`); vals.push(pointsCost); }
  if (isActive !== undefined)   { fields.push(`is_active = $${i++}`);   vals.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: 'Нет полей для обновления' });
  vals.push(req.params.id);
  try {
    const result = await query(
      `UPDATE rewards SET ${fields.join(', ')} WHERE id = $${i} RETURNING id, title, description, emoji, image_url, points_cost, is_active`,
      vals
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Награда не найдена' });
    const r = result.rows[0];
    res.json({
      id: r.id, title: r.title, description: r.description,
      emoji: r.emoji, imageUrl: r.image_url, pointsCost: r.points_cost, isActive: r.is_active,
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
// Админские маршруты — аналитика поведения
// ============================================================

// from/to — 'YYYY-MM-DD'. По умолчанию — последние 7 дней. `to` включает
// весь указанный день (до 23:59:59.999).
function parseAnalyticsRange(reqQuery) {
  const to = reqQuery.to ? new Date(`${reqQuery.to}T23:59:59.999Z`) : new Date();
  const from = reqQuery.from
    ? new Date(`${reqQuery.from}T00:00:00.000Z`)
    : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// Шаги воронки в порядке прохождения. 'home'..'cart' — screen_view по
// экрану; 'checkout'/'order_placed' — отдельные event_type (в этом
// приложении оформление — секция экрана "Корзина", а не отдельный роут).
const FUNNEL_STEPS = [
  { key: 'home', label: 'Главная' },
  { key: 'catalog', label: 'Каталог' },
  { key: 'product', label: 'Товар' },
  { key: 'cart', label: 'Корзина' },
  { key: 'checkout', label: 'Оформление' },
  { key: 'order_placed', label: 'Заказ' },
];

function funnelStepWhere(stepKey) {
  switch (stepKey) {
    case 'checkout': return `event_type = 'checkout_start'`;
    case 'order_placed': return `event_type = 'order_placed'`;
    default: return `event_type = 'screen_view' AND screen_name = '${stepKey}'`;
  }
}

// Воронка: для каждого шага — уникальные session_id за период (не строго
// последовательно — сессия считается "дошедшей" до шага, если у неё есть
// хоть одно подходящее событие в диапазоне), и % отвала от предыдущего шага.
app.get('/api/admin/analytics/funnel', requireAuth, async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query);
    const unionSql = FUNNEL_STEPS
      .map((s) => `SELECT '${s.key}' AS step, COUNT(DISTINCT session_id)::int AS count
        FROM analytics_events WHERE ${funnelStepWhere(s.key)} AND created_at >= $1 AND created_at < $2`)
      .join(' UNION ALL ');
    const result = await query(unionSql, [from, to]);
    const countByStep = Object.fromEntries(result.rows.map((r) => [r.step, r.count]));

    let prevCount = null;
    const steps = FUNNEL_STEPS.map((s) => {
      const count = countByStep[s.key] || 0;
      const dropOffPct = prevCount == null
        ? null
        : prevCount === 0 ? 0 : Math.round((1 - count / prevCount) * 1000) / 10;
      prevCount = count;
      return { step: s.key, label: s.label, count, dropOffPct };
    });

    res.json({ from, to, steps });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Список сессий за период (опционально — по user_id): дата начала,
// число событий, до какого шага воронки дошла.
app.get('/api/admin/analytics/sessions', requireAuth, async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query);
    const params = [from, to];
    let userFilter = '';
    if (req.query.user_id) {
      params.push(req.query.user_id);
      userFilter = `AND user_id = $${params.length}`;
    }
    const result = await query(
      `SELECT
         session_id,
         MAX(user_id) AS user_id,
         MIN(created_at) AS started_at,
         COUNT(*)::int AS event_count,
         MAX(
           CASE
             WHEN event_type = 'order_placed' THEN 6
             WHEN event_type = 'checkout_start' THEN 5
             WHEN event_type = 'screen_view' AND screen_name = 'cart' THEN 4
             WHEN event_type = 'screen_view' AND screen_name = 'product' THEN 3
             WHEN event_type = 'screen_view' AND screen_name = 'catalog' THEN 2
             WHEN event_type = 'screen_view' AND screen_name = 'home' THEN 1
             ELSE 0
           END
         ) AS final_step_rank
       FROM analytics_events
       WHERE created_at >= $1 AND created_at < $2 ${userFilter}
       GROUP BY session_id
       ORDER BY started_at DESC
       LIMIT 200`,
      params
    );
    const STEP_BY_RANK = ['other', 'home', 'catalog', 'product', 'cart', 'checkout', 'order_placed'];
    res.json(result.rows.map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      startedAt: r.started_at,
      eventCount: r.event_count,
      finalStep: STEP_BY_RANK[r.final_step_rank] || 'other',
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Полный хронологический путь одной сессии.
app.get('/api/admin/analytics/sessions/:session_id', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT user_id, event_type, screen_name, metadata, created_at
       FROM analytics_events WHERE session_id = $1 ORDER BY created_at ASC`,
      [req.params.session_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Сессия не найдена' });
    }
    res.json({
      sessionId: req.params.session_id,
      userId: result.rows.find((r) => r.user_id != null)?.user_id ?? null,
      events: result.rows.map((r) => ({
        eventType: r.event_type,
        screenName: r.screen_name,
        metadata: r.metadata,
        createdAt: r.created_at,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Самые посещаемые экраны за период.
app.get('/api/admin/analytics/top-screens', requireAuth, async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query);
    const result = await query(
      `SELECT screen_name, COUNT(*)::int AS views
       FROM analytics_events
       WHERE event_type = 'screen_view' AND screen_name IS NOT NULL
         AND created_at >= $1 AND created_at < $2
       GROUP BY screen_name
       ORDER BY views DESC`,
      [from, to]
    );
    res.json(result.rows.map((r) => ({ screenName: r.screen_name, views: r.views })));
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

// Пытается получить file_id аватарки пользователя из Telegram (для карточки
// отзыва на главной). Берём самый маленький доступный размер фото — для
// круглого аватара 26px незачем тянуть 640x640. Храним именно file_id (не
// протухает и не содержит токена бота) — в реальную картинку резолвится на
// лету через /api/avatar/:fileId. Best-effort: null при любой ошибке (нет
// фото, бот не может достучаться и т.д.) — тогда карточка покажет заглушку
// с инициалом.
async function getTelegramAvatarFileId(telegramUserId) {
  try {
    const photos = await botRequest('getUserProfilePhotos', { user_id: telegramUserId, limit: 1 });
    return photos?.photos?.[0]?.[0]?.file_id || null;
  } catch (e) {
    console.error('getTelegramAvatarFileId error:', e);
    return null;
  }
}

// Прокси для аватарок из Telegram: принимает file_id (не протухает, не
// содержит секретов), сам резолвит свежий file_path через getFile и
// стримит картинку клиенту — токен бота наружу не уходит.
app.get('/api/avatar/:fileId', async (req, res) => {
  try {
    const file = await botRequest('getFile', { file_id: req.params.fileId });
    if (!file?.file_path) return res.status(404).end();

    const tgRes = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    if (!tgRes.ok) return res.status(404).end();

    res.set('Content-Type', tgRes.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await tgRes.arrayBuffer()));
  } catch (e) {
    console.error('avatar proxy error:', e);
    res.status(500).end();
  }
});

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
// Telegram-бот: вебхук для /start
// ============================================================

const START_MESSAGE = `Привет! 👋 Я Михаил, делаю доставку свежих овощей и фруктов на юго-запад Москвы.

Работаю со своими проверенными поставщиками, лично отбираю лучшее, привожу вечером с 18:00 до 21:00.

💳 Оплата при получении — никакой предоплаты
🌿 Показываю честно, куда уходит каждый рубль
📍 Работаю по вашему району

Жмите кнопку ниже, чтобы посмотреть каталог 👇`;

// Принимает апдейты от Telegram (сейчас только текстовые сообщения — см.
// allowed_updates в registerWebhook). Проверяем секрет, чтобы левые POST-запросы
// не могли слать сообщения от имени бота случайным chat_id.
app.post('/telegram-webhook', async (req, res) => {
  if (req.get('X-Telegram-Bot-Api-Secret-Token') !== TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }
  res.sendStatus(200); // отвечаем сразу — Telegram ждёт быстрый 200

  const msg = req.body?.message;
  if (!msg?.text) return;

  // /start (в том числе с реферальным диплинком "/start ref_XXXXX")
  if (msg.text === '/start' || msg.text.startsWith('/start ')) {
    await botRequest('sendMessage', {
      chat_id: msg.chat.id,
      text: START_MESSAGE,
      reply_markup: {
        inline_keyboard: [[
          { text: '🛒 Открыть Прилавку', web_app: { url: MINI_APP_URL } },
        ]],
      },
    });
  }
});

// Регистрирует вебхук при каждом старте сервера — идемпотентно, безопасно
// вызывать повторно (Telegram просто обновит URL/секрет на тот же).
async function registerWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  const result = await botRequest('setWebhook', {
    url: `${BACKEND_PUBLIC_URL}/telegram-webhook`,
    secret_token: TELEGRAM_WEBHOOK_SECRET,
    allowed_updates: ['message'],
  });
  if (result === null) {
    console.error('Не удалось зарегистрировать Telegram-вебхук');
  } else {
    console.log('Telegram-вебхук зарегистрирован:', `${BACKEND_PUBLIC_URL}/telegram-webhook`);
  }
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

// fixedCostsMonthly — не отдельная колонка (см. migrations/034), считается
// суммой трёх статей на каждое чтение, чтобы не хранить то же число дважды.
function toPricingSettingsDTO(row) {
  const rentMonthly = Number(row.rent_monthly);
  const salaryMonthly = Number(row.salary_monthly);
  const otherCostsMonthly = Number(row.other_costs_monthly);
  return {
    rentMonthly,
    salaryMonthly,
    otherCostsMonthly,
    fixedCostsMonthly: rentMonthly + salaryMonthly + otherCostsMonthly,
    plannedSalesMonthly: Number(row.planned_sales_monthly),
    packagingCostPerUnit: Number(row.packaging_cost_per_unit),
    acquiringPercent: Number(row.acquiring_percent),
    defaultMarginPercent: Number(row.default_margin_percent),
    wastePercent: Number(row.waste_percent),
  };
}

// Настройки модуля ценообразования — singleton-таблица (см. migrations/032,
// 034), ровно одна строка, поэтому GET просто берёт LIMIT 1, а PUT обновляет
// её целиком одной формой (не по одному полю, как /api/admin/settings — тут
// все числа составляют один взаимосвязанный расчёт, порознь сохранять
// нет смысла).
app.get('/api/admin/pricing-settings', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM pricing_settings LIMIT 1');
    if (!result.rows[0]) return res.status(404).json({ error: 'Настройки ценообразования не найдены' });
    res.json(toPricingSettingsDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/pricing-settings', requireAuth, async (req, res) => {
  const p = req.body || {};
  const fields = [
    'rentMonthly', 'salaryMonthly', 'otherCostsMonthly', 'plannedSalesMonthly',
    'packagingCostPerUnit', 'acquiringPercent', 'defaultMarginPercent', 'wastePercent',
  ];
  for (const f of fields) {
    if (typeof p[f] !== 'number' || Number.isNaN(p[f]) || p[f] < 0) {
      return res.status(400).json({ error: `Поле ${f} должно быть неотрицательным числом` });
    }
  }
  if (p.wastePercent >= 100) {
    return res.status(400).json({ error: 'Процент списаний должен быть меньше 100' });
  }
  try {
    const result = await query(
      `UPDATE pricing_settings SET
        rent_monthly = $1, salary_monthly = $2, other_costs_monthly = $3,
        planned_sales_monthly = $4, packaging_cost_per_unit = $5,
        acquiring_percent = $6, default_margin_percent = $7, waste_percent = $8,
        updated_at = now()
       RETURNING *`,
      [
        p.rentMonthly, p.salaryMonthly, p.otherCostsMonthly, p.plannedSalesMonthly,
        p.packagingCostPerUnit, p.acquiringPercent, p.defaultMarginPercent, p.wastePercent,
      ]
    );
    res.json(toPricingSettingsDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ============================================================
// Запуск сервера
// ============================================================

loadSettings().catch((e) => console.error('loadSettings error:', e));
registerWebhook().catch((e) => console.error('registerWebhook error:', e));

app.listen(PORT, () => {
  console.log(`Прилавка API запущен на порту ${PORT}`);
});
