export class AuditorBackendError extends Error {
  constructor(code, message, {
    backend = 'unknown',
    stage = 'unknown',
    diagnostics = null,
    cause = null,
  } = {}) {
    super(message);
    this.name = 'AuditorBackendError';
    this.code = code;
    this.backend = backend;
    this.stage = stage;
    if (diagnostics !== null) this.diagnostics = diagnostics;
    if (cause !== null) this.cause = cause;
  }
}
