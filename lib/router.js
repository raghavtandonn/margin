import express from 'express';

// Express 4 does not forward rejected async handlers to error middleware.
// Wrap handlers when registering them so a validation/database rejection is
// contained to its request instead of becoming a process-wide rejection.
export function Router(...options) {
  const router = express.Router(...options);
  const wrap = handler => {
    if (Array.isArray(handler)) return handler.map(wrap);
    if (typeof handler !== 'function' || handler.length === 4 || handler.stack) return handler;
    return function guarded(req, res, next) {
      try { Promise.resolve(handler(req, res, next)).catch(next); }
      catch (error) { next(error); }
    };
  };
  for (const method of ['use', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']) {
    const register = router[method].bind(router);
    router[method] = (...args) => register(...args.map(wrap));
  }
  return router;
}
