// AI-сценарии Прилавки.
//
// Сейчас здесь две ручки:
//   POST /api/ai/test — проверка связи с OpenAI;
//   POST /api/ai/shop — сценарий «Собрать покупку» по реальному каталогу.
//
// Проверочная ручка нужна, чтобы отделить «ключ и сеть в порядке» от
// «сценарий работает неправильно»: при любой ошибке это первый вопрос, и
// отвечать на него проще отдельным эндпоинтом, чем отладкой боевого
// сценария.
//
// Отдельный модуль, а не дописка в server.js: монолит и так около 6000
// строк, и у партнёрки рядом уже есть тот же приём (partners.js). Доступ
// к базе приходит параметром по той же причине, что и там: иначе два
// файла импортировали бы друг друга.
//
// Ключ читается из окружения при каждом запросе, а не при импорте: на
// Railway переменные подставляются на старте контейнера, и модуль,
// запомнивший отсутствие ключа на этапе импорта, пришлось бы
// передеплоивать после каждой правки переменной. Сам ключ никуда не
// пишется и не возвращается — ни в лог, ни в ответ.
import express from 'express';
import OpenAI from 'openai';

// Модель задаётся переменной окружения, чтобы менять её без правки кода.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Потолок на ответ модели: корзина — это десяток позиций, и длиннее
// ответу быть незачем. Ограничение страхует от неожиданного счёта, если
// модель уйдёт в рассуждения.
const SHOP_MAX_OUTPUT_TOKENS = 900;

// Длина пользовательского запроса. Всё, что длиннее, — это уже не фраза
// «собери овощей на двоих», а чужой текст, и платить за него токенами не
// нужно.
const MAX_MESSAGE_LENGTH = 500;

// Сколько упаковок одного товара модель может положить в корзину.
// Защита от «20 кг помидоров» из-за ошибки в рассуждении.
const MAX_ITEM_QUANTITY = 10;

// Описание веса в каталоге — свободный текст, иногда с пояснением
// («примерно ~6 кг, хватит на 2-3 кастрюли борща»). Модели нужен размер
// упаковки, а не рекламный текст, поэтому длинные строки подрезаются.
const MAX_WEIGHT_CHARS = 42;

// Сколько позиций должно остаться после ужимания под бюджет. Ниже этого
// корзина перестаёт быть корзиной, и честнее вернуть «не уложились», чем
// отдать одну морковку.
const MIN_ITEMS_AFTER_FIT = 3;

// Клиент создаётся один раз и переиспользуется: он держит пул соединений,
// и собирать его на каждый запрос незачем. Пересоздаётся только если
// ключ в окружении сменился.
let cachedClient = null;
let cachedKey = null;

function getClient(apiKey) {
  if (!cachedClient || cachedKey !== apiKey) {
    cachedClient = new OpenAI({ apiKey });
    cachedKey = apiKey;
  }
  return cachedClient;
}

// OpenAI на неверной авторизации возвращает текст с огрызком ключа
// (sk-xxxx…1234). Он уже замаскирован ими, но в наш лог и наш ответ не
// должно попадать вообще ничего похожего на ключ — вырезаем.
function scrubKeys(text) {
  return String(text ?? '').replace(/sk-[A-Za-z0-9_*-]+/g, '[ключ скрыт]');
}

// Отсутствие ключа — не поломка сервера, а незаконченная настройка среды,
// поэтому 503 и прямым текстом что делать. Отдельный код reason нужен
// вызывающей стороне, чтобы отличить этот случай от ошибки самого OpenAI.
function requireApiKey(res) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) return apiKey;
  res.status(503).json({
    ok: false,
    reason: 'missing_api_key',
    error: 'OPENAI_API_KEY не задан в окружении backend. '
      + 'Добавьте переменную и перезапустите сервис.',
  });
  return null;
}

