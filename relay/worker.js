/**
 * Bridge Break relay — a Cloudflare Worker.
 *
 * Players without a token of their own still need to register, withdraw and
 * find partners, and every one of those is a comment on the tournament's page.
 * This posts those comments for them with one token that never leaves this
 * Worker. It will post only the handful of commands players use, built here
 * from checked fields — never text passed through as given — and signs each
 * one with a tag that only the player's own browser can produce.
 *
 * It also serves the tournament list to those players, through a short
 * cache, so a room full of people refreshing shares one allowance of requests
 * rather than each network spending its own small one.
 *
 * Settings (Workers → this Worker → Settings → Variables and Secrets):
 *   GITHUB_TOKEN     secret  fine-grained token: this repository only,
 *                            Issues read and write
 *   REPO             text    owner/name, e.g. ixm7/BTO
 *   ALLOWED_ORIGINS  text    comma-separated, e.g.
 *                            https://www.bridgebreak.org,https://bridgebreak.org
 */

const API = 'https://api.github.com';
/** Long enough to shield the token from a room full of refreshes, short enough not to be noticed. */
const CACHE_SECONDS = 15;
const SKILLS = ['Beginner', 'Intermediate', 'Advanced', 'Expert', 'World Class'];
const TAG_LENGTH = 20;
/** Best effort, per instance: a speed bump for a script, not a wall. */
const ACTIONS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;

/** The exact list and comment URLs the app asks for, so a write can clear them from the cache. */
const LIST_QUERY = '?state=all&per_page=100&sort=created&direction=desc';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('Origin') || '', env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      let res;
      if (request.method === 'GET' && url.pathname.startsWith('/repos/')) res = await read(url, env, ctx);
      else if (request.method === 'POST' && url.pathname === '/act') res = await act(request, url, env, ctx);
      else if (request.method === 'GET' && url.pathname === '/') res = json({ ok: true, repo: env.REPO });
      else res = json({ error: 'Not found' }, 404);
      return withHeaders(res, cors);
    } catch (e) {
      const status = e instanceof Refusal ? e.status : 500;
      return withHeaders(json({ error: e instanceof Refusal ? e.message : 'The relay ran into a problem.' }, status), cors);
    }
  },
};

class Refusal extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/* ------------------------------------------------------------- reading */

/** Only this repository's issues and their comments — nothing else on the account. */
function repoPath(env) {
  const [owner, repo] = String(env.REPO || '').split('/');
  if (!owner || !repo) throw new Refusal('The relay has no repository set.', 500);
  return { owner, repo, prefix: `/repos/${owner}/${repo}`.toLowerCase() };
}

async function read(url, env, ctx) {
  const { prefix } = repoPath(env);
  const path = url.pathname.toLowerCase();
  if (!path.startsWith(prefix)) throw new Refusal('Not found', 404);
  const rest = path.slice(prefix.length);
  if (!/^\/issues(\/\d+(\/comments)?)?$/.test(rest)) throw new Refusal('Not found', 404);

  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const upstream = await github(`${url.pathname}${url.search}`, env);
  const body = await upstream.text();
  const res = new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
    },
  });
  if (upstream.ok) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

