const express = require('express');
const mysql = require('mysql2'); // only for escape/format helpers
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const session = require('express-session');
const path = require('path');
const multer = require('multer');

// only load .env locally; Railway sets env for prod
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const app = express();
// Railway provides PORT
const port = process.env.PORT || 3000;

// use the ONE pooled client from db.js (uses DATABASE_URL)
const { pool } = require('./db');

app.set('trust proxy', 1); // Railway is behind a proxy

const cookieSession = require('cookie-session');
app.use(cookieSession({
  name: 'session',
  secret: process.env.SESSION_SECRET || 'change-me',
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production', // true on Railway (HTTPS)
  httpOnly: true,
  maxAge: 1000 * 60 * 60 * 8, // 8 hours
}));



// Middleware
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'supersecretkey', // change this to something unique
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // set secure:true if using HTTPS
}));

// Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());   // ✅ parse JSON


// Multer storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // save in uploads/ folder
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

// Make the uploads folder accessible
app.use('/uploads', express.static('uploads'));


// Use the pooled client from db.js
const db = {
  query(sql, params, cb) {
    if (typeof params === 'function') { cb = params; params = []; }
    pool
      .query(sql, params || [])
      .then(([rows]) => cb(null, rows))
      .catch(err => cb(err));
  },
  escape: mysql.escape,
  format: mysql.format,
};



// Landing page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Serve login pages
app.get('/login/student', (req, res) => {
  res.sendFile(__dirname + '/public/student-login.html');
});

app.get('/login/professor', (req, res) => {
  res.sendFile(__dirname + '/public/professor-login.html');
});

// Student login
app.post('/auth/student', (req, res) => {
  const { username, password } = req.body;

  db.query(
    'SELECT * FROM users WHERE username = ? AND role = "student"',
    [username],
    async (err, results) => {
      if (err) return res.status(500).send('❌ Database error');
      if (results.length === 0) return res.send('❌ Invalid student credentials');

      const user = results[0];
      const match = await bcrypt.compare(password, user.password);

      if (match) {
        // ✅ include user.id so it’s available later
        req.session.user = { id: user.id, username: user.username, role: 'student' };
        res.redirect('/student/dashboard');
      } else {
        res.send('❌ Invalid student credentials');
      }
    }
  );
});

// Professor login
app.post('/auth/professor', (req, res) => {
  const { username, password } = req.body;

  db.query(
    'SELECT * FROM users WHERE username = ? AND role = "professor"',
    [username],
    async (err, results) => {
      if (err) return res.status(500).send('❌ Database error');
      if (results.length === 0) return res.send('❌ Invalid professor credentials');

      const user = results[0];
      const match = await bcrypt.compare(password, user.password);

      if (match) {
        // ✅ same here
        req.session.user = { id: user.id, username: user.username, role: 'professor' };
        res.redirect('/professor/dashboard');
      } else {
        res.send('❌ Invalid professor credentials');
      }
    }
  );
});


