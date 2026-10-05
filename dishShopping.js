const ALIASES = [
  { key: 'eggplant', terms: ['баклажан', 'aubergine', 'eggplant'] },
  { key: 'zucchini', terms: ['кабачок', 'цукини', 'zucchini', 'courgette'] },
  { key: 'sweet pepper', terms: ['сладкий перец', 'болгарский перец', 'перец сладкий', 'bell pepper', 'sweet pepper', 'capsicum'] },
  { key: 'tomato', terms: ['помидор', 'томат', 'tomato'] },
  { key: 'onion', terms: ['репчатый лук', 'желтый лук', 'жёлтый лук', 'onion', 'лук'] },
  { key: 'garlic', terms: ['чеснок', 'garlic'] },
  { key: 'basil', terms: ['базилик', 'basil'] },
  { key: 'thyme', terms: ['тимьян', 'чабрец', 'thyme'] },
  { key: 'beet', terms: ['свекла', 'свёкла', 'beetroot', 'beet'] },
  { key: 'cabbage', terms: ['капуста', 'cabbage'] },
  { key: 'potato', terms: ['картофель', 'картошка', 'potato'] },
  { key: 'carrot', terms: ['морковь', 'carrot'] },
  { key: 'cucumber', terms: ['огурец', 'cucumber'] },
  { key: 'feta', terms: ['фета', 'feta'] },
  { key: 'olive oil', terms: ['оливковое масло', 'olive oil'] },
  { key: 'parsley', terms: ['петрушка', 'parsley'] },
  { key: 'dill', terms: ['укроп', 'dill'] },
  { key: 'lettuce', terms: ['салат латук', 'латук', 'lettuce'] },
  { key: 'apple', terms: ['яблоко', 'яблоки', 'apple'] },
  { key: 'pear', terms: ['груша', 'груши', 'pear'] },
  { key: 'grape', terms: ['виноград', 'grape'] },
];

const BLOCKED_SUBTYPES = {
  'sweet pepper': ['чили', 'chili', 'jalapeno', 'халапеньо', 'острый перец', 'перец острый'],
  tomato: ['томатная паста', 'tomato paste', 'кетчуп', 'ketchup', 'томатный соус', 'tomato sauce'],
  onion: ['зеленый лук', 'зелёный лук', 'green onion', 'spring onion', 'shallot', 'шалот'],
};
const stablePlans = new Map();

export function normalizeFoodText(value) {
  return String(value ?? '').toLocaleLowerCase('ru')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function isExplicitDishShoppingRequest(message) {
  const normalized = normalizeFoodText(message);
  const purchaseVerb = /(?:^| )(?:собери|соберите|подбери|подберите|купи|купите|закажи|закажите|добавь|добавьте|найди|найдите|нужен|нужна|нужно|нужны|продукты|ингредиенты)(?= |$)/u;
  return purchaseVerb.test(normalized) && /(?:^| )для (?=\S)/u.test(normalized);
}

export function getStableDishPlan(dishName, proposedIngredients) {
  const key = normalizeFoodText(dishName);
  if (!key) return (proposedIngredients || []).slice(0, 14);
  if (stablePlans.has(key)) return stablePlans.get(key).map((item) => ({ ...item, aliases: [...item.aliases] }));
  const plan = (proposedIngredients || []).slice(0, 14).map((raw) => ({
    canonical: String(raw?.canonical ?? '').trim(),
    aliases: Array.isArray(raw?.aliases) ? raw.aliases.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 8) : [],
    required: raw?.required !== false,
  })).filter((item) => item.canonical);
  if (stablePlans.size >= 128) stablePlans.delete(stablePlans.keys().next().value);
  stablePlans.set(key, plan);
  return plan.map((item) => ({ ...item, aliases: [...item.aliases] }));
}

export function dishIngredientMatchesName(ingredient, name) {
  const candidate = normalizeFoodText(name);
  if (!candidate) return false;
  return [ingredient?.canonical, ...(ingredient?.aliases || [])].some((term) => {
    const value = normalizeFoodText(term);
    return value === candidate || phraseMatches(value, candidate);
  });
}

function stem(token) {
  const word = normalizeFoodText(token);
  return word.replace(/(?:ами|ями|ого|ему|ому|ыми|ими|ая|яя|ое|ее|ый|ий|ые|ие|ов|ев|ей|ам|ям|ах|ях|ом|ем|ы|и|а|я|у|ю|е|о|ь)$/u, '');
}

function tokens(text) {
  return normalizeFoodText(text).split(/\s+/).filter(Boolean).map(stem);
}

function sameTerms(left, right) {
  const a = [...new Set(tokens(left))].sort();
  const b = [...new Set(tokens(right))].sort();
  return a.length > 0 && a.length === b.length && a.every((part, index) => part === b[index]);
}

function phraseMatches(title, phrase) {
  const actual = tokens(title);
  const expected = tokens(phrase);
  return expected.length > 0 && expected.every((wanted) => actual.some((part) => part === wanted || (wanted.length >= 5 && part.startsWith(wanted))));
}

function termsFor(ingredient) {
  const own = [ingredient?.canonical, ...(ingredient?.aliases || [])].filter((x) => typeof x === 'string' && x.trim());
  const known = ALIASES.find((group) => group.terms.some((term) => own.some((name) => sameTerms(name, term))));
  return [...new Set([...own, ...(known?.terms || [])])];
}

