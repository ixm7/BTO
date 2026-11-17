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
const SYSTEMS = ['sayc', '21', 'sayc+21', '21+sayc'];
/* Which page each kind of write belongs on; anything else is a tournament. */
const PAGE_FOR = { chat: 'bridge-lobby', unsay: 'bridge-lobby', pair: 'bridge-pairs' };
const CHAT_MAX = 150;
const PAIR_NOTE_MAX = 240;
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
      else if (request.method === 'POST' && url.pathname === '/lock') res = await makeLock(request, env);
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


/* ------------------------------------------------------------- passwords */

/*
 * A tournament can be shut to everybody but the people its director gives a
 * password to. What the page carries is not the password and not a hash of it
 * alone: it is a signature made with a secret only this relay holds, over a
 * salt it chose. So the page gives a reader nothing to guess against — there
 * is no checking a guess without the secret, and the only way to try one is
 * through here, where the rate limit is waiting.
 */
const LOCK_RE = /^v1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{20,88})$/;

function lockSecret(env) {
  const secret = String(env.LOCK_SECRET || '');
  /* Without it nothing can be checked, so nothing is let through: a gate that
     fails open is not a gate. */
  if (secret.length < 16) throw new Refusal('This relay cannot check tournament passwords. Ask the director to set LOCK_SECRET.', 503);
  return secret;
}

