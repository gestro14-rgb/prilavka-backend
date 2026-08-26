import express from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { pool, query } from './db.js';
import { s3Client, s3PresignClient, S3_BUCKET } from './s3.js';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Upload } from '@aws-sdk/lib-storage';
import busboy from 'busboy';
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
  referral_discount:        '100',
  max_points_spend_percent: '30',
  default_slot:             '18:00–21:00',
  review_photo_points:      '50',
  today_cutoff_time:        '17:00',
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
    // "Было" для зачёркнутой цены (см. PriceTag.jsx) — null, если скидки нет.
    oldPrice: row.old_price != null ? Number(row.old_price) : null,
    // Продажная цена за килограмм для витринного акцента "39 ₽/кг"
    // (migrations/045) — customer-facing, поэтому в публичном DTO, в
    // отличие от pricingUnit/weightKg ниже (те только для закупки, см.
    // toAdminProductDTO). null — товар без акцента, PriceTag.jsx рендерит
    // обычную price как раньше.
    pricePerKg: row.price_per_kg != null ? Number(row.price_per_kg) : null,
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
    // Видео набора для hero-блока Главной (migrations/048). Непустое
    // значение = набор участвует в hero-карусели — отдельного флага/списка
    // нет, см. heroSets в Home.jsx.
    homeVideoUrl: row.home_video_url || null,
    // Короткая ситуативная подпись для витринных карточек наборов (задача
    // 10 воронки, migrations/051) — НЕ замена title: тот остаётся точным и
    // используется в чеке заказа, поиске каталога, истории "Уже заказывали".
    // Пусто → фронт сам берёт title/weight, как раньше (см. cardEmoji/
    // cardTitle/cardSubtitle в HeroSetCard.jsx и Home.jsx).
    cardEmoji: row.card_emoji || null,
    cardTitle: row.card_title || null,
    cardSubtitle: row.card_subtitle || null,
    // Цветная плашка-тег для секции «Сегодня особенно хорошее» на Главной
    // (migrations/052) — про вкус/текстуру самого продукта, отдельно от
    // badge выше (тот про статус в ассортименте: Хит / Выгодно / Чаще
    // берут). Непустой tagLabel = товар участвует в секции, отдельного
    // флага нет — см. specialProducts в Home.jsx. tagColor — имя пресета
    // ('green'|'orange'|'ochre'|'berry'), не hex: разворачивает его фронт,
    // чтобы произвольные цвета из админки не размывали палитру, как это
    // вышло с badge_color (см. Badge.jsx).
    tagLabel: row.tag_label || null,
    tagColor: row.tag_color || null,
    // «На скольких человек» и «на какой срок» набора (migrations/053) —
    // две строки рядом с весом на hero-карточке Главной. Пусто → фронт
    // пробует достать фразу из названия регуляркой, как делал до появления
    // этих полей (setPeopleLabel/setTermLabel в format.js).
    audienceLabel: row.audience_label || null,
    termLabel: row.term_label || null,
    isBundle: row.is_bundle ?? false,
    subcategoryId: row.subcategory_id ?? null,
    nutrition: row.nutrition ?? null,
  };
}

// purchase_price — закупочная цена, вход для модуля ценообразования.
// Намеренно НЕ в toProductDTO: это себестоимость, а toProductDTO отдаёт и
// публичный /api/catalog — админские product-роуты подмешивают поле сами.
function toAdminProductDTO(row) {
  return {
    ...toProductDTO(row),
    purchasePrice: row.purchase_price != null ? Number(row.purchase_price) : null,
    // 'kg' — purchase_price указана за килограмм, эффективная закупка
    // упаковки = purchase_price × weight_kg; 'piece' — как есть.
    // Текстовое weight не участвует в расчётах (см. migrations/036).
    pricingUnit: row.pricing_unit || 'piece',
    weightKg: row.weight_kg != null ? Number(row.weight_kg) : null,
    // Индивидуальная маржа товара — верхний уровень приоритета маржи
    // (migrations/038): товар → подкатегория → глобальная настройка.
    individualMarginPercent: row.individual_margin_percent != null ? Number(row.individual_margin_percent) : null,
  };
}

function toSubcategoryDTO(row) {
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    slug: row.slug,
    sortOrder: row.sort_order,
    // Второй уровень приоритета маржи (migrations/038); null — у
    // подкатегории нет своей маржи, действует глобальная настройка.
    targetMarginPercent: row.target_margin_percent != null ? Number(row.target_margin_percent) : null,
  };
}

// Сторис-карточка Главной (migrations/047). productId наружу отдаём, хотя
// фронт его пока не читает — понадобится странице просмотра видео.
function toStoryCardDTO(row) {
  return {
    id: row.id,
    title: row.title,
    priceLabel: row.price_label || '',
    coverImageUrl: row.cover_image_url || null,
    videoUrl: row.video_url || null,
    durationSeconds: row.duration_seconds ?? 0,
    badgeText: row.badge_text || null,
    productId: row.product_id || null,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    createdAt: row.created_at,
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

// Один запрос к Яндекс Geocoder HTTP API. Параметр geocode понимает и текст
// ("Профсоюзная 142"), и координаты в порядке "долгота,широта" — от него же
// зависит направление: прямое или обратное геокодирование.
// Возвращает { lat, lng, formatted } или null, если ничего не найдено.
// formatted — GeocoderMetaData.text, полная строка вида
// "Россия, Москва, Профсоюзная улица, 142": на фронте её причёсывает
// cleanStreet() (срезает "Россия"/"Москва"), а extractDistrictFromStreet()
// вытаскивает из неё район — поэтому берём именно text, а не короткий
// GeoObject.name, одинаково на обоих направлениях.
async function requestGeocoder(geocode, extraParams = {}) {
  if (!YANDEX_GEOCODER_API_KEY) {
    throw new Error('YANDEX_GEOCODER_API_KEY не настроен на сервере');
  }
  const url = new URL('https://geocode-maps.yandex.ru/1.x/');
  url.searchParams.set('apikey', YANDEX_GEOCODER_API_KEY);
  url.searchParams.set('geocode', geocode);
  url.searchParams.set('format', 'json');
  url.searchParams.set('results', '1');
  url.searchParams.set('lang', 'ru_RU');
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }

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
    formatted: geoObject.metaDataProperty?.GeocoderMetaData?.text || null,
  };
}

// Прямое геокодирование: текстовый адрес → координаты.
async function geocodeAddress(address) {
  const result = await requestGeocoder(address);
  if (!result) return null;
  return { ...result, formatted: result.formatted || address };
}

