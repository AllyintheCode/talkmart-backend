export function fail(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: code,
    message,
  });
}

export function ok(res, payload = {}, status = 200) {
  return res.status(status).json({
    success: true,
    ...payload,
  });
}