/* ── «Собрать покупку» ───────────────────────────────────────────────────
   Разделение обязанностей здесь жёсткое и намеренное.

   Модель делает ровно одно: читает фразу покупателя и выбирает товары из
   списка, который ей дали. Ни придумать товар, ни назвать цену она не
   может — у неё нет инструментов, нет доступа к базе, а productId
   перечислены в самой схеме ответа, так что выбрать что-то вне каталога
   структурно невозможно.

   Деньги считает только backend. Цена берётся из той же строки products,
   из которой товар попал в список, уже после ответа модели. Это не
   перестраховка: цены меняются, и сумма, придуманная моделью, была бы
   обещанием, которого магазин не давал.

   Бюджет держится в два прохода. Первый — обычный подбор; модель видит
   цены и старается уложиться, но арифметика у неё ненадёжная. Если после
   честного пересчёта корзина не влезла, делается ровно один
   корректирующий проход: модели показывают её же корзину с нашими
   ценами, итог и превышение и просят ужать. Второй пересчёт — снова наш.

   Проходов строго два, цикла нет: каждая итерация стоит полного каталога
   в промпте (~3 тыс. токенов), а выигрыш после второй попытки почти не
   растёт. Не уложились — отдаём флаг и честную сумму, подбор замен это
   задача следующего шага сценария.

   Проверка productId на нашей стороне остаётся даже при enum в схеме:
   каталог мог измениться между сборкой списка и ответом, а доверять
   чужому выводу как ключу к базе нельзя в принципе. */

// Активные товары каталога — тот же источник, что у /api/catalog:
// products + categories, is_active = true. Порядок как в каталоге, чтобы
// модель видела товары сгруппированными по категориям.
const CATALOG_QUERY = `
  SELECT p.id, p.title, p.price, p.weight, p.category, c.label AS category_label
  FROM products p
  LEFT JOIN categories c ON c.id = p.category
  WHERE p.is_active = true
  ORDER BY c.sort_order ASC NULLS LAST, p.sort_order ASC, p.title ASC
`;

// Компактная строка товара для модели. Цена в списке нужна, чтобы модель
// не предлагала корзину, заведомо выходящую за бюджет, — но считает
// итог всё равно backend.
function catalogLine(p) {
  const weight = String(p.weight ?? '').trim().slice(0, MAX_WEIGHT_CHARS);
  return `${p.id} | ${p.title} | ${p.price} ₽ | ${weight} | ${p.category_label || p.category}`;
}

function catalogBlock(products) {
  return [
    'Каталог (productId | название | цена за упаковку | размер упаковки | категория):',
    products.map(catalogLine).join('\n'),
  ].join('\n');
}

function itemRules(minItems) {
  return [
    `— items: от ${minItems} до 10 позиций. productId — строго из каталога выше.`,
    '  quantity — целое число упаковок, от 1 до ' + MAX_ITEM_QUANTITY + '.',
    '  reason — 2–5 слов, почему позиция в корзине.',
    '',
    'Запреты:',
    '— не выдумывай productId: любой идентификатор вне списка — ошибка;',
    '— не называй в message цены и итоговую сумму: стоимость считает сервис',
    '  по своей базе, а не ты;',
    '— учитывай ограничения из запроса: если просили без какого-то продукта,',
    '  его в корзине быть не должно.',
  ].join('\n');
}

// Самые дешёвые позиции каждой категории. В корректирующем проходе
// каталог длинный, и дешёвые товары теряются в середине списка —
// отдельной короткой подсказкой они видны сразу.
function cheapestBlock(products, perCategory = 5) {
  const byCategory = new Map();
  for (const p of products) {
    const key = p.category_label || p.category;
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(p);
  }
  const lines = [];
  for (const [label, list] of byCategory) {
    const cheap = [...list].sort((a, b) => a.price - b.price).slice(0, perCategory);
    lines.push(`${label}: ` + cheap.map((p) => `${p.id} (${p.price} ₽)`).join(', '));
  }
  return ['Самые дешёвые товары по категориям:', ...lines].join('\n');
}

