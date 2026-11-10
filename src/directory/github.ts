/**
 * The tournament directory lives in the Issues of a public GitHub repository.
 *
 *   one issue            = one tournament (the issue author is the director)
 *   "/register Name"     = a comment that registers the commenter
 *   "/withdraw"          = a comment that withdraws them
 *   results comment      = final rankings, after which the issue is closed
 *
 * Reading needs no login. Writing either uses a GitHub token the user pastes
 * in, or falls back to opening a pre-filled page on github.com.
 */
import { zonedToUtc } from './time';

export const LEVELS = ['Open', 'Novice', 'Intermediate', 'Advanced', 'Expert'] as const;
export type Level = (typeof LEVELS)[number];

export interface TournamentMeta {
  v: 1;
  name: string;
  /** Display name of the initiator / tournament director. */
  director: string;
  scoring: 'matchpoints';
  /** Wall-clock start in `timeZone`, e.g. "2026-11-21T19:30". */
  start: string;
  timeZone: string;
  /** The same instant in UTC (ISO 8601). */
  startUtc: string;
  level: Level;
  /** Maximum number of players. */
  capacity: number;
  boardsPerRound: number;
  rounds: number;
  /**
   * How many seconds a player may keep the table waiting before a robot takes
   * their seat. Absent on tournaments created before the setting existed,
   * which fall back to DEFAULT_IDLE_SEC.
   */
  idleTimeoutSec?: number;
}

/** The inactivity limit used when a tournament does not name one. */
export const DEFAULT_IDLE_SEC = 60;
/** Below this there is no time to think, so the director may not go lower. */
export const MIN_IDLE_SEC = 20;
export const MAX_IDLE_SEC = 900;

export interface Registration {
  login: string;
  name: string;
  pairCode?: string;
  at: string;
}

export interface ResultRow {
  rank: number;
  players: string;
  direction: 'NS' | 'EW';
  percent: number;
  matchpoints: number;
  maxMatchpoints: number;
}

export interface TournamentResults {
  v: 1;
  finishedAt: string;
  tables: number;
  boards: number;
  rankings: ResultRow[];
}

export type Status = 'upcoming' | 'in progress' | 'finished' | 'cancelled' | 'aborted';

/** Someone who has put themselves on the "looking for a partner" list for this tournament. */
export interface PartnerSeeker {
  login: string;
  note?: string;
  at: string;
}

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'unpaired';

/** A partner invitation from one GitHub login to another, scoped to one tournament. */
export interface Invitation {
  from: string;
  to: string;
  note?: string;
  status: InviteStatus;
  at: string;
}

export interface PartnersData {
  seekers: PartnerSeeker[];
  invitations: Invitation[];
}

export interface Listing {
  number: number;
  url: string;
  meta: TournamentMeta;
  /** GitHub login of the issue author. */
  initiatorLogin: string;
  status: Status;
  /** Null when comments could not be read (e.g. rate limit). */
  registrations: Registration[] | null;
  results: TournamentResults | null;
  partners: PartnersData | null;
  /** Peer-to-peer room name for this tournament. */
  roomId: string;
  /** GitHub's global id for the issue; needed to delete it. */
  nodeId?: string;
}

export interface Repo { owner: string; repo: string }

export function parseRepo(s: string): Repo {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s.trim());
  if (!m) throw new Error('Repository must look like "owner/name"');
  return { owner: m[1] as string, repo: m[2] as string };
}

/* ---------------------------------------------------------------- parsing */

const META_RE = /<!--\s*bridge-tournament\s*([\s\S]*?)-->/;
const RESULTS_RE = /<!--\s*bridge-results\s*([\s\S]*?)-->/;

export function makeMeta(input: Omit<TournamentMeta, 'v' | 'scoring' | 'startUtc'>): TournamentMeta {
  const name = input.name.trim();
  if (!name) throw new Error('Tournament name is required');
  if (!input.director.trim()) throw new Error('Director name is required');
  if (!LEVELS.includes(input.level)) throw new Error('Unknown player level');
  if (!Number.isInteger(input.capacity) || input.capacity < 4 || input.capacity > 200) throw new Error('Capacity must be between 4 and 200 players');
  if (!Number.isInteger(input.boardsPerRound) || input.boardsPerRound < 1 || input.boardsPerRound > 8) throw new Error('Boards per round must be 1-8');
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20) throw new Error('Rounds must be 1-20');
  const idle = input.idleTimeoutSec;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < MIN_IDLE_SEC || idle > MAX_IDLE_SEC)) {
    throw new Error(`Inactivity timeout must be between ${MIN_IDLE_SEC} and ${MAX_IDLE_SEC} seconds`);
  }
  const startUtc = zonedToUtc(input.start, input.timeZone).toISOString();
  return { v: 1, scoring: 'matchpoints', ...input, name, director: input.director.trim(), startUtc };
}

