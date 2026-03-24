const express = require('express');
const { R2Service, upload } = require('../services/r2.service');
const { authenticate } = require('../middleware/auth.middleware');
const { sendSuccess, sendError } = require('../utils/response');

const router = express.Router();

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
 *     summary: Upload a compliance photo
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               folder:
 *                 type: string
 *                 example: "compliance"
 *     responses:
 *       200:
 *         description: File uploaded successfully
 *
 * /upload/document:
 *   post:
 *     summary: Upload a document (PDF)
 *     tags: [Upload]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Document uploaded successfully
 */

// Upload single photo
router.post('/photo',
  authenticate,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return sendError(res, 'No file provided', 400);
      }

      const folder = req.body.folder || 'compliance';
      const result = await R2Service.uploadFile(
        req.file.buffer,
        req.file.originalname,
        folder
      );

      return sendSuccess(res, {
        url: result.url,
        key: result.key,
        size: req.file.size,
        mimetype: req.file.mimetype,
      }, 'File uploaded successfully');
    } catch (err) {
      next(err);
    }
  }
);

// Upload document
router.post('/document',
  authenticate,
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) {
        return sendError(res, 'No file provided', 400);
      }

      const result = await R2Service.uploadFile(
        req.file.buffer,
        req.file.originalname,
        'documents'
      );

      return sendSuccess(res, {
        url: result.url,
        key: result.key,
      }, 'Document uploaded successfully');
    } catch (err) {
      next(err);
    }
  }
);

// Upload multiple photos at once (for compliance steps)
router.post('/photos',
  authenticate,
  upload.array('files', 5),
  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        return sendError(res, 'No files provided', 400);
      }

      const folder = req.body.folder || 'compliance';
      const uploads = await Promise.all(
        req.files.map(file =>
          R2Service.uploadFile(file.buffer, file.originalname, folder)
        )
      );

      return sendSuccess(res, {
        files: uploads,
        count: uploads.length,
      }, 'Files uploaded successfully');
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;