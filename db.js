// db.js
const mysql = require('mysql2/promise');
require('dotenv').config();

function parseUrl(url) {
  const u = new URL(url);

  // accept multiple spellings and default to ON for Railway proxy
  const q = u.searchParams;
  const sslFlag = (q.get('ssl') || q.get('sslmode') || q.get('sslMode') || '').toLowerCase();
  let wantSSL = /^(1|true|require|required|enabled)$/i.test(sslFlag);

  // If using Railway proxy host, force SSL on (proxy requires TLS)
  const isRailwayProxy = /\.proxy\.rlwy\.net$/i.test(u.hostname);
  if (isRailwayProxy) wantSSL = true;

  const ssl =
    wantSSL
      ? {
          // Railway proxy presents a self-signed chain
          rejectUnauthorized: false,
          minVersion: 'TLSv1.2',
        }
      : undefined;

  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl,
  };
}

// Prefer DATABASE_URL; else fall back to MYSQL* vars
const cfg = process.env.DATABASE_URL
  ? parseUrl(process.env.DATABASE_URL)
  : {
      host: process.env.MYSQLHOST,
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE,
      ssl: ['true','1','require','required','enabled'].includes(String(process.env.MYSQL_SSL || '').toLowerCase())
        ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' }
        : undefined,
    };

// 🔎 Log what we’re actually passing (safe)
console.log('DEBUG DB CONFIG host/port/db:', cfg.host, cfg.port, cfg.database);
console.log('DEBUG DB SSL:', cfg.ssl ? cfg.ssl : 'no SSL');

const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Always do a tiny self-test so logs show success/failure in prod too
(async () => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    console.log('DB connected:', cfg.host, cfg.port, r[0]);
  } catch (e) {
    console.error('DB connect failed:', e.code, e.message, 'host:', cfg.host, 'port:', cfg.port);
  }
})();

module.exports = { pool };