async function sign(secret, salt, password) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${salt}:${password}`));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The verifier for a password, with a salt of this relay's choosing. */
async function makeLock(request, env) {
  throttle(request.headers.get('CF-Connecting-IP') || 'unknown');
  let input;
  try { input = await request.json(); } catch { throw new Refusal('That request could not be read.'); }
  const key = String(input.key || '');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Refusal('This browser has no player key.');
  const password = String(input.pw || '');
  if (password.length < 4 || password.length > 128) throw new Refusal('A password must be between 4 and 128 characters.');
  const secret = lockSecret(env);
  /* The salt is never the caller's to choose: one that was could be used to
     try guesses against a verifier read off the page. */
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return json({ lock: `v1.${salt}.${await sign(secret, salt, password)}` });
}

/** Is this the password that tournament was shut with? */
async function unlocks(lock, password, env) {
  const m = LOCK_RE.exec(String(lock || ''));
  if (!m) return false;
  const want = m[2];
  const got = await sign(lockSecret(env), m[1], String(password || ''));
  /* Same length every time, so the comparison gives nothing away by how long
     it takes. */
  if (got.length !== want.length) return false;
  let same = 0;
  for (let i = 0; i < got.length; i++) same |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return same === 0;
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

  const tag = await playerTag(key);
  const line = command(String(input.act || ''), input, name, tag);

  /* Only the page this kind of write belongs on: the token can reach every
     issue in the repository, and this should not be how any of the others
     are written to. A tournament's page carries one marker, the lobby
     another, and a write meant for one is refused on the other. */
  const { owner, repo } = repoPath(env);
  const wants = PAGE_FOR[String(input.act || '')] || 'bridge-tournament';
  const issueRes = await github(`/repos/${owner}/${repo}/issues/${issue}`, env);
  if (!issueRes.ok) throw new Refusal('No such page.', 404);
  const found = await issueRes.json();
  if (found.pull_request || !new RegExp(`<!--\\s*${wants}`).test(found.body || '')) throw new Refusal('No such page.', 404);
  if (found.state !== 'open') throw new Refusal('That page is closed.', 409);

  /*
   * A tournament shut with a password takes one. Only registering is gated:
   * it is what decides who plays, and everything else here is done by people
   * already registered.
   */
  if (input.act === 'register') {
    const meta = (() => {
      const m = /<!--\s*bridge-tournament\s*([\s\S]*?)-->/.exec(found.body || '');
      try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
    })();
    if (meta && meta.lock) {
      if (!await unlocks(meta.lock, input.pw, env)) throw new Refusal('That is not the password for this tournament.', 403);
    }
  }

  /*
   * Taking back something said in the lobby. A player without a token cannot
   * delete anything themselves, so the relay does it for them — but only
   * their own message, which it tells by the mark their browser leaves on
   * everything it says, and only on the page they named.
   */
  if (input.act === 'unsay') {
    const id = Number(input.comment);
    if (!Number.isInteger(id) || id < 1 || id > 1e12) throw new Refusal('No such message.');
    const was = await github(`/repos/${owner}/${repo}/issues/comments/${id}`, env);
    if (!was.ok) throw new Refusal('No such message.', 404);
    const comment = await was.json();
    if (Number(String(comment.issue_url || '').split('/').pop()) !== issue) throw new Refusal('No such message.', 404);
    const mine = new RegExp(`<!--\\s*player\\s*\\{[^}]*"t"\\s*:\\s*"${tag}"`).test(comment.body || '');
    if (!mine) throw new Refusal('That message is not yours to delete.', 403);
    if (/<!--\s*pinned/.test(comment.body || '')) throw new Refusal('That message has been pinned.', 409);
    const gone = await github(`/repos/${owner}/${repo}/issues/comments/${id}`, env, { method: 'DELETE' });
    if (!gone.ok) throw new Refusal(`That message would not go (error ${gone.status}).`, 502);
    ctx.waitUntil(forget(url.origin, owner, repo, issue));
    return json({ ok: true, deleted: id });
  }

  /* A tournament has one result, and every browser that saw the last board
     scored offers one. The first is kept and the rest are told it is done,
     so the page is not filled with the same table over and over. */
  if (input.act === 'results' && await alreadyThere(owner, repo, issue, env, /<!--\s*bridge-results/)) return json({ ok: true, already: true });
  /* The hand records are the largest thing a tournament puts on its page and
     every browser that finishes offers them, so the same rule holds: one
     copy, and the rest are told it is done. */
  if (input.act === 'records' && await alreadyThere(owner, repo, issue, env, /<!--\s*bridge-records/)) return json({ ok: true, already: true });

  /* The command a person reads on the page, then the signature the app reads. */
  const trailer = `<!-- player ${JSON.stringify({ t: tag, n: name })} -->`;
  const posted = await github(`/repos/${owner}/${repo}/issues/${issue}/comments`, env, {
    method: 'POST', body: JSON.stringify({ body: `${line}\n${trailer}` }),
  });
  if (!posted.ok) throw new Refusal(`The tournament page would not take that (error ${posted.status}).`, 502);

  /* A tournament with its result on it is over, and an issue that says so can
     be told apart from one still being played without reading it through —
     which is what keeps a list of hundreds affordable. */
  if (input.act === 'results') {
    await github(`/repos/${owner}/${repo}/issues/${issue}`, env, {
      method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'completed' }),
    });
  }

  /* So the person who just acted sees it straight away rather than in a few seconds. */
  ctx.waitUntil(forget(url.origin, owner, repo, issue));
  return json({ ok: true, tag });
}

/** Is this already on the page? Used for the one-copy things: result, records. */
async function alreadyThere(owner, repo, issue, env, mark) {
  for (let page = 1; page <= 5; page++) {
    const res = await github(`/repos/${owner}/${repo}/issues/${issue}/comments?per_page=100&page=${page}`, env);
    if (!res.ok) return false;
    const batch = await res.json();
    if (batch.some((c) => mark.test(c.body || ''))) return true;
    if (batch.length < 100) return false;
  }
  return false;
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
function command(action, input, name, tag) {
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
      /* The bidding system or systems they prefer, as one of five words. */
      const sys = input.sys ? SYSTEMS.find((x) => x === String(input.sys).toLowerCase()) : '';
      if (input.sys && !sys) throw new Refusal('Unknown bidding system.');
      return `/register ${name}${pair ? ` pair:${pair}` : ''}${level ? ` level:${level}` : ''}${sys ? ` sys:${sys}` : ''}`;
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
    case 'pair': {
      /* A pair card is named by the two players in it, and only they may
         write it: the tag is what this browser has proved it is. */
      const key = String(input.pairKey || '').trim().toLowerCase();
      if (!/^[a-z0-9~_+-]{3,110}$/.test(key) || key.split('+').length !== 2) throw new Refusal('That is not a pair.');
      if (!key.split('+').includes(`~${tag}`)) throw new Refusal('A pair card can only be written by one of its two players.');
      const sys = String(input.sys || '').toLowerCase() === '21' ? '21' : 'sayc';
      /* Two pieces of their own prose, each under its own word, so that
         neither can be read as the other. */
      const over = clean(input.vs, PAIR_NOTE_MAX);
      const note = clean(input.note, PAIR_NOTE_MAX);
      return `/pair ${key} sys:${sys}${over ? ` vs:${over}` : ''}${note ? ` note:${note}` : ''}`;
    }
    case 'unsay': return '';
    case 'chat': {
      const said = clean(input.text, CHAT_MAX);
      if (!said) throw new Refusal('There was nothing to say.');
      return said;
    }
    case 'abandoned': return ABANDONED_BODY;
    case 'results': return resultsBody(input.results);
    case 'records': return recordsBody(input.records);
    default: throw new Refusal('That is not something the relay does.');
  }
}

const ABANDONED_BODY = ['/abandoned', '', 'Every table was left without a player, so this tournament was given up on.'].join('\n');

/* ------------------------------------------------------- the hand records */

/*
 * The hands a tournament played, so they outlive the browsers that played
 * them. It is a lot of numbers, and the relay writes none of it on trust:
 * every field is read back as the kind of thing it is meant to be, and the
 * body is built here rather than taken from the browser.
 *
 * The deal of a board is not written down — the seed deals it again for
 * anybody — unless the director brought the boards in a file, in which case
 * the file is the only copy there is.
 */
const DEAL_RE = /^[NESW]:[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*(?: [AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*\.[AKQJT2-9]*){3}$/;
/* "Pass" as the app writes it, and the short forms a file might use. */
const CALL_RE = /^(?:[1-7](?:[SHDCN]|NT)|P|PASS|X|DBL|XX|RDBL)(?:![^,]{0,80})?$/i;

function recordsBody(input) {
  if (!input || typeof input !== 'object') throw new Refusal('Those hand records could not be read.');
  const rounds = int(input.rounds, 1, 60, 'rounds');
  const bpr = int(input.boardsPerRound, 1, 60, 'boards a round');
  const tables = int(input.tables, 1, 200, 'tables');
  const seed = String(input.seed || '').slice(0, 80);
  if (!/^[\w .:+/-]{1,80}$/.test(seed)) throw new Refusal('Those hand records have no seed.');

  const pairs = Array.isArray(input.pairs) ? input.pairs : null;
  if (!pairs || pairs.length === 0 || pairs.length > 400) throw new Refusal('Those hand records have no pairs in them.');
  const names = pairs.map((p) => {
    const two = Array.isArray(p) ? p : [];
    return [clean(two[0], 60) || '?', clean(two[1], 60) || '?'];
  });

  const lines = Array.isArray(input.lines) ? input.lines : null;
  if (!lines || lines.length === 0 || lines.length > 4000) throw new Refusal('Those hand records have no boards in them.');
  const rows = lines.map((l) => {
    const row = {
      b: int(l && l.b, 1, rounds * bpr, 'board'),
      t: int(l && l.t, 0, tables - 1, 'table'),
      n: int(l && l.n, 0, names.length - 1, 'pair'),
      e: int(l && l.e, 0, names.length - 1, 'pair'),
      s: int(l && l.s, -10000, 10000, 'score'),
      r: clean(l && l.r, 40),
    };
    const auction = String((l && l.a) || '').slice(0, 600);
    if (auction) {
      const calls = auction.split(',');
      if (calls.length > 80 || !calls.every((c) => CALL_RE.test(c))) throw new Refusal('That bidding could not be read.');
      row.a = calls.join(',');
    }
    return row;
  });

  const given = Array.isArray(input.deals) ? input.deals.slice(0, rounds * bpr) : [];
  const deals = given.filter((d) => typeof d === 'string' && DEAL_RE.test(d));
  if (deals.length !== given.length) throw new Refusal('One of those boards is not a deal.');

  const r = {
    v: 1, seed, rounds, boardsPerRound: bpr, tables,
    ...(input.scoring === 'imps' ? { scoring: 'imps' } : {}),
    ...(deals.length ? { deals } : {}),
    pairs: names, lines: rows,
  };
  /* A page holds one comment of 65,536 characters. The browser drops the
     bidding before it sends anything this large, so a payload that still does
     not fit is one to refuse rather than to have GitHub refuse for us. */
  if (JSON.stringify(r).length > 62000) throw new Refusal('Those hand records are too large for one page.');
  const boards = new Set(rows.map((x) => x.b)).size;
  return [
    `### Hand records \u2014 ${boards} board(s), ${tables} table(s)`,
    '',
    'Every board of this tournament: the deal, the bidding at each table and what it scored. '
      + 'Open the tournament on the site to read them.',
    '',
    `<!-- bridge-records\n${JSON.stringify(r)}\n-->`,
  ].join('\n');
}

