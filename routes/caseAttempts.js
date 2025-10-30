const express = require('express');
const router = express.Router();
const { pool } = require('../db'); // mysql2/promise

// ---------- Auth middleware (uses cookie-session set in server.js) ----------
function requireAuth(req, res, next) {
  const u = req.session && req.session.user;
  if (!u || !u.id) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // normalize shape
  req.user = { user_id: u.id, username: u.username, role: u.role };
  next();
}

// ---------- Helpers ----------
async function getAttemptByIdForUser(attemptId, userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM case_attempts WHERE attempt_id=? AND user_id=?',
    [attemptId, userId]
  );
  return rows[0] || null;
}

async function getAttemptByCaseForUser(caseId, userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM case_attempts WHERE case_id=? AND user_id=? LIMIT 1',
    [caseId, userId]
  );
  return rows[0] || null;
}

// ---------- ROUTES ----------

/**
 * 1) Ensure a single attempt per student×case.
 *    - If an IN_PROGRESS attempt exists: return it.
 *    - If COMPLETED: 403 and block re-entry.
 *    - If none: create IN_PROGRESS (optionally set last_page).
 */
router.post('/case-attempts/ensure', requireAuth, async (req, res) => {
  try {
    const { caseId, lastPage } = req.body || {};
    const userId = req.user.user_id;
    if (!caseId) return res.status(400).json({ error: 'MISSING_CASE_ID' });

    const existing = await getAttemptByCaseForUser(caseId, userId);
    if (existing) {
      if (existing.status === 'COMPLETED') {
        return res.status(403).json({
          error: 'CASE_COMPLETED',
          message: 'You already completed this case.',
          attempt: existing
        });
      }
      if (lastPage) {
        await pool.execute(
          'UPDATE case_attempts SET last_page=?, updated_at=NOW() WHERE attempt_id=?',
          [lastPage, existing.attempt_id]
        );
        existing.last_page = lastPage;
      }
      return res.json({ attempt: existing });
    }

    const [ins] = await pool.execute(
      'INSERT INTO case_attempts (case_id, user_id, last_page, status) VALUES (?,?,?,?)',
      [caseId, userId, lastPage || 'history', 'IN_PROGRESS']
    );
    const [createdRows] = await pool.execute(
      'SELECT * FROM case_attempts WHERE attempt_id=?',
      [ins.insertId]
    );
    return res.json({ attempt: createdRows[0] });
  } catch (err) {
    console.error('ensure attempt error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/**
 * 1b) Guard endpoint by caseId.
 *     Use this before loading a case to hard-block completed cases.
 *     - 200 with { attempt } if IN_PROGRESS (or null if none yet)
 *     - 403 with error CASE_COMPLETED if already finished
 */
router.get('/case-attempts/by-case/:caseId', requireAuth, async (req, res) => {
  try {
    const caseId = req.params.caseId;
    const userId = req.user.user_id;
    if (!caseId) return res.status(400).json({ error: 'MISSING_CASE_ID' });

    const attempt = await getAttemptByCaseForUser(caseId, userId);
    if (attempt && attempt.status === 'COMPLETED') {
      return res.status(403).json({
        error: 'CASE_COMPLETED',
        message: 'You already completed this case.',
        attempt
      });
    }
    return res.json({ attempt: attempt || null });
  } catch (err) {
    console.error('by-case guard error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/**
 * 2) Autosave progress for a given attempt.
 *    Body: { section: 'history'|'exam'|'assessment'|'plan'|'attachments', data: {...}, lastPage? }
 */
router.put('/case-attempts/:attemptId/save', requireAuth, async (req, res) => {
  try {
    const { attemptId } = req.params;
    const { section, data, lastPage } = req.body || {};
    const userId = req.user.user_id;

    const attempt = await getAttemptByIdForUser(attemptId, userId);
    if (!attempt) return res.status(404).json({ error: 'NOT_FOUND' });
    if (attempt.status === 'COMPLETED') {
      return res.status(403).json({ error: 'CASE_COMPLETED' });
    }

    const colMap = {
      history: 'history_json',
      exam: 'exam_json',
      assessment: 'assessment_json',
      plan: 'plan_json',
      attachments: 'attachments_json'
    };
    const col = colMap[section];
    if (!col) return res.status(400).json({ error: 'BAD_SECTION' });

    await pool.execute(
      `UPDATE case_attempts
       SET ${col}=?, last_page=COALESCE(?, last_page), updated_at=NOW()
       WHERE attempt_id=? AND user_id=?`,
      [JSON.stringify(data || {}), lastPage || null, attemptId, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('autosave error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/**
 * 3) Mark complete & lock attempt.
 *    Body: { pdfUrl? }
 */
router.post('/case-attempts/:attemptId/complete', requireAuth, async (req, res) => {
  try {
    const { attemptId } = req.params;
    const { pdfUrl } = req.body || {};
    const userId = req.user.user_id;

    const attempt = await getAttemptByIdForUser(attemptId, userId);
    if (!attempt) return res.status(404).json({ error: 'NOT_FOUND' });

    if (attempt.status === 'COMPLETED') {
      return res.json({ ok: true, alreadyCompleted: true });
    }

    await pool.execute(
      'UPDATE case_attempts SET status="COMPLETED", pdf_url=?, completed_at=NOW(), updated_at=NOW() WHERE attempt_id=? AND user_id=?',
      [pdfUrl || null, attemptId, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('complete attempt error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

/**
 * 4) My Progress list (completed first or last_page recency)
 */
router.get('/my-progress', requireAuth, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const [rows] = await pool.execute(
      `SELECT a.attempt_id, a.case_id, a.status, a.last_page,
              a.started_at, a.updated_at, a.completed_at, a.pdf_url,
              c.case_name
       FROM case_attempts a
       JOIN cases c ON c.case_id = a.case_id
       WHERE a.user_id=?
       ORDER BY (a.status='IN_PROGRESS') DESC, a.updated_at DESC`,
      [userId]
    );
    return res.json({ attempts: rows });
  } catch (err) {
    console.error('my-progress error:', err);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

module.exports = router;
