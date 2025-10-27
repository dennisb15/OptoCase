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

// Prefer DATABASE_URL if present; otherwise fall back to MYSQL* vars
const cfg = process.env.DATABASE_URL
  ? parseUrl(process.env.DATABASE_URL)
  : {
      host: process.env.MYSQLHOST,
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      ssl: ['true', '1', 'require'].includes(String(process.env.MYSQL_SSL || '').toLowerCase())
        ? { rejectUnauthorized: true }
        : undefined,
    };

const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Log where we’re trying to connect (helps verify not localhost)
(async () => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    console.log('DB connected:', cfg.host, cfg.port, r[0]);
  } catch (e) {
    console.error('DB connect failed:', e.code, e.message, 'host:', cfg.host, 'port:', cfg.port);
  }
})();

module.exports = { pool };
