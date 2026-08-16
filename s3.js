import { S3Client } from '@aws-sdk/client-s3';
import 'dotenv/config';

// S3-совместимое хранилище Selectel (сторис-карточки — модель данных и
// бизнес-логика ещё впереди, здесь только клиент подключения).
const endpoint = process.env.S3_ENDPOINT;
const region = process.env.S3_REGION;
const accessKeyId = process.env.S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

export const S3_BUCKET = process.env.S3_BUCKET;

if (!endpoint || !region || !S3_BUCKET || !accessKeyId || !secretAccessKey) {
  console.error('ОШИБКА: переменные окружения S3_* заданы не полностью.');
  console.error('На Railway (сервис prilavka-backend): Variables -> S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.');
}

const clientConfig = {
  region,
  credentials: { accessKeyId, secretAccessKey },
  // Path-style ("endpoint/bucket/key"), а не virtual-hosted-style
  // ("bucket.endpoint/key") — большинство S3-совместимых провайдеров вне
  // AWS (включая Selectel) не гарантируют wildcard DNS под каждый бакет,
  // на котором virtual-hosted-style завязан.
  forcePathStyle: true,
};

// Серверные операции (delete, list и т.п.) — обычный S3-эндпоинт.
export const s3Client = new S3Client({ ...clientConfig, endpoint });

// ОТДЕЛЬНЫЙ клиент для presigned-ссылок, по которым грузит БРАУЗЕР.
//
// Почему не тот же самый: S3-эндпоинт Selectel (s3.ru-7.storage.selcloud.ru)
// не реализует метод OPTIONS — на preflight отвечает "405 method not
// allowed", и в его собственном заголовке allow значатся только
// GET/HEAD/PUT/POST/DELETE. Кросс-доменный PUT из браузера ВСЕГДА требует
// preflight, поэтому загрузка падала ещё до самого PUT, независимо от
// CORS-правила: правило на бакете выставлено верно (GetBucketCors его
// возвращает дословно), просто этот эндпоинт его не применяет.
//
// Публичный домен контейнера (S3_PRESIGN_ENDPOINT, тот же selstorage.ru,
// что и для чтения) на OPTIONS отвечает 200 с корректными
// Access-Control-Allow-* и принимает подписанный PUT по пути
// /<bucket>/<key>. Проверено на живом бакете.
//
// Не задан — поведение прежнее (подпись под обычный эндпоинт).
const presignEndpoint = process.env.S3_PRESIGN_ENDPOINT;
export const s3PresignClient = presignEndpoint
  ? new S3Client({ ...clientConfig, endpoint: presignEndpoint })
  : s3Client;
