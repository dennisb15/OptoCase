// db.js
const mysql = require('mysql2/promise');

function parseUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: (u.searchParams.get('ssl') || '').match(/^(1|true|require)$/i)
      ? { rejectUnauthorized: true }
      : undefined,
  };
}

const cfg = parseUrl(process.env.DATABASE_URL);

const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

(async () => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    console.log('✅ DB connected:', cfg.host, cfg.port, r[0]);
  } catch (e) {
    console.error('❌ DB connect failed:', e.code, e.message);
  }
})();

module.exports = { pool };