function github(pathAndQuery, env, init = {}) {
  return fetch(`${API}${pathAndQuery}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'bridge-break-relay',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

/* -------------------------------------------------------------- acting */

const recent = new Map();

function throttle(ip) {
  const now = Date.now();
  const times = (recent.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (times.length >= ACTIONS_PER_WINDOW) throw new Refusal('Too many changes from here just now — try again in a few minutes.', 429);
  times.push(now);
  recent.set(ip, times);
}

async function act(request, url, env, ctx) {
  throttle(request.headers.get('CF-Connecting-IP') || 'unknown');

  let input;
  try { input = await request.json(); } catch { throw new Refusal('That request could not be read.'); }

  const issue = Number(input.issue);
  if (!Number.isInteger(issue) || issue < 1 || issue > 1e8) throw new Refusal('No such tournament.');
  if (input.act === 'repeat') return repeat(issue, url, env, ctx);
  const key = String(input.key || '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Refusal('This browser has no player key.');
  const name = clean(input.name, 40);
  if (!name) throw new Refusal('Set your name in Settings first.');

  const line = command(String(input.act || ''), input, name);
  const tag = await playerTag(key);

  /* Only an open tournament's page: the token can reach every issue in the
     repository, and this should not be how any of the others are written to. */
  const { owner, repo } = repoPath(env);
  const issueRes = await github(`/repos/${owner}/${repo}/issues/${issue}`, env);
  if (!issueRes.ok) throw new Refusal('No such tournament.', 404);
  const found = await issueRes.json();
  if (found.pull_request || !/<!--\s*bridge-tournament/.test(found.body || '')) throw new Refusal('No such tournament.', 404);
  if (found.state !== 'open') throw new Refusal('That tournament is over.', 409);

  /* The command a person reads on the page, then the signature the app reads. */
  const trailer = `<!-- player ${JSON.stringify({ t: tag, n: name })} -->`;
  const posted = await github(`/repos/${owner}/${repo}/issues/${issue}/comments`, env, {
    method: 'POST', body: JSON.stringify({ body: `${line}\n${trailer}` }),
  });
  if (!posted.ok) throw new Refusal(`The tournament page would not take that (error ${posted.status}).`, 502);

  /* So the person who just acted sees it straight away rather than in a few seconds. */
  ctx.waitUntil(forget(url.origin, owner, repo, issue));
  return json({ ok: true, tag });
}

/* ------------------------------------------------------- weekly series */

const META_RE = /<!--\s*bridge-tournament\s*([\s\S]*?)-->/;

/**
 * Put next week's copy of a weekly tournament on the list. Anybody's browser
 * may ask, so everything is checked here against GitHub itself: that it
 * repeats, that its start has passed, that the series has not been stopped,
 * and that next week's is not there already. Nothing in the request is used
 * but the issue number.
 */
async function repeat(issue, url, env, ctx) {
  const { owner, repo } = repoPath(env);
  const res = await github(`/repos/${owner}/${repo}/issues/${issue}`, env);
  if (!res.ok) throw new Refusal('No such tournament.', 404);
  const found = await res.json();
  const m = META_RE.exec(found.body || '');
  if (found.pull_request || !m) throw new Refusal('No such tournament.', 404);
  let meta;
  try { meta = JSON.parse(m[1]); } catch { throw new Refusal('No such tournament.', 404); }
  if (meta.repeat !== 'weekly') throw new Refusal('That tournament does not repeat.', 409);
  if (found.state === 'closed' && found.state_reason !== 'completed') throw new Refusal('That series has been stopped.', 409);
  const now = Date.now();
  if (!(now >= Date.parse(meta.startUtc))) throw new Refusal('Not due yet.', 409);
  const series = Number.isInteger(meta.seriesId) && meta.seriesId > 0 ? meta.seriesId : issue;

  /* Anything newer in the same series means this is not the one to copy. */
  const listRes = await github(`/repos/${owner}/${repo}/issues${LIST_QUERY}`, env);
  if (!listRes.ok) throw new Refusal('The tournament list could not be read.', 502);
  for (const other of await listRes.json()) {
    const om = META_RE.exec(other.body || '');
    if (!om || other.pull_request) continue;
    let o;
    try { o = JSON.parse(om[1]); } catch { continue; }
    const theirs = Number.isInteger(o.seriesId) && o.seriesId > 0 ? o.seriesId : other.number;
    if (theirs === series && String(o.startUtc) > String(meta.startUtc)) return json({ ok: true, number: other.number, existed: true });
  }

  const next = { ...meta, ...nextWeekly(meta, now), seriesId: series };
  const startRow = `| **Start** | ${next.start.replace('T', ' ')} (${next.timeZone}) — ${next.startUtc.slice(0, 16).replace('T', ' ')} UTC |`;
  const body = (found.body || '')
    .replace(/^\| \*\*Start\*\* \|.*$/m, startRow)
    .replace(META_RE, `<!-- bridge-tournament\n${JSON.stringify(next, null, 1)}\n-->`);
  const made = await github(`/repos/${owner}/${repo}/issues`, env, {
    method: 'POST', body: JSON.stringify({ title: found.title, body }),
  });
  if (!made.ok) throw new Refusal(`Next week's tournament could not be created (error ${made.status}).`, 502);
  const created = await made.json();
  ctx.waitUntil(forget(url.origin, owner, repo, created.number));
  return json({ ok: true, number: created.number });
}

/** Same wall-clock time, whole weeks on, after now — as the app works it out. */
export function nextWeekly(meta, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(meta.start));
  if (!m) throw new Refusal('That tournament has no start time.', 409);
  for (let weeks = 1; weeks < 1000; weeks++) {
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 7 * weeks));
    const start = `${day.toISOString().slice(0, 10)}T${m[4]}`;
    const at = zonedToUtc(start, String(meta.timeZone || 'UTC'));
    if (at.getTime() > now) return { start, startUtc: at.toISOString() };
  }
  throw new Refusal('No next date.', 409);
}

