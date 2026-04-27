/**
 * Upload routes — write to Cloudflare R2 via `services/r2Storage.js`.
 *
 * The caller sends multipart/form-data with a single `photo` (or `file`) field
 * plus a `folder` discriminator. Based on the discriminator and the supplied
 * `jobId` / `phone` / `certId`, we pick the right key builder so files land
 * in a predictable place inside the shared bucket.
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');

const {
  uploadBuffer,
  buildJobKey,
  buildCustomerKey,
  buildCertKey,
} = require('../services/r2Storage');
const { authenticate } = require('../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response');

const router = express.Router();

// ── Multer config ─────────────────────────────────────────────────────────────
// memoryStorage keeps the file in RAM as a Buffer — perfect for streaming
// straight to R2 with no temp files on disk.

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB hard cap
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_IMAGE_EXT  = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 5 },
  fileFilter: (_req, file, cb) => {
    const ext  = path.extname(file.originalname || '').toLowerCase();
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_IMAGE_EXT.has(ext) || !ALLOWED_IMAGE_MIME.has(mime)) {
      return cb(new Error('Only JPEG / PNG / WebP images are allowed.'));
    }
    cb(null, true);
  },
});

// ── Key resolution ────────────────────────────────────────────────────────────
// Decides which key builder to use based on what the caller provided. The
// order is intentional: explicit ids win, then we fall back to a generic
// folder bucket so old callers keep working.

function resolveKey({ folder, jobId, phone, certId, originalName }) {
  if (jobId) {
    // `folder` doubles as the phase tag (before / after / incident / compliance-step-3 / livestream-thumbnail)
    return buildJobKey({
      jobId,
      phase: folder || 'misc',
      filename: originalName,
    });
  }
  if (certId) {
    return buildCertKey({ certId, filename: originalName });
  }
  if (phone) {
    return buildCustomerKey({
      phone,
      kind: folder || 'misc',
      filename: originalName,
    });
  }
  // Generic fallback — keep legacy `folder` semantics
  const safeFolder = String(folder || 'misc').replace(/[^a-zA-Z0-9_-]/g, '-');
  const safeName = (originalName || `file-${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `misc/${safeFolder}/${Date.now()}-${safeName}`;
}

/**
 * @swagger
 * tags:
 *   name: Upload
 *   description: File upload to Cloudflare R2
 */

/**
 * @swagger
 * /upload/photo:
 *   post:
 *     summary: Upload a single image to R2
 *     description: |
 *       Multipart upload. Send the file under `photo` (preferred) or `file`.
 *       Provide either `jobId`, `phone`, or `certId` so we can route the file
 *       to the right folder. `folder` doubles as the phase tag for jobs
 *       (`before`, `after`, `incident`, `compliance-step-3`, `livestream-thumbnail`, …).
 *     tags: [Upload]
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               photo:    { type: string, format: binary }
 *               file:     { type: string, format: binary }
 *               folder:   { type: string, example: "before" }
 *               jobId:    { type: string, format: uuid }
 *               phone:    { type: string, example: "+919999999999" }
 *               certId:   { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Uploaded successfully — returns url and key
 *       400:
 *         description: Missing or invalid file
 */
router.post(
  '/photo',
  authenticate,
  // Accept either `photo` (new) or `file` (legacy) field name.
  imageUpload.fields([{ name: 'photo', maxCount: 1 }, { name: 'file', maxCount: 1 }]),
  async (req, res, next) => {
    try {
      const file = req.files?.photo?.[0] || req.files?.file?.[0];
      if (!file) return sendError(res, 'No photo provided. Use the `photo` field.', 400);

      const folder = req.body.folder || req.query.folder;
      const jobId  = req.body.jobId  || req.query.jobId;
      const phone  = req.body.phone  || req.query.phone;
      const certId = req.body.certId || req.query.certId;

      const key = resolveKey({ folder, jobId, phone, certId, originalName: file.originalname });
      const result = await uploadBuffer(file.buffer, { key, contentType: file.mimetype });

      return sendSuccess(res, {
        url: result.publicUrl,
        key: result.key,
        size: file.size,
        mimetype: file.mimetype,
      }, 'File uploaded successfully');
    } catch (err) {
      next(err);
    }
  }
);

/**
 * @swagger
 * /upload/photos:
 *   post:
 *     summary: Upload up to 5 images at once
 *     tags: [Upload]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Returns array of uploaded files with url and key
 */
router.post(
  '/photos',
  authenticate,
  imageUpload.array('photos', 5),
  async (req, res, next) => {
    try {
      const files = req.files;
      if (!files || files.length === 0) {
        return sendError(res, 'No photos provided. Use the `photos` field.', 400);
      }

      const folder = req.body.folder || req.query.folder;
      const jobId  = req.body.jobId  || req.query.jobId;
      const phone  = req.body.phone  || req.query.phone;
      const certId = req.body.certId || req.query.certId;

      const uploads = await Promise.all(
        files.map(async (f) => {
          const key = resolveKey({ folder, jobId, phone, certId, originalName: f.originalname });
          const r = await uploadBuffer(f.buffer, { key, contentType: f.mimetype });
          return { url: r.publicUrl, key: r.key, size: f.size, mimetype: f.mimetype };
        })
      );

      return sendSuccess(res, { files: uploads, count: uploads.length }, 'Files uploaded successfully');
    } catch (err) {
      next(err);
    }
  }
);

// ── Multer error handler (file too large, wrong type) ────────────────────────
router.use((err, _req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return sendError(res, 'File too large. Max 5 MB.', 413);
    }
    return sendError(res, err.message, 400);
  }
  if (err && /allowed/i.test(err.message)) {
    return sendError(res, err.message, 400);
  }
  next(err);
});

module.exports = router;
