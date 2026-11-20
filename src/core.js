// Shared logic used by the Cloudflare Worker and the local CLI.

// Telegram Bot API limits for sendPoll
export const LIMITS = { question: 300, option: 100, explanation: 200, minOptions: 2, maxOptions: 10 };

export function validate(polls) {
  const errors = [];
  const ids = new Set();

  for (const p of polls) {
    const tag = `[${p.id}]`;
    if (!p.id) errors.push(`${tag} missing id`);
    if (ids.has(p.id)) errors.push(`${tag} duplicate id`);
    ids.add(p.id);

    if (Number.isNaN(Date.parse(p.at))) errors.push(`${tag} invalid "at": ${p.at}`);
    if (!['quiz', 'regular'].includes(p.type)) errors.push(`${tag} type must be "quiz" or "regular"`);

    if (!p.question || p.question.length > LIMITS.question)
      errors.push(`${tag} question must be 1–${LIMITS.question} chars (now ${p.question?.length ?? 0})`);

    if (!Array.isArray(p.options) || p.options.length < LIMITS.minOptions || p.options.length > LIMITS.maxOptions) {
      errors.push(`${tag} needs ${LIMITS.minOptions}–${LIMITS.maxOptions} options`);
    } else {
      p.options.forEach((o, i) => {
        if (typeof o !== 'string' || !o.length || o.length > LIMITS.option)
          errors.push(`${tag} option ${i + 1} must be a 1–${LIMITS.option} char string`);
      });
    }

    if (p.type === 'quiz') {
      if (!Number.isInteger(p.correct) || p.correct < 0 || p.correct >= (p.options?.length ?? 0))
        errors.push(`${tag} "correct" must be a valid option index (0-based)`);
      if (p.explanation) {
        if (p.explanation.length > LIMITS.explanation)
          errors.push(`${tag} explanation is ${p.explanation.length} chars, max ${LIMITS.explanation}`);
        if ((p.explanation.match(/\n/g) ?? []).length > 2)
          errors.push(`${tag} explanation may contain at most 2 line breaks`);
      }
    }
  }
  return errors;
}

/** Polls whose time has come, but not more than `maxLateMs` ago. Oldest first. */
export function duePolls(polls, now, maxLateMs) {
  const t = now.getTime();
  return polls
    .filter((p) => {
      const at = Date.parse(p.at);
      return at <= t && t - at <= maxLateMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Next poll after `now`, or null. */
export function nextPoll(polls, now) {
  const t = now.getTime();
  return (
    polls
      .filter((p) => Date.parse(p.at) > t)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] ?? null
  );
}

export function buildPayload(p, chatId) {
  const body = {
    chat_id: chatId,
    question: p.question,
    options: p.options.map((text) => ({ text })),
    type: p.type,
    is_anonymous: true, // channel polls are always anonymous
  };
  if (p.type === 'quiz') {
    body.correct_option_id = p.correct;
    if (p.explanation) body.explanation = p.explanation;
  }
  return body;
}

export async function sendPoll(token, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPoll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API ${res.status}: ${data.description ?? 'unknown error'}`);
  }
  return data.result;
}