app.post('/api/student-notes', (req, res) => {
  const { case_id, section, notes, interpretations } = req.body;

  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: '❌ Unauthorized' });
  }

  const student_id = req.session.user.id;

  if (section === "testing" && Array.isArray(interpretations)) {
    const sql = `
      INSERT INTO interpretations 
        (case_id, test_type, date, reason, cooperation, findings_od, findings_os)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

    // Wrap db.query in a Promise
    const queries = interpretations.map(interp => {
      return new Promise((resolve, reject) => {
        db.query(sql, [
          case_id,
          interp.test_type,
          interp.date || null,
          interp.reason || null,
          interp.cooperation || null,
          interp.findings_od || null,
          interp.findings_os || null
        ], (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    });

    Promise.all(queries)
      .then(() => res.json({ success: true }))
      .catch(err => {
        console.error("❌ Error saving interpretation:", err);
        res.status(500).json({
          success: false,
          error: err.code,
          message: err.sqlMessage
        });
      });

    return; // stop here so we don’t fall through
  }

  // ✅ History + Exam stay the same
  const sql = `
    INSERT INTO student_notes (case_id, student_id, section, notes)
    VALUES (?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE notes = VALUES(notes), submitted_at = CURRENT_TIMESTAMP
  `;

  db.query(sql, [case_id, student_id, section, notes], (err) => {
    if (err) {
      console.error("❌ Error saving notes:", err);
      return res.status(500).json({
        success: false,
        error: err.code,
        message: err.sqlMessage
      });
    }
    res.json({ success: true });
  });
});

app.post('/api/assessment-plan', (req, res) => {
  const { case_id, assessments } = req.body;

  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: '❌ Unauthorized' });
  }

  const student_id = req.session.user.id;

  const sql = `
  INSERT INTO assessment_plan (case_id, student_id, icd10_code, plan)
  VALUES ?
`;
const values = assessments.map(a => [case_id, student_id, a.icd10_code, a.plan]);


  db.query(sql, [values], (err, result) => {
    if (err) {
      console.error("❌ Error saving assessments:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }

    // Return the IDs of inserted rows
    res.json({ success: true, insertedIds: Array.from({ length: result.affectedRows }, (_, i) => result.insertId + i) });
  });
});

// Save CPT codes linked to assessments
app.post('/api/assessment-plan-cpt', (req, res) => {
  const { case_id, cpt_codes } = req.body;

  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: '❌ Unauthorized' });
  }

  const student_id = req.session.user.id;

  if (!cpt_codes || cpt_codes.length === 0) {
    return res.json({ success: true, message: "No CPT codes to save" });
  }

  const sql = `
    INSERT INTO assessment_plan_cpt (assessment_plan_id, cpt_code, applies_to)
    VALUES ?
  `;

  // Flatten CPT mapping rows
  const values = cpt_codes.map(c => [
    // store as JSON which assessment_plan IDs this CPT applies to
    c.applies_to.length > 0 ? c.applies_to[0] : null,
    c.code,
    JSON.stringify(c.applies_to)
  ]);

  db.query(sql, [values], (err) => {
    if (err) {
      console.error("❌ Error saving CPT codes:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json({ success: true });
  });
});




// ✅ Get student notes by case + section
app.get('/api/student-notes', (req, res) => {
  const { case_id, section } = req.query;

  if (!req.session.user) {
    return res.status(403).json({ success: false, message: '❌ Unauthorized' });
  }

  const sql = `
    SELECT *
    FROM student_notes
    WHERE case_id = ? AND section = ? AND student_id = ?
    ORDER BY submitted_at DESC
  `;

  db.query(sql, [case_id, section, req.session.user.id], (err, results) => {
    if (err) {
      console.error("❌ Error fetching student notes:", err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json(results);
  });
});






// Student dashboard (protected)
app.get('/student/dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect('/login/student');
  }
  res.sendFile(__dirname + '/public/student-dashboard.html');
});

// Professor dashboard (protected)
app.get('/professor/dashboard', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.redirect('/login/professor');
  }
  res.sendFile(__dirname + '/public/professor-dashboard.html');
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).send('❌ Error logging out');
    res.redirect('/');
  });
});

// Get logged in user info
app.get('/api/user', (req, res) => {
  if (req.session.user) {
    res.json(req.session.user);
  } else {
    res.status(401).json({ error: 'Not logged in' });
  }
});

// Step 1 page
app.get('/wizard/step1', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }
  res.sendFile(__dirname + '/public/wizard-step1.html');
});

// ======================
// View Cases Page
// ======================
app.get('/view-cases', (req, res) => {
  res.sendFile(__dirname + '/public/view-cases.html');
});

// Fetch all cases
app.get('/api/cases', (req, res) => {
  const sql = `
    SELECT case_id, case_name, instructions, created_by, created_at
    FROM cases
    ORDER BY case_id DESC
  `;
  db.query(sql, (err, results) => {
    if (err) {
      console.error("❌ Error fetching cases:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(results);
  });
});


// Delete a case
app.delete('/api/cases/:id', (req, res) => {
  const caseId = req.params.id;
  const sql = "DELETE FROM cases WHERE case_id = ?";
  db.query(sql, [caseId], (err, result) => {
    if (err) {
      console.error("❌ Error deleting case:", err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json({ success: true });
  });
});

// ======================
// Fetch a single case by ID (Step 1–6)
// ======================
app.get('/api/cases/:id', (req, res) => {
  const caseId = req.params.id;

  const caseQuery = `
    SELECT case_id, case_name, instructions, created_by, created_at
    FROM cases
    WHERE case_id = ?
  `;

  db.query(caseQuery, [caseId], (err, results) => {
    if (err) {
      console.error("❌ Error fetching case:", err);
      return res.status(500).json({ error: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ error: "Case not found" });
    }

    const caseData = results[0];

    // Patients
    db.query("SELECT * FROM patients WHERE case_id = ?", [caseId], (err, patientResults) => {
      if (err) return res.status(500).json({ error: "Database error" });
      caseData.patient = patientResults[0] || null;

      // Appointments
      db.query("SELECT * FROM appointments WHERE case_id = ?", [caseId], (err, apptResults) => {
        if (err) return res.status(500).json({ error: "Database error" });
        caseData.appointment = apptResults[0] || null;

        // Histories
        db.query("SELECT * FROM histories WHERE case_id = ?", [caseId], (err, historyResults) => {
          if (err) return res.status(500).json({ error: "Database error" });
          caseData.history = historyResults[0] || null;

          // Exam Findings (Step 4 + 5)
          db.query("SELECT * FROM exam_sections WHERE case_id = ?", [caseId], (err, examResults) => {
            if (err) return res.status(500).json({ error: "Database error" });
            caseData.exam = examResults[0] || null;

            // Assessments & Plan (Step 6 - ICD10 codes + plans)
db.query(
  "SELECT icd10_code, plan FROM assessment_plan WHERE case_id = ?",
  [caseId],
  (err, planResults) => {
    if (err) return res.status(500).json({ error: "Database error" });

    // 🔑 Fix: Convert MySQL RowDataPackets into plain objects
    caseData.assessments = planResults && planResults.length > 0 
      ? JSON.parse(JSON.stringify(planResults)) 
      : [];

    // CPT Codes (Step 6 - procedures)
    db.query(
      "SELECT cpt_code FROM codes WHERE case_id = ?",
      [caseId],
      (err, cptResults) => {
        if (err) return res.status(500).json({ error: "Database error" });
        caseData.cpt_codes = cptResults.map(row => row.cpt_code);

        // ✅ Send final combined data
        res.json(caseData);
              });
            });
          });
        });
      });
    });
  });
});


// ✅ Fetch simplified case list for students
app.get('/api/student-cases', (req, res) => {
  const query = `
    SELECT c.case_id, c.case_name, c.created_by, c.created_at,
           DATE_FORMAT(a.date, '%Y-%m-%d') AS appt_date,
           TIME_FORMAT(a.time, '%H:%i') AS appt_time,
           a.exam_type,
           a.patient_name, 
           p.dob, 
           p.race, 
           p.address,
           p.vision_insurance, p.vision_insurance_info,
           p.medical_insurance, p.medical_insurance_info
    FROM cases c
    LEFT JOIN appointments a ON c.case_id = a.case_id
    LEFT JOIN patients p ON c.case_id = p.case_id
    ORDER BY c.created_at DESC
  `;
  db.query(query, (err, results) => {
    if (err) {
      console.error("❌ Error fetching student cases:", err.sqlMessage || err);
      return res.status(500).json({ error: "Database error" });
    }
    res.json(results);
  });
});








// ======================
// Case Wizard - Step 1
// ======================
app.post('/wizard/step1', (req, res) => {
  const { case_name, instructions } = req.body;

  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

  db.query(
    'INSERT INTO cases (case_name, instructions, created_by) VALUES (?, ?, ?)',
    [case_name, instructions, req.session.user.username],
    (err, result) => {
      if (err) {
        console.error('❌ Error inserting case basics:', err);
        return res.status(500).send('Database error');
      }

      const caseId = result.insertId;
      console.log('✅ New case created with ID:', caseId);

      res.redirect(`/wizard/step2?case_id=${caseId}`);
    }
  );
});

app.get('/wizard/step2', (req, res) => {
  res.sendFile(__dirname + '/public/wizard-step2.html');
});

// ======================
// Case Wizard - Step 2
// ======================
app.post('/wizard/step2', (req, res) => {
  const {
    case_id,
    patient_name, address, dob, race,
    vision_insurance, vision_insurance_info,
    medical_insurance, medical_insurance_info,
    appt_date, appt_time, exam_type
  } = req.body;

  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

  // Insert patient info
  db.query(
    `INSERT INTO patients 
      (case_id, name, address, dob, race, vision_insurance, vision_insurance_info, medical_insurance, medical_insurance_info)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [case_id, patient_name, address, dob, race, vision_insurance, vision_insurance_info, medical_insurance, medical_insurance_info],
    (err) => {
      if (err) {
        console.error('❌ Error inserting patient:', err);
        return res.status(500).send('Database error');
      }

      // Insert appointment info
      db.query(
        `INSERT INTO appointments (case_id, date, time, exam_type, patient_name)
         VALUES (?, ?, ?, ?, ?)`,
        [case_id, appt_date, appt_time, exam_type, patient_name],
        (err2) => {
          if (err2) {
            console.error('❌ Error inserting appointment:', err2);
            return res.status(500).send('Database error');
          }

          res.redirect(`/wizard/step3?case_id=${case_id}`);
        }
      );
    }
  );
});