// ── Первый проход: обычный подбор ───────────────────────────────────────
function buildShopInstructions(products) {
  return [
    'Ты — помощник сервиса доставки продуктов «Прилавка».',
    'По фразе покупателя собери корзину ТОЛЬКО из товаров каталога ниже.',
    '',
    catalogBlock(products),
    '',
    'Правила:',
    itemRules(4),
    '— budget: бюджет в рублях целым числом, если он назван в запросе; иначе null.',
    '— people: на скольких ЧЕЛОВЕК, целым числом, и только если в запросе сказано',
    '  именно про людей («на двоих», «на одного», «на семью из четырёх»).',
    '  Срок («на 3 дня», «на неделю») — это НЕ люди: тогда people = null,',
    '  а срок уходит в preferences.',
    '— preferences: короткие пожелания из запроса своими словами',
    '  («больше фруктов», «без авокадо», «на 3 дня»). Если их нет — пустой массив.',
    '— message: одно-два коротких дружелюбных предложения покупателю.',
    '',
    'Если бюджет назван — старайся уложиться в него по ценам из каталога,',
    'но никогда не подменяй и не пересчитывай сами цены.',
  ].join('\n');
}

// ── Второй проход: ужать под бюджет ─────────────────────────────────────
//
// Модели показывают её же корзину, но уже с нашими ценами и нашим итогом:
// без этого она «чинит» воображаемую сумму, которую посчитала сама.
function buildFitInstructions(products, { request, budget, basket }) {
  const lines = basket.items.map(
    (x) => `${x.productId} | ${x.title} | ${x.price} ₽ x ${x.quantity} = ${x.lineTotal} ₽`,
  );
  return [
    'Ты — помощник сервиса доставки продуктов «Прилавка».',
    'Корзина, которую ты собрал, не укладывается в бюджет покупателя.',
    '',
    `Запрос покупателя: «${request}»`,
    `Бюджет: ${budget} ₽`,
    '',
    'Текущая корзина (цены сервиса, не твои):',
    lines.join('\n'),
    `Итог по нашим ценам: ${basket.total} ₽. Превышение: ${basket.total - budget} ₽.`,
    '',
    catalogBlock(products),
    '',
    cheapestBlock(products),
    '',
    'Задача: собери корзину заново так, чтобы сумма (цена из каталога × количество)',
    `была НЕ БОЛЬШЕ ${budget} ₽. Считай по ценам каталога выше, они настоящие.`,
    '',
    'Как ужимать, по порядку:',
    '— уменьши количество упаковок там, где их больше одной;',
    '— замени дорогие позиции на более дешёвые из той же категории;',
    '— убери наименее нужные позиции, но оставь минимум ' + MIN_ITEMS_AFTER_FIT + ' штуки.',
    '',
    'Перед ответом сложи цены выбранных позиций и убедись, что сумма помещается',
    `в ${budget} ₽. Если не помещается — бери позиции из списка самых дешёвых выше.`,
    'Смысл запроса сохраняй: если просили овощи и фрукты — оставь и то и другое,',
    'если просили без какого-то продукта — его быть не должно.',
    '',
    'Правила:',
    itemRules(MIN_ITEMS_AFTER_FIT),
    '— message: одно короткое предложение о том, что корзину ужали. Без цифр и цен.',
    '',
    `Если уложиться в ${budget} ₽ невозможно даже минимальной корзиной —`,
    'верни самый дешёвый разумный набор, какой получается. Не выдумывай товары',
    'и не занижай количества до нуля.',
  ].join('\n');
}

// Схема первого прохода. strict требует, чтобы все поля были в required,
// а additionalProperties был false. productId перечислен enum'ом по
// реальному каталогу — так модель физически не может назвать товар,
// которого нет.
function buildBasketItemsSchema(productIds) {
  return {
    type: 'array',
    description: 'Позиции корзины — только товары каталога',
    items: {
      type: 'object',
      properties: {
        productId: { type: 'string', enum: productIds },
        quantity: { type: 'integer', description: 'Число упаковок' },
        reason: { type: 'string', description: 'Коротко, зачем позиция' },
      },
      required: ['productId', 'quantity', 'reason'],
      additionalProperties: false,
    },
  };
}

