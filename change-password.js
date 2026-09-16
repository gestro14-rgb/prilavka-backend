import pg from 'pg';
const { Client } = pg;
const c = new Client({ connectionString: process.env.DATABASE_URL });
c.connect()
  .then(() => c.query("ALTER USER postgres PASSWORD 'PrilavkaSecure2026xyz'"))
  .then(() => console.log('OK, password changed'))
  .catch(e => console.error(e))
  .finally(() => c.end());