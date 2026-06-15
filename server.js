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

// Отправляет сообщение в Telegram через Bot API.
// Если TELEGRAM_BOT_TOKEN или TELEGRAM_ADMIN_CHAT_ID не настроены, тихо ничего не делает.
async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_ADMIN_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage failed:', res.status, body);
    }
  } catch (e) {
    console.error('Telegram sendMessage error:', e);
  }
}

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

// ВРЕМЕННЫЙ маршрут: применяет миграцию для таблицы orders.
// Открыть один раз в браузере после деплоя, затем убрать этот код.
app.get('/api/migrate-orders', async (req, res) => {
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        items JSONB NOT NULL DEFAULT '[]',
        total INTEGER NOT NULL,
        delivery_date JSONB,
        delivery_slot TEXT,
        address_street TEXT,
        address_details JSONB,
        comment TEXT,
        payment_method TEXT NOT NULL DEFAULT 'cash',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        status TEXT NOT NULL DEFAULT 'new',
        telegram_user_id BIGINT,
        telegram_username TEXT,
        telegram_first_name TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    res.json({ ok: true, message: 'Таблица orders создана (или уже существовала)' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

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
  } = req.body || {};

  if (!Array.isArray(items) || items.length === 0 || total == null) {
    return res.status(400).json({ error: 'Укажите items и total' });
  }

  try {
    const result = await query(
      `INSERT INTO orders
        (items, total, delivery_date, delivery_slot, address_street, address_details, comment, payment_method, telegram_user_id, telegram_username, telegram_first_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        JSON.stringify(items),
        total,
        JSON.stringify(deliveryDate || null),
        deliverySlot || null,
        addressStreet || null,
        addressDetails ? JSON.stringify(addressDetails) : null,
        comment || null,
        paymentMethod === 'cash' ? 'cash' : 'online',
        telegramUser?.id || null,
        telegramUser?.username || null,
        telegramUser?.firstName || null,
      ]
    );

    const order = result.rows[0];

    // Уведомление в Telegram — не блокирует ответ клиенту, если не настроено или упало
    const notification = formatOrderNotification({
      id: order.id,
      items,
      total,
      delivery_date: deliveryDate,
      delivery_slot: deliverySlot,
      address_street: addressStreet,
      address_details: addressDetails,
      comment,
      payment_method: order.payment_method,
      telegram_first_name: order.telegram_first_name,
      telegram_username: order.telegram_username,
    });
    sendTelegramMessage(notification);

    res.status(201).json({ id: order.id, status: order.status });
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

// Обновить статус заказа (например, "в работе", "доставлен", "отменён")
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
    res.json({ id: o.id, status: o.status, paymentStatus: o.payment_status });
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
