const STRUCTURAL_CHARACTERS = /[<>&]/g;

const UNICODE_ESCAPE = Object.freeze({
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
});

// Auditor inputs are untrusted conversation data. Keep them inside one JSON value and
// make XML-like delimiter characters impossible so transcript text cannot close a prompt block.
export function serializeAuditorPromptData(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw new TypeError('auditor prompt data must be JSON serializable');
  }
  return json.replace(STRUCTURAL_CHARACTERS, (character) => UNICODE_ESCAPE[character]);
}

export function validateRecentContext(recentContext) {
  if (recentContext === undefined) return Object.freeze([]);
  if (!Array.isArray(recentContext) || recentContext.length === 0 || recentContext.length > 3) {
    throw new TypeError('recentContext must contain 1 to 3 turns');
  }
  let totalChars = 0;
  const turns = recentContext.map((turn) => {
    if (!turn || typeof turn !== 'object' || Array.isArray(turn) ||
      typeof turn.user !== 'string' || typeof turn.assistant !== 'string' ||
      turn.user.length > 2400 || turn.assistant.length > 2400) {
      throw new TypeError('recentContext contains an invalid turn');
    }
    totalChars += turn.user.length + turn.assistant.length;
    return Object.freeze({ user: turn.user, assistant: turn.assistant });
  });
  if (totalChars > 4000) {
    throw new TypeError('recentContext exceeds the character limit');
  }
  return Object.freeze(turns);
}
