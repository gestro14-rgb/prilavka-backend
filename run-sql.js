// Прогон произвольного SQL-файла с ПЕЧАТЬЮ всех результатов.
//
// Отличие от migrations/apply.js: тот печатает только "Применено" и молча
// проглатывает result set'ы и NOTICE. Для скрипта очистки нужен отчёт по
// шагам (сколько строк затронуто) и текст RAISE NOTICE/EXCEPTION из
// защитного DO-блока — иначе непонятно, что произошло.
//
// Многооператорный SQL (BEGIN / DELETE / DO / COMMIT) идёт одной строкой
// через простой протокол запросов — pg возвращает массив результатов,
// по одному на оператор. Веб-интерфейс Railway так не умеет: он
// оборачивает введённое в свой SELECT ... LIMIT, отчего многооператорный
// скрипт падает с "syntax error at or near LIMIT".
//
// Запускать ВНУТРИ сети Railway (railway ssh), потому что DATABASE_URL
// указывает на postgres.railway.internal — снаружи этот хост не резолвится:
//   railway ssh --service prilavka-backend
//   node run-sql.js cleanup-test-data.sql
//
// Использование: node run-sql.js <файл.sql>
import { readFileSync } from 'fs';
import { pool } from './db.js';

const file = process.argv[2];
if (!file) {
  console.error('Использование: node run-sql.js <файл.sql>');
  process.exit(1);
}

const sql = readFileSync(new URL(file, import.meta.url), 'utf-8');

const client = await pool.connect();
// RAISE NOTICE из DO-блока приходит отдельным событием, а не в результате.
client.on('notice', (n) => console.log(`NOTICE: ${n.message}`));

try {
  const res = await client.query(sql);
  const results = Array.isArray(res) ? res : [res];

  for (const r of results) {
    if (r.rows && r.rows.length > 0) {
      console.table(r.rows);
    } else if (r.command && r.rowCount != null) {
      console.log(`${r.command}: строк ${r.rowCount}`);
    }
  }
  console.log(`\nГотово: ${file}`);
} catch (e) {
  // Ошибка внутри транзакции откатывает её целиком — данные не изменены.
  console.error(`\nОШИБКА (${e.code || 'без кода'}): ${e.message}`);
  console.error('Транзакция откачена, данные не изменены.');
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
