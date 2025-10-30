require('dotenv').config();
const { pool } = require('./db');

(async () => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    console.log('✅ Connected! Result:', rows);
    process.exit(0);
  } catch (err) {
    console.error('❌ Connection error:', err);
    process.exit(1);
  }
})();
