// Cloudflare Worker: posts due polls from data/polls.json to Telegram on a Cron Trigger.
//
// Bindings (see wrangler.toml):
//   POSTED              – KV namespace, key = poll id, value = ISO time it was posted
//   TELEGRAM_CHAT_ID    – var, e.g. "@andridev"
//   MAX_LATE_HOURS      – var, skip polls older than this (default 3)
// Secrets (wrangler secret put …):
//   TELEGRAM_BOT_TOKEN  – bot token from @BotFather
//   RUN_TOKEN           – protects POST /run (manual run)

import polls from '../data/polls.json';
import { validate, duePolls, nextPoll, buildPayload, sendPoll } from './core.js';

const errors = validate(polls);

async function run(env, { now = new Date(), maxLateHours, dryRun = false } = {}) {
  if (errors.length) throw new Error('polls.json is invalid:\n' + errors.join('\n'));

  const lateHours = Number(maxLateHours ?? env.MAX_LATE_HOURS ?? 3);
  const due = duePolls(polls, now, lateHours * 60 * 60 * 1000);
  const results = [];

  for (const p of due) {
    if (await env.POSTED.get(p.id)) continue;

    const payload = buildPayload(p, env.TELEGRAM_CHAT_ID);
    if (dryRun) {
      results.push({ id: p.id, status: 'dry-run', payload });
      continue;
    }
    try {
      await sendPoll(env.TELEGRAM_BOT_TOKEN, payload);
      await env.POSTED.put(p.id, new Date().toISOString());
      results.push({ id: p.id, status: 'posted' });
      console.log(`Posted ${p.id}: ${p.question.split('\n')[0]}`);
    } catch (err) {
      results.push({ id: p.id, status: 'error', error: err.message });
      console.error(`Failed ${p.id}: ${err.message}`);
    }
  }

  if (!results.length) console.log(`Nothing to post at ${now.toISOString()}`);
  return results;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { now: new Date(event.scheduledTime) }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // GET / – health check and what's next
    if (request.method === 'GET' && url.pathname === '/') {
      const next = nextPoll(polls, new Date());
      return json({
        ok: errors.length === 0,
        errors,
        total: polls.length,
        next: next && { id: next.id, at: next.at, type: next.type, question: next.question.split('\n')[0] },
      });
    }

    // POST /run – manual run. Query: ?dry=1, ?maxLate=8, ?now=ISO (dry runs only)
    if (request.method === 'POST' && url.pathname === '/run') {
      if (!env.RUN_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.RUN_TOKEN}`) {
        return json({ ok: false, error: 'unauthorized' }, 401);
      }
      const dryRun = url.searchParams.get('dry') === '1';
      const nowParam = url.searchParams.get('now');
      if (nowParam && !dryRun) return json({ ok: false, error: '"now" is only allowed with dry=1' }, 400);

      try {
        const results = await run(env, {
          dryRun,
          now: nowParam ? new Date(nowParam) : new Date(),
          maxLateHours: url.searchParams.get('maxLate') ?? undefined,
        });
        return json({ ok: true, results });
      } catch (err) {
        return json({ ok: false, error: err.message }, 500);
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
