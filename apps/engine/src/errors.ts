/**
 * Errors people can act on: a stable code (listed in docs/user-guide.md, Troubleshooting), a message
 * saying what went wrong, and a hint saying how to fix it. The API returns them as
 * { error, code, hint } and the dashboard shows both.
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export const appError = (code: string, message: string, status = 400, hint?: string) => new AppError(code, message, status, hint);

const has = (e: unknown, ...codes: string[]) => {
  const c = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
  return !!c && codes.includes(c);
};

/**
 * Turns a low-level failure into an AppError with a code and a fix, or returns null when it isn't one
 * of the known kinds (the caller keeps its own message then).
 */
export function classify(e: unknown, what = 'Maestro'): AppError | null {
  if (e instanceof AppError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (has(e, 'ENOSPC') || /SQLITE_FULL|database or disk is full|no space left/i.test(msg)) {
    return appError('disk_full', 'The disk is full, so Maestro could not save.', 507, 'Free some space (old worktrees: Runs tab → Remove finished worktrees; Docker: docker system prune), then try again.');
  }
  if (has(e, 'EACCES', 'EPERM') || /permission denied|EACCES/i.test(msg)) {
    return appError('permission_denied', `Maestro may not read or write a file it needs (${msg.replace(/^.*?(EACCES|EPERM):?\s*/i, '')}).`, 500, 'In Docker, check that MAESTRO_UID/MAESTRO_GID in .env match the owner of your data and projects folders.');
  }
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return appError('db_busy', 'The database is busy with another program.', 503, 'Make sure only one Maestro engine uses this data folder (not Docker and a host engine at once), then retry.');
  }
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|malformed|file is not a database/i.test(msg)) {
    return appError('db_corrupt', 'The database file is damaged.', 500, 'Stop Maestro and restore a backup of maestro.db (see the user guide, Backups).');
  }
  if (has(e, 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EHOSTUNREACH') || /fetch failed|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(msg)) {
    return appError('unreachable', `${what} could not be reached.`, 502, 'Check that the service is running and that its address is right. In Docker, localhost means the container: use host.docker.internal or host networking.');
  }
  if (/No answer within \d+ seconds|timed? ?out|ETIMEDOUT/i.test(msg)) {
    return appError('timeout', `${what} did not answer in time.`, 504, 'It may be overloaded or a large local model may still be loading. Try again in a moment.');
  }
  return null;
}

/** What an AI provider's HTTP error means, as an AppError. */
export function providerError(name: string, status: number, body: string, model?: string): AppError {
  const text = body.slice(0, 300);
  if (status === 401 || status === 403) return appError('provider_auth', `${name} refused the API key (${status}).`, 502, `Check the key for ${name} in Settings → AI providers.`);
  if (status === 404 || /model .*not found|unknown model|does not exist/i.test(text)) {
    return appError('model_not_found', `${name} doesn't have the model${model ? ` "${model}"` : ''}.`, 502, model && /ollama|11434/i.test(name + text) ? `Run "ollama pull ${model}" or pick another model in Settings.` : 'Pick a model the provider lists in Settings → AI providers.');
  }
  if (status === 429) return appError('rate_limited', `${name} is rate-limiting requests.`, 503, 'Wait a minute, lower "Tickets worked on at once" in Settings, or use another provider.');
  if (/context|too long|maximum.*tokens|exceeds/i.test(text) && status === 400) {
    return appError('context_too_long', `The request is too long for ${name}${model ? ` (${model})` : ''}.`, 502, 'Use a model with a larger context, raise its context size (Ollama: num_ctx), or split the ticket into smaller ones.');
  }
  if (/tool/i.test(text) && status === 400) return appError('tools_unsupported', `${name}: this model does not support tool calling.`, 502, 'Workers need a model with tool calling (for example qwen3-coder or gpt-oss); pick one in Settings.');
  if (status >= 500) return appError('provider_unavailable', `${name} had an internal error (${status}).`, 502, 'Try again shortly; if it keeps failing, check the provider\'s own logs.');
  return appError('provider_rejected', `${name} refused the request (${status}): ${text}`, 502);
}