// Обратное геокодирование: координаты геолокации → человекочитаемый адрес.
// Яндекс ждёт "долгота,широта" (обратный привычному порядок).
// kind=house просим отдельным первым заходом: без него ближайшим объектом
// часто оказывается улица/район/метро, и в поле "Улица и дом" прилетала бы
// строка без номера дома. Если дома рядом нет (частный сектор, парк, трасса) —
// повторяем без ограничения, чтобы вернуть хотя бы улицу, а не пустоту.
async function reverseGeocode(lat, lng) {
  const point = `${lng},${lat}`;
  return (await requestGeocoder(point, { kind: 'house' })) || (await requestGeocoder(point));
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
//
// (xmax = 0) отличает вставку от обновления: у только что вставленной строки
// xmax нулевой, у обновлённой через DO UPDATE — это id блокирующей
// транзакции. Без этого признака ON CONFLICT ... RETURNING не даёт способа
// понять, новый ли это пользователь — а уведомление админу нужно ровно один
// раз, а не при каждом заходе. Наружу флаг не отдаём: вызывающий код ждёт
// строку пользователя ровно в том виде, в каком она лежит в таблице.
// Проставляет новому пользователю источник привлечения и дату первого визита.
//
// Источник берём из start_attributions (payload диплинка, пойманный ботом на
// /start), а дату первого визита — из analytics_events: users.created_at
// фиксирует появление строки, то есть первый ЗАКАЗ или вход по телефону, а
// это заметно позже, чем человек впервые открыл приложение.
//
// Молча ничего не делает, если сопоставить не с чем — у входа по телефону
// telegram_id нет вовсе, и это нормальный случай, а не ошибка.
async function attachAcquisition(user, telegramId) {
  if (!telegramId) return;
  try {
    const attrRes = await query(
      'SELECT utm_source, utm_campaign, utm_medium, referral_code FROM start_attributions WHERE telegram_id = $1',
      [telegramId]
    );
    const attr = attrRes.rows[0] || {};
    const firstSeenRes = await query(
      'SELECT MIN(created_at) AS first_seen FROM analytics_events WHERE user_id = $1',
      [telegramId]
    );
    const firstSeen = firstSeenRes.rows[0]?.first_seen || null;

    // 'direct' — пришёл сам, без размеченной ссылки; это полноценный ответ
    // на вопрос "откуда", а не отсутствие данных, поэтому пишем его явно.
    const channel = attr.utm_source ? 'ad' : attr.referral_code ? 'referral' : 'direct';

    await query(
      `UPDATE users SET utm_source = $1, utm_campaign = $2, utm_medium = $3,
                        acquisition_channel = $4, first_seen_at = $5
       WHERE id = $6`,
      [attr.utm_source || null, attr.utm_campaign || null, attr.utm_medium || null,
       channel, firstSeen, user.id]
    );
  } catch (e) {
    // Атрибуция — сопутствующая запись: её потеря не должна ломать
    // регистрацию пользователя, ради которой всё и происходит.
    console.error('attachAcquisition:', e);
  }
}

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
         RETURNING *, (xmax = 0) AS is_new`,
        [telegramId, username || null, firstName || null, code]
      );
      const { is_new: isNew, ...user } = result.rows[0];
      if (isNew) {
        notifyNewUser(user, 'Telegram');
        // Атрибуцию проставляем ровно один раз — при появлении строки.
        // Позже её переписывать нельзя: человек привлечён однажды, и
        // повторный заход по другой ссылке не меняет, откуда он пришёл.
        await attachAcquisition(user, telegramId);
      }
      return user;
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

// Все сообщения уходят с parse_mode: 'HTML', поэтому имя из Telegram
// (произвольный текст пользователя) обязано быть экранировано — иначе имя
// с '<' ломает разметку и Telegram отклоняет сообщение целиком.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Уведомление админу о первом появлении пользователя в БД. Вызывается из
// upsertUser/upsertUserByPhone только когда строка реально была вставлена.
// Намеренно не await — регистрация не должна ждать Telegram и тем более
// падать из-за него (ошибки логирует sendTelegramMessageToChat).
function notifyNewUser(user, source) {
  const name = [user.first_name, user.username && `@${user.username}`]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' ');
  const who = name || (user.phone ? escapeHtml(user.phone) : `id ${user.id}`);
  sendTelegramMessage(`👤 Новый пользователь: <b>${who}</b>\nВход: ${escapeHtml(source)}`);
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

// Иконки статичных мест интерфейса (заголовки секций в Профиле и т.п.) —
// публичный маршрут, читает и приложение (для отображения), и админка (для
// списка на странице "Иконки интерфейса"). Запись — только через
// /api/admin/ui-icons/:key (см. ниже), здесь только чтение.
app.get('/api/ui-icons', async (req, res) => {
  try {
    const result = await query('SELECT key, image_url, fallback_emoji FROM ui_icons ORDER BY key');
    res.json(result.rows.map((row) => ({
      key: row.key,
      imageUrl: row.image_url,
      fallbackEmoji: row.fallback_emoji,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


// ============================================================
// Автоматический расчёт разбивки "Честная цена" (Поставщику/Логистика/
// Упаковка/Сервис) для карточки товара, когда админ не заполнил pricing
// вручную. Формула — инверсия calcPricing из prilavka-admin/src/pricingCalc.js
// относительно ТЕКУЩЕЙ цены (а не рекомендуемой): что мы "предполагаем" о
// закупке, чтобы эта формула объясняла уже установленную цену. purchase_price,
// если он заполнен, приоритетнее — тогда доля фермера берётся напрямую, без
// подразумеваемого расчёта через маржу.
// ============================================================

const FAIR_PRICE_SEGMENT_COLORS = ['#2A7A2A', '#C4782A', '#7A5230', '#6B7A3A'];
// За пределами диапазона цифры выглядят неправдоподобно (см. обсуждение
// бага с 33% у большинства товаров) — лучше не показать блок вовсе, чем
// подставить сомнительное число.
const FAIR_PRICE_MIN_FARMER_PCT = 25;
const FAIR_PRICE_MAX_FARMER_PCT = 80;

// Дублирует effectivePurchaseCost из prilavka-admin/src/pricingCalc.js —
// бэкенд и админка разные деплоймые приложения без общего пакета.
function effectivePurchaseCost({ purchasePrice, pricingUnit, weightKg }) {
  if (purchasePrice == null || purchasePrice === '') return null;
  if (pricingUnit === 'kg') {
    const w = Number(weightKg);
    if (!Number.isFinite(w) || w <= 0) return null;
    return Number(purchasePrice) * w;
  }
  return Number(purchasePrice);
}

// Ручной pricing валиден, только если это непустой массив объектов с
// непустым label и числовым pct. Иначе считаем "не задано" и запускаем
// автоматику — это же лечит уже испорченные записи (см. баг посимвольного
// спреда строки в ProductForm.jsx: updatePricingItem/normalizePricing).
function isValidManualPricing(pricing) {
  return Array.isArray(pricing) && pricing.length > 0 && pricing.every((p) =>
    p && typeof p === 'object' && !Array.isArray(p)
    && typeof p.label === 'string' && p.label.trim() !== ''
    && typeof p.pct === 'number' && Number.isFinite(p.pct)
  );
}

// Метод наибольших остатков (Hamilton): округляет проценты так, чтобы их
// сумма была ровно 100, а не "около 100" из-за независимого округления
// каждого сегмента.
function roundPercentsTo100(rawPercents) {
  const floors = rawPercents.map((p) => Math.floor(p));
  const remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = rawPercents
    .map((p, i) => ({ i, frac: p - Math.floor(p) }))
    .sort((a, b) => b.frac - a.frac);
  const result = [...floors];
  for (let k = 0; k < remainder; k++) {
    result[order[k].i] += 1;
  }
  return result;
}

function computeAutoPricing({ price, purchasePrice, pricingUnit, weightKg, productMarginPercent, subcategoryMarginPercent, settings }) {
  const price_ = Number(price);
  if (!Number.isFinite(price_) || price_ <= 0) return null;

  const fixedCostsMonthly = Number(settings?.fixedCostsMonthly) || 0;
  const plannedSalesMonthly = Number(settings?.plannedSalesMonthly) || 0;
  const packagingCostPerUnit = Number(settings?.packagingCostPerUnit) || 0;
  const acquiringPercent = Number(settings?.acquiringPercent) || 0;
  const defaultMarginPercent = Number(settings?.defaultMarginPercent) || 0;
  const wastePercent = Number(settings?.wastePercent) || 0;
  const avgItemsPerOrder = settings?.avgItemsPerOrder != null ? Number(settings.avgItemsPerOrder) : null;

  // Настройки ценообразования не заполнены — считать не из чего.
  if (plannedSalesMonthly <= 0 || !avgItemsPerOrder || avgItemsPerOrder <= 0) return null;

  const w = wastePercent / 100;
  if (w >= 1) return null;

  const fixedShare = (fixedCostsMonthly / plannedSalesMonthly) / avgItemsPerOrder;

  // Приоритет 1: purchase_price заполнена — доля фермера напрямую.
  // Приоритет 2: не заполнена — подразумеваемая закупка обратным ходом из
  // той же формулы, что и рекомендуемая цена, но относительно текущей цены.
  let farmerShareValue;
  const directCost = effectivePurchaseCost({ purchasePrice, pricingUnit, weightKg });

  if (directCost != null) {
    farmerShareValue = directCost;
  } else {
    let marginPercent = defaultMarginPercent;
    if (productMarginPercent != null) marginPercent = Number(productMarginPercent);
    else if (subcategoryMarginPercent != null) marginPercent = Number(subcategoryMarginPercent);
    const m = marginPercent / 100;

    // Реальная комиссия эквайринга с конкретной продажи не завязана на
    // списания — waste-adjusted aw используется только для D (там он часть
    // модели ценообразования, а не факт по этой транзакции).
    const a = acquiringPercent / 100;
    const aw = a / (1 - w);

    const D = (price_ * (1 - aw * (1 + m))) / (1 + m);
    const Cw = D - fixedShare;
    farmerShareValue = Cw * (1 - w) - packagingCostPerUnit;

    if (!(farmerShareValue > 0)) return null;
  }

  const farmerPctRaw = (farmerShareValue / price_) * 100;
  if (farmerPctRaw < FAIR_PRICE_MIN_FARMER_PCT || farmerPctRaw > FAIR_PRICE_MAX_FARMER_PCT) return null;

  const packagingPctRaw = (packagingCostPerUnit / price_) * 100;
  const servicePctRaw = acquiringPercent + (fixedShare / price_) * 100;
  const logisticsPctRaw = 100 - farmerPctRaw - packagingPctRaw - servicePctRaw;

  const rawPercents = [farmerPctRaw, logisticsPctRaw, packagingPctRaw, servicePctRaw];
  // Любой сегмент в минус (обычно логистика на слишком дешёвых товарах с
  // высокой долей постоянных расходов) — тоже "бессмыслица", прячем блок.
  if (rawPercents.some((v) => v < 0)) return null;

  const [farmerPct, logisticsPct, packagingPct, servicePct] = roundPercentsTo100(rawPercents);

  return [
    { label: 'Поставщику', sub: 'фермер получает напрямую', pct: farmerPct, amount: Math.round(price_ * farmerPct / 100), color: FAIR_PRICE_SEGMENT_COLORS[0] },
    { label: 'Логистика', sub: 'доставка и хранение', pct: logisticsPct, amount: Math.round(price_ * logisticsPct / 100), color: FAIR_PRICE_SEGMENT_COLORS[1] },
    { label: 'Упаковка и сборка', sub: 'картон, сортировка', pct: packagingPct, amount: Math.round(price_ * packagingPct / 100), color: FAIR_PRICE_SEGMENT_COLORS[2] },
    { label: 'Сервис', sub: 'работа склада, эквайринг', pct: servicePct, amount: Math.round(price_ * servicePct / 100), color: FAIR_PRICE_SEGMENT_COLORS[3] },
  ];
}

// Весь каталог (категории + товары + отзывы + доставки) — то, что раньше было в products.js
app.get('/api/catalog', resolveUserOptional, async (req, res) => {
  try {
    const [categoriesRes, subcatsRes, productsRes, reviewsRes, reviewStatsRes, deliveriesRes, compositionsRes, productRatingsRes, homeShelvesRes, pricingSettingsRes, storyCardsRes] = await Promise.all([
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
      // Для автоматического расчёта "Честная цена" у товаров без ручного
      // pricing (см. computeAutoPricing выше).
      query('SELECT * FROM pricing_settings LIMIT 1'),
      // Сторис-лента Главной (migrations/047) — только активные, порядок
      // ручной. Едет вместе с остальными данными Главной (deliveries,
      // homeShelves, homeContent), а не отдельной ручкой: Home и так тянет
      // /api/catalog через CatalogContext, второй сетевой запрос не нужен.
      query('SELECT * FROM story_cards WHERE is_active = true ORDER BY sort_order ASC, id ASC'),
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

    const subcategoryMarginById = {};
    for (const sc of subcatsRes.rows) {
      subcategoryMarginById[sc.id] = sc.target_margin_percent != null ? Number(sc.target_margin_percent) : null;
    }
    const pricingSettingsForCalc = pricingSettingsRes.rows[0] ? toPricingSettingsDTO(pricingSettingsRes.rows[0]) : null;

    res.json({
      categories: [{ id: 'all', label: 'Все' }, ...categoriesRes.rows.map((c) => ({ id: c.id, label: c.label }))],
      subcategories: subcatsRes.rows.map((sc) => ({
        id: sc.id,
        category_id: sc.category_id,
        name: sc.name,
        slug: sc.slug,
        sort_order: sc.sort_order,
      })),
      products: productsRes.rows.map((row) => {
        const dto = toProductDTO(row);
        if (row.is_bundle) {
          // Наборы никогда не считаются автоматически — сверено на данных:
          // у всех 8 наборов проценты уникальные и осмысленные (включая
          // Гриль-набор, у которого разбивка совпадает с типовым дефолтом
          // 33/25/12/15/15 — это тоже подтверждённый ручной ввод, не
          // заглушка). У наборов бывают статьи сверх стандартных 4
          // (например "Сборка"), 4-сегментная модель им не подходит в
          // принципе — исключение по is_bundle, а не по валидности pricing.
          if (!isValidManualPricing(row.pricing)) dto.pricing = [];
        } else if (!isValidManualPricing(row.pricing)) {
          // Обычный товар без валидного ручного pricing (пусто или
          // испорчено — см. isValidManualPricing) — считаем сами.
          dto.pricing = computeAutoPricing({
            price: row.price,
            purchasePrice: row.purchase_price,
            pricingUnit: row.pricing_unit,
            weightKg: row.weight_kg,
            productMarginPercent: row.individual_margin_percent,
            subcategoryMarginPercent: row.subcategory_id != null ? subcategoryMarginById[row.subcategory_id] : null,
            settings: pricingSettingsForCalc,
          }) || [];
        }
        return {
          ...dto,
          bundleComposition: compositionsByProduct[row.id] ?? null,
          rating: ratingByProduct[row.id] ?? null,
        };
      }),
      reviews: reviewsRes.rows.map((row) => toReviewDTO(row, votedReviewIds)),
      reviewStats: toReviewStatsDTO(reviewStatsRes.rows[0]),
      deliveries: deliveriesRes.rows.map((d) => ({
        emoji: d.emoji,
        title: d.title,
        text: d.text,
        imageUrl: d.image_url || null,
        // Момент реального добавления записи — дата на Главной больше не
        // вписывается вручную в text (см. migrations/042).
        createdAt: d.created_at,
      })),
      // Ручные подборки: { hits: [productId, ...], seasonal: [productId, ...] }.
      // Заголовок/подзаголовок "Сейчас в сезоне" — из settings (редактируется
      // в админке так же, как остальные настройки).
      homeShelves,
      homeContent: {
        seasonalTitle: getSetting('home_seasonal_title') || 'Сейчас в сезоне',
        seasonalSubtitle: getSetting('home_seasonal_subtitle') || '',
        // Заголовок «Сегодня особенно хорошее 🍓» (migrations/052) — тем же
        // механизмом, что и «Сейчас в сезоне» выше.
        specialTitle: getSetting('home_special_title') || 'Сегодня особенно хорошее 🍓',
      },
      storyCards: storyCardsRes.rows.map(toStoryCardDTO),
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
      // Координаты пришли с геолокации — сами по себе они пользователю ничего
      // не говорят, поэтому переводим их обратно в адрес: именно эта строка
      // подставится в поле "Улица и дом". Падение геокодера здесь не должно
      // ломать проверку зоны — она считается по координатам и без адреса,
      // поэтому ошибку глотаем и оставляем formattedAddress пустым (фронт
      // покажет свою заглушку).
      try {
        const geocoded = await reverseGeocode(lat, lng);
        if (geocoded) formattedAddress = geocoded.formatted;
      } catch (e) {
        console.error('Обратное геокодирование не удалось:', e.message);
      }
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
      // Всегда явным ключом (null, а не пропущенное поле) — фронту нужно
      // отличать "адрес не определился" от "поля нет в ответе старого сервера".
      address: formattedAddress || null,
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

// Сколько заказов пользователь уже оформил — по user_id, а не по
// telegram_user_id: колонка появилась в миграции 028, забэкфилена для старых
// заказов и одинаково работает для входа через Telegram и по телефону
// (у телефонного telegram_id нет вовсе). Отменённые не считаем: отмена не
// должна навсегда лишать человека промокода "на первый заказ".
async function countUserOrders(userId) {
  const res = await query(
    "SELECT COUNT(*)::int AS count FROM orders WHERE user_id = $1 AND status != 'cancelled'",
    [userId]
  );
  return res.rows[0]?.count || 0;
}

// Русское склонение по числу: plural(3, 'заказ', 'заказа', 'заказов') → 'заказа'.
// Тот же алгоритм, что в prilavka-app/src/format.js — сообщения об отказе
// собираются на сервере, поэтому склонять нужно и здесь.
function plural(n, one, few, many) {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

// Единственный источник истины по "можно ли применить этот промокод".
// Зовётся и из /api/promo/check (предпросмотр в корзине), и из POST /api/orders
// (списание) — раньше набор проверок был выписан в обоих местах отдельно, и
// они разъезжались: корзина показывала отказ, а заказ молча уходил без скидки.
// ordersCount — сколько заказов у пользователя УЖЕ есть; оформляемый сейчас
// идёт следующим по счёту, поэтому ниже сравниваем с ordersCount + 1.
// usedByUser — применял ли этот клиент именно этот код раньше; считается
// вызывающим через loadPromoContext ниже, чтобы сама функция осталась
// синхронной и без обращений к базе.
function validatePromo(promo, { total, ordersCount, usedByUser = false }) {
  if (!promo) {
    return { valid: false, message: 'Промокод не найден' };
  }
  // Одноразовость бывает двух видов (миграция 049). У именных кодов
  // (once_global) она на весь код: первый применивший закрывает его для
  // всех — это и есть замысел раздачи "лично Ольге". У массового
  // приветственного кода (once_per_user) — на клиента: код общий, но
  // каждому достаётся один раз, и глобальный is_used для него не смотрим
  // вовсе, иначе первый же заказ сжёг бы код для всех остальных.
  if (promo.usage_type === 'once_per_user') {
    if (usedByUser) {
      return { valid: false, message: 'Вы уже использовали этот промокод' };
    }
  } else if (promo.is_used) {
    return { valid: false, message: 'Промокод уже использован' };
  }
  if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
    return { valid: false, message: 'Промокод истёк' };
  }
  if (promo.min_order_total && total != null && total < promo.min_order_total) {
    return {
      valid: false,
      message: `Промокод действует от ${promo.min_order_total.toLocaleString('ru-RU')} ₽`,
    };
  }

  const orderNumber = ordersCount + 1;
  const min = promo.min_order_number;
  const max = promo.max_order_number;
  if (min != null && orderNumber < min) {
    return {
      valid: false,
      message: min === 2
        ? 'Промокод действует только на повторные заказы'
        : `Промокод действует начиная с ${min}-го заказа`,
    };
  }
  if (max != null && orderNumber > max) {
    return {
      valid: false,
      message: max === 1
        ? 'Промокод действует только на первый заказ'
        : `Промокод действует только на первые ${max} ${plural(max, 'заказ', 'заказа', 'заказов')}`,
    };
  }

  return { valid: true, discount: computeDiscount(promo, total || 0) };
}

// Собирает всё, что нужно validatePromo, по коду и клиенту. Отдельной
// функцией — по той же причине, по которой сама validatePromo одна на два
// места: корзина и сабмит заказа должны готовить контекст проверки
// одинаково, иначе условия снова разъедутся между экраном и заказом.
async function loadPromoContext(code, userId) {
  const res = await query('SELECT * FROM promo_codes WHERE code = $1', [String(code).trim().toUpperCase()]);
  const promo = res.rows[0];
  const ordersCount = await countUserOrders(userId);
  // Лишний запрос делаем только для кодов, которым он вообще нужен —
  // у once_global одноразовость целиком в самом promo_codes.is_used.
  let usedByUser = false;
  if (promo && promo.usage_type === 'once_per_user') {
    const used = await query(
      'SELECT 1 FROM promo_code_uses WHERE promo_code_id = $1 AND user_id = $2 LIMIT 1',
      [promo.id, userId]
    );
    usedByUser = used.rowCount > 0;
  }
  return { promo, ordersCount, usedByUser };
}

// Проверяет промокод и возвращает размер скидки, не списывая его.
// Используется в корзине для предпросмотра скидки до оформления заказа.
// resolveUser обязателен: без личности не посчитать номер заказа, а без него
// условие "только на первый заказ" пришлось бы проверять лишь на сабмите —
// то есть корзина снова показывала бы сумму, отличную от итоговой. Ограничения
// это не добавляет: POST /api/orders и так требует авторизации, без входа
// заказ оформить нельзя.
app.post('/api/promo/check', resolveUser, async (req, res) => {
  const { code, total } = req.body || {};
  if (!code || !String(code).trim()) {
    return res.status(400).json({ error: 'Укажите промокод' });
  }
  try {
    const { promo, ordersCount, usedByUser } = await loadPromoContext(code, req.userId);
    const check = validatePromo(promo, { total, ordersCount, usedByUser });
    if (!check.valid) {
      return res.json({ valid: false, message: check.message });
    }
    res.json({
      valid: true,
      discountType: promo.discount_type,
      discountValue: promo.discount_value,
      discount: check.discount,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Промокод для баннера на Главной. Публичный и намеренно без
// пользовательского контекста: баннер маркетинговый, а не персональный, и
// виден в том числе до входа — валидность конкретному клиенту всё равно
// считает /api/promo/check при вводе кода в корзине.
//
// Какой код показывать, отдельным флагом "показывать в баннере" не помечаем:
// массовый код — это ровно тот, у которого usage_type = 'once_per_user',
// потому что раздаваемые лично именные коды по определению once_global и в
// баннер попасть не могут. Одна колонка вместо двух, которые пришлось бы
// держать согласованными вручную. Если таких кодов заведут несколько,
// показываем самый свежий.
app.get('/api/promo/featured', async (req, res) => {
  try {
    const result = await query(
      `SELECT * FROM promo_codes
        WHERE usage_type = 'once_per_user'
          AND is_used = false
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at DESC
        LIMIT 1`
    );
    const promo = result.rows[0];
    if (!promo) return res.json(null);
    res.json({
      code: promo.code,
      discountType: promo.discount_type,
      discountValue: promo.discount_value,
      minOrderTotal: promo.min_order_total,
      // Баннер обещает скидку "на первый заказ" — текст должен следовать за
      // данными, а не быть зашитым в вёрстку: код с другим условием
      // (например на первые 3 заказа) подпишется иначе.
      maxOrderNumber: promo.max_order_number,
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

    // Применяем промокод из таблицы promo_codes. Одноразовый — либо на весь
    // код, либо на клиента, в зависимости от usage_type (см. validatePromo
    // и миграцию 049).
    // Проверка — та же validatePromo, что и в предпросмотре корзины, поэтому
    // условия не могут разъехаться между экраном и сабмитом. Отказ теперь
    // возвращается ошибкой, а не проглатывается: раньше невалидный код просто
    // не применялся, и заказ уходил на полную сумму — пользователь видел в
    // корзине одну цифру, а получал другую, без единого сообщения.
    if (promoCode && String(promoCode).trim()) {
      const { promo, ordersCount, usedByUser } = await loadPromoContext(promoCode, req.userId);
      const check = validatePromo(promo, { total, ordersCount, usedByUser });
      if (!check.valid) {
        return res.status(400).json({ error: check.message });
      }
      discountAmount = check.discount;
      finalTotal = Math.max(0, total - discountAmount);
      appliedPromo = promo;
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

    // Фиксируем применение промокода сразу после успешного создания заказа.
    if (appliedPromo) {
      // Строку в promo_code_uses пишем для любого вида кода — это общая
      // история применений. Для once_per_user она же и есть механизм
      // одноразовости, а уникальный индекс (promo_code_id, user_id) заодно
      // ловит гонку двух одновременно оформляемых заказов, которую проверка
      // выше пропускает. Заказ на этот момент уже создан, поэтому конфликт
      // гасим DO NOTHING: отвечать 500-й на успешно оформленный заказ хуже,
      // чем не записать дубль строки, которая и так уже есть.
      await query(
        `INSERT INTO promo_code_uses (promo_code_id, user_id, telegram_id, order_id)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [appliedPromo.id, req.userId, telegramUser?.id || null, order.id]
      );
      // is_used гасит код целиком, для всех — это верно только для именных
      // (once_global). Массовый приветственный код так помечать нельзя.
      if (appliedPromo.usage_type !== 'once_per_user') {
        await query(
          'UPDATE promo_codes SET is_used = true, used_at = now(), used_by_telegram_id = $1 WHERE id = $2',
          [telegramUser?.id || null, appliedPromo.id]
        );
      }
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

// Разбор payload из диплинка (?start=… у бота, ?src=… в URL мини-аппа).
//
// Telegram жёстко ограничивает payload: до 64 символов из [A-Za-z0-9_-].
// Поэтому сырые "utm_source=vk&utm_campaign=summer" туда не поместить ни
// синтаксически, ни по длине — вместо них компактный позиционный формат.
// Разделять механизмы префиксом, а не флагом, дёшево и расширяемо:
//
//   ref_<КОД>                              — реферальная программа
//   u_<source>-<medium>-<campaign>-<...>   — рекламный источник
//   что угодно ещё                         — молча игнорируем
//
// Дефис служит разделителем полей, поэтому внутри самих значений его быть
// не может — собирающая сторона (лендинг) их зачищает. Пустое поле — это
// пустая позиция: "u_vk--summer" = source vk, medium нет, campaign summer.
//
// Разбор живёт только здесь, на сервере: клиенту достаточно передать сырой
// payload, и две копии формата не разъедутся.
function parseStartPayload(payload) {
  const empty = { utmSource: null, utmCampaign: null, utmMedium: null, referralCode: null };
  if (!payload || typeof payload !== 'string') return empty;
  const raw = payload.trim();
  if (!raw) return empty;

  const ref = /^ref_(.+)$/i.exec(raw);
  if (ref) return { ...empty, referralCode: ref[1] };

  const utm = /^u_(.*)$/i.exec(raw);
  if (utm) {
    const [source, medium, campaign] = utm[1].split('-');
    return {
      ...empty,
      utmSource: source || null,
      utmMedium: medium || null,
      utmCampaign: campaign || null,
    };
  }
  return empty;
}