function blocked(title, ingredient) {
  const normalized = normalizeFoodText(title);
  const own = String(ingredient?.canonical ?? '');
  const group = ALIASES.find((entry) => entry.terms.some((term) => sameTerms(own, term)));
  return (BLOCKED_SUBTYPES[group?.key] || []).some((term) => phraseMatches(normalized, term));
}

function isCompositeProduct(product) {
  if (product?.is_bundle || product?.isBundle) return true;
  if (/\b(?:набор|ассорти|комплект|bundle|kit|set)\b/iu.test(String(product?.title ?? ''))) return true;
  const composition = product?.composition;
  return Array.isArray(composition) && composition.length >= 4;
}

function productDescriptor(product) {
  const rows = product?.composition;
  if (!Array.isArray(rows)) return '';
  return rows.map((row) => {
    const text = Array.isArray(row) ? row[0] : (typeof row === 'object' ? row?.name : row);
    return typeof text === 'string' ? text.split(/[.!?;\n]/u, 1)[0] : '';
  }).filter(Boolean).join(' ');
}

export function rankProductForIngredient(product, ingredient) {
  const title = String(product?.title ?? '');
  const detail = productDescriptor(product);
  const searchable = `${title} ${detail}`;
  if (!title || blocked(searchable, ingredient)) return 0;
  if (isCompositeProduct(product)) return 0;
  const canonicalText = normalizeFoodText(ingredient?.canonical);
  if (canonicalText === 'перец' || canonicalText === 'pepper') {
    return /черный перец|чёрный перец|black pepper|перец горошком|перец молотый/u.test(normalizeFoodText(searchable)) ? 95 : 0;
  }
  if (/зеленый лук|зелёный лук|spring onion|green onion/u.test(canonicalText)) {
    return /зеленый лук|зелёный лук|spring onion|green onion/u.test(normalizeFoodText(searchable)) ? 100 : 0;
  }
  if (canonicalText === 'капуста' || canonicalText === 'cabbage') {
    const detailText = normalizeFoodText(searchable);
    if (/белокоч/u.test(detailText)) return 100;
    if (/пекин|краснокоч/u.test(detailText)) return 75;
  }
  const terms = termsFor(ingredient);
  const canonical = String(ingredient?.canonical ?? '').trim();
  if (canonical && phraseMatches(searchable, canonical)) return 100;
  let score = 0;
  for (const term of terms) {
    if (phraseMatches(title, term)) score = Math.max(score, normalizeFoodText(term) === normalizeFoodText(canonical) ? 100 : 90);
    else if (phraseMatches(detail, term)) score = Math.max(score, 85);
  }
  // Permit an explicit AI alias set with word order differences, but do not
  // match on a shared category or a single generic word such as "перец".
  return score;
}

export function matchDishIngredients(products, ingredients, budget = null) {
  const usedProducts = new Set();
  const matches = [];
  const unmatchedRequired = [];
  const unmatchedOptional = [];

  for (const raw of ingredients || []) {
    const ingredient = {
      canonical: String(raw?.canonical ?? '').trim(),
      aliases: Array.isArray(raw?.aliases) ? raw.aliases.filter((x) => typeof x === 'string').slice(0, 8) : [],
      required: raw?.required !== false,
    };
    if (!ingredient.canonical) continue;
    const candidates = (products || []).map((product) => ({ product, score: rankProductForIngredient(product, ingredient) }))
      .filter(({ product, score }) => score > 0 && !usedProducts.has(String(product.id)))
      .sort((a, b) => b.score - a.score || Number(a.product.price) - Number(b.product.price) || String(a.product.id).localeCompare(String(b.product.id), 'en'));
    const selected = candidates[0]?.product;
    if (!selected) {
      (ingredient.required ? unmatchedRequired : unmatchedOptional).push(ingredient.canonical);
      continue;
    }
    usedProducts.add(String(selected.id));
    matches.push({ ingredient, product: selected });
  }

  // Required items always remain. Optional items are considered in canonical
  // order and fit only when they do not push an otherwise fitting basket over.
  const required = matches.filter((x) => x.ingredient.required);
  const optional = matches.filter((x) => !x.ingredient.required);
  const totalOf = (rows) => rows.reduce((sum, { product }) => sum + Math.max(0, Number(product.price) || 0), 0);
  const requiredTotal = totalOf(required);
  let chosen = [...required];
  for (const item of optional) {
    if (budget == null || (requiredTotal <= budget && totalOf(chosen) + Number(item.product.price || 0) <= budget)) chosen.push(item);
  }
  const skippedOptional = optional.filter((item) => !chosen.includes(item)).map((item) => item.ingredient.canonical);
  const items = chosen.map(({ ingredient, product }) => ({
    productId: String(product.id), title: product.title, imageUrl: product.image_url || product.imageUrl || product.image || null,
    price: Number(product.price) || 0, quantity: 1, lineTotal: Number(product.price) || 0,
    weight: product.weight ?? '', category: product.category, reason: ingredient.canonical,
  }));
  const total = totalOf(chosen);
  return {
    items, total,
    unmatchedRequired: [...new Set(unmatchedRequired)],
    unmatchedOptional: [...new Set([...unmatchedOptional, ...skippedOptional])],
    budgetExceeded: budget != null && total > budget,
    requiredTotal,
  };
}
