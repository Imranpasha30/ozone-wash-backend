const { sendError } = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  // PostgreSQL duplicate value
  if (err.code === '23505') {
    return sendError(res, 'A record with this value already exists.', 409);
  }

  // PostgreSQL foreign key violation
  if (err.code === '23503') {
    return sendError(res, 'Referenced record does not exist.', 400);
  }

  // Custom errors thrown from services like: throw { status: 400, message: '...' }
  if (err.status) {
    return sendError(res, err.message, err.status);
  }

  // Unknown server error
  return sendError(
    res,
    process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
    500
  );
};

// Called when no route matched
const notFound = (req, res) => {
  return sendError(res, `Route ${req.method} ${req.path} not found`, 404);
};

module.exports = { errorHandler, notFound };