// Принимает одно событие аналитики. Без авторизации (обычные пользователи),
// но с базовой валидацией — sessionId и eventType обязательны, остальное
// опционально. Фронт шлёт это fire-and-forget и игнорирует любой ответ,
// поэтому ошибки здесь не должны ничего ронять — только логируются.
app.post('/api/analytics/event', async (req, res) => {
  const { sessionId, eventType, screenName, metadata, userId, startPayload } = req.body || {};
  if (!sessionId || typeof sessionId !== 'string' || !eventType || typeof eventType !== 'string') {
    return res.status(400).json({ error: 'Укажите sessionId и eventType' });
  }
  try {
    // Атрибуция пишется только в app_opened — она свойство сессии, а не
    // каждого её события (см. миграцию 050). Клиент присылает сырой payload,
    // если он у него есть; если нет — поднимаем сохранённый ботом на /start,
    // потому что до Mini App payload доходит не всегда (пользователь мог
    // открыть приложение из меню, а не кнопкой под приветственным фото).
    let utm = { utmSource: null, utmCampaign: null, utmMedium: null };
    if (eventType === 'app_opened') {
      const parsed = parseStartPayload(startPayload);
      if (parsed.utmSource) {
        utm = parsed;
      } else if (!startPayload && userId) {
        const saved = await query(
          'SELECT utm_source, utm_campaign, utm_medium FROM start_attributions WHERE telegram_id = $1',
          [userId]
        );
        const row = saved.rows[0];
        if (row) {
          utm = { utmSource: row.utm_source, utmCampaign: row.utm_campaign, utmMedium: row.utm_medium };
        }
      }
    }

    await query(
      `INSERT INTO analytics_events (user_id, session_id, event_type, screen_name, metadata, utm_source, utm_campaign, utm_medium)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId || null,
        sessionId,
        eventType,
        screenName || null,
        metadata ? JSON.stringify(metadata) : null,
        utm.utmSource,
        utm.utmCampaign,
        utm.utmMedium,
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
         RETURNING *, (xmax = 0) AS is_new`,
        [phone, code]
      );
      const { is_new: isNew, ...user } = result.rows[0];
      if (isNew) notifyNewUser(user, 'телефон + SMS');
      return user;
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
  if (p.pricingUnit !== undefined && !['kg', 'piece'].includes(p.pricingUnit)) {
    return res.status(400).json({ error: "pricingUnit должен быть 'kg' или 'piece'" });
  }
  try {
    // weight_kg и price_per_kg имеют смысл только при закупке за кг
    // (migrations/036, 045) — при 'piece' пишем NULL в оба, чтобы в базе не
    // оставались значения, которые ни на что не влияют (price_per_kg без
    // веса нечем умножить, витринный акцент показывать не по чему).
    const pricingUnit = p.pricingUnit === 'kg' ? 'kg' : 'piece';
    const weightKg = pricingUnit === 'kg' && p.weightKg != null && p.weightKg !== '' && Number(p.weightKg) > 0
      ? Number(p.weightKg)
      : null;
    const pricePerKg = pricingUnit === 'kg' && p.pricePerKg != null && p.pricePerKg !== '' && Number(p.pricePerKg) > 0
      ? Number(p.pricePerKg)
      : null;
    // Индивидуальная маржа (migrations/038) — верхний уровень приоритета;
    // 0 — валидное значение, "не задано" — только null/пусто.
    const individualMargin = p.individualMarginPercent != null && p.individualMarginPercent !== '' && Number(p.individualMarginPercent) >= 0
      ? Number(p.individualMarginPercent)
      : null;
    await query(
      `INSERT INTO products
        (id, slug, title, price, old_price, weight, emoji, bg, category, badge_type, badge_label, badge_color, composition, suppliers, pricing, is_active, in_stock, sort_order, image_url, is_bundle, subcategory_id, nutrition, home_image_url, purchase_price, pricing_unit, weight_kg, individual_margin_percent, price_per_kg, home_video_url, card_emoji, card_title, card_subtitle, tag_label, tag_color, audience_label, term_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36)`,
      [
        p.id,
        p.slug || p.id,
        p.title,
        p.price,
        p.oldPrice != null && p.oldPrice !== '' ? p.oldPrice : null,
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
        pricingUnit,
        weightKg,
        individualMargin,
        pricePerKg,
        p.homeVideoUrl || null,
        p.cardEmoji || null,
        p.cardTitle || null,
        p.cardSubtitle || null,
        p.tagLabel || null,
        p.tagColor || null,
        p.audienceLabel || null,
        p.termLabel || null,
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
  if (p.pricingUnit !== undefined && !['kg', 'piece'].includes(p.pricingUnit)) {
    return res.status(400).json({ error: "pricingUnit должен быть 'kg' или 'piece'" });
  }
  try {
    const existing = await query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Товар не найден' });
    const cur = existing.rows[0];

    // Итоговая единица закупки — из запроса или текущая; вес и цена за кг
    // (migrations/036, 045) хранятся только при 'kg', при 'piece' затираются
    // в NULL.
    const pricingUnit = p.pricingUnit !== undefined ? p.pricingUnit : (cur.pricing_unit || 'piece');
    const weightKgRaw = p.weightKg !== undefined ? p.weightKg : cur.weight_kg;
    const weightKg = pricingUnit === 'kg' && weightKgRaw != null && weightKgRaw !== '' && Number(weightKgRaw) > 0
      ? Number(weightKgRaw)
      : null;
    const pricePerKgRaw = p.pricePerKg !== undefined ? p.pricePerKg : cur.price_per_kg;
    const pricePerKg = pricingUnit === 'kg' && pricePerKgRaw != null && pricePerKgRaw !== '' && Number(pricePerKgRaw) > 0
      ? Number(pricePerKgRaw)
      : null;
    // Индивидуальная маржа (migrations/038): undefined — не трогаем,
    // ''/null — сброс на приоритет подкатегория → глобальная.
    const individualMarginRaw = p.individualMarginPercent !== undefined ? p.individualMarginPercent : cur.individual_margin_percent;
    const individualMargin = individualMarginRaw != null && individualMarginRaw !== '' && Number(individualMarginRaw) >= 0
      ? Number(individualMarginRaw)
      : null;

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
        pricing_unit = $23,
        weight_kg = $24,
        individual_margin_percent = $25,
        old_price = $26,
        price_per_kg = $27,
        home_video_url = $28,
        card_emoji = $29,
        card_title = $30,
        card_subtitle = $31,
        tag_label = $32,
        tag_color = $33,
        audience_label = $34,
        term_label = $35,
        updated_at = now()
       WHERE id = $36`,
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
        pricingUnit,
        weightKg,
        individualMargin,
        p.oldPrice !== undefined ? (p.oldPrice !== '' && p.oldPrice != null ? p.oldPrice : null) : cur.old_price,
        pricePerKg,
        p.homeVideoUrl !== undefined ? (p.homeVideoUrl || null) : (cur.home_video_url || null),
        p.cardEmoji !== undefined ? (p.cardEmoji || null) : (cur.card_emoji || null),
        p.cardTitle !== undefined ? (p.cardTitle || null) : (cur.card_title || null),
        p.cardSubtitle !== undefined ? (p.cardSubtitle || null) : (cur.card_subtitle || null),
        p.tagLabel !== undefined ? (p.tagLabel || null) : (cur.tag_label || null),
        p.tagColor !== undefined ? (p.tagColor || null) : (cur.tag_color || null),
        p.audienceLabel !== undefined ? (p.audienceLabel || null) : (cur.audience_label || null),
        p.termLabel !== undefined ? (p.termLabel || null) : (cur.term_label || null),
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
    res.json(result.rows.map(toSubcategoryDTO));
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
    res.status(201).json(toSubcategoryDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/subcategories/:id', requireAuth, async (req, res) => {
  const { name, sortOrder, categoryId, targetMarginPercent } = req.body || {};
  // Целевая маржа (migrations/038): null сбрасывает на глобальную настройку,
  // undefined — поле не трогается.
  if (targetMarginPercent !== null && targetMarginPercent !== undefined) {
    if (typeof targetMarginPercent !== 'number' || Number.isNaN(targetMarginPercent) || targetMarginPercent < 0) {
      return res.status(400).json({ error: 'targetMarginPercent должен быть неотрицательным числом или null' });
    }
  }
  try {
    const existing = await query('SELECT * FROM subcategories WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Подкатегория не найдена' });
    const cur = existing.rows[0];
    const newName = name !== undefined ? String(name).trim() : cur.name;
    const newSlug = name !== undefined
      ? newName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-]/gi, '')
      : cur.slug;
    const result = await query(
      'UPDATE subcategories SET name = $1, slug = $2, sort_order = $3, category_id = $4, target_margin_percent = $5 WHERE id = $6 RETURNING *',
      [
        newName,
        newSlug,
        sortOrder !== undefined ? Number(sortOrder) : cur.sort_order,
        categoryId !== undefined ? categoryId : cur.category_id,
        targetMarginPercent !== undefined ? targetMarginPercent : cur.target_margin_percent,
        req.params.id,
      ]
    );
    res.json(toSubcategoryDTO(result.rows[0]));
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
    usageType: row.usage_type,
    isUsed: row.is_used,
    usedAt: row.used_at,
    expiresAt: row.expires_at,
    minOrderNumber: row.min_order_number,
    maxOrderNumber: row.max_order_number,
    createdAt: row.created_at,
  };
}

// Селект в админке оперирует понятными вариантами, а в базе лежит пара границ
// (см. миграцию 044). Раскладываем вариант на min/max здесь, чтобы фронт не
// знал про внутреннее представление и не мог записать несогласованную пару.
function orderConditionToRange(condition, n) {
  const count = Number.parseInt(n, 10);
  switch (condition) {
    case 'first_order': return { min: null, max: 1 };
    case 'repeat_order': return { min: 2, max: null };
    case 'first_n_orders':
      // Некорректное или отсутствующее N трактуем как отсутствие ограничения,
      // а не как "первые 0 заказов" — такой код не сработал бы никогда.
      return Number.isInteger(count) && count >= 1 ? { min: null, max: count } : { min: null, max: null };
    default: return { min: null, max: null };
  }
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
  const { code, discountType, discountValue, minOrderTotal, expiresAt, orderCondition, orderConditionN, usageType } = req.body || {};
  if (!code || !String(code).trim() || !discountValue) {
    return res.status(400).json({ error: 'Укажите код и размер скидки' });
  }
  if (orderCondition === 'first_n_orders' && !(Number.parseInt(orderConditionN, 10) >= 1)) {
    return res.status(400).json({ error: 'Укажите, на сколько первых заказов действует промокод' });
  }
  const type = discountType === 'percent' ? 'percent' : 'fixed';
  // Неизвестное значение схлопываем в once_global — это более узкое право
  // (код сгорает после первого применения), поэтому ошибка в сторону
  // безопасности, а не бесконечно применимого кода.
  const usage = usageType === 'once_per_user' ? 'once_per_user' : 'once_global';
  const range = orderConditionToRange(orderCondition, orderConditionN);
  try {
    const result = await query(
      `INSERT INTO promo_codes (code, discount_type, discount_value, min_order_total, expires_at, min_order_number, max_order_number, usage_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        String(code).trim().toUpperCase(),
        type,
        discountValue,
        minOrderTotal || 0,
        expiresAt || null,
        range.min,
        range.max,
        usage,
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
      createdAt: d.created_at,
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
    res.status(201).json({ id: d.id, emoji: d.emoji, title: d.title, text: d.text, imageUrl: d.image_url || null, sortOrder: d.sort_order, createdAt: d.created_at });
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
    res.json({ id: d.id, emoji: d.emoji, title: d.title, text: d.text, imageUrl: d.image_url || null, sortOrder: d.sort_order, createdAt: d.created_at });
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
// Админские маршруты — сторис-карточки Главной (migrations/047)
// ============================================================

// Presigned PUT в S3 (Selectel) — админка грузит файл НАПРЯМУЮ в бакет по
// этой временной ссылке, минуя бэкенд. Видео тяжёлое, гонять его через
// прокси-ручку (как /api/admin/upload-image для картинок в Cloudinary)
// незачем: сервер бы держал весь файл в памяти multer'ом ради того же
// результата. Бэкенд только подписывает ссылку и говорит, по какому
// публичному URL файл будет доступен после заливки — сам URL сохраняется в
// story_cards отдельным PUT-запросом уже после успешной загрузки.
//
// Бакет публичный на чтение, поэтому presigned нужен только на запись
// (GET-ссылки постоянные, без срока жизни — их и храним в БД).
//
// ВАЖНО: этот путь НЕ РАБОТАЕТ из браузера — Selectel не отвечает на
// CORS-preflight, когда в URL есть presigned-параметры (см. подробности в
// s3.js). Реальная загрузка из админки идёт через прокси-эндпоинт
// /api/admin/story-cards/upload ниже. Ручка оставлена рабочей на случай,
// если провайдер починит preflight на своей стороне.
const STORY_UPLOAD_URL_TTL_SEC = 15 * 60;
// setVideo — видео набора для hero-блока Главной (migrations/048). Отдельный
// префикс, а не stories/video: в одном бакете иначе не отличить видео набора
// от видео сторис, а чистка мусора идёт именно по префиксам. Пайплайн тот же
// (busboy + ffmpeg + заливка потоком) — обработка выбирается по типу файла,
// а не по kind, поэтому достаточно записи в этой таблице.
const STORY_ALLOWED_KINDS = { video: 'stories/video', cover: 'stories/cover', setVideo: 'sets/video' };

// Какие kind несут видео (а не картинку): от этого зависит и ожидаемый
// content-type, и то, гнать ли файл через ffmpeg. Проверять по списку, а не
// сравнением kind === 'video', иначе каждый новый видео-kind пришлось бы
// дописывать в три разных места.
const STORY_VIDEO_KINDS = new Set(['video', 'setVideo']);

// Лимит размера файла. Сторис — ролики на 7–75 секунд; 200 МБ с большим
// запасом покрывают даже минуту с телефона в высоком битрейте, но не дают
// залить в витрину произвольно тяжёлый файл.
const STORY_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

// База публичной ссылки. По умолчанию — сам S3-эндпоинт в path-style, как
// у клиента (forcePathStyle в s3.js).
//
// S3_PUBLIC_BASE_URL позволяет отдать другой хост, не трогая код: у
// Selectel «публичность» контейнера работает через их Swift/CDN-домен, а
// НЕ через S3-эндпоинт — по s3.ru-7.storage.selcloud.ru объекты отдаются с
// 403 даже когда контейнер помечен публичным (проверено на живом бакете:
// и загруженный по API файл, и залитый вручную через панель, читаются
// только по своему публичному домену).
function storyPublicUrl(key) {
  const base = process.env.S3_PUBLIC_BASE_URL
    ? process.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')
    : `${String(process.env.S3_ENDPOINT || '').replace(/\/+$/, '')}/${S3_BUCKET}`;
  return `${base}/${key}`;
}

// Расширение берём из имени файла, а не из mime — mime-типы видео
// (video/quicktime) не мапятся на расширение однозначно.
function storyObjectKey(prefix, fileName) {
  const ext = String(fileName || '').includes('.')
    ? String(fileName).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
    : '';
  return `${prefix}/${crypto.randomUUID()}${ext ? `.${ext}` : ''}`;
}

// ── Транскодирование видео сторис ────────────────────────────────────────────
//
// Исходники — сырой экспорт с телефона: 1920x1080@60fps H.264 на 22-23 Мбит/с,
// 20-29 МБ на 7-10 секунд. Во StoryViewer это показывается в боксе шириной до
// ~480px CSS, то есть избыточно примерно на порядок и было главным вкладом в
// задержку старта видео (см. разведку: readyState залипал на HAVE_METADATA,
// пока файл качался).
//
// Целевой бокс — ПОРТРЕТНЫЙ. Исходники сняты на телефон: в потоке лежат как
// 1920x1080, но с матрицей поворота (rotation=-90), то есть реально
// отображаются как 1080x1920. ffmpeg применяет поворот до фильтров, поэтому
// iw/ih ниже — уже повёрнутые размеры, и бокс должен быть 720x1280, иначе
// портрет вписывается в ландшафтный бокс и схлопывается до ~404px по ширине.
// Кадрирование под 3:4 вьюера по-прежнему делает CSS (object-fit: cover) —
// на сервере кадр не режем, чтобы не сдвинуть то, что попадает в кадр.
const TRANSCODE_MAX_WIDTH = 720;
const TRANSCODE_MAX_HEIGHT = 1280;
const TRANSCODE_FPS = 30;    // исходные ~60 для еды крупным планом не нужны
// Качество вместо жёсткого битрейта: на малоподвижном контенте даёт меньший
// размер при том же виде. 26 подобран замером на реальном ролике — 2.35 Мбит/с
// против 3.47 у CRF 23, покадровое сравнение с оригиналом отличий не выявило.
const TRANSCODE_CRF = 26;
const TRANSCODE_TIMEOUT_MS = 4 * 60 * 1000;

// ffmpeg пишет прогресс в stderr и может там накопить много — не даём буферу
// расти бесконечно, для диагностики хватает хвоста.
const FFMPEG_STDERR_KEEP_CHARS = 4000;

/**
 * Перекодирует видеофайл под веб-доставку. Возвращает промис, который
 * резолвится, когда outPath готов. Всегда убивает процесс по таймауту —
 * иначе зависший ffmpeg держал бы HTTP-запрос до его собственного таймаута.
 */
function transcodeStoryVideo(inPath, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inPath,
      // Вписать в 1280x720 с сохранением пропорций; -2 держит чётность
      // размеров (обязательна для yuv420p) и не апскейлит то, что и так меньше.
      '-vf', `scale='min(${TRANSCODE_MAX_WIDTH},iw)':'min(${TRANSCODE_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${TRANSCODE_FPS}`,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', String(TRANSCODE_CRF),
      // yuv420p — иначе часть мобильных плееров не покажет картинку вовсе.
      '-pix_fmt', 'yuv420p',
      // Звук вырезаем целиком: сторис жёстко muted без какого-либо UI для
      // включения звука (StoryViewer.jsx), дорожку физически невозможно
      // услышать — это бесплатные ~10% веса.
      '-an',
      // moov-атом в начало файла: без этого плеер не может начать
      // проигрывание, пока не скачает файл целиком.
      '-movflags', '+faststart',
      '-y', outPath,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let timedOut = false;

    proc.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-FFMPEG_STDERR_KEEP_CHARS);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, TRANSCODE_TIMEOUT_MS);

    proc.on('error', (e) => {
      clearTimeout(timer);
      // ENOENT здесь — ffmpeg не установлен в образе (см. railpack.json).
      reject(new Error(`Не удалось запустить ffmpeg: ${e.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`ffmpeg превысил лимит ${TRANSCODE_TIMEOUT_MS / 1000}с и был остановлен`));
      }
      if (code !== 0) {
        return reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-800)}`));
      }
      resolve();
    });
  });
}

app.post('/api/admin/story-cards/upload-url', requireAuth, async (req, res) => {
  const { kind, contentType, fileName } = req.body || {};
  const prefix = STORY_ALLOWED_KINDS[kind];
  if (!prefix) {
    return res.status(400).json({ error: `kind должен быть одним из: ${Object.keys(STORY_ALLOWED_KINDS).join(', ')}` });
  }
  if (!contentType || typeof contentType !== 'string') {
    return res.status(400).json({ error: 'Укажите contentType файла' });
  }
  const expectedPrefix = STORY_VIDEO_KINDS.has(kind) ? 'video/' : 'image/';
  if (!contentType.startsWith(expectedPrefix)) {
    return res.status(400).json({ error: `Для kind=${kind} ожидается contentType ${expectedPrefix}*` });
  }
  if (!S3_BUCKET) {
    return res.status(500).json({ error: 'S3 не настроен: не задан S3_BUCKET' });
  }
  try {
    // Расширение берём из имени файла, а не из contentType — mime-типы
    // видео (video/quicktime) не мапятся на расширение однозначно.
    const ext = String(fileName || '').includes('.')
      ? String(fileName).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
      : '';
    const key = storyObjectKey(prefix, fileName);
    // s3PresignClient, а не s3Client: подпись под хост, который в принципе
    // умеет отвечать на CORS-preflight (см. s3.js).
    const uploadUrl = await getSignedUrl(
      s3PresignClient,
      new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }),
      { expiresIn: STORY_UPLOAD_URL_TTL_SEC }
    );
    res.json({ uploadUrl, publicUrl: storyPublicUrl(key), key, expiresIn: STORY_UPLOAD_URL_TTL_SEC });
  } catch (e) {
    console.error('S3 presign error:', e);
    res.status(500).json({ error: 'Не удалось подготовить ссылку для загрузки' });
  }
});

/**
 * Приём видео сторис: поток → временный файл → ffmpeg → временный файл →
 * S3. Синхронно в рамках HTTP-запроса (для одного админа, загружающего
 * сторис вручную, это приемлемо; очередь была бы оверинжинирингом при
 * текущем объёме — при желании сюда же позже вставляется фоновая задача).
 *
 * Ключ в S3 всегда .mp4 независимо от исходного расширения — на выходе
 * ffmpeg всегда mp4, и отдавать .mov-ключ для mp4-содержимого нельзя.
 */
async function handleVideoUpload({ stream, filename, prefix, reply, req, res, isSettled }) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'story-'));
  const srcExt = String(filename || '').includes('.')
    ? String(filename).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
    : 'bin';
  const inPath = path.join(tmpDir, `in.${srcExt || 'bin'}`);
  const outPath = path.join(tmpDir, 'out.mp4');
  const key = `${prefix}/${crypto.randomUUID()}.mp4`;

  let tooLarge = false;
  stream.on('limit', () => { tooLarge = true; });

  // Отдельный флаг вместо req.destroyed: у req включён autoDestroy, поэтому
  // сразу после того, как тело запроса дочитано до конца, req.destroyed
  // становится true и на штатном пути тоже. Проверка по нему молча
  // прекращала обработку ещё до ffmpeg и не отвечала вовсе — запрос висел
  // до 5-минутного таймаута прокси Railway (502 upstream error).
  let clientGone = false;
  const markGone = () => { if (!isSettled()) clientGone = true; };
  req.on('aborted', markGone);
  res.on('close', markGone);

  const cleanupTmp = async () => {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* уже нет — не страшно */ }
  };

  try {
    // pipeline закроет дескриптор и на ошибке тоже — иначе на неудачных
    // загрузках копились бы висящие файлы во временной папке.
    await pipeline(stream, fs.createWriteStream(inPath));

    if (tooLarge) {
      await cleanupTmp();
      return reply(413, { error: `Файл больше ${Math.round(STORY_UPLOAD_MAX_BYTES / 1024 / 1024)} МБ` });
    }
    // Клиент мог отвалиться, пока шла заливка на диск — тогда ffmpeg
    // запускать уже незачем, ответ всё равно никто не прочитает.
    if (isSettled() || clientGone) {
      await cleanupTmp();
      return;
    }

    const srcBytes = (await fs.promises.stat(inPath)).size;
    const startedAt = Date.now();
    await transcodeStoryVideo(inPath, outPath);
    const outBytes = (await fs.promises.stat(outPath)).size;
    console.log(
      `story video transcoded: ${(srcBytes / 1024 / 1024).toFixed(1)}МБ → ` +
      `${(outBytes / 1024 / 1024).toFixed(1)}МБ за ${((Date.now() - startedAt) / 1000).toFixed(1)}с (${key})`
    );

    if (isSettled() || clientGone) {
      await cleanupTmp();
      return;
    }

    const upload = new Upload({
      client: s3Client,
      params: {
        Bucket: S3_BUCKET, Key: key, Body: fs.createReadStream(outPath),
        ContentType: 'video/mp4',
        CacheControl: 'public, max-age=31536000, immutable',
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
    });
    const abortIfUnsettled = () => {
      if (isSettled()) return;
      upload.abort().catch(() => { /* могло уже завершиться */ });
    };
    req.on('aborted', abortIfUnsettled);
    res.on('close', abortIfUnsettled);

    await upload.done();
    reply(200, { url: storyPublicUrl(key), key });
  } catch (e) {
    console.error('story video upload/transcode error:', e);
    // Объекта в S3 на этом пути ещё нет (заливка идёт последним шагом и
    // при её падении lib-storage сам обрывает multipart) — чистим только диск.
    reply(500, { error: 'Не удалось обработать видео' });
  } finally {
    await cleanupTmp();
  }
}

