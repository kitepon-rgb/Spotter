import { hasRuntimeErrorReceipt, observeRuntimeError } from './runtime-error-store.mjs';

async function main() {
  if (process.env.SPOTTER_RUNTIME_ERROR_WORKER !== '1' || process.argv.length !== 5) process.exit(2);
  const action = process.argv[2];
  const value = process.argv[3];
  if (action !== 'observe' && action !== 'receipt') process.exit(2);
  let options;
  try {
    const encoded = process.argv[4];
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 16_384) process.exit(2);
    options = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    process.exit(2);
  }
  const allowed = action === 'observe'
    ? new Set(['configPath', 'storePath', 'productVersion', 'platform', 'arch', 'beforeOpenDelayMs', 'observationId'])
    : new Set(['configPath', 'storePath', 'productVersion', 'platform', 'arch', 'observationId', 'expectedFingerprint', 'waitMs']);
  const required = new Set(['configPath', 'storePath', 'productVersion', 'platform', 'arch', 'observationId']);
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => !allowed.has(key))
    || [...required].some((key) => !Object.hasOwn(options, key))
    || (options.configPath !== null && (typeof options.configPath !== 'string' || options.configPath.length > 4_096))
    || typeof options.storePath !== 'string' || options.storePath.length < 1 || options.storePath.length > 4_096
    || typeof options.productVersion !== 'string' || options.productVersion.length < 1 || options.productVersion.length > 64
    || typeof options.platform !== 'string' || !/^[a-z0-9_-]{1,32}$/.test(options.platform)
    || typeof options.arch !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(options.arch)
    || typeof options.observationId !== 'string' || !/^[a-f0-9]{32}$/.test(options.observationId)
    || (action === 'receipt' && (typeof options.expectedFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/.test(options.expectedFingerprint)
      || !Number.isSafeInteger(options.waitMs) || options.waitMs < 10 || options.waitMs > 10_000))
    || ('beforeOpenDelayMs' in options
      && (!Number.isSafeInteger(options.beforeOpenDelayMs) || options.beforeOpenDelayMs < 0 || options.beforeOpenDelayMs > 10_000))) process.exit(2);
  try {
    if (action === 'receipt') {
      if (value !== options.observationId) process.exit(2);
      const deadline = Date.now() + options.waitMs;
      do {
        if (await hasRuntimeErrorReceipt(value, options.expectedFingerprint, options)) process.exit(0);
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      process.exit(11);
    }
    const result = await observeRuntimeError(value, options);
    process.exit(result.collected ? 0 : 10);
  } catch {
    process.exit(1);
  }
}

main();
