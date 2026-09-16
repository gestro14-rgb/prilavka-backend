// Разовое наполнение библиотеки бейджей по утверждённому референсу.
//
// Идёт через тот же admin API, что и конструктор в админке
// (POST /api/admin/badges), а не прямыми INSERT: так запись проходит ту же
// валидацию цветов и длины текста, и результат неотличим от созданного
// руками.
//
// Повторный запуск безопасен: перед созданием читается текущая библиотека,
// и бейдж с таким же label + icon пропускается. Сравнение по паре, а не по
// одному label: в референсе есть три «Острое» и три «Сочный», они
// различаются именно числом эмодзи.
//
// Запуск: node scripts/seed-badge-library.js
import jwt from 'jsonwebtoken';

const LIBRARY = [
  // 1. Вкус и острота — градация 1–3 уровня
  { label: 'Острое', icon: '🌶️', bgColor: '#FFF1E8', textColor: '#ED2E24' },
  { label: 'Острое', icon: '🌶️🌶️', bgColor: '#FFE4DF', textColor: '#ED2E24' },
  { label: 'Острое', icon: '🌶️🌶️🌶️', bgColor: '#FFD3C0', textColor: '#D92D20' },
  { label: 'Сладкий', icon: '🍬', bgColor: '#FFF0F7', textColor: '#C0266D' },
  { label: 'Сладкий', icon: '🍬🍬', bgColor: '#FDE2F3', textColor: '#C0266D' },
  { label: 'Сладкий', icon: '🍬🍬🍬', bgColor: '#FBCFE8', textColor: '#BE1B5D' },
  { label: 'Кислый', icon: '🍋', bgColor: '#FFF9E6', textColor: '#CA8A04' },
  { label: 'Кислый', icon: '🍋🍋', bgColor: '#FEF3C7', textColor: '#CA8A04' },
  { label: 'Кислый', icon: '🍋🍋🍋', bgColor: '#FDE68A', textColor: '#B45309' },
  { label: 'Сладко-кислый', icon: '🍋🍬', bgColor: '#FFF1E8', textColor: '#EA580C' },
  { label: 'Пряный', icon: '🌶️', bgColor: '#F3E8FF', textColor: '#7C3AED' },
  { label: 'Пряный', icon: '🌶️🌶️', bgColor: '#E9D5FF', textColor: '#7C3AED' },

  // 2. Текстура и ощущение
  { label: 'Сочный', icon: '💧', bgColor: '#E8F8FA', textColor: '#0891B2' },
  { label: 'Сочный', icon: '💧💧', bgColor: '#CFEFF7', textColor: '#0891B2' },
  { label: 'Сочный', icon: '💧💧💧', bgColor: '#BAE6FD', textColor: '#0369A1' },
  { label: 'Хрустящий', icon: '🍃', bgColor: '#ECFDF5', textColor: '#16A34A' },
  { label: 'Хрустящий', icon: '🍃🍃', bgColor: '#D1FAE5', textColor: '#16A34A' },
  { label: 'Хрустящий', icon: '🍃🍃🍃', bgColor: '#B9F7D0', textColor: '#15803D' },
  { label: 'Нежный', icon: '☁️', bgColor: '#EEF5FB', textColor: '#3B82F6' },
  { label: 'Мягкий', icon: '🧈', bgColor: '#FEF3C7', textColor: '#D97706' },
  { label: 'Плотный', icon: '💪', bgColor: '#F3E8FF', textColor: '#7C3AED' },
  { label: 'Кремовый', icon: '🥣', bgColor: '#FFF1E8', textColor: '#EA580C' },
  { label: 'Мясистый', icon: '🥩', bgColor: '#FEE2E2', textColor: '#DC2626' },
  { label: 'Зернистый', icon: '🌾', bgColor: '#FFFBEB', textColor: '#CA8A04' },

  // 3. Аромат
  { label: 'Душистый', icon: '🌸', bgColor: '#FEF3C7', textColor: '#D97706' },
  { label: 'Душистый', icon: '🌸🌸', bgColor: '#FDE68A', textColor: '#D97706' },
  { label: 'Душистый', icon: '🌸🌸🌸', bgColor: '#FCD34D', textColor: '#B45309' },
  { label: 'Ароматный', icon: '🌿', bgColor: '#ECFDF5', textColor: '#059669' },
  { label: 'Пряный', icon: '🌶️🌶️🌶️', bgColor: '#DDD6FE', textColor: '#6D28D9' },
  { label: 'Землистый', icon: '🍃', bgColor: '#E5E7EB', textColor: '#475569' },

  // 4. Свежесть и происхождение
  { label: 'Свежий', icon: '🍃', bgColor: '#EBF9EF', textColor: '#15803D' },
  { label: 'Только привезли', icon: '🚚', bgColor: '#E0F2FE', textColor: '#0284C7' },
  { label: 'Сезонный', icon: '☀️', bgColor: '#FEF3C7', textColor: '#D97706' },
  { label: 'Фермерский', icon: '👨‍🌾', bgColor: '#ECFDF5', textColor: '#059669' },
  { label: 'Отборный', icon: '⭐', bgColor: '#FEF9C3', textColor: '#CA8A04' },
  { label: 'Экологичный', icon: '🌱', bgColor: '#EBF5E9', textColor: '#2E7D32' },

  // 5. Маркетинговые и специальные
  { label: 'Новинка', icon: '✨', bgColor: '#F3E8FF', textColor: '#9333EA' },
  { label: 'Хит продаж', icon: '👑', bgColor: '#FEF3C7', textColor: '#D97706' },
  { label: 'Рекомендуем', icon: '❤️', bgColor: '#FFE4E6', textColor: '#DC2626' },
  { label: 'Выгодно', icon: '％', bgColor: '#ECFDF5', textColor: '#059669' },
  { label: 'Осталось мало', icon: '⏳', bgColor: '#FEE2E2', textColor: '#DC2626' },
  { label: 'Большая упаковка', icon: '📦', bgColor: '#FEF3C7', textColor: '#D97706' },
];

const url = 'http://127.0.0.1:' + (process.env.PORT || 3001);
const token = jwt.sign({ sub: 0, username: 'badge-library-seed' }, process.env.JWT_SECRET, { expiresIn: '15m' });
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };

const run = async () => {
  const existing = await (await fetch(url + '/api/admin/badges', { headers: H })).json();
  const key = (b) => `${b.label}|${b.icon || ''}`;
  const have = new Set(existing.map(key));
  console.log('в библиотеке уже есть: ' + existing.length);

  let created = 0;
  let skipped = 0;
  for (let i = 0; i < LIBRARY.length; i += 1) {
    const b = LIBRARY[i];
    if (have.has(key(b))) { skipped += 1; console.log('пропуск (уже есть): ' + key(b)); continue; }
    // sort_order = позиция в референсе: порядок в админке совпадает с
    // порядком на картинке, по группам.
    const res = await fetch(url + '/api/admin/badges', {
      method: 'POST', headers: H, body: JSON.stringify({ ...b, sortOrder: i + 1, isActive: true }),
    });
    if (res.status !== 201) {
      console.log('ОШИБКА ' + res.status + ' на ' + key(b) + ': ' + JSON.stringify(await res.json()));
      continue;
    }
    created += 1;
  }
  const after = await (await fetch(url + '/api/admin/badges', { headers: H })).json();
  console.log('создано: ' + created + ', пропущено дублей: ' + skipped + ', всего в библиотеке: ' + after.length);
};

run().catch((e) => { console.error('ОШИБКА:', e); process.exitCode = 1; });