// Загрузка файла сторис ЧЕРЕЗ бэкенд (multipart/form-data, поле "file",
// вид — в ?kind=video|cover). Это рабочий путь загрузки из админки: прямой
// presigned PUT из браузера в Selectel невозможен, потому что их шлюз не
// отдаёт CORS-заголовки на запись (детали в s3.js).
//
// Тело НЕ буферизуется: busboy отдаёт поток файла, lib-storage режет его на
// части и грузит в S3 по мере поступления. Ради этого здесь busboy, а не
// multer (как в /api/admin/upload-image) — multer держит файл целиком в
// памяти, что для видео на сотню мегабайт неприемлемо.
app.post('/api/admin/story-cards/upload', requireAuth, (req, res) => {
  const kind = String(req.query.kind || '');
  const prefix = STORY_ALLOWED_KINDS[kind];
  if (!prefix) {
    return res.status(400).json({ error: `kind должен быть одним из: ${Object.keys(STORY_ALLOWED_KINDS).join(', ')}` });
  }
  if (!S3_BUCKET) {
    return res.status(500).json({ error: 'S3 не настроен: не задан S3_BUCKET' });
  }

  let bb;
  try {
    bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: STORY_UPLOAD_MAX_BYTES } });
  } catch {
    return res.status(400).json({ error: 'Ожидается multipart/form-data' });
  }

  // Ответить можно только один раз: сюда ведут несколько независимых путей
  // (ошибка разбора, превышение лимита, ошибка S3, успех).
  let settled = false;
  const reply = (status, body) => {
    if (settled) return;
    settled = true;
    res.status(status).json(body);
  };

  let sawFile = false;

  bb.on('file', (_field, stream, info) => {
    sawFile = true;
    const { filename, mimeType } = info;
    const expected = STORY_VIDEO_KINDS.has(kind) ? 'video/' : 'image/';
    if (!mimeType || !mimeType.startsWith(expected)) {
      // Поток обязательно осушить, иначе запрос повиснет до таймаута.
      stream.resume();
      return reply(400, { error: `Для kind=${kind} ожидается файл ${expected}*` });
    }

    // Видео идёт через ffmpeg и потому через диск: ffmpeg не умеет читать
    // из пайпа и одновременно писать mp4 с moov-атомом в начале (длину
    // потока нужно знать заранее). Обложки как грузились напрямую в S3
    // без промежуточного файла, так и грузятся.
    if (STORY_VIDEO_KINDS.has(kind)) {
      return handleVideoUpload({ stream, filename, prefix, reply, req, res, isSettled: () => settled });
    }

    const key = storyObjectKey(prefix, filename);
    let tooLarge = false;

    const upload = new Upload({
      client: s3Client,
      // immutable безопасен — имя объекта содержит UUID (см. storyObjectKey),
      // один и тот же ключ никогда не перезаписывается новым содержимым.
      // Тот же паттерн, что у прокси аватарок (см. Cache-Control там же).
      params: {
        Bucket: S3_BUCKET, Key: key, Body: stream, ContentType: mimeType,
        CacheControl: 'public, max-age=31536000, immutable',
      },
      partSize: 8 * 1024 * 1024,
      queueSize: 2,
    });

    // Лимит busboy обрезает поток молча — без abort() в S3 уехал бы
    // «успешно загруженный» обрезанный файл.
    stream.on('limit', () => {
      tooLarge = true;
      upload.abort().catch(() => { /* уже могло завершиться */ });
    });

    // Клиент отвалился на полпути (закрыл вкладку, оборвалась сеть, или мы
    // сами оборвали соединение отказом по лимиту). Без явного abort в
    // хранилище остаётся незавершённая multipart-загрузка: объекта в
    // листинге нет, а место занято — проверено на живом бакете.
    const abortIfUnsettled = () => {
      if (settled) return;
      upload.abort().catch(() => { /* могло уже завершиться */ });
    };
    req.on('aborted', abortIfUnsettled);
    res.on('close', abortIfUnsettled);

    const cleanupPartial = async () => {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      } catch { /* объекта может и не быть — это нормально */ }
    };

    upload.done()
      .then(async () => {
        if (tooLarge) {
          await cleanupPartial();
          return reply(413, { error: `Файл больше ${Math.round(STORY_UPLOAD_MAX_BYTES / 1024 / 1024)} МБ` });
        }
        reply(200, { url: storyPublicUrl(key), key });
      })
      .catch(async (e) => {
        await cleanupPartial();
        if (tooLarge) {
          return reply(413, { error: `Файл больше ${Math.round(STORY_UPLOAD_MAX_BYTES / 1024 / 1024)} МБ` });
        }
        console.error('S3 stream upload error:', e);
        reply(500, { error: 'Не удалось загрузить файл в хранилище' });
      });
  });

  bb.on('close', () => {
    if (!sawFile) reply(400, { error: 'Файл не получен' });
  });

  bb.on('error', (e) => {
    console.error('busboy error:', e);
    reply(500, { error: 'Ошибка разбора запроса' });
  });

  req.pipe(bb);
});