function buildShopSchema(productIds) {
  return {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Короткое сообщение покупателю, без цен' },
      budget: { type: ['integer', 'null'], description: 'Бюджет в рублях или null' },
      people: { type: ['integer', 'null'], description: 'Число едоков или null' },
      preferences: {
        type: 'array',
        description: 'Пожелания из запроса',
        items: { type: 'string' },
      },
      items: buildBasketItemsSchema(productIds),
    },
    required: ['message', 'budget', 'people', 'preferences', 'items'],
    additionalProperties: false,
  };
}

// Схема корректирующего прохода: бюджет, едоки и пожелания уже разобраны
// первым проходом, второй раз их спрашивать незачем.
function buildFitSchema(productIds) {
  return {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Короткое сообщение покупателю, без цен' },
      items: buildBasketItemsSchema(productIds),
    },
    required: ['message', 'items'],
    additionalProperties: false,
  };
}

// Один проход к модели. Возвращает либо { parsed, response }, либо
// { failure } с готовыми полями ответа — вызывающий решает, падать ему
// или продолжать с тем, что уже есть.
async function runPass(client, { instructions, input, schema, schemaName }) {
  let response;
  try {
    response = await client.responses.create({
      model: OPENAI_MODEL,
      instructions,
      input,
      max_output_tokens: SHOP_MAX_OUTPUT_TOKENS,
      text: {
        format: { type: 'json_schema', name: schemaName, strict: true, schema },
      },
    });
  } catch (err) {
    const message = scrubKeys(err?.message ?? 'Неизвестная ошибка запроса к OpenAI');
    console.error('[ai] запрос к OpenAI не прошёл:', err?.status ?? '', message);
    return { failure: { reason: 'openai_error', status: err?.status ?? null, error: message } };
  }

  // Модель могла упереться в потолок токенов или отказаться отвечать.
  // В обоих случаях текста по схеме не будет, и разбирать нечего.
  if (response.status && response.status !== 'completed') {
    const why = response.incomplete_details?.reason ?? response.status;
    console.error('[ai] shop: ответ не завершён:', why);
    return { failure: { reason: 'incomplete_response', error: `Модель не завершила ответ (${why}).` }, response };
  }

  // Structured Outputs гарантирует схему, но страховка нужна: отказ
  // модели, обрыв генерации или смена модели на не поддерживающую схемы
  // дадут здесь не-JSON, и падать с 500 из-за этого нельзя.
  const text = response.output_text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error('[ai] shop: модель вернула не JSON, первые 200 символов:', text.slice(0, 200));
    return { failure: { reason: 'bad_model_json', error: 'Модель вернула ответ не по схеме.' }, response };
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.items)) {
    console.error('[ai] shop: в ответе нет items');
    return { failure: { reason: 'bad_model_json', error: 'В ответе модели нет списка позиций.' }, response };
  }

  return { parsed, response };
}

// Сборка корзины по ответу модели: цена и название берутся из базы, а не
// из того, что сказала модель. Товары вне каталога отбрасываются — их не
// должно быть благодаря enum, но проверка здесь дешевле любой гипотезы.
function buildBasket(modelItems, productById) {
  const items = [];
  const dropped = [];
  const seen = new Set();

  for (const raw of modelItems) {
    const id = typeof raw?.productId === 'string' ? raw.productId : '';
    const product = productById.get(id);

    if (!product) {
      dropped.push({ productId: id, reason: 'нет в каталоге' });
      continue;
    }
    // Один и тот же товар дважды — это ошибка модели, а не «две записи»:
    // складываем в одну позицию, чтобы корзина выглядела как корзина.
    if (seen.has(id)) {
      const existing = items.find((x) => x.productId === id);
      existing.quantity = Math.min(MAX_ITEM_QUANTITY, existing.quantity + 1);
      existing.lineTotal = existing.price * existing.quantity;
      continue;
    }
    seen.add(id);

    const asked = Number(raw?.quantity);
    const quantity = Number.isFinite(asked)
      ? Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.round(asked)))
      : 1;

    items.push({
      productId: product.id,
      title: product.title,
      // Цена — из базы. То, что модель могла бы сказать о цене, не
      // участвует в расчёте вообще.
      price: product.price,
      quantity,
      lineTotal: product.price * quantity,
      weight: product.weight,
      category: product.category,
      reason: typeof raw?.reason === 'string' ? raw.reason : '',
    });
  }

  const total = items.reduce((sum, x) => sum + x.lineTotal, 0);
  return { items, dropped, total };
}

