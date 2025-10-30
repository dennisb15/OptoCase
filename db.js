// db.js
const mysql = require('mysql2/promise');

// Only load .env locally; Railway injects env in prod
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

/**
 * Parse mysql://user:pass@host:port/db?ssl=require
 * Forces TLS for Railway proxy hosts.
 */
function parseUrl(url) {
  const u = new URL(url);

  const q = u.searchParams;
  const sslFlag = (q.get('ssl') || q.get('sslmode') || q.get('sslMode') || '').toLowerCase();
  let wantSSL = /^(1|true|require|required|enabled|verify_ca|verify_full)$/i.test(sslFlag);

  const isRailwayProxy = /\.proxy\.rlwy\.net$/i.test(u.hostname);
  if (isRailwayProxy) wantSSL = true; // Railway proxy requires TLS

  const ssl = wantSSL
    ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' }
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

// Prefer DATABASE_URL; else use MYSQL* envs
const cfg = process.env.DATABASE_URL
  ? parseUrl(process.env.DATABASE_URL)
  : {
      host: process.env.MYSQLHOST,
      port: Number(process.env.MYSQLPORT || 3306),
      user: process.env.MYSQLUSER,
      password: process.env.MYSQLPASSWORD,
      database: process.env.MYSQLDATABASE || 'railway',
      ssl: ['true','1','require','required','enabled'].includes(
        String(process.env.MYSQL_SSL || '').toLowerCase()
      ) ? { rejectUnauthorized: false, minVersion: 'TLSv1.2' } : undefined,
    };

// Optional debug prints without flooding Railway logs
if (process.env.DEBUG_DB === '1') {
  console.log('[DB] host:', cfg.host, 'port:', cfg.port, 'db:', cfg.database);
  console.log('[DB] SSL:', cfg.ssl ? 'on' : 'off');
}

// Create a resilient pool
const pool = mysql.createPool({
  ...cfg,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,      // keep TCP alive
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4',
  // Timeouts help avoid hanging under proxy hiccups
  connectTimeout: 15000,
  idleTimeout: 60000
});

// One-time ping (quiet unless DEBUG_DB)
(async () => {
  try {
    const [r] = await pool.query('SELECT 1 AS ok');
    if (process.env.DEBUG_DB === '1') {
      console.log('[DB] initial ping ok:', r && r[0]);
    }
  } catch (e) {
    console.error('[DB] initial ping failed:', e.code, e.message);
  }
})();

module.exports = { pool };