app.get('/api/admin/story-cards', requireAuth, async (req, res) => {
  try {
    const result = await query('SELECT * FROM story_cards ORDER BY sort_order ASC, id ASC');
    res.json(result.rows.map(toStoryCardDTO));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/admin/story-cards', requireAuth, async (req, res) => {
  const { title, priceLabel, coverImageUrl, videoUrl, durationSeconds, badgeText, productId, sortOrder, isActive } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Укажите title' });
  }
  try {
    const result = await query(
      `INSERT INTO story_cards
         (title, price_label, cover_image_url, video_url, duration_seconds, badge_text, product_id, sort_order, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        String(title).trim(),
        priceLabel != null ? String(priceLabel).trim() : '',
        coverImageUrl || null,
        videoUrl || null,
        Number(durationSeconds) || 0,
        badgeText ? String(badgeText).trim() : null,
        productId || null,
        Number(sortOrder) || 0,
        isActive !== undefined ? Boolean(isActive) : true,
      ]
    );
    res.status(201).json(toStoryCardDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Частичное обновление: undefined-поля не трогаем (как в PUT подкатегорий) —
// админка шлёт форму целиком, но загрузка файлов сохраняет URL отдельно,
// не перетирая остальное.
app.put('/api/admin/story-cards/:id', requireAuth, async (req, res) => {
  const { title, priceLabel, coverImageUrl, videoUrl, durationSeconds, badgeText, productId, sortOrder, isActive } = req.body || {};
  try {
    const existing = await query('SELECT * FROM story_cards WHERE id = $1', [req.params.id]);
    const cur = existing.rows[0];
    if (!cur) return res.status(404).json({ error: 'Карточка не найдена' });
    const result = await query(
      `UPDATE story_cards SET
         title = $1, price_label = $2, cover_image_url = $3, video_url = $4,
         duration_seconds = $5, badge_text = $6, product_id = $7, sort_order = $8, is_active = $9
       WHERE id = $10 RETURNING *`,
      [
        title !== undefined ? String(title).trim() : cur.title,
        priceLabel !== undefined ? String(priceLabel).trim() : cur.price_label,
        coverImageUrl !== undefined ? (coverImageUrl || null) : cur.cover_image_url,
        videoUrl !== undefined ? (videoUrl || null) : cur.video_url,
        durationSeconds !== undefined ? (Number(durationSeconds) || 0) : cur.duration_seconds,
        badgeText !== undefined ? (badgeText ? String(badgeText).trim() : null) : cur.badge_text,
        productId !== undefined ? (productId || null) : cur.product_id,
        sortOrder !== undefined ? (Number(sortOrder) || 0) : cur.sort_order,
        isActive !== undefined ? Boolean(isActive) : cur.is_active,
        req.params.id,
      ]
    );
    res.json(toStoryCardDTO(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Файлы в S3 при удалении карточки не трогаем — публичная ссылка могла уже
// уйти наружу, а место в бакете дешевле неожиданно битой ссылки. Чистка
// осиротевших объектов — отдельная задача, если понадобится.
app.delete('/api/admin/story-cards/:id', requireAuth, async (req, res) => {
  try {
    const result = await query('DELETE FROM story_cards WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Карточка не найдена' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление произвольного объекта сторис из S3 по ключу — для расчистки
// мусора (осиротевшие оригиналы, тестовые загрузки), не привязанного ни к
// одной строке story_cards. Ключ ограничен префиксом stories/, чтобы
// опечатка или чужой ключ не задели что-то за пределами этой фичи.
app.delete('/api/admin/story-media', requireAuth, async (req, res) => {
  const key = String(req.query.key || req.body?.key || '');
  if (!key.startsWith('stories/')) {
    return res.status(400).json({ error: 'key должен начинаться с stories/' });
  }
  if (!S3_BUCKET) {
    return res.status(500).json({ error: 'S3 не настроен: не задан S3_BUCKET' });
  }
  try {
    await s3Client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    res.json({ ok: true });
  } catch (e) {
    console.error('S3 delete error:', e);
    res.status(500).json({ error: 'Не удалось удалить объект' });
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

// Предикат для каждого целевого события воронки — единственное место, где
// живёт соответствие "целевое имя → то, что реально лежит в базе".
//
// Часть событий пишется под историческими именами (checkout_start,
// order_placed) — переименовывать их в базе значило бы порвать историю,
// поэтому имена сведены к целевому списку здесь, алиасами.
//
// Товар и набор — одно и то же событие с разным metadata.category: у
// наборов category = 'bundles'. Отдельных event_type для них нет
// намеренно — иначе пришлось бы дублировать всю логику отправки ради
// одного признака.
const FUNNEL_EVENT_SQL = {
  landing_viewed:      `event_type = 'landing_viewed'`,
  app_opened:          `event_type = 'app_opened'`,
  catalog_opened:      `event_type = 'screen_view' AND screen_name = 'catalog'`,
  sets_opened:         `event_type = 'sets_opened'`,
  product_opened:      `event_type = 'screen_view' AND screen_name = 'product' AND COALESCE(metadata->>'category', '') <> 'bundles'`,
  set_opened:          `event_type = 'screen_view' AND screen_name = 'product' AND metadata->>'category' = 'bundles'`,
  add_to_cart_product: `event_type = 'add_to_cart' AND COALESCE(metadata->>'category', '') <> 'bundles'`,
  add_to_cart_set:     `event_type = 'add_to_cart' AND metadata->>'category' = 'bundles'`,
  cart_opened:         `event_type = 'screen_view' AND screen_name = 'cart'`,
  checkout_started:    `event_type = 'checkout_start'`,
  address_started:     `event_type = 'address_started'`,
  address_completed:   `event_type = 'address_completed'`,
  payment_step_opened: `event_type = 'payment_step_opened'`,
  order_created:       `event_type = 'order_placed'`,
};

// Воронка описана стадиями, а не плоским списком из 14 шагов, потому что
// плоский список давал бы заведомо неверные проценты:
//
//   • landing_viewed живёт на другом домене (prilavka.shop) и в своей
//     сессии — с app_opened по session_id он не связывается в принципе,
//     поэтому вынесен в отдельный блок "до приложения" с грубым
//     отношением вместо честного отвала (см. ниже preFunnel);
//   • наборы — это ВЕТКА, а не ступень: сессия, ушедшая в наборы, не даёт
//     product_opened, и линейный шаг показал бы фиктивный "отвал 100%".
//     Поэтому у стадии может быть branches — они считаются параллельно и
//     не участвуют в расчёте отвала;
//   • address_* и payment_step_opened происходят ВНУТРИ оформления, между
//     checkout_started и order_created — это под-воронка, а не стадии
//     основной.
const FUNNEL_STAGES = [
  { key: 'app_opened', label: 'Открыли приложение' },
  { key: 'catalog_opened', label: 'Каталог', branches: [{ key: 'sets_opened', label: 'Готовые наборы' }] },
  { key: 'product_opened', label: 'Карточка товара', branches: [{ key: 'set_opened', label: 'Карточка набора' }] },
  { key: 'add_to_cart_product', label: 'Товар в корзину', branches: [{ key: 'add_to_cart_set', label: 'Набор в корзину' }] },
  { key: 'cart_opened', label: 'Корзина' },
  { key: 'checkout_started', label: 'Начали оформление' },
  { key: 'order_created', label: 'Заказ оформлен' },
];

// Под-воронка внутри оформления — от начала оформления до заказа.
const CHECKOUT_SUBSTEPS = [
  { key: 'checkout_started', label: 'Начали оформление' },
  { key: 'address_started', label: 'Открыли адрес' },
  { key: 'address_completed', label: 'Адрес сохранён' },
  { key: 'payment_step_opened', label: 'Дошли до оплаты' },
  { key: 'order_created', label: 'Заказ оформлен' },
];

// Фильтр по источнику трафика. Атрибуция лежит только в строке app_opened
// (см. миграцию 050), поэтому фильтруем не событие, а СЕССИЮ: берём
// session_id тех сессий, чей app_opened подходит под источник, и дальше
// считаем по ним любые события. Без этого фильтр по utm_source отсекал бы
// всё, кроме самих app_opened, и воронка схлопнулась бы в одну ступень.
function attributionFilter(reqQuery, params) {
  const conds = [];
  if (reqQuery.utm_source) {
    params.push(reqQuery.utm_source);
    conds.push(`utm_source = $${params.length}`);
  }
  if (reqQuery.utm_campaign) {
    params.push(reqQuery.utm_campaign);
    conds.push(`utm_campaign = $${params.length}`);
  }
  if (conds.length === 0) return '';
  return ` AND session_id IN (
    SELECT session_id FROM analytics_events
    WHERE event_type = 'app_opened' AND ${conds.join(' AND ')}
  )`;
}

// Воронка: для каждого шага — уникальные session_id за период (не строго
// последовательно — сессия считается "дошедшей" до шага, если у неё есть
// хоть одно подходящее событие в диапазоне), и % отвала от предыдущего шага.
app.get('/api/admin/analytics/funnel', requireAuth, async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query);
    const params = [from, to];
    const attrWhere = attributionFilter(req.query, params);

    // Считаем все 14 целевых событий одним запросом — раскладываем по
    // стадиям/веткам/под-шагам уже здесь, в JS.
    const unionSql = Object.entries(FUNNEL_EVENT_SQL)
      .map(([key, predicate]) => `SELECT '${key}' AS step, COUNT(DISTINCT session_id)::int AS count
        FROM analytics_events
        WHERE (${predicate}) AND created_at >= $1 AND created_at < $2${
          // landing_viewed приходит с лендинга, где никакого app_opened и
          // никакой атрибуции в нашем смысле нет — фильтр по источнику к
          // нему неприменим, иначе он всегда обнулялся бы.
          key === 'landing_viewed' ? '' : attrWhere
        }`)
      .join(' UNION ALL ');
    const result = await query(unionSql, params);
    const countOf = Object.fromEntries(result.rows.map((r) => [r.step, r.count]));

    // Основная воронка: отвал считается только по магистрали, ветки идут
    // рядом и в расчёт отвала не входят (см. комментарий у FUNNEL_STAGES).
    let prevCount = null;
    const stages = FUNNEL_STAGES.map((s) => {
      const count = countOf[s.key] || 0;
      const dropOffPct = prevCount == null
        ? null
        : prevCount === 0 ? 0 : Math.round((1 - count / prevCount) * 1000) / 10;
      prevCount = count;
      return {
        step: s.key,
        label: s.label,
        count,
        dropOffPct,
        branches: (s.branches || []).map((b) => ({ step: b.key, label: b.label, count: countOf[b.key] || 0 })),
      };
    });

    let prevSub = null;
    const checkoutSteps = CHECKOUT_SUBSTEPS.map((s) => {
      const count = countOf[s.key] || 0;
      const dropOffPct = prevSub == null
        ? null
        : prevSub === 0 ? 0 : Math.round((1 - count / prevSub) * 1000) / 10;
      prevSub = count;
      return { step: s.key, label: s.label, count, dropOffPct };
    });

    // Лендинг и мини-апп — разные origin и разные сессии, связать их по
    // session_id нельзя. Поэтому не ступень воронки, а отдельный блок с
    // честно названным грубым отношением.
    const landingViews = countOf.landing_viewed || 0;
    const appOpens = countOf.app_opened || 0;
    const preFunnel = {
      landingViews,
      appOpens,
      ratioPct: landingViews ? Math.round((appOpens / landingViews) * 1000) / 10 : null,
    };

    res.json({ from, to, stages, checkoutSteps, preFunnel });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Имя пользователя для аналитики. ВАЖНО: analytics_events.user_id — это
// telegram_id (фронт шлёт Telegram.WebApp.initDataUnsafe.user.id), а НЕ
// суррогатный users.id, на который ссылается orders.user_id. Поэтому JOIN
// в запросах ниже идёт по users.telegram_id — иначе к сессиям подтянулись бы
// имена посторонних людей с совпавшим id.
//
// Возвращает null, когда сопоставить не с кем: у входа по телефону (без
// Telegram) и у сессий вне Telegram user_id вообще не пишется.
function analyticsUserName(row) {
  if (row.first_name || row.username) {
    return [row.first_name, row.username && `@${row.username}`].filter(Boolean).join(' ');
  }
  return row.phone || null;
}

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
    const attrWhere = attributionFilter(req.query, params);
    const result = await query(
      `WITH sess AS (
         SELECT
           session_id,
           MAX(user_id) AS user_id,
           MIN(created_at) AS started_at,
           COUNT(*)::int AS event_count,
           -- Атрибуция лежит только в строке app_opened, в остальных NULL,
           -- поэтому MAX по сессии и достаёт ровно её (см. миграцию 050).
           MAX(utm_source) AS utm_source,
           MAX(utm_campaign) AS utm_campaign,
           MAX(
             CASE
               WHEN event_type = 'order_placed' THEN 7
               WHEN event_type = 'checkout_start' THEN 6
               WHEN event_type = 'screen_view' AND screen_name = 'cart' THEN 5
               WHEN event_type = 'add_to_cart' THEN 4
               WHEN event_type = 'screen_view' AND screen_name = 'product' THEN 3
               WHEN event_type = 'screen_view' AND screen_name = 'catalog' THEN 2
               WHEN event_type = 'sets_opened' THEN 2
               WHEN event_type = 'app_opened' THEN 1
               WHEN event_type = 'screen_view' AND screen_name = 'home' THEN 1
               ELSE 0
             END
           ) AS final_step_rank
         FROM analytics_events
         WHERE created_at >= $1 AND created_at < $2 ${userFilter}${attrWhere}
         GROUP BY session_id
       )
       SELECT sess.*, u.first_name, u.username, u.phone
       FROM sess
       LEFT JOIN users u ON u.telegram_id = sess.user_id
       ORDER BY sess.started_at DESC
       LIMIT 200`,
      params
    );
    const STEP_BY_RANK = ['other', 'app_opened', 'catalog_opened', 'product_opened', 'add_to_cart', 'cart_opened', 'checkout_started', 'order_created'];
    res.json(result.rows.map((r) => ({
      sessionId: r.session_id,
      userId: r.user_id,
      userName: analyticsUserName(r),
      startedAt: r.started_at,
      eventCount: r.event_count,
      finalStep: STEP_BY_RANK[r.final_step_rank] || 'other',
      utmSource: r.utm_source,
      utmCampaign: r.utm_campaign,
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Какие источники вообще встречались за период — чтобы в админке выбирать
// из реального списка, а не вспоминать, как именно была размечена ссылка.
app.get('/api/admin/analytics/sources', requireAuth, async (req, res) => {
  try {
    const { from, to } = parseAnalyticsRange(req.query);
    const result = await query(
      `SELECT utm_source, utm_campaign, COUNT(DISTINCT session_id)::int AS sessions
       FROM analytics_events
       WHERE event_type = 'app_opened' AND utm_source IS NOT NULL
         AND created_at >= $1 AND created_at < $2
       GROUP BY utm_source, utm_campaign
       ORDER BY sessions DESC`,
      [from, to]
    );
    res.json(result.rows.map((r) => ({
      utmSource: r.utm_source,
      utmCampaign: r.utm_campaign,
      sessions: r.sessions,
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
      `SELECT e.user_id, e.event_type, e.screen_name, e.metadata, e.created_at,
              u.first_name, u.username, u.phone
       FROM analytics_events e
       LEFT JOIN users u ON u.telegram_id = e.user_id
       WHERE e.session_id = $1 ORDER BY e.created_at ASC`,
      [req.params.session_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Сессия не найдена' });
    }
    const identified = result.rows.find((r) => r.user_id != null);
    res.json({
      sessionId: req.params.session_id,
      userId: identified?.user_id ?? null,
      userName: identified ? analyticsUserName(identified) : null,
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

// Публичный: время отсечки для предупреждения "успеем доставить только
// завтра" при выборе даты "Сегодня" (Cart.jsx, migrations/046). Отдельный
// эндпоинт, а не поле внутри /api/delivery-schedule — тот отдаёт голый
// массив (schedule.map/every/findIndex во фронте завязаны на эту форму),
// и превращение его в { days, todayCutoffTime } было бы breaking change
// публичного API: при рассинхроне деплоя бэкенда и клиента с ещё не
// обновившимся бандлом (см. useVersionCheck.js) чекаут упал бы на
// "schedule.map is not a function" у всех со старым бандлом в памяти.
app.get('/api/delivery-cutoff', (req, res) => {
  res.json({ todayCutoffTime: getSetting('today_cutoff_time') });
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

// Вариант botRequest для методов с файлом (sendPhoto и т.п.) — Bot API для
// них требует multipart/form-data, не JSON. FormData/Blob — нативные (Node
// 18+), fetch сам проставляет верный Content-Type с boundary; вручную его
// задавать нельзя — сломает границу между полями.
async function botRequestMultipart(method, { file, fileField, ...fields }) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  try {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    form.append(fileField, new Blob([file.buffer]), file.filename);

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json();
    if (!data.ok) console.error(`botRequestMultipart ${method} failed:`, data);
    return data.ok ? data.result : null;
  } catch (e) {
    console.error(`botRequestMultipart ${method} error:`, e);
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

// parse_mode: 'HTML' — не MarkdownV2: тот требует экранирования почти
// дюжины спецсимволов (. ! - и т.д.), а в этом тексте есть и точки, и
// восклицательный знак. HTML-варианту нужно экранировать только & < >,
// которых в тексте нет вовсе — см. parse_mode в вызове sendMessage ниже.
const START_MESSAGE = `<b>Привет! 👋 Я Михаил.

Использую проверенные связи с поставщиками и сам выбираю продукты для ваших заказов.

Вы экономите время — я беру покупки на себя.

💳 Оплата при получении

👇 Нажмите «Прилавка», чтобы выбрать продукты.</b>`;

// Фото для приветствия — читаем один раз при старте процесса, а не на
// каждый /start: статичный файл, лишний disk I/O на каждое сообщение не
// нужен, а падать (если файла нет) лучше сразу при запуске, а не молча
// на первом реальном /start.
const START_PHOTO_PATH = fileURLToPath(new URL('./assets/IMG_8571.PNG', import.meta.url));
const START_PHOTO_BUFFER = fs.readFileSync(START_PHOTO_PATH);

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

  // /start (в том числе с диплинком "/start ref_XXXXX" или "/start u_vk-cpc-summer")
  if (msg.text === '/start' || msg.text.startsWith('/start ')) {
    // Payload доходит СЮДА и больше никуда: initDataUnsafe.start_param
    // заполняется только при открытии по прямой ссылке Mini App
    // (t.me/бот/приложение?startapp=…), а этот бот открывает приложение
    // инлайн-кнопкой web_app. До сих пор payload здесь молча терялся —
    // из-за чего реферальные ссылки ?start=ref_КОД фактически не работали.
    // Поэтому: сохраняем его на будущее и пробрасываем в URL кнопки, откуда
    // мини-апп прочитает его обычным location.search.
    const payload = msg.text.startsWith('/start ') ? msg.text.slice('/start '.length).trim() : '';
    const telegramId = msg.from?.id;

    if (payload && telegramId) {
      const parsed = parseStartPayload(payload);
      try {
        await query(
          `INSERT INTO start_attributions (telegram_id, payload, utm_source, utm_campaign, utm_medium, referral_code)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (telegram_id) DO UPDATE SET
             payload = EXCLUDED.payload,
             utm_source = EXCLUDED.utm_source,
             utm_campaign = EXCLUDED.utm_campaign,
             utm_medium = EXCLUDED.utm_medium,
             referral_code = EXCLUDED.referral_code,
             created_at = now()`,
          [telegramId, payload, parsed.utmSource, parsed.utmCampaign, parsed.utmMedium, parsed.referralCode]
        );
      } catch (e) {
        // Атрибуция не должна мешать человеку начать пользоваться ботом —
        // приветствие ниже отправляется в любом случае.
        console.error('start_attributions:', e);
      }
    }

    const webAppUrl = payload
      ? `${MINI_APP_URL}?src=${encodeURIComponent(payload)}`
      : MINI_APP_URL;

    await botRequestMultipart('sendPhoto', {
      file: { buffer: START_PHOTO_BUFFER, filename: 'start-photo.png' },
      fileField: 'photo',
      chat_id: msg.chat.id,
      caption: START_MESSAGE,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Прилавка', web_app: { url: webAppUrl } },
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

// image_url = '' или null — сброс к fallback_emoji (или к SVG-иконке на
// фронте, если fallback_emoji тоже пуст, см. migrations/039_ui_icons.sql).
app.put('/api/admin/ui-icons/:key', requireAuth, async (req, res) => {
  const { key } = req.params;
  const { imageUrl } = req.body || {};
  try {
    const result = await query(
      'UPDATE ui_icons SET image_url = $1, updated_at = now() WHERE key = $2 RETURNING key, image_url, fallback_emoji',
      [imageUrl ? String(imageUrl).trim() : null, key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Иконка не найдена' });
    }
    const row = result.rows[0];
    res.json({ key: row.key, imageUrl: row.image_url, fallbackEmoji: row.fallback_emoji });
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
    // Nullable намеренно (см. migrations/035) — null означает "не настроено",
    // а не "1 позиция на заказ".
    avgItemsPerOrder: row.avg_items_per_order != null ? Number(row.avg_items_per_order) : null,
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
  // avgItemsPerOrder — единственное необязательное поле формы (см.
  // migrations/035): null допускается ("ещё не настроено"), но если
  // прислали что-то — это обязано быть целое число ≥ 1, не 0/дробь/строка.
  if (p.avgItemsPerOrder !== null && p.avgItemsPerOrder !== undefined) {
    if (typeof p.avgItemsPerOrder !== 'number' || !Number.isInteger(p.avgItemsPerOrder) || p.avgItemsPerOrder < 1) {
      return res.status(400).json({ error: 'Поле avgItemsPerOrder должно быть целым числом не меньше 1' });
    }
  }
  try {
    const result = await query(
      `UPDATE pricing_settings SET
        rent_monthly = $1, salary_monthly = $2, other_costs_monthly = $3,
        planned_sales_monthly = $4, packaging_cost_per_unit = $5,
        acquiring_percent = $6, default_margin_percent = $7, waste_percent = $8,
        avg_items_per_order = $9, updated_at = now()
       RETURNING *`,
      [
        p.rentMonthly, p.salaryMonthly, p.otherCostsMonthly, p.plannedSalesMonthly,
        p.packagingCostPerUnit, p.acquiringPercent, p.defaultMarginPercent, p.wastePercent,
        p.avgItemsPerOrder ?? null,
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
