import test from 'node:test';
import assert from 'node:assert/strict';
import { dishIngredientMatchesName, getStableDishPlan, isExplicitDishShoppingRequest, matchDishIngredients, rankProductForIngredient } from './dishShopping.js';

const products = [
  { id: '1', title: 'Баклажан', price: 180, weight: '500 г' },
  { id: '2', title: 'Кабачок', price: 120, weight: '500 г' },
  { id: '3', title: 'Перец сладкий', price: 160, weight: '500 г' },
  { id: '4', title: 'Помидоры', price: 130, weight: '500 г' },
  { id: '5', title: 'Лук репчатый', price: 50, weight: '500 г' },
  { id: '6', title: 'Чеснок', price: 40, weight: '100 г' },
  { id: '7', title: 'Базилик', price: 90, weight: '50 г' },
  { id: '8', title: 'Огурцы', price: 100, weight: '500 г' },
  { id: '9', title: 'Морковь', price: 70, weight: '500 г' },
  { id: '10', title: 'Перец острый чили', price: 60, weight: '100 г' },
  { id: '11', title: 'Свёкла', price: 70, weight: '500 г' },
  { id: '12', title: 'Капуста белокочанная', price: 80, weight: '1 шт.' },
  { id: '13', title: 'Картофель', price: 90, weight: '1 кг' },
  { id: '14', title: 'Фета', price: 220, weight: '200 г' },
  { id: '15', title: 'Перец, Градиент', price: 189, weight: '500 г', composition: [['Свежий зелёный болгарский перец. Хрустящий и сочный — для салатов и горячих блюд.', '']] },
  { id: '16', title: 'Гриль набор на компанию', price: 1490, is_bundle: false, composition: [['Красный лук', ''], ['Помидор', ''], ['Кабачок', ''], ['Баклажан', '']] },
  { id: '17', title: 'Укроп', price: 75, composition: [['Укроп со свежим пряным ароматом. К рыбе, картофелю, салатам и домашним заготовкам.', '']] },
];

const ingredient = (canonical, aliases = [], required = true) => ({ canonical, aliases, required });

test('ratatouille maps only canonical vegetable ingredients and repeats deterministically', () => {
  const set = [ingredient('баклажан', ['aubergine']), ingredient('кабачок', ['zucchini']), ingredient('сладкий перец', ['bell pepper']), ingredient('помидоры', ['tomato']), ingredient('репчатый лук', ['onion']), ingredient('чеснок', ['garlic']), ingredient('базилик', ['basil'], false)];
  const first = matchDishIngredients(products, set);
  for (let i = 0; i < 3; i++) assert.deepEqual(matchDishIngredients(products, set).items.map((x) => x.productId), first.items.map((x) => x.productId));
  assert.deepEqual(first.items.map((x) => x.productId), ['1', '2', '3', '4', '5', '6', '7']);
  assert.equal(first.items.some((x) => /огурец|морковь|чили|фрукт/i.test(x.title)), false);
});

test('borscht uses required root vegetables and cabbage, no unrelated substitutions', () => {
  const result = matchDishIngredients(products, [ingredient('свёкла', ['beetroot']), ingredient('капуста', ['cabbage']), ingredient('картофель', ['potato']), ingredient('морковь', ['carrot']), ingredient('репчатый лук', ['onion']), ingredient('помидоры', ['tomato'], false)]);
  assert.deepEqual(result.items.map((x) => x.productId), ['11', '12', '13', '9', '5', '4']);
});

test('Greek salad reports unavailable olive oil instead of substituting a neighbor', () => {
  const result = matchDishIngredients(products, [ingredient('помидоры', ['tomato']), ingredient('огурцы', ['cucumber']), ingredient('сладкий перец', ['bell pepper']), ingredient('репчатый лук', ['onion']), ingredient('фета', ['feta']), ingredient('оливковое масло', ['olive oil'])]);
  assert.deepEqual(result.items.map((x) => x.productId), ['4', '8', '3', '5', '14']);
  assert.deepEqual(result.unmatchedRequired, ['оливковое масло']);
  assert.equal(rankProductForIngredient(products[9], ingredient('сладкий перец', ['bell pepper'])), 0);
});

test('pepper subtype is grounded in catalog composition and spicy peppers stay excluded', () => {
  assert.equal(rankProductForIngredient(products[14], ingredient('сладкий перец', ['bell pepper'])), 85);
  assert.equal(rankProductForIngredient(products[9], ingredient('сладкий перец', ['bell pepper'])), 0);
  assert.deepEqual(matchDishIngredients([products[14], products[9]], [ingredient('сладкий перец', ['bell pepper'])]).items.map((x) => x.productId), ['15']);
  assert.equal(rankProductForIngredient(products[9], ingredient('перец')), 0);
});

test('generic pepper does not silently become chilli and bundles do not satisfy ingredients', () => {
  assert.equal(rankProductForIngredient(products[9], ingredient('перец')), 0);
  assert.equal(rankProductForIngredient(products[15], ingredient('красный лук', ['red onion'])), 0);
});

test('mentions of other foods in product marketing copy are not ingredient matches', () => {
  assert.equal(rankProductForIngredient(products[16], ingredient('картофель', ['potato'])), 0);
  assert.deepEqual(matchDishIngredients([products[16], products[12]], [ingredient('картофель', ['potato'])]).items.map((x) => x.productId), ['13']);
});

test('canonical ingredient plan is stable for repeated requests to the same dish', () => {
  const first = [ingredient('баклажан'), ingredient('кабачок'), ingredient('сладкий перец')];
  const second = [ingredient('картофель'), ingredient('морковь')];
  assert.deepEqual(getStableDishPlan('Unit Dish Stable Cache', first), first);
  assert.deepEqual(getStableDishPlan('unit dish stable cache', second), first);
  assert.equal(dishIngredientMatchesName(first[2], 'сладкий перец'), true);
});

test('explicit Russian dish-shopping phrases route through the canonical dish planner', () => {
  assert.equal(isExplicitDishShoppingRequest('Собери продукты для рататуя до 700 ₽'), true);
  assert.equal(isExplicitDishShoppingRequest('Подберите ингредиенты для борща'), true);
  assert.equal(isExplicitDishShoppingRequest('Что приготовить для ужина?'), false);
  assert.equal(isExplicitDishShoppingRequest('Что полезнее: яблоко или груша?'), false);
});

test('budget keeps all required dish ingredients and drops optional items first', () => {
  const result = matchDishIngredients(products, [ingredient('баклажан'), ingredient('кабачок'), ingredient('сладкий перец'), ingredient('базилик', [], false)], 300);
  assert.deepEqual(result.items.map((x) => x.productId), ['1', '2', '3']);
  assert.deepEqual(result.unmatchedOptional, ['базилик']);
  assert.equal(result.budgetExceeded, true);
  assert.equal(result.total, 460);
});

test('missing required products are reported without category-neighbor fallback', () => {
  const result = matchDishIngredients(products, [ingredient('цветная капуста', ['cauliflower'])]);
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.unmatchedRequired, ['цветная капуста']);
});