/** The tournament's inactivity limit in seconds, defaulted for older entries. */
export const idleSecOf = (meta: TournamentMeta): number => meta.idleTimeoutSec ?? DEFAULT_IDLE_SEC;

export function issueBody(meta: TournamentMeta): string {
  return [
    '### ♠ ♥ Bridge tournament ♦ ♣',
    '',
    '| | |',
    '|---|---|',
    `| **Director** | ${meta.director} |`,
    '| **Scoring** | Matchpoints |',
    `| **Start** | ${meta.start.replace('T', ' ')} (${meta.timeZone}) — ${meta.startUtc.slice(0, 16).replace('T', ' ')} UTC |`,
    `| **Level** | ${meta.level} |`,
    `| **Capacity** | ${meta.capacity} players |`,
    `| **Format** | ${meta.rounds} round(s) × ${meta.boardsPerRound} board(s) |`,
    `| **Inactivity limit** | ${idleSecOf(meta)} seconds, then a robot takes the seat |`,
    '',
    'To register, add a comment containing `/register Your Name` (optionally followed by `pair:CODE` — two players using the same code are partnered).',
    'To withdraw, comment `/withdraw`.',
    '',
    'Looking for a partner? Comment `/seek-partner` (an optional note after it is fine), or `/seek-partner cancel` to leave that list.',
    'To invite someone from that list: `/invite @their-username`. They accept with `/accept @your-username` or decline with `/decline @your-username`.',
    'Accepting registers you both automatically. Either of you can comment `/unpair @their-username` to split up again.',
    '',
    `<!-- bridge-tournament\n${JSON.stringify(meta, null, 1)}\n-->`,
  ].join('\n');
}

export function parseMeta(body: string | null | undefined): TournamentMeta | null {
  const m = META_RE.exec(body ?? '');
  if (!m) return null;
  try {
    const j = JSON.parse(m[1] as string) as Partial<TournamentMeta>;
    if (j.v !== 1 || typeof j.name !== 'string' || typeof j.startUtc !== 'string' || Number.isNaN(Date.parse(j.startUtc))) return null;
    return {
      v: 1, name: j.name, director: String(j.director ?? ''), scoring: 'matchpoints',
      start: String(j.start ?? j.startUtc.slice(0, 16)), timeZone: String(j.timeZone ?? 'UTC'), startUtc: j.startUtc,
      level: LEVELS.includes(j.level as Level) ? (j.level as Level) : 'Open',
      capacity: Number(j.capacity) || 0, boardsPerRound: Number(j.boardsPerRound) || 2, rounds: Number(j.rounds) || 2,
      /* The issue body can be edited by hand on GitHub, so an out-of-range
         limit is pulled back into range rather than failing the whole entry. */
      ...(Number.isFinite(Number(j.idleTimeoutSec))
        ? { idleTimeoutSec: Math.min(MAX_IDLE_SEC, Math.max(MIN_IDLE_SEC, Math.round(Number(j.idleTimeoutSec)))) }
        : {}),
    };
  } catch { return null; }
}

export interface RawComment { user: { login: string } | null; body: string | null; created_at: string }

