const API_ORIGIN = 'https://www.themealdb.com';
const PANTRY = new Set(['salt', 'pepper', 'water', 'oil', 'olive oil', 'sugar']);

export function normalizeFood(value) {
  return String(value || '').toLowerCase().trim().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').replace(/\b(tomatoes|potatoes|apples|pears|grapes|aubergines|peppers|courgettes)\b/g, (word) => ({ tomatoes: 'tomato', potatoes: 'potato', apples: 'apple', pears: 'pear', grapes: 'grape', aubergines: 'aubergine', peppers: 'pepper', courgettes: 'courgette' })[word]).replace(/\b(eggplant|zucchini|bell pepper)\b/g, (word) => ({ eggplant: 'aubergine', zucchini: 'courgette', 'bell pepper': 'pepper' })[word]);
}

function foodMatches(left, right) {
  const a = normalizeFood(left);
  const b = normalizeFood(right);
  if (!a || !b) return false;
  const processed = /\b(puree|paste|ketchup|sauce|juice|powder|flour|dried|canned|tinned|stock|vinegar)\b/;
  if (processed.test(a) !== processed.test(b)) return false;
  if (a === b) return true;
  // Colour and size modifiers still denote the same fresh produce.
  const modifiers = /\b(red|green|yellow|large|small|fresh|baby|cherry|plum)\b/g;
  return a.replace(modifiers, '').replace(/\s+/g, ' ').trim() === b.replace(modifiers, '').replace(/\s+/g, ' ').trim();
}

export function mealIngredients(meal) {
  return Array.from({ length: 20 }, (_, index) => {
    const n = index + 1;
    const food = String(meal[`strIngredient${n}`] || '').trim();
    const measure = String(meal[`strMeasure${n}`] || '').trim();
    return food ? { food, measure, text: [measure, food].filter(Boolean).join(' ') } : null;
  }).filter(Boolean);
}

export function splitMealInstructions(value) {
  const paragraphs = String(value || '').replace(/\r\n?/g, '\n').split(/\n+/)
    .map((part) => part.trim())
    .filter((part) => part && !/^(?:step\s*)?\d+[.)\-:]?$/i.test(part))
    .map((part) => part.replace(/^\s*(?:step\s*)?\d+[.)\-:]\s*/i, '').trim())
    .filter(Boolean);
  if (!paragraphs.length) return [];
  if (paragraphs.length >= 2 && paragraphs.length <= 8 && paragraphs.every((part) => part.length <= 240)) return paragraphs;
  const sentences = paragraphs.flatMap((part) => part.split(/(?<=[.!?])\s+(?=[A-ZА-ЯЁ])/u)).filter(Boolean);
  const groupSize = Math.max(1, Math.ceil(sentences.length / 6));
  const steps = [];
  for (let index = 0; index < sentences.length; index += groupSize) {
    steps.push(sentences.slice(index, index + groupSize).join(' '));
  }
  return steps.slice(0, 8);
}

export function rankMeal(meal, basketEnglish, dishQuery = '') {
  const ingredients = mealIngredients(meal);
  const matched = ingredients.filter((item) => basketEnglish.some((name) => foodMatches(item.food, name)));
  const missing = ingredients.filter((item) => !basketEnglish.some((name) => foodMatches(item.food, name)) && !PANTRY.has(normalizeFood(item.food)));
  const distinctBasketMatches = basketEnglish.filter((name) => matched.some((item) => foodMatches(item.food, name))).length;
  const titleMatch = dishQuery && normalizeFood(meal.strMeal).includes(normalizeFood(dishQuery)) ? 8 : 0;
  const coverage = basketEnglish.length ? distinctBasketMatches / basketEnglish.length : 0;
  return { score: distinctBasketMatches * 8 + coverage * 12 + titleMatch - missing.length * 1.5, matched, missing, distinctBasketMatches };
}

async function requestMealDb(apiKey, path, params, fetchImpl = fetch) {
  const url = new URL(`/api/json/v1/${encodeURIComponent(apiKey)}/${path}`, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response.ok) throw Object.assign(new Error(`TheMealDB HTTP ${response.status}`), { code: 'themealdb_http', status: response.status });
    const body = await response.json();
    return Array.isArray(body?.meals) ? body.meals : [];
  } finally { clearTimeout(timer); }
}

export async function findMealDbRecipes({ apiKey, basketEnglish, dishQuery = '', limit = 3, fetchImpl = fetch }) {
  const names = [...new Set(basketEnglish.map((name) => String(name).trim()).filter(Boolean))].slice(0, 5);
  const searches = [];
  if (dishQuery) searches.push(requestMealDb(apiKey, 'search.php', { s: dishQuery }, fetchImpl));
  for (const name of names.slice(0, 4)) searches.push(requestMealDb(apiKey, 'filter.php', { i: name }, fetchImpl));
  const settled = await Promise.allSettled(searches);
  const candidates = new Map();
  let successes = 0;
  for (const [sourceIndex, entry] of settled.entries()) {
    if (entry.status !== 'fulfilled') continue;
    successes++;
    for (const meal of entry.value.slice(0, 60)) {
      if (!meal.idMeal) continue;
      const prior = candidates.get(meal.idMeal);
      candidates.set(meal.idMeal, { meal, hits: (prior?.hits || 0) + 1, nameHit: (prior?.nameHit || 0) + (dishQuery && sourceIndex === 0 ? 1 : 0) });
    }
  }
  if (!successes) throw Object.assign(new Error('TheMealDB search unavailable'), { code: 'themealdb_network' });
  const ids = [...candidates.entries()].sort((a, b) => (b[1].hits * 2 + b[1].nameHit * 3) - (a[1].hits * 2 + a[1].nameHit * 3)).slice(0, 18).map(([id]) => id);
  const details = await Promise.allSettled(ids.map((id) => requestMealDb(apiKey, 'lookup.php', { i: id }, fetchImpl)));
  const ranked = details.flatMap((entry) => entry.status === 'fulfilled' ? entry.value : [])
    .map((meal) => ({ meal, ranking: rankMeal(meal, names, dishQuery) }))
    .filter(({ meal, ranking }) => !(['Beef', 'Chicken', 'Lamb', 'Pork', 'Seafood', 'Goat'].includes(meal.strCategory)
        && !names.some((name) => /\b(beef|chicken|lamb|pork|seafood|fish|goat|meat)\b/i.test(name)))
      && ranking.distinctBasketMatches >= Math.min(2, names.length)
      && ranking.missing.length <= ranking.distinctBasketMatches * 3)
    .sort((a, b) => b.ranking.score - a.ranking.score)
    .slice(0, limit);
  return ranked.map(({ meal, ranking }) => ({
    id: meal.idMeal,
    label: meal.strMeal,
    imageUrl: meal.strMealThumb || null,
    source: 'TheMealDB',
    url: `https://www.themealdb.com/meal/${encodeURIComponent(meal.idMeal)}`,
    originalUrl: (() => { try { const link = new URL(meal.strSource); return ['http:', 'https:'].includes(link.protocol) ? link.href : null; } catch { return null; } })(),
    category: meal.strCategory || null,
    area: meal.strArea || null,
    sourceSteps: splitMealInstructions(meal.strInstructions),
    ingredients: mealIngredients(meal).map((item) => ({
      ...item,
      inBasket: ranking.matched.some((match) => foodMatches(item.food, match.food)),
    })),
    matchedIngredients: ranking.matched,
    missingIngredients: ranking.missing,
    matchScore: ranking.score,
    yield: null,
    totalTime: null,
    nutrition: null,
  }));
}
