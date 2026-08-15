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

export const s3Client = new S3Client({
  endpoint,
  region,
  credentials: { accessKeyId, secretAccessKey },
  // Path-style ("endpoint/bucket/key"), а не virtual-hosted-style
  // ("bucket.endpoint/key") — большинство S3-совместимых провайдеров вне
  // AWS (включая Selectel) не гарантируют wildcard DNS под каждый бакет,
  // на котором virtual-hosted-style завязан.
  forcePathStyle: true,
});