/** Fold the comment stream into the current registration list (each user's latest command wins). */
export function parseRegistrations(comments: readonly RawComment[]): Registration[] {
  const reg = new Map<string, Registration>();
  for (const c of comments) {
    const login = c.user?.login;
    if (!login) continue;
    for (const line of (c.body ?? '').split(/\r?\n/)) {
      const t = line.trim();
      if (/^\/withdraw\b/i.test(t)) { reg.delete(login); continue; }
      const m = /^\/register\b(.*)$/i.exec(t);
      if (!m) continue;
      let rest = (m[1] as string).trim();
      let pairCode: string | undefined;
      const pm = /\bpair:\s*(\S+)\s*$/i.exec(rest);
      if (pm) { pairCode = pm[1]; rest = rest.slice(0, pm.index).trim(); }
      const prev = reg.get(login);
      reg.set(login, { login, name: rest || login, ...(pairCode ? { pairCode } : {}), at: prev?.at ?? c.created_at });
    }
  }
  return [...reg.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Fold the comment stream into the current "looking for a partner" list and
 * invitation statuses. Commands (each a line of its own, case-insensitive):
 *   /seek-partner <note?>     join (or update your note on) the list
 *   /seek-partner cancel      leave the list
 *   /invite @login <note?>    invite that person to partner with you
 *   /invite-cancel @login     withdraw an invitation you sent, while pending
 *   /accept @login            accept an invitation you received from them
 *   /decline @login           decline an invitation you received from them
 *   /unpair @login            break up an accepted partnership with them
 * The latest command wins for seekers; for an (inviter, invitee) pair, each
 * new /invite starts a fresh pending invitation, superseding any old status.
 */
export function parsePartners(comments: readonly RawComment[]): PartnersData {
  const seekers = new Map<string, PartnerSeeker>();
  const invitations = new Map<string, Invitation>();
  for (const c of comments) {
    const login = c.user?.login;
    if (!login) continue;
    for (const rawLine of (c.body ?? '').split(/\r?\n/)) {
      const t = rawLine.trim();
      let m: RegExpExecArray | null;
      if ((m = /^\/seek-partner\b(.*)$/i.exec(t))) {
        const rest = (m[1] as string).trim();
        if (/^cancel$/i.test(rest)) seekers.delete(login.toLowerCase());
        else seekers.set(login.toLowerCase(), { login, note: rest || undefined, at: c.created_at });
        continue;
      }
      // A login never contains '.', ',', ':', ';' or '!', so excluding them from the
      // captured username (rather than trimming afterwards) keeps a trailing mark
      // like "@bob." from either breaking the match or leaking into the note.
      if ((m = /^\/invite\s+@?([^\s.,:;!]+)[.,:;!]*(?:\s+(.*))?$/i.exec(t))) {
        const to = m[1] as string;
        if (to.toLowerCase() === login.toLowerCase()) continue; // can't invite yourself
        const note = (m[2] as string | undefined)?.trim() || undefined;
        invitations.set(`${login.toLowerCase()}->${to.toLowerCase()}`, { from: login, to, note, status: 'pending', at: c.created_at });
        continue;
      }
      if ((m = /^\/invite-cancel\s+@?([^\s.,:;!]+)[.,:;!]*\s*$/i.exec(t))) {
        const key = `${login.toLowerCase()}->${(m[1] as string).toLowerCase()}`;
        const cur = invitations.get(key);
        if (cur && cur.status === 'pending') invitations.set(key, { ...cur, status: 'cancelled', at: c.created_at });
        continue;
      }
      if ((m = /^\/(accept|decline)\s+@?([^\s.,:;!]+)[.,:;!]*\s*$/i.exec(t))) {
        const key = `${(m[2] as string).toLowerCase()}->${login.toLowerCase()}`;
        const cur = invitations.get(key);
        if (cur && cur.status === 'pending') invitations.set(key, { ...cur, status: (m[1] as string).toLowerCase() === 'accept' ? 'accepted' : 'declined', at: c.created_at });
        continue;
      }
      // Either side of an accepted partnership can break it up; the invitation may have
      // been accepted in either direction, so check both keys for the one that's live.
      if ((m = /^\/unpair\s+@?([^\s.,:;!]+)[.,:;!]*\s*$/i.exec(t))) {
        const other = (m[1] as string).toLowerCase();
        const keyA = `${login.toLowerCase()}->${other}`;
        const keyB = `${other}->${login.toLowerCase()}`;
        const key = invitations.get(keyA)?.status === 'accepted' ? keyA : keyB;
        const cur = invitations.get(key);
        if (cur && cur.status === 'accepted') invitations.set(key, { ...cur, status: 'unpaired', at: c.created_at });
        continue;
      }
    }
  }
  return {
    seekers: [...seekers.values()].sort((a, b) => a.at.localeCompare(b.at)),
    invitations: [...invitations.values()].sort((a, b) => a.at.localeCompare(b.at)),
  };
}

/** A deterministic partner code for a tournament, shared by exactly these two logins once they accept. */
export function inviteCode(issueNumber: number, loginA: string, loginB: string): string {
  const pair = [loginA, loginB].map((s) => s.toLowerCase()).sort().join('-');
  return `inv-${issueNumber}-${pair}`.replace(/[^a-z0-9-]/gi, '');
}

export function parseResults(comments: readonly RawComment[]): TournamentResults | null {
  for (const c of comments) {
    const m = RESULTS_RE.exec(c.body ?? '');
    if (!m) continue;
    try {
      const j = JSON.parse(m[1] as string) as TournamentResults;
      if (j.v === 1 && Array.isArray(j.rankings)) return j;
    } catch { /* keep looking */ }
  }
  return null;
}

export function resultsBody(r: TournamentResults): string {
  return [
    `### Final results — ${r.tables} table(s), ${r.boards} board(s)`,
    '',
    '| Rank | Pair | Dir | Score | MP |',
    '|---:|---|:-:|---:|---:|',
    ...r.rankings.map((x) => `| ${x.rank} | ${x.players} | ${x.direction} | ${x.percent.toFixed(2)}% | ${x.matchpoints}/${x.maxMatchpoints} |`),
    '',
    `<!-- bridge-results\n${JSON.stringify(r)}\n-->`,
  ].join('\n');
}

/**
 * How long a tournament could plausibly still be running: a generous ten
 * minutes a board, plus an hour for a late start and slow play. Past that with
 * no results posted, nobody finished it.
 */
export function playingWindowMs(meta: TournamentMeta): number {
  const boards = Math.max(1, meta.rounds * meta.boardsPerRound);
  return boards * 10 * 60 * 1000 + 3600 * 1000;
}

/** How long a played-out tournament stays on the list before it is dropped. */
export const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;

/**
 * What belongs on the tournament list. One that was abandoned is of no use to
 * anybody and goes at once; one that was played stays a week so the results
 * can be read, then goes too. Nothing is deleted on GitHub: the issue is still
 * there to be opened directly, this only decides what the list shows.
 */
export function visibleInList(l: { status: Status; meta: TournamentMeta }, now: number): boolean {
  if (l.status === 'aborted') return false;
  if (l.status === 'finished') return now - Date.parse(l.meta.startUtc) < KEEP_FINISHED_MS;
  return true;
}

export function deriveStatus(meta: TournamentMeta, issue: { state: string; state_reason?: string | null }, results: TournamentResults | null, now: number): Status {
  if (results) return 'finished';
  if (issue.state === 'closed') return issue.state_reason === 'completed' ? 'finished' : 'cancelled';
  const start = Date.parse(meta.startUtc);
  if (now < start) return 'upcoming';
  /* It began, but no result was ever posted: it ran out of players or was
     abandoned part-way. Either way it is not still in progress. */
  return now < start + playingWindowMs(meta) ? 'in progress' : 'aborted';
}

/* -------------------------------------------------------------------- API */

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; cache?: RequestCache }) => Promise<{
  ok: boolean; status: number; json(): Promise<unknown>; headers: { get(name: string): string | null };
}>;

