'use strict';

class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
const notFound = (message) => new AppError(404, 'NOT_FOUND', message);
const conflict = (code, message, details) => new AppError(409, code, message, details);

module.exports = { AppError, badRequest, notFound, conflict };
