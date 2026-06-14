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

// ============================================================
// Публичные маршруты (используются мини-приложением)
// ============================================================

// Healthcheck
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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
// Запуск сервера
// ============================================================

app.listen(PORT, () => {
  console.log(`Прилавка API запущен на порту ${PORT}`);
});