/* ── Ужимание под бюджет без модели ──────────────────────────────────────
   Два прохода модели снижают сумму, но не гарантируют попадания: gpt-4o-mini
   считает ненадёжно и от запроса к запросу выдаёт разный результат. Поэтому
   последнее слово за арифметикой, а не за моделью.

   Работает только с тем, что модель уже выбрала: те же productId, те же
   цены из базы. Новых товаров не появляется, цены не меняются, третьего
   обращения к модели нет — иначе разброс вернулся бы вместе с ним.

   Порядок от менее разрушительного к более: сначала количества, потом
   позиции целиком. Внутри каждого шага первой страдает самая дорогая
   строка — она и приближает к бюджету быстрее всего.

   Разнообразие корзины бережётся на первом круге удаления: последнюю
   позицию своей категории не трогаем, чтобы из «овощей и фруктов» не
   осталось одних овощей. Если иначе в бюджет не попасть, второй круг снимает
   и эту защиту: уложиться важнее, чем сохранить состав. */
function fitToBudget(sourceItems, budget) {
  const items = sourceItems.map((x) => ({ ...x, fromQuantity: x.quantity }));
  const removed = [];
  const total = () => items.reduce((sum, x) => sum + x.lineTotal, 0);

  // Шаг 1: количества. По одной упаковке за раз, начиная с самой дорогой
  // строки — пересчёт после каждого шага, чтобы не срезать лишнего.
  while (total() > budget) {
    const candidates = items.filter((x) => x.quantity > 1);
    if (!candidates.length) break;
    candidates.sort((a, b) => b.lineTotal - a.lineTotal || b.price - a.price);
    const target = candidates[0];
    target.quantity -= 1;
    target.lineTotal = target.price * target.quantity;
  }

  // Шаг 2: позиции целиком. Первый круг щадит последнюю позицию каждой
  // категории, второй — уже нет.
  for (const keepDiversity of [true, false]) {
    while (total() > budget && items.length > MIN_ITEMS_AFTER_FIT) {
      const perCategory = new Map();
      for (const x of items) perCategory.set(x.category, (perCategory.get(x.category) ?? 0) + 1);

      const removable = keepDiversity
        ? items.filter((x) => perCategory.get(x.category) > 1)
        : items.slice();
      if (!removable.length) break;

      removable.sort((a, b) => b.lineTotal - a.lineTotal || b.price - a.price);
      const victim = removable[0];
      items.splice(items.indexOf(victim), 1);
      removed.push({
        productId: victim.productId,
        title: victim.title,
        price: victim.price,
        quantity: victim.quantity,
        lineTotal: victim.lineTotal,
      });
    }
  }

  // Урезанные количества считаем по тому, что осталось: позиция, которую
  // сначала ужали, а потом удалили целиком, числится только в removed.
  const reduced = items
    .filter((x) => x.quantity < x.fromQuantity)
    .map((x) => ({
      productId: x.productId,
      title: x.title,
      price: x.price,
      from: x.fromQuantity,
      to: x.quantity,
    }));

  return {
    items: items.map(({ fromQuantity, ...rest }) => rest),
    total: total(),
    removed,
    reduced,
  };
}