function zoneOffsetMinutes(d, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const x of fmt.formatToParts(d)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

function zonedToUtc(wall, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let utc = naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60000;
  utc = naive - zoneOffsetMinutes(new Date(utc), timeZone) * 60000;
  return new Date(utc);
}

/** The one line a player's action becomes. Built from checked fields only. */
function command(action, input, name) {
  const note = clean(input.note, 140);
  const target = String(input.target || '');
  const who = () => {
    if (!/^(~[0-9a-f]{20}|[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))$/.test(target)) throw new Refusal('No such player.');
    return target;
  };
  switch (action) {
    case 'register': {
      const pair = String(input.pair || '').trim();
      /* Long enough for the code the app makes when two players pair up: both
         ids, which for two GitHub usernames can run to nearly a hundred. */
      if (pair && !/^[A-Za-z0-9_-]{1,100}$/.test(pair)) throw new Refusal('That partner code is not one the relay can use.');
      const level = input.level ? SKILLS.find((x) => x.toLowerCase() === String(input.level).toLowerCase()) : '';
      if (input.level && !level) throw new Refusal('Unknown skill level.');
      return `/register ${name}${pair ? ` pair:${pair}` : ''}${level ? ` level:${level}` : ''}`;
    }
    case 'withdraw': return '/withdraw';
    case 'seek':
      if (/^cancel$/i.test(note)) throw new Refusal('That note would cancel rather than add you.');
      return `/seek-partner${note ? ` ${note}` : ''}`;
    case 'seek-cancel': return '/seek-partner cancel';
    case 'invite': return `/invite @${who()}${note ? ` ${note}` : ''}`;
    case 'invite-cancel': return `/invite-cancel @${who()}`;
    case 'accept': return `/accept @${who()}`;
    case 'decline': return `/decline @${who()}`;
    case 'unpair': return `/unpair @${who()}`;
    default: throw new Refusal('That is not something the relay does.');
  }
}

/**
 * Free text from a player, made safe to sit on one line of a comment: no line
 * breaks, nothing that reads as markup or a mention, and none of the words
 * the app reads as part of a command.
 */
function clean(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f<>@`]/g, ' ')
    .replace(/\b(pair|level|player):\S*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Clear what a write has made stale. Per data centre, which is the one this player uses. */
async function forget(origin, owner, repo, issue) {
  const cache = caches.default;
  const base = `${origin}/repos/${owner}/${repo}/issues`;
  const urls = [`${base}${LIST_QUERY}`, `${base}/${issue}`];
  for (let page = 1; page <= 5; page++) urls.push(`${base}/${issue}/comments?per_page=100&page=${page}`);
  await Promise.all(urls.map((u) => cache.delete(new Request(u, { method: 'GET' }))));
}

/* ------------------------------------------------------------ plumbing */

/** The player's public tag: derived from their private key, so only they can make it. */
export async function playerTag(key) {
  const bytes = new TextEncoder().encode(`bridgebreak:${key}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, TAG_LENGTH);
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || 'https://www.bridgebreak.org,https://bridgebreak.org')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ...(ok ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept, X-GitHub-Api-Version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function withHeaders(res, extra) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/* Exposed for the app's own tests; the Worker runtime ignores named exports. */
export const _test = { clean, command, Refusal };
