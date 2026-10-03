// Проверка связи с OpenAI.
//
// Пока здесь ровно одна ручка — POST /api/ai/test. Она нужна, чтобы
// отделить «ключ и сеть в порядке» от «сценарий работает неправильно»:
// когда к AI-экранам приложения подключится настоящая модель, первым
// вопросом при любой ошибке будет именно этот, и отвечать на него проще
// отдельным эндпоинтом, чем отладкой боевого сценария.
//
// Отдельный модуль, а не дописка в server.js: монолит и так около 6000
// строк, и у партнёрки рядом уже есть тот же приём (partners.js).
//
// Ключ читается из окружения при каждом запросе, а не при импорте: на
// Railway переменные подставляются на старте контейнера, и модуль,
// запомнивший отсутствие ключа на этапе импорта, пришлось бы
// передеплоивать после каждой правки переменной. Сам ключ никуда не
// пишется и не возвращается — ни в лог, ни в ответ.
import express from 'express';
import OpenAI from 'openai';

// Модель задаётся переменной окружения, чтобы менять её без правки кода.
// Значение по умолчанию — дешёвая и быстрая: для проверки связи большего
// не нужно.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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

export function createAiRoutes() {
  const router = express.Router();

  // POST /api/ai/test — один короткий запрос к модели и её ответ обратно.
  router.post('/test', async (req, res) => {
    const apiKey = process.env.OPENAI_API_KEY;

    // Отсутствие ключа — не поломка сервера, а незаконченная настройка
    // среды, поэтому 503 и прямым текстом что делать. Отдельный код
    // reason нужен вызывающей стороне, чтобы отличить этот случай от
    // ошибки самого OpenAI.
    if (!apiKey) {
      return res.status(503).json({
        ok: false,
        reason: 'missing_api_key',
        error: 'OPENAI_API_KEY не задан в окружении backend. '
          + 'Добавьте переменную и перезапустите сервис.',
      });
    }

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
      // В лог уходит только код и текст ошибки, из которого вырезано всё
      // похожее на ключ. Сам ключ не логируется и не возвращается ни
      // здесь, ни где-либо ещё в модуле.
      const message = scrubKeys(err?.message ?? 'Неизвестная ошибка запроса к OpenAI');
      console.error('[ai] запрос к OpenAI не прошёл:', err?.status ?? '', message);
      return res.status(502).json({
        ok: false,
        reason: 'openai_error',
        status: err?.status ?? null,
        error: message,
        tookMs: Date.now() - startedAt,
      });
    }
  });

  return router;
}
