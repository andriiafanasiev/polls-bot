// Posts due polls/quizzes from data/polls.json to a Telegram channel.
// Env:
//   TELEGRAM_BOT_TOKEN  – bot token from @BotFather (required unless DRY_RUN=1)
//   TELEGRAM_CHAT_ID    – "@andridev" or numeric chat id (required unless DRY_RUN=1)
//   DRY_RUN=1           – print what would be sent, don't call Telegram, don't save state
//   NOW                 – ISO date to fake "current time" (for testing)
//   MAX_LATE_HOURS      – skip polls that are older than this (default 3)
//   CHECK_ONLY=1        – only validate polls.json and exit

import { readFile, writeFile } from 'node:fs/promises';

const POLLS_FILE = new URL('../data/polls.json', import.meta.url);
const STATE_FILE = new URL('../data/posted.json', import.meta.url);

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  DRY_RUN,
  NOW,
  MAX_LATE_HOURS = '3',
  CHECK_ONLY,
} = process.env;

const isDry = DRY_RUN === '1';
const now = NOW ? new Date(NOW) : new Date();
const maxLateMs = Number(MAX_LATE_HOURS) * 60 * 60 * 1000;

// Telegram Bot API limits for sendPoll
const LIMITS = { question: 300, option: 100, explanation: 200, minOptions: 2, maxOptions: 10 };

function validate(polls) {
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

    if (!Array.isArray(p.options) || p.options.length < LIMITS.minOptions || p.options.length > LIMITS.maxOptions)
      errors.push(`${tag} needs ${LIMITS.minOptions}–${LIMITS.maxOptions} options`);
    else
      p.options.forEach((o, i) => {
        if (typeof o !== 'string' || !o.length || o.length > LIMITS.option)
          errors.push(`${tag} option ${i + 1} must be a 1–${LIMITS.option} char string`);
      });

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

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function sendPoll(p) {
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    question: p.question,
    options: p.options.map((text) => ({ text })),
    type: p.type,
    is_anonymous: true, // channel polls are always anonymous
  };
  if (p.type === 'quiz') {
    body.correct_option_id = p.correct;
    if (p.explanation) body.explanation = p.explanation;
  }

  if (isDry) {
    console.log(`[dry-run] would send ${p.id}:`, JSON.stringify(body, null, 2));
    return;
  }

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPoll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(`Telegram API ${res.status}: ${data.description ?? 'unknown error'}`);
  }
}

async function main() {
  const polls = await readJson(POLLS_FILE, []);
  const errors = validate(polls);
  if (errors.length) {
    console.error('polls.json is invalid:\n' + errors.map((e) => '  - ' + e).join('\n'));
    process.exit(1);
  }
  if (CHECK_ONLY === '1') {
    console.log(`OK: ${polls.length} polls are valid`);
    return;
  }

  if (!isDry && (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID)) {
    console.error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or run with DRY_RUN=1)');
    process.exit(1);
  }

  const posted = new Set(await readJson(STATE_FILE, []));
  const due = polls
    .filter((p) => !posted.has(p.id))
    .filter((p) => {
      const at = new Date(p.at).getTime();
      return at <= now.getTime() && now.getTime() - at <= maxLateMs;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const missed = polls.filter(
    (p) => !posted.has(p.id) && now.getTime() - Date.parse(p.at) > maxLateMs,
  );
  if (missed.length) {
    console.warn(`Skipping ${missed.length} poll(s) older than ${MAX_LATE_HOURS}h: ${missed.map((p) => p.id).join(', ')}`);
  }

  if (!due.length) {
    console.log(`Nothing to post at ${now.toISOString()}`);
    return;
  }

  let failed = false;
  for (const p of due) {
    try {
      await sendPoll(p);
      posted.add(p.id);
      console.log(`${isDry ? '[dry-run] ok' : 'Posted'} ${p.id}: ${p.question.split('\n')[0]}`);
    } catch (err) {
      failed = true;
      console.error(`Failed ${p.id}: ${err.message}`);
    }
  }

  if (!isDry) {
    await writeFile(STATE_FILE, JSON.stringify([...posted].sort(), null, 2) + '\n');
  }
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