/* --------------------------------------------------------- the result */

const int = (x, lo, hi, what) => {
  const n = Number(x);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Refusal(`That result makes no sense (${what}).`);
  return n;
};
const num = (x, lo, hi, what) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n < lo || n > hi) throw new Refusal(`That result makes no sense (${what}).`);
  return Math.round(n * 100) / 100;
};
const imps = (n) => {
  const r = Math.round(Number(n) * 100) / 100;
  const body = Math.abs(r).toFixed(2).replace(/\.?0+$/, '');
  return r > 0 ? `+${body}` : r < 0 ? `\u2212${body}` : '0';
};

/**
 * The result of a tournament, as the page carries it: a table for a person to
 * read and the same thing as data underneath. Every number is checked and the
 * comment is built here, so what a player's browser sends is a result and not
 * a comment of its own choosing.
 */
function resultsBody(input) {
  if (!input || typeof input !== 'object') throw new Refusal('That result could not be read.');
  const rows = Array.isArray(input.rankings) ? input.rankings : null;
  if (!rows || rows.length === 0 || rows.length > 128) throw new Refusal('That result has no standings in it.');
  const byImps = input.scoring === 'imps';
  const r = {
    v: 1,
    ...(byImps ? { scoring: 'imps' } : {}),
    finishedAt: new Date().toISOString(),
    tables: int(input.tables, 1, 500, 'tables'),
    boards: int(input.boards, 1, 500, 'boards'),
    rankings: rows.map((x) => {
      const players = clean(x && x.players, 120);
      if (!players) throw new Refusal('That result has a pair without names.');
      const direction = x.direction === 'EW' ? 'EW' : 'NS';
      return {
        rank: int(x.rank, 1, 999, 'rank'), players, direction,
        percent: num(x.percent, 0, 100, 'percentage'),
        matchpoints: num(x.matchpoints, 0, 1e6, 'matchpoints'),
        maxMatchpoints: num(x.maxMatchpoints, 0, 1e6, 'matchpoints'),
        ...(byImps ? { imps: num(x.imps, -1e4, 1e4, 'IMPs') } : {}),
      };
    }),
  };
  return [
    `### Final results — ${r.tables} table(s), ${r.boards} board(s)`,
    '',
    ...(byImps ? [
      '| Rank | Pair | Dir | IMPs |',
      '|---:|---|:-:|---:|',
      ...r.rankings.map((x) => `| ${x.rank} | ${x.players} | ${x.direction} | ${imps(x.imps)} |`),
    ] : [
      '| Rank | Pair | Dir | Score | MP |',
      '|---:|---|:-:|---:|---:|',
      ...r.rankings.map((x) => `| ${x.rank} | ${x.players} | ${x.direction} | ${x.percent.toFixed(2)}% | ${x.matchpoints}/${x.maxMatchpoints} |`),
    ]),
    '',
    `<!-- bridge-results\n${JSON.stringify(r)}\n-->`,
  ].join('\n');
}

/**
 * Free text from a player, made safe to sit on one line of a comment: no line
 * breaks, nothing that reads as markup or a mention, and none of the words
 * the app reads as part of a command.
 */
function clean(text, max) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f<>@`|]/g, ' ')
    .replace(/\b(pair|level|sys|vs|note|player):\S*/gi, ' ')
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
  /* A repository with hundreds of tournaments is read a page at a time, and
     every page of it is now out of date. */
  for (let page = 2; page <= 5; page++) urls.push(`${base}${LIST_QUERY}&page=${page}`);
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