interface RawIssue {
  number: number; title: string; body: string | null; html_url: string; state: string; state_reason?: string | null;
  comments: number; user: { login: string } | null; pull_request?: unknown;
  /** Needed to delete the issue, which only the GraphQL API can do. */
  node_id?: string;
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class Directory {
  readonly repo: Repo;
  constructor(repo: string | Repo, private token: string | null = null, private fetcher: FetchLike = (u, i) => fetch(u, i)) {
    this.repo = typeof repo === 'string' ? parseRepo(repo) : repo;
  }

  get canWrite(): boolean { return !!this.token; }
  get slug(): string { return `${this.repo.owner}/${this.repo.repo}`; }
  private api(path: string): string { return `https://api.github.com/repos/${this.repo.owner}/${this.repo.repo}${path}`; }
  roomId(number: number): string { return `${this.slug}#${number}`; }

  private async req<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // GitHub's API responses are often cacheable for ~60s; without this, a refresh
    // run right after a write (e.g. registering) can be served a stale listing
    // straight from the browser's HTTP cache instead of hitting the network.
    const res = await this.fetcher(url, { method, headers, cache: 'no-store', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (!res.ok) {
      const limited = res.status === 403 || res.status === 429 ? res.headers.get('x-ratelimit-remaining') === '0' : false;
      let detail = '';
      try { detail = String(((await res.json()) as { message?: string }).message ?? ''); } catch { /* no body */ }
      throw new GitHubError(
        limited ? 'GitHub rate limit reached. Add a token in Settings (5,000 requests/hour) or try again later.'
          : res.status === 401 ? 'GitHub rejected the token.'
          : res.status === 404 ? `Not found on GitHub (${this.slug}). Check the repository name and that it is public.`
          : `GitHub error ${res.status}${detail ? `: ${detail}` : ''}`,
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  /** GitHub login of the token owner. */
  async whoAmI(): Promise<string> {
    if (!this.token) throw new Error('No GitHub token set');
    return (await this.req<{ login: string }>('https://api.github.com/user')).login;
  }

  private async comments(number: number): Promise<RawComment[]> {
    const all: RawComment[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.req<RawComment[]>(this.api(`/issues/${number}/comments?per_page=100&page=${page}`));
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  }

  private async toListing(issue: RawIssue, meta: TournamentMeta, now: number): Promise<Listing> {
    let registrations: Registration[] | null = [];
    let results: TournamentResults | null = null;
    let partners: PartnersData | null = { seekers: [], invitations: [] };
    if (issue.comments > 0) {
      try {
        const cs = await this.comments(issue.number);
        registrations = parseRegistrations(cs);
        // Only the director or a registered player can publish results.
        const trusted = new Set([issue.user?.login, ...registrations.map((r) => r.login)]);
        results = parseResults(cs.filter((c) => trusted.has(c.user?.login)));
        partners = parsePartners(cs);
      } catch { registrations = null; partners = null; }
    }
    return {
      number: issue.number, url: issue.html_url, meta, initiatorLogin: issue.user?.login ?? '',
      status: deriveStatus(meta, issue, results, now), registrations, results, partners, roomId: this.roomId(issue.number),
      ...(issue.node_id ? { nodeId: issue.node_id } : {}),
    };
  }

  /** All tournaments in the repository, soonest upcoming first, then past ones newest first. */
  async list(now: number = Date.now()): Promise<Listing[]> {
    const issues = await this.req<RawIssue[]>(this.api('/issues?state=all&per_page=100&sort=created&direction=desc'));
    const found: { issue: RawIssue; meta: TournamentMeta }[] = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const meta = parseMeta(issue.body);
      if (meta) found.push({ issue, meta });
    }
    const out = await Promise.all(found.map(({ issue, meta }) => this.toListing(issue, meta, now)));
    /* Remember what was left off the list so it can be swept away later; the
       caller decides whether to, and the next listing recomputes this anyway. */
    this.abandoned = out.filter((l) => l.status === 'aborted');
    /* Newest first, so what is still to come is at the top of the page. */
    return out.filter((l) => visibleInList(l, now))
      .sort((a, b) => Date.parse(b.meta.startUtc) - Date.parse(a.meta.startUtc));
  }

  /** Abandoned tournaments found by the last `list()`, ready to be removed. */
  abandoned: Listing[] = [];

  /**
   * Remove an abandoned tournament for good. Deleting an issue is a GraphQL-only
   * operation and needs admin rights on the repository, so where that is refused
   * this falls back to closing the issue as not planned — which takes it off
   * GitHub's own default view as well as ours.
   */
  async remove(l: Listing): Promise<'deleted' | 'closed'> {
    if (!this.token) throw new Error('No GitHub token set');
    if (l.results) throw new Error('That tournament has results and will not be removed');
    if (l.nodeId) {
      try {
        const r = await this.req<{ errors?: { message: string }[] }>(
          'https://api.github.com/graphql', 'POST',
          { query: 'mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}', variables: { id: l.nodeId } },
        );
        if (!r.errors?.length) return 'deleted';
      } catch { /* no admin rights, or GraphQL unavailable to this token */ }
    }
    await this.req(this.api(`/issues/${l.number}`), 'PATCH', { state: 'closed', state_reason: 'not_planned' });
    return 'closed';
  }

  /**
   * Clear away every abandoned tournament the last listing turned up. Returns
   * what became of each. A failure on one is reported and the rest go on, so a
   * single stubborn issue cannot block the sweep.
   */
  async sweepAbandoned(): Promise<{ number: number; name: string; outcome: 'deleted' | 'closed' | 'failed' }[]> {
    const done: { number: number; name: string; outcome: 'deleted' | 'closed' | 'failed' }[] = [];
    for (const l of this.abandoned) {
      try { done.push({ number: l.number, name: l.meta.name, outcome: await this.remove(l) }); }
      catch { done.push({ number: l.number, name: l.meta.name, outcome: 'failed' }); }
    }
    this.abandoned = [];
    return done;
  }

  async get(number: number, now: number = Date.now()): Promise<Listing> {
    const issue = await this.req<RawIssue>(this.api(`/issues/${number}`));
    const meta = parseMeta(issue.body);
    if (!meta) throw new Error('That issue is not a bridge tournament');
    return this.toListing(issue, meta, now);
  }

  /** Create a tournament with the API (needs a token). Returns the new issue number. */
  async create(meta: TournamentMeta): Promise<number> {
    if (!this.token) throw new Error('A GitHub token is needed to create a tournament from here');
    const issue = await this.req<RawIssue>(this.api('/issues'), 'POST', { title: `🂡 ${meta.name}`, body: issueBody(meta) });
    return issue.number;
  }

  /** Without a token: a github.com page with the tournament pre-filled; the user just presses "Submit". */
  newIssueUrl(meta: TournamentMeta): string {
    const q = new URLSearchParams({ title: `🂡 ${meta.name}`, body: issueBody(meta) });
    return `https://github.com/${this.slug}/issues/new?${q.toString()}`;
  }

  issueUrl(number: number): string { return `https://github.com/${this.slug}/issues/${number}`; }

  // `async` here matters beyond style: it guarantees that throwing (e.g. "no
  // token set") always produces a rejected promise, even though register(),
  // withdraw() and the partner-list methods below are plain (non-async)
  // functions that just return this.comment(...)'s result — without this,
  // calling one of them with no token would throw synchronously instead.
  private async comment(number: number, body: string): Promise<unknown> {
    if (!this.token) throw new Error('A GitHub token is needed for this');
    return this.req(this.api(`/issues/${number}/comments`), 'POST', { body });
  }

  register(number: number, name: string, pairCode?: string): Promise<unknown> {
    const clean = name.replace(/[\r\n]/g, ' ').trim();
    const code = pairCode?.trim().replace(/\s+/g, '-');
    return this.comment(number, `/register ${clean}${code ? ` pair:${code}` : ''}`);
  }

  withdraw(number: number): Promise<unknown> { return this.comment(number, '/withdraw'); }

  /** Join (or update your note on) the "looking for a partner" list for this tournament. */
  seekPartner(number: number, note?: string): Promise<unknown> {
    const clean = (note ?? '').replace(/[\r\n]/g, ' ').trim();
    return this.comment(number, `/seek-partner${clean ? ` ${clean}` : ''}`);
  }

  cancelSeekingPartner(number: number): Promise<unknown> { return this.comment(number, '/seek-partner cancel'); }

  invitePartner(number: number, toLogin: string, note?: string): Promise<unknown> {
    const clean = (note ?? '').replace(/[\r\n]/g, ' ').trim();
    return this.comment(number, `/invite @${toLogin}${clean ? ` ${clean}` : ''}`);
  }

  cancelInvite(number: number, toLogin: string): Promise<unknown> { return this.comment(number, `/invite-cancel @${toLogin}`); }

  /** Respond to an invitation you received from `fromLogin`. */
  respondToInvite(number: number, fromLogin: string, accept: boolean): Promise<unknown> {
    return this.comment(number, `${accept ? '/accept' : '/decline'} @${fromLogin}`);
  }

  /** Break up an already-accepted partnership with `otherLogin` (either side may call this). */
  unpair(number: number, otherLogin: string): Promise<unknown> { return this.comment(number, `/unpair @${otherLogin}`); }

  /** Post the final rankings and close the issue (closing only works for the director or a maintainer). */
  async publishResults(number: number, results: TournamentResults): Promise<{ closed: boolean }> {
    await this.comment(number, resultsBody(results));
    try {
      await this.req(this.api(`/issues/${number}`), 'PATCH', { state: 'closed', state_reason: 'completed' });
      return { closed: true };
    } catch { return { closed: false }; }
  }

  async cancel(number: number): Promise<void> {
    await this.req(this.api(`/issues/${number}`), 'PATCH', { state: 'closed', state_reason: 'not_planned' });
  }
}
