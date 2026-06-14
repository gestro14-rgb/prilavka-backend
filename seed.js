// Seed-скрипт: создаёт таблицы и заполняет начальными данными
// Запуск: npm run seed
// Переменные окружения: DATABASE_URL (обязательно), ADMIN_USERNAME, ADMIN_PASSWORD (опционально)

import { readFileSync } from 'fs';
import bcrypt from 'bcryptjs';
import 'dotenv/config';
import { pool, query } from './db.js';

async function main() {
  console.log('Подключение к базе данных...');

  // 1. Создаём таблицы
  const schema = readFileSync('./schema.sql', 'utf-8');
  await query(schema);
  console.log('Таблицы созданы (или уже существовали).');

  // 2. Загружаем данные каталога
  const data = JSON.parse(readFileSync('./seed-data.json', 'utf-8'));

  // 2a. Категории (пропускаем "all" — она добавляется автоматически в API)
  for (const [i, cat] of data.categories.entries()) {
    if (cat.id === 'all') continue;
    await query(
      `INSERT INTO categories (id, label, sort_order)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
      [cat.id, cat.label, i]
    );
  }
  console.log(`Категории загружены: ${data.categories.length - 1}`);

  // 2b. Товары
  for (const [i, p] of data.products.entries()) {
    await query(
      `INSERT INTO products
        (id, title, price, weight, emoji, bg, category, badge_type, badge_label, composition, suppliers, pricing, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         price = EXCLUDED.price,
         weight = EXCLUDED.weight,
         emoji = EXCLUDED.emoji,
         bg = EXCLUDED.bg,
         category = EXCLUDED.category,
         badge_type = EXCLUDED.badge_type,
         badge_label = EXCLUDED.badge_label,
         composition = EXCLUDED.composition,
         suppliers = EXCLUDED.suppliers,
         pricing = EXCLUDED.pricing,
         sort_order = EXCLUDED.sort_order`,
      [
        p.id,
        p.title,
        p.price,
        p.weight,
        p.emoji,
        p.bg,
        p.category,
        p.badge?.type || null,
        p.badge?.label || null,
        JSON.stringify(p.composition || []),
        JSON.stringify(p.suppliers || []),
        JSON.stringify(p.pricing || []),
        true,
        i,
      ]
    );
  }
  console.log(`Товары загружены: ${data.products.length}`);

  // 2c. Отзывы
  for (const [i, r] of (data.reviews || []).entries()) {
    await query(
      `INSERT INTO reviews (name, area, stars, text, emoji, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
      [r.name, r.area, r.stars, r.text, r.emoji, i]
    );
  }
  console.log(`Отзывы загружены: ${(data.reviews || []).length}`);

  // 2d. Последние доставки
  for (const [i, d] of (data.deliveries || []).entries()) {
    await query(
      `INSERT INTO deliveries (emoji, title, text, sort_order) VALUES ($1,$2,$3,$4)`,
      [d.emoji, d.title, d.text, i]
    );
  }
  console.log(`Записи о доставках загружены: ${(data.deliveries || []).length}`);

  // 3. Администратор
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'prilavka2026';
  const passwordHash = await bcrypt.hash(password, 10);

  await query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [username, passwordHash]
  );
  console.log(`Администратор создан: ${username} / ${password}`);
  console.log('ВАЖНО: смени пароль после первого входа!');

  await pool.end();
  console.log('Готово!');
}

main().catch((e) => {
  console.error('Ошибка при заполнении базы данных:', e);
  process.exit(1);
});