app.get('/wizard/step3', (req, res) => {
  res.sendFile(__dirname + '/public/wizard-step3.html');
});

// ======================
// Case Wizard - Step 3
// ======================
app.post('/wizard/step3', upload.single('patient_avatar'), (req, res) => {
  const {
    case_id,
    chief_complaint, hpi, poh, pmh, fhx, meds, allergies, social_history
  } = req.body;

  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

  // ✅ Avatar upload goes to patients table
  const avatarPath = req.file ? `/uploads/${req.file.filename}` : null;

  // Insert into histories (same as before)
  db.query(
    `INSERT INTO histories 
      (case_id, chief_complaint, hpi, poh, pmh, fhx, meds, allergies, social_history)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [case_id, chief_complaint, hpi, poh, pmh, fhx, meds, allergies, social_history],
    (err) => {
      if (err) {
        console.error('❌ Error inserting history:', err);
        return res.status(500).send('Database error');
      }

      // ✅ Update patient avatar separately
      if (avatarPath) {
        db.query(
          `UPDATE patients SET avatar = ? WHERE case_id = ?`,
          [avatarPath, case_id],
          (err2) => {
            if (err2) console.error("⚠️ Avatar not saved:", err2);
          }
        );
      }

      res.redirect(`/wizard/step4?case_id=${case_id}`);
    }
  );
});

// Step 4 page loader (same as before)
app.get('/wizard/step4', (req, res) => {
  res.sendFile(__dirname + '/public/wizard-step4.html');
});





// ======================
// Case Wizard - Step 4
// ======================
app.post('/wizard/step4', upload.fields([
  { name: 'anterior_image', maxCount: 10 },
  { name: 'posterior_image', maxCount: 10 },
  { name: 'fundus_autofluorescence_images', maxCount: 10 },
  { name: 'oct_images', maxCount: 10 },
  { name: 'vf_images', maxCount: 10 },
  { name: 'gonioscopy_images', maxCount: 10 },
  { name: 'topography_images', maxCount: 10 },
  { name: 'ascan_images', maxCount: 10 },
  { name: 'bscan_images', maxCount: 10 },
  { name: 'pachymetry_images', maxCount: 10 },
  { name: 'fundus_photo_images', maxCount: 10 }
]), (req, res) => {

  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

  const {
  case_id,
  va_type, va_od, va_os,
  eoms, pupils, fields,
  iop_method, iop_od, iop_os,
  redcap, prelim_other,
  // anterior
  od_adnexa, os_adnexa,
  od_lids_lashes, os_lids_lashes,
  od_conjunctiva, os_conjunctiva,
  od_cornea, os_cornea,
  od_anterior_chamber, os_anterior_chamber,
  od_iris, os_iris,
  od_lens, os_lens,
  od_anterior_vitreous, os_anterior_vitreous,
  // posterior
  od_posterior_vitreous, os_posterior_vitreous,
  od_cd, os_cd,
  od_disc, os_disc,
  od_macula, os_macula,
  od_vessels, os_vessels,
  od_periphery, os_periphery,
  // ancillary statuses + notes
  fundus_autofluorescence_status, fundus_autofluorescence_notes,
  oct_type, oct_subtype, oct_status, oct_notes,
  vf_status, vf_subtype, vf_notes,
  gonioscopy_status, gonioscopy_notes,
  topography_status, topography_notes,
  ascan_status, ascan_notes,
  bscan_status, bscan_notes,
  pachymetry_status, pachymetry_notes,
  fundus_photo_status, fundus_photo_notes,
  // new fields
  fa_type, fa_date, fa_reason, fa_cooperation, fa_reliability, fa_findings_od, fa_findings_os,
  vf_type, vf_date, vf_reason, vf_cooperation, vf_reliability, vf_findings_od, vf_findings_os,
  oct_date, oct_reason, oct_cooperation, oct_reliability, oct_findings_od, oct_findings_os
} = req.body

  // Uploaded images (joined filenames)
  const anteriorImages = req.files['anterior_image']?.map(f => f.filename).join(',') || null;
  const posteriorImages = req.files['posterior_image']?.map(f => f.filename).join(',') || null;

  const fundusAutofluorescenceImages = req.files['fundus_autofluorescence_images']?.map(f => f.filename).join(',') || null;
  const octImages = req.files['oct_images']?.map(f => f.filename).join(',') || null;
  const vfImages = req.files['vf_images']?.map(f => f.filename).join(',') || null;
  const gonioscopyImages = req.files['gonioscopy_images']?.map(f => f.filename).join(',') || null;
  const topographyImages = req.files['topography_images']?.map(f => f.filename).join(',') || null;
  const ascanImages = req.files['ascan_images']?.map(f => f.filename).join(',') || null;
  const bscanImages = req.files['bscan_images']?.map(f => f.filename).join(',') || null;
  const pachymetryImages = req.files['pachymetry_images']?.map(f => f.filename).join(',') || null;
  const fundusPhotoImages = req.files['fundus_photo_images']?.map(f => f.filename).join(',') || null;

  // ======================
  // Save into exam_sections
  // ======================
  db.query(
  `INSERT INTO exam_sections (
    case_id,
    od_adnexa, os_adnexa,
    od_lids_lashes, os_lids_lashes,
    od_conjunctiva, os_conjunctiva,
    od_cornea, os_cornea,
    od_anterior_chamber, os_anterior_chamber,
    od_iris, os_iris,
    od_lens, os_lens,
    od_anterior_vitreous, os_anterior_vitreous,
    od_posterior_vitreous, os_posterior_vitreous,
    od_cd, os_cd,
    od_disc, os_disc,
    od_macula, os_macula,
    od_vessels, os_vessels,
    od_periphery, os_periphery,
    anterior_image, posterior_image,
    va_type, va_od, va_os,
    eoms, pupils, fields,
    iop_method, iop_od, iop_os,
    redcap, prelim_other,
    fundus_autofluorescence_status, fundus_autofluorescence_notes, fundus_autofluorescence_images,
    oct_type, oct_subtype, oct_status, oct_notes, oct_images,
    vf_status, vf_subtype, vf_notes, vf_images,
    fa_type, fa_date, fa_reason, fa_cooperation, fa_reliability, fa_findings_od, fa_findings_os,
    vf_type, vf_date, vf_reason, vf_cooperation, vf_reliability, vf_findings_od, vf_findings_os,
    oct_date, oct_reason, oct_cooperation, oct_reliability, oct_findings_od, oct_findings_os,
    gonioscopy_status, gonioscopy_notes, gonioscopy_images,
    topography_status, topography_notes, topography_images,
    ascan_status, ascan_notes, ascan_images,
    bscan_status, bscan_notes, bscan_images,
    pachymetry_status, pachymetry_notes, pachymetry_images,
    fundus_photo_status, fundus_photo_notes, fundus_photo_images
  ) VALUES (
    ${Array(92).fill('?').join(', ')}

  )`,
  [
    case_id,
    od_adnexa, os_adnexa,
    od_lids_lashes, os_lids_lashes,
    od_conjunctiva, os_conjunctiva,
    od_cornea, os_cornea,
    od_anterior_chamber, os_anterior_chamber,
    od_iris, os_iris,
    od_lens, os_lens,
    od_anterior_vitreous, os_anterior_vitreous,
    od_posterior_vitreous, os_posterior_vitreous,
    od_cd, os_cd,
    od_disc, os_disc,
    od_macula, os_macula,
    od_vessels, os_vessels,
    od_periphery, os_periphery,
    anteriorImages, posteriorImages,
    va_type, va_od, va_os,
    eoms, pupils, fields,
    iop_method, iop_od, iop_os,
    redcap, prelim_other,
    fundus_autofluorescence_status, fundus_autofluorescence_notes, fundusAutofluorescenceImages,
    oct_type, oct_subtype, oct_status, oct_notes, octImages,
    vf_status, vf_subtype, vf_notes, vfImages,
    fa_type, fa_date, fa_reason, fa_cooperation, fa_reliability, fa_findings_od, fa_findings_os,
    vf_type, vf_date, vf_reason, vf_cooperation, vf_reliability, vf_findings_od, vf_findings_os,
    oct_date, oct_reason, oct_cooperation, oct_reliability, oct_findings_od, oct_findings_os,
    gonioscopy_status, gonioscopy_notes, gonioscopyImages,
    topography_status, topography_notes, topographyImages,
    ascan_status, ascan_notes, ascanImages,
    bscan_status, bscan_notes, bscanImages,
    pachymetry_status, pachymetry_notes, pachymetryImages,
    fundus_photo_status, fundus_photo_notes, fundusPhotoImages
  ],
  (err) => {
    if (err) {
      console.error('❌ Error inserting exam findings:', err);
      return res.status(500).send("Database error");
    }
    res.redirect(`/wizard/step5?case_id=${case_id}`);
  }
);


});

app.get('/wizard/step5', (req, res) => {
  res.sendFile(__dirname + '/public/wizard-step5.html');
});


// ======================
// Case Wizard - Step 5
// ======================
app.post('/wizard/step5', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

    // Helper: Convert blank strings to NULL for MySQL
  function toNull(val) {
    return val && val.trim() !== "" ? val : null;
  }


  const case_id = req.body.case_id || req.query.case_id;

  const {
    // Fundus Autofluorescence
    fa_type, fa_date, fa_reason, fa_cooperation, fa_reliability, fa_findings_od, fa_findings_os,
    // OCT
    oct_type, oct_subtype, oct_status, oct_notes,
    oct_date, oct_reason, oct_cooperation, oct_reliability, oct_findings_od, oct_findings_os,
    // Visual Field
    vf_type, vf_status, vf_subtype, vf_notes,
    vf_date, vf_reason, vf_cooperation, vf_reliability, vf_findings_od, vf_findings_os,
    // Gonioscopy
    gonioscopy_date, gonioscopy_reason, gonioscopy_cooperation, gonioscopy_reliability, gonioscopy_findings_od, gonioscopy_findings_os,
    // Topography
    topography_date, topography_reason, topography_cooperation, topography_reliability, topography_findings_od, topography_findings_os,
    // A-Scan
    ascan_date, ascan_reason, ascan_cooperation, ascan_reliability, ascan_findings_od, ascan_findings_os,
    // B-Scan
    bscan_date, bscan_reason, bscan_cooperation, bscan_reliability, bscan_findings_od, bscan_findings_os,
    // Pachymetry
    pachymetry_date, pachymetry_reason, pachymetry_cooperation, pachymetry_reliability, pachymetry_findings_od, pachymetry_findings_os,
    // Fundus Photo
    fundus_photo_date, fundus_photo_reason, fundus_photo_cooperation, fundus_photo_reliability, fundus_photo_findings_od, fundus_photo_findings_os
  } = req.body;

  // ✅ Normalize dates to NULL if blank
  const safe_fa_date = toNull(fa_date);
  const safe_oct_date = toNull(oct_date);
  const safe_vf_date = toNull(vf_date);
  const safe_gonio_date = toNull(gonioscopy_date);
  const safe_topo_date = toNull(topography_date);
  const safe_ascan_date = toNull(ascan_date);
  const safe_bscan_date = toNull(bscan_date);
  const safe_pachy_date = toNull(pachymetry_date);
  const safe_fundus_date = toNull(fundus_photo_date);


  // ✅ Save interpretation & results into exam_sections
db.query(
  `UPDATE exam_sections SET
      -- Fundus Autofluorescence
      fa_type = ?, fa_date = ?, fa_reason = ?, fa_cooperation = ?, fa_reliability = ?, fa_findings_od = ?, fa_findings_os = ?,
      -- OCT
      oct_type = ?, oct_subtype = ?, oct_status = ?, oct_notes = ?,
      oct_date = ?, oct_reason = ?, oct_cooperation = ?, oct_reliability = ?, oct_findings_od = ?, oct_findings_os = ?,
      -- Visual Field
      vf_type = ?, vf_status = ?, vf_subtype = ?, vf_notes = ?,
      vf_date = ?, vf_reason = ?, vf_cooperation = ?, vf_reliability = ?, vf_findings_od = ?, vf_findings_os = ?,
      -- Gonioscopy
      gonioscopy_date = ?, gonioscopy_reason = ?, gonioscopy_cooperation = ?, gonioscopy_reliability = ?, gonioscopy_findings_od = ?, gonioscopy_findings_os = ?,
      -- Topography
      topography_date = ?, topography_reason = ?, topography_cooperation = ?, topography_reliability = ?, topography_findings_od = ?, topography_findings_os = ?,
      -- A-Scan
      ascan_date = ?, ascan_reason = ?, ascan_cooperation = ?, ascan_reliability = ?, ascan_findings_od = ?, ascan_findings_os = ?,
      -- B-Scan
      bscan_date = ?, bscan_reason = ?, bscan_cooperation = ?, bscan_reliability = ?, bscan_findings_od = ?, bscan_findings_os = ?,
      -- Pachymetry
      pachymetry_date = ?, pachymetry_reason = ?, pachymetry_cooperation = ?, pachymetry_reliability = ?, pachymetry_findings_od = ?, pachymetry_findings_os = ?,
      -- Fundus Photo
      fundus_photo_date = ?, fundus_photo_reason = ?, fundus_photo_cooperation = ?, fundus_photo_reliability = ?, fundus_photo_findings_od = ?, fundus_photo_findings_os = ?
   WHERE case_id = ?`,
  [
    // Fundus Autofluorescence
    fa_type, safe_fa_date, fa_reason, fa_cooperation, fa_reliability, fa_findings_od, fa_findings_os,
    // OCT
    oct_type, oct_subtype, oct_status, oct_notes,
    safe_oct_date, oct_reason, oct_cooperation, oct_reliability, oct_findings_od, oct_findings_os,
    // Visual Field
    vf_type, vf_status, vf_subtype, vf_notes,
    safe_vf_date, vf_reason, vf_cooperation, vf_reliability, vf_findings_od, vf_findings_os,
    // Gonioscopy
    safe_gonio_date, gonioscopy_reason, gonioscopy_cooperation, gonioscopy_reliability, gonioscopy_findings_od, gonioscopy_findings_os,
    // Topography
    safe_topo_date, topography_reason, topography_cooperation, topography_reliability, topography_findings_od, topography_findings_os,
    // A-Scan
    safe_ascan_date, ascan_reason, ascan_cooperation, ascan_reliability, ascan_findings_od, ascan_findings_os,
    // B-Scan
    safe_bscan_date, bscan_reason, bscan_cooperation, bscan_reliability, bscan_findings_od, bscan_findings_os,
    // Pachymetry
    safe_pachy_date, pachymetry_reason, pachymetry_cooperation, pachymetry_reliability, pachymetry_findings_od, pachymetry_findings_os,
    // Fundus Photo
    safe_fundus_date, fundus_photo_reason, fundus_photo_cooperation, fundus_photo_reliability, fundus_photo_findings_od, fundus_photo_findings_os,
    // Case link
    case_id
  ],
    (err) => {
      if (err) {
        console.error('❌ Error saving interpretations:', err);
        return res.status(500).send("Database error");
      }
      res.redirect(`/wizard/step6?case_id=${case_id}`);
    }
  );
});




// ======================
// Case Wizard - Step 6
// ======================
app.get('/wizard/step6', (req, res) => {
  res.sendFile(__dirname + '/public/wizard-step6.html');
});

app.post('/wizard/step6', (req, res) => {
  if (!req.session.user || req.session.user.role !== 'professor') {
    return res.status(403).send('❌ Unauthorized');
  }

  const { case_id, cpt_codes } = req.body;

  // ✅ Save up to 10 ICD10 + Plan pairs (allows partial entries)
  for (let i = 1; i <= 10; i++) {
    const icd10_code = req.body[`icd10_code_${i}`]?.trim();
    const plan = req.body[`plan_${i}`]?.trim();

    // Only insert if ICD-10 is provided
    if (icd10_code && icd10_code !== "") {
      db.query(
        `INSERT INTO assessment_plan (case_id, icd10_code, plan)
         VALUES (?, ?, ?)`,
        [case_id, icd10_code, plan || null],
        (err) => {
          if (err) console.error(`❌ Error saving ICD10 + Plan #${i}:`, err);
        }
      );
    }
  }

  // ✅ Save CPT codes (comma separated input)
  if (cpt_codes && cpt_codes.trim() !== "") {
    const codesArray = cpt_codes.split(",").map(c => c.trim());

    codesArray.forEach(code => {
      if (code) {
        db.query(
          `INSERT INTO codes (case_id, cpt_code) VALUES (?, ?)`,
          [case_id, code],
          (err) => {
            if (err) console.error("❌ Error saving CPT code:", err);
          }
        );
      }
    });
  }

  // ✅ Success popup (redirects after 3s)
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Case Completed</title>
      <link rel="stylesheet" href="/styles.css">
      <style>
        body {
          background-color: #f4f7fb;
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
        }
        .success-popup {
          background: #ffffff;
          padding: 40px;
          border-radius: 15px;
          box-shadow: 0 6px 20px rgba(0,0,0,0.2);
          text-align: center;
          max-width: 500px;
          width: 90%;
          border-top: 8px solid #115680;
        }
        .success-popup h2 {
          color: #115680;
          font-size: 28px;
          margin-bottom: 15px;
        }
        .success-popup p {
          font-size: 18px;
          color: #333;
          margin: 10px 0;
        }
        .loading-bar {
          margin: 20px auto 10px;
          width: 80%;
          height: 12px;
          border-radius: 6px;
          background: #eee;
          overflow: hidden;
        }
        .loading-bar span {
          display: block;
          height: 100%;
          width: 0%;
          background: linear-gradient(90deg, #115680, #fad739);
          animation: load 3s forwards;
        }
        @keyframes load {
          from { width: 0%; }
          to { width: 100%; }
        }
      </style>
      <script>
        setTimeout(() => {
          window.location.href = '/professor/dashboard';
        }, 3000);
      </script>
    </head>
    <body>
      <div class="success-popup">
        <h2>🎉 Case Completed!</h2>
        <p>The case has been fully uploaded and saved.</p>
        <div class="loading-bar"><span></span></div>
        <p>Redirecting you back to dashboard...</p>
      </div>
    </body>
    </html>
  `);
});


// ======================
// ✅ Performed Tests API
// ======================

// POST - save a performed test
app.post('/api/performed-tests', (req, res) => {
  const { case_id, kind, test } = req.body;

  // ensure user is logged in as student
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  if (!case_id || !kind || !test) {
    return res.status(400).json({ success: false, message: 'Missing fields' });
  }

  const sql = `
    INSERT INTO performed_tests (case_id, kind, test)
    VALUES (?, ?, ?)
  `;

  db.query(sql, [case_id, kind, test], (err) => {
    if (err) {
      console.error('❌ Error saving performed test:', err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json({ success: true });
  });
});


// GET - retrieve performed tests for a specific case
app.get('/api/performed-tests', (req, res) => {
  const { case_id } = req.query;

  if (!case_id) {
    return res.status(400).json({ success: false, message: 'Missing case_id' });
  }

  const sql = `
    SELECT kind, test, performed_at
    FROM performed_tests
    WHERE case_id = ?
    ORDER BY performed_at ASC
  `;

  db.query(sql, [case_id], (err, results) => {
    if (err) {
      console.error('❌ Error fetching performed tests:', err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json(results);
  });
});


// ======================
// ✅ Assessment Plan GET
// ======================
app.get('/api/assessment-plan', (req, res) => {
  const { case_id } = req.query;

  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }

  const sql = `
    SELECT id, icd10_code, assessment, plan, student_id, case_id
    FROM assessment_plan
    WHERE case_id = ? AND student_id = ?
    ORDER BY id ASC
  `;

  db.query(sql, [case_id, req.session.user.id], (err, results) => {
    if (err) {
      console.error('❌ Error fetching assessment_plan:', err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json(results);
  });
});


// ======================
// ✅ Interpretations GET
// ======================
app.get('/api/interpretations', (req, res) => {
  const { case_id } = req.query;

  if (!case_id) {
    return res.status(400).json({ success: false, message: 'Missing case_id' });
  }

  const sql = `
    SELECT interpretation_id AS id,
           test_type,
           subtype,
           date,
           reason,
           cooperation,
           findings_od,
           findings_os,
           interpretation
    FROM interpretations
    WHERE case_id = ?
    ORDER BY date ASC, test_type ASC
  `;

  db.query(sql, [case_id], (err, results) => {
    if (err) {
      console.error('❌ Error fetching interpretations:', err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json(results);
  });
});

// ✅ Return all per-test exam notes like section='exam:va', 'exam:posterior', etc.
app.get('/api/student-notes/exam-cards', (req, res) => {
  const { case_id } = req.query;
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.status(403).json({ success: false, message: 'Unauthorized' });
  }
  if (!case_id) {
    return res.status(400).json({ success: false, message: 'Missing case_id' });
  }
  const sql = `
    SELECT section, notes, submitted_at
    FROM student_notes
    WHERE case_id = ? AND student_id = ? AND section LIKE 'exam:%'
    ORDER BY submitted_at DESC
  `;
  db.query(sql, [case_id, req.session.user.id], (err, rows) => {
    if (err) {
      console.error('❌ Error fetching exam card notes:', err);
      return res.status(500).json({ success: false, message: err.sqlMessage });
    }
    res.json(rows);
  });
});

// ✅ Test route to check MySQL connection
app.get('/db-ping', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.status(200).json({ db: 'connected', result: rows[0] });
  } catch (e) {
    res.status(500).json({ db: 'error', code: e.code, message: e.message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

