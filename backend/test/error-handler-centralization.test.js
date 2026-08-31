import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

const createApp = (middleware) => {
  const app = express();
  app.use((req, _res, next) => {
    req.traceId = 'trace-123';
    req.headers['x-request-id'] = 'corr-456';
    next();
  });
  app.use(middleware);
  return app;
};

test('error handler promotes the request correlation id and strips stack data from responses', async () => {
  const { errorHandler } = await import('../src/middleware/errorHandler.ts');
  const app = createApp((req, _res, next) => {
    next(new Error('Sensitive DB password=secret123'));
  });
  app.use(errorHandler);

  const res = await request(app).get('/');
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, 'INTERNAL_ERROR');
  assert.equal(res.body.error.message, 'Internal server error');
  assert.equal(res.body.error.requestId, 'corr-456');
  assert.equal(res.body.error.traceId, 'trace-123');
  assert.equal(res.body.error.details, undefined);
  assert.equal(res.body.error.stack, undefined);
  assert.equal(res.body.stack, undefined);
});

test('api errors preserve a safe public message and keep their mapped error code', async () => {
  const { errorHandler } = await import('../src/middleware/errorHandler.ts');
  const { ApiError } = await import('../src/utils/errors.ts');
  const { ErrorCode } = await import('../src/types/index.ts');

  const app = createApp((req, _res, next) => {
    next(
      new ApiError(
        400,
        ErrorCode.VALIDATION_ERROR,
        'Invalid vote payload',
        { field: 'proof', reason: 'malformed' },
      ),
    );
  });
  app.use(errorHandler);

  const res = await request(app).get('/');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error.code, ErrorCode.VALIDATION_ERROR);
  assert.equal(res.body.error.message, 'Invalid vote payload');
  assert.equal(res.body.error.requestId, 'corr-456');
  assert.ok(res.body.error.details);
  assert.equal(res.body.error.traceId, 'trace-123');
});
