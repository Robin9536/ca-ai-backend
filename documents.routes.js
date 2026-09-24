const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { query } = require('../db/pool');
const { asyncRoute, HttpError } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const uploadDir = process.env.UPLOAD_DIR || './uploads';
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`),
});
const upload = multer({
  storage,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
    cb(null, allowed.includes(file.mimetype));
  },
});

async function getOwnBusinessId(userId) {
  const { rows } = await query('SELECT id FROM business_profiles WHERE user_id = $1', [userId]);
  if (!rows.length) throw new HttpError(404, 'Business profile not found');
  return rows[0].id;
}

// GET /api/documents
router.get('/', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const { rows } = await query(
    `SELECT d.*, e.vendor, e.amount_paise, e.tax_paise, e.extracted_date, e.confirmed_at
     FROM documents d
     LEFT JOIN document_extractions e ON e.document_id = d.id
     WHERE d.business_id = $1 ORDER BY d.created_at DESC LIMIT 100`,
    [businessId]
  );
  res.json(rows);
}));

// POST /api/documents  (multipart/form-data, field name "file")
router.post('/', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a PDF, JPG or PNG file as "file"');
  const businessId = await getOwnBusinessId(req.user.id);

  const { rows } = await query(
    `INSERT INTO documents (business_id, uploaded_by, original_name, storage_path, mime_type, size_bytes, doc_type, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'processing') RETURNING *`,
    [businessId, req.user.id, req.file.originalname, req.file.path, req.file.mimetype, req.file.size, req.body.docType || 'other']
  );
  const doc = rows[0];

  // NOTE: actual OCR / structured extraction is not implemented here — it needs
  // a real document-AI provider (e.g. Textract, Document AI, or a vision-capable
  // LLM call) wired in with its own credentials. This endpoint stores the file
  // and leaves the document in "processing" status so a worker can pick it up.
  // For now we flag it back to "needs_review" so a human can enter values manually.
  await query(`UPDATE documents SET status = 'needs_review' WHERE id = $1`, [doc.id]);

  res.status(201).json({ ...doc, status: 'needs_review' });
}));

// PATCH /api/documents/:id/extraction — human (or future OCR worker) submits reviewed fields
router.patch('/:id/extraction', asyncRoute(async (req, res) => {
  const businessId = await getOwnBusinessId(req.user.id);
  const doc = await query('SELECT id FROM documents WHERE id = $1 AND business_id = $2', [req.params.id, businessId]);
  if (!doc.rows.length) throw new HttpError(404, 'Document not found');

  const { vendor, invoiceNumber, extractedDate, amountPaise, taxPaise, category } = req.body;

  const { rows } = await query(
    `INSERT INTO document_extractions (document_id, vendor, invoice_number, extracted_date, amount_paise, tax_paise, category, confirmed_by, confirmed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (document_id) DO UPDATE SET
       vendor = EXCLUDED.vendor, invoice_number = EXCLUDED.invoice_number,
       extracted_date = EXCLUDED.extracted_date, amount_paise = EXCLUDED.amount_paise,
       tax_paise = EXCLUDED.tax_paise, category = EXCLUDED.category,
       confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()
     RETURNING *`,
    [req.params.id, vendor, invoiceNumber, extractedDate, amountPaise, taxPaise, category, req.user.id]
  );
  await query(`UPDATE documents SET status = 'reviewed' WHERE id = $1`, [req.params.id]);
  res.json(rows[0]);
}));

module.exports = router;
