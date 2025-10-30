const bcrypt = require('bcryptjs');
const { pool } = require('../db'); // this assumes db.js is one folder above scripts/

(async () => {
  const username = 'Brandon Dennis';
  const rawPassword = '123456';
  const role = 'student';

  try {
    // check if table uses "password_hash" or "password"
    const [pwColCheck] = await pool.query("SHOW COLUMNS FROM `users` LIKE 'password_hash'");
    const passwordCol = pwColCheck.length ? 'password_hash' : 'password';

    // hash the password before saving
    const hash = await bcrypt.hash(rawPassword, 10);

    // ensure unique username key (optional)
    await pool.query("ALTER TABLE `users` ADD UNIQUE KEY `uniq_username` (`username`)").catch(() => {});

    // insert or update
    await pool.execute(
      `INSERT INTO users (username, ${passwordCol}, role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE ${passwordCol}=VALUES(${passwordCol}), role=VALUES(role)`,
      [username, hash, role]
    );

    console.log(`✅ Created/updated user: ${username} (role: ${role})`);
  } catch (e) {
    console.error('❌ Failed to create user:', e.message);
  } finally {
    pool.end();
  }
})();
