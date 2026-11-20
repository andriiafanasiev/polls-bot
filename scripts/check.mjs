// Local helper: validate data/polls.json and preview what the Worker would post.
//   node scripts/check.mjs                                   – validate
//   NOW=2026-11-21T15:05:00+02:00 node scripts/check.mjs     – also show polls due at NOW

import { readFile } from 'node:fs/promises';
import { validate, duePolls, nextPoll, buildPayload } from '../src/core.js';

const polls = JSON.parse(await readFile(new URL('../data/polls.json', import.meta.url), 'utf8'));
const errors = validate(polls);

if (errors.length) {
  console.error('polls.json is invalid:\n' + errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`OK: ${polls.length} polls are valid`);

const { NOW, MAX_LATE_HOURS = '3' } = process.env;
if (NOW) {
  const now = new Date(NOW);
  const due = duePolls(polls, now, Number(MAX_LATE_HOURS) * 60 * 60 * 1000);
  if (!due.length) {
    const next = nextPoll(polls, now);
    console.log(`Nothing due at ${now.toISOString()}. Next: ${next ? `${next.id} at ${next.at}` : 'none'}`);
  }
  for (const p of due) {
    console.log(`Due ${p.id}:`, JSON.stringify(buildPayload(p, '@channel'), null, 2));
  }
}