export function createAiRoutes({ query } = {}) {
  const router = express.Router();

  // POST /api/ai/test — один короткий запрос к модели и её ответ обратно.
  router.post('/test', async (req, res) => {
    const apiKey = requireApiKey(res);
    if (!apiKey) return undefined;

    // Текст запроса можно передать в теле — удобно для ручной проверки.
    // По умолчанию тот, на который ожидается односложный ответ.
    const prompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
      ? req.body.prompt.trim()
      : 'Ответь одним словом: работает';

    const startedAt = Date.now();

    try {
      const response = await getClient(apiKey).responses.create({
        model: OPENAI_MODEL,
        input: prompt,
      });

      return res.json({
        ok: true,
        model: response.model || OPENAI_MODEL,
        prompt,
        // output_text — собранный текст ответа; у Responses API это
        // штатное удобное поле поверх структуры output[].
        answer: response.output_text ?? '',
        usage: response.usage ?? null,
        tookMs: Date.now() - startedAt,
      });
    } catch (err) {
      const message = scrubKeys(err?.message ?? 'Неизвестная ошибка запроса к OpenAI');
      console.error('[ai] запрос к OpenAI не прошёл:', err?.status ?? '', message);
      return res.status(502).json({
        ok: false, reason: 'openai_error', status: err?.status ?? null,
        error: message, tookMs: Date.now() - startedAt,
      });
    }
  });

  // POST /api/ai/shop — сценарий «Собрать покупку».
  router.post('/shop', async (req, res) => {
    const raw = req.body?.message;
    if (typeof raw !== 'string' || !raw.trim()) {
      return res.status(400).json({
        ok: false,
        reason: 'bad_request',
        error: 'Нужно поле message: строка с запросом покупателя.',
      });
    }
    if (raw.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({
        ok: false,
        reason: 'message_too_long',
        error: `Запрос длиннее ${MAX_MESSAGE_LENGTH} символов.`,
      });
    }

    const apiKey = requireApiKey(res);
    if (!apiKey) return undefined;

    const message = raw.trim();
    const startedAt = Date.now();
    const client = getClient(apiKey);

    // ── Каталог ───────────────────────────────────────────────────────
    let products;
    try {
      const result = await query(CATALOG_QUERY);
      products = result.rows;
    } catch (err) {
      console.error('[ai] shop: каталог не прочитался:', err?.message ?? err);
      return res.status(503).json({
        ok: false, reason: 'catalog_unavailable',
        error: 'Не удалось прочитать каталог.', tookMs: Date.now() - startedAt,
      });
    }

    if (!products.length) {
      return res.status(503).json({
        ok: false, reason: 'catalog_empty',
        error: 'В каталоге нет активных товаров.', tookMs: Date.now() - startedAt,
      });
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const productIds = products.map((p) => p.id);

    // ── Проход 1: подбор ──────────────────────────────────────────────
    const first = await runPass(client, {
      instructions: buildShopInstructions(products),
      input: message,
      schema: buildShopSchema(productIds),
      schemaName: 'shop_basket',
    });

    if (first.failure) {
      return res.status(502).json({
        ok: false, ...first.failure, tookMs: Date.now() - startedAt,
      });
    }

    let basket = buildBasket(first.parsed.items, productById);

    if (!basket.items.length) {
      return res.status(502).json({
        ok: false, reason: 'no_valid_items',
        error: 'Ни один выбранный товар не нашёлся в каталоге.',
        dropped: basket.dropped, tookMs: Date.now() - startedAt,
      });
    }

    const budget = Number.isInteger(first.parsed.budget) ? first.parsed.budget : null;
    let basketMessage = typeof first.parsed.message === 'string' ? first.parsed.message : '';

    // ── Проход 2: ужать под бюджет ────────────────────────────────────
    //
    // Запускается только при названном бюджете и только если наш
    // пересчёт показал превышение. Второго условия выхода нет и не
    // нужно: проход ровно один.
    let optimizationAttempted = false;
    let secondUsage = null;
    // Итог первого прохода запоминаем до ужимания: по нему видно, на
    // сколько корзина промахнулась и помог ли второй проход.
    let firstTotal = basket.total;

    if (budget != null && basket.total > budget) {
      optimizationAttempted = true;

      const second = await runPass(client, {
        instructions: buildFitInstructions(products, { request: message, budget, basket }),
        input: message,
        schema: buildFitSchema(productIds),
        schemaName: 'shop_basket_fit',
      });
      secondUsage = second.response?.usage ?? null;

      // Сбой второго прохода не рушит ответ: у нас уже есть корректная
      // корзина первого, с ней и отдаём — просто без успеха оптимизации.
      if (second.failure) {
        console.error('[ai] shop: корректирующий проход не удался:', second.failure.reason);
      } else {
        const retry = buildBasket(second.parsed.items, productById);
        // Вторую корзину берём, только если она действительно лучше:
        // уложилась в бюджет или хотя бы дешевле первой. Иначе честнее
        // остаться с первой.
        const better = retry.items.length >= Math.min(MIN_ITEMS_AFTER_FIT, basket.items.length)
          && (retry.total <= budget || retry.total < basket.total);
        if (better) {
          basket = retry;
          if (typeof second.parsed.message === 'string' && second.parsed.message) {
            basketMessage = second.parsed.message;
          }
        }
      }
    }

    // ── Проход 3: арифметика вместо модели ────────────────────────────
    //
    // Если после обоих проходов корзина всё ещё не влезла, ужимаем её
    // сами. Это не ещё один запрос к OpenAI, а чистый расчёт по уже
    // выбранным товарам и их ценам из базы.
    const aiTotal = basket.total;
    let backendAdjustmentApplied = false;
    let backendAdjustmentRemovedItems = [];
    let backendAdjustmentReducedQuantities = [];

    if (budget != null && basket.total > budget) {
      const fitted = fitToBudget(basket.items, budget);
      // Берём результат, только если он действительно дешевле: иначе
      // отчитываться было бы не о чем.
      if (fitted.total < basket.total) {
        basket = { items: fitted.items, dropped: basket.dropped, total: fitted.total };
        backendAdjustmentApplied = true;
        backendAdjustmentRemovedItems = fitted.removed;
        backendAdjustmentReducedQuantities = fitted.reduced;
      }
    }

    // ── Итог ──────────────────────────────────────────────────────────
    const overBy = budget != null ? Math.max(0, basket.total - budget) : 0;
    const budgetStatus = budget == null ? 'unknown' : (overBy > 0 ? 'over' : 'ok');
    const optimizationSucceeded = optimizationAttempted && overBy === 0;

    // Текст про деньги пишет backend, а не модель: модель не знает
    // итоговой суммы и легко пообещает то, чего нет.
    if (budgetStatus === 'ok' && backendAdjustmentApplied) {
      basketMessage = `Чтобы уложиться в ${budget} ₽, немного сократил корзину — `
        + `получилось ${basket.total} ₽.`;
    }
    if (budgetStatus === 'over') {
      basketMessage = `Собрал самую экономную корзину, но в ${budget} ₽ она не укладывается: `
        + `получилось ${basket.total} ₽, это на ${overBy} ₽ больше. `
        + 'Можно убрать часть позиций или увеличить бюджет.';
    }

    return res.json({
      ok: true,
      model: first.response.model || OPENAI_MODEL,
      request: message,
      catalogSize: products.length,
      // Сколько раз ходили к модели. Третьего обращения в этом сценарии
      // нет и не будет: бюджет дожимается расчётом.
      aiCalls: optimizationAttempted ? 2 : 1,
      optimizationAttempted,
      optimizationSucceeded,
      optimizationFromTotal: optimizationAttempted ? firstTotal : null,
      // Итог после обоих проходов модели — до того, как за дело взялась
      // арифметика.
      aiTotal,
      backendAdjustmentApplied,
      backendAdjustmentRemovedItems,
      backendAdjustmentReducedQuantities,
      result: {
        message: basketMessage,
        budget,
        people: Number.isInteger(first.parsed.people) ? first.parsed.people : null,
        preferences: Array.isArray(first.parsed.preferences) ? first.parsed.preferences : [],
        items: basket.items,
        total: basket.total,
        budgetStatus,
        withinBudget: budget == null ? null : overBy === 0,
        overBy,
        // Пусто при нормальной работе. Непустое — сигнал, что каталог
        // разъехался со списком, который видела модель.
        dropped: basket.dropped,
      },
      usage: {
        first: first.response.usage ?? null,
        second: secondUsage,
        totalTokens: (first.response.usage?.total_tokens ?? 0) + (secondUsage?.total_tokens ?? 0),
      },
      tookMs: Date.now() - startedAt,
    });
  });

  return router;
}
