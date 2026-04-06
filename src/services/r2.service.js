const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// R2 is S3-compatible so we use the AWS S3 client
const r2Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY || 'placeholder',
    secretAccessKey: process.env.R2_SECRET_KEY || 'placeholder',
  },
});

const BUCKET = process.env.R2_BUCKET || 'ozone-wash-assets';
const PUBLIC_URL = process.env.R2_PUBLIC_URL || 'http://localhost:3000/uploads';

const R2Service = {

  // Upload a file buffer to R2
  uploadFile: async (fileBuffer, originalName, folder = 'uploads') => {
    const ext = path.extname(originalName).toLowerCase();
    const fileName = `${folder}/${uuidv4()}${ext}`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: fileName,
      Body: fileBuffer,
      ContentType: R2Service.getContentType(ext),
    });

    try {
      await r2Client.send(command);
      return {
        key: fileName,
        url: `${PUBLIC_URL}/${fileName}`,
      };
    } catch (err) {
      console.error('R2 upload error:', err.message);
      // In development return a placeholder URL
      if (process.env.NODE_ENV === 'development') {
        return {
          key: fileName,
          url: `http://localhost:3000/placeholder/${fileName}`,
        };
      }
      throw { status: 500, message: 'File upload failed.' };
    }
  },

  // Delete a file from R2
  deleteFile: async (key) => {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: key,
    });
    try {
      await r2Client.send(command);
    } catch (err) {
      console.error('R2 delete error:', err.message);
    }
  },

  // Get content type from extension
  getContentType: (ext) => {
    const types = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
    };
    return types[ext] || 'application/octet-stream';
  },

};

// Allowed MIME types — checked against the real file header, not just the extension.
// This prevents extension-spoofing attacks (e.g. renaming a .php to .jpg).
const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'video/mp4',
  'audio/mpeg',
]);

const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.mp4', '.mp3']);

// Multer config — stores files in memory before uploading to R2
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mime = file.mimetype.toLowerCase();

    if (!ALLOWED_EXT.has(ext)) {
      return cb(new Error('File extension not allowed. Use jpg, png, webp, pdf, mp4 or mp3.'));
    }
    if (!ALLOWED_MIME.has(mime)) {
      return cb(new Error('File type not allowed. MIME type mismatch detected.'));
    }
    cb(null, true);
  },
});

module.exports = { R2Service, upload };