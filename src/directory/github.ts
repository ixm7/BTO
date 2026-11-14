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

/**
 * How a player describes their own game, from the Settings dialog, and the
 * levels a tournament is open to.
 */
export const SKILLS = ['Beginner', 'Intermediate', 'Advanced', 'Expert', 'World Class'] as const;
export type Skill = (typeof SKILLS)[number];

/** The skill a player has set, if any: an empty string means they have not said. */
export type MaybeSkill = Skill | '';

/** Read a level written by hand, whatever its capitals or spacing. */
export function toSkill(text: unknown): Skill | null {
  const want = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return SKILLS.find((x) => x.toLowerCase() === want) ?? null;
}

/** The levels a tournament welcomes, in the order they are listed above. */
export function skillList(levels: readonly Skill[]): Skill[] {
  return SKILLS.filter((x) => levels.includes(x));
}

/** How the welcome reads on a card: 'All levels', or the ones named. */
export function levelText(meta: { levels: readonly Skill[] }): string {
  return meta.levels.length >= SKILLS.length ? 'All levels' : meta.levels.join(', ');
}

/** The same list as it reads in a sentence: 'Advanced, Expert and World Class'. */
export function levelPhrase(meta: { levels: readonly Skill[] }): string {
  const list = skillList(meta.levels);
  if (list.length >= SKILLS.length) return 'players of any level';
  if (list.length === 1) return `${list[0] as string} players`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1] as string} players`;
}

/** Is this player's own description of their game one the tournament asks for? */
export function welcomes(meta: { levels: readonly Skill[] }, skill: MaybeSkill): boolean {
  if (meta.levels.length >= SKILLS.length) return true;
  return skill !== '' && meta.levels.includes(skill);
}

export interface TournamentMeta {
  v: 1;
  name: string;
  /** Display name of the initiator / tournament director. */
  director: string;
  scoring: 'matchpoints' | 'imps';
  /** Wall-clock start in `timeZone`, e.g. "2026-11-21T19:30". */
  start: string;
  timeZone: string;
  /** The same instant in UTC (ISO 8601). */
  startUtc: string;
  /** The levels of player this tournament is open to. */
  levels: Skill[];
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
  /** Held again every week, same day and time, until somebody stops it. */
  repeat?: 'weekly';
  /** The system the robots bid. Absent means Standard American (SAYC). */
  robots?: 'sayc' | '2/1';
  /** The first tournament of a weekly series; absent on that first one itself. */
  seriesId?: number;
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
  /** How they describe their own game, when they have said. */
  skill?: Skill;
  at: string;
}

export interface ResultRow {
  rank: number;
  players: string;
  direction: 'NS' | 'EW';
  percent: number;
  matchpoints: number;
  maxMatchpoints: number;
  /** IMP pairs: total IMPs. */
  imps?: number;
}

/** What a tournament's scoring is called on screen. */
export const scoringName = (s: TournamentMeta['scoring'] | undefined): string => (s === 'imps' ? 'IMP Pairs' : 'Matchpoints');

/** IMPs as written: +3.5, −2, 0. */
export function impsText(n: number): string {
  const r = Math.round(n * 100) / 100;
  const body = Math.abs(r).toFixed(2).replace(/\.?0+$/, '');
  return r > 0 ? `+${body}` : r < 0 ? `\u2212${body}` : '0';
}

export interface TournamentResults {
  v: 1;
  /** Absent on results from before IMP pairs existed: matchpoints. */
  scoring?: TournamentMeta['scoring'];
  finishedAt: string;
  tables: number;
  boards: number;
  rankings: ResultRow[];
}

export type Status = 'upcoming' | 'starting' | 'in progress' | 'finished' | 'cancelled' | 'aborted';

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
  /** Set once the director has closed the entry list and fixed the deals. */
  pinned: PinnedStart | null;
  /** GitHub's global id for the issue; needed to delete it. */
  nodeId?: string;
  /** Display names of players who came through the relay, by their ~tag id. */
  names?: Record<string, string>;
  /** Cancelled because too few players had registered by the start time. */
  tooFew?: boolean;
  /** Where the automatic start stands; null when the comments could not be read. */
  plan?: StartPlan | null;
  /** Everyone in the draw, once entries have closed. */
  field?: Registration[];
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

export function makeMeta(input: Omit<TournamentMeta, 'v' | 'scoring' | 'startUtc' | 'levels'> & { levels: readonly Skill[]; scoring?: TournamentMeta['scoring'] }): TournamentMeta {
  const name = input.name.trim();
  if (!name) throw new Error('Tournament name is required');
  if (!input.director.trim()) throw new Error('Director name is required');
  const levels = skillList(input.levels);
  if (levels.length === 0) throw new Error('Choose at least one level of player');
  if (!Number.isInteger(input.capacity) || input.capacity < 4 || input.capacity > 200) throw new Error('Capacity must be between 4 and 200 players');
  if (!Number.isInteger(input.boardsPerRound) || input.boardsPerRound < 1 || input.boardsPerRound > 8) throw new Error('Boards per round must be 1-8');
  if (!Number.isInteger(input.rounds) || input.rounds < 1 || input.rounds > 20) throw new Error('Rounds must be 1-20');
  const idle = input.idleTimeoutSec;
  if (idle !== undefined && (!Number.isInteger(idle) || idle < MIN_IDLE_SEC || idle > MAX_IDLE_SEC)) {
    throw new Error(`Inactivity timeout must be between ${MIN_IDLE_SEC} and ${MAX_IDLE_SEC} seconds`);
  }
  const startUtc = zonedToUtc(input.start, input.timeZone).toISOString();
  return { v: 1, ...input, scoring: input.scoring === 'imps' ? 'imps' : 'matchpoints', levels, name, director: input.director.trim(), startUtc };
}

/**
 * The entry list as it stood when the director closed it: everyone registered
 * at or before that moment, in the order they entered. Every player derives
 * the same list, so every player derives the same draw.
 */
export function pinnedRoster(l: { registrations: Registration[] | null; pinned: PinnedStart | null; field?: Registration[] }): Registration[] {
  if (l.pinned && l.field) return [...l.field].sort((a, b) => a.at.localeCompare(b.at) || a.login.localeCompare(b.login));
  if (!l.pinned || !l.registrations) return [];
  return l.registrations
    .filter((r) => r.at <= (l.pinned as PinnedStart).at)
    .sort((a, b) => a.at.localeCompare(b.at) || a.login.localeCompare(b.login));
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
    `| **Scoring** | ${scoringName(meta.scoring)} |`,
    `| **Start** | ${meta.start.replace('T', ' ')} (${meta.timeZone}) — ${meta.startUtc.slice(0, 16).replace('T', ' ')} UTC |`,
    `| **Open to** | ${levelText(meta)} |`,
    `| **Capacity** | ${meta.capacity} players |`,
    `| **Format** | ${meta.rounds} round(s) × ${meta.boardsPerRound} board(s) |`,
    `| **Inactivity limit** | ${idleSecOf(meta)} seconds, then a robot takes the seat |`,
    `| **Robots** | ${meta.robots === '2/1' ? '2/1' : 'SAYC'} |`,
    ...(meta.repeat === 'weekly' ? ['| **Repeats** | Every week, same day and time |'] : []),
    '',
    'To register, add a comment containing `/register Your Name` (optionally followed by `pair:CODE` — two players using the same code are partnered — and `level:Your Level`).',
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
      v: 1, name: j.name, director: String(j.director ?? ''), scoring: j.scoring === 'imps' ? 'imps' : 'matchpoints',
      start: String(j.start ?? j.startUtc.slice(0, 16)), timeZone: String(j.timeZone ?? 'UTC'), startUtc: j.startUtc,
      /* An entry made before levels were a thing is open to everyone. */
      levels: (() => {
        const list = Array.isArray(j.levels) ? skillList(j.levels.map(toSkill).filter((x): x is Skill => x !== null)) : [];
        return list.length ? list : [...SKILLS];
      })(),
      capacity: Number(j.capacity) || 0, boardsPerRound: Number(j.boardsPerRound) || 2, rounds: Number(j.rounds) || 2,
      /* The issue body can be edited by hand on GitHub, so an out-of-range
         limit is pulled back into range rather than failing the whole entry. */
      ...(Number.isFinite(Number(j.idleTimeoutSec))
        ? { idleTimeoutSec: Math.min(MAX_IDLE_SEC, Math.max(MIN_IDLE_SEC, Math.round(Number(j.idleTimeoutSec)))) }
        : {}),
      ...(j.repeat === 'weekly' ? { repeat: 'weekly' as const } : {}),
      ...(j.robots === '2/1' ? { robots: '2/1' as const } : {}),
      ...(Number.isInteger(j.seriesId) && (j.seriesId as number) > 0 ? { seriesId: j.seriesId } : {}),
    };
  } catch { return null; }
}

/**
 * The moment the field was fixed. The director posts this, and from then on
 * the entry list is closed: everyone registered at or before it is in the
 * draw, and the seed settles the deals. Every player works the seating out
 * from these two facts alone, which is what lets them go straight to their own
 * table instead of gathering in one room to be told.
 */
export interface PinnedStart {
  seed: string;
  at: string;
}

const START_RE = /^\s*\/start\s+([A-Za-z0-9_-]{6,64})\s*$/im;

/** A fresh seed for the deals, unguessable before the director posts it. */
export function randomSeed(): string {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
}

/** The director's start command, if they have given it. The first one wins. */
export function parseStart(comments: readonly RawComment[], directorLogin: string): PinnedStart | null {
  for (const c of [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if ((c.user?.login ?? '').toLowerCase() !== directorLogin.toLowerCase()) continue;
    const m = START_RE.exec(c.body ?? '');
    if (m) return { seed: m[1] as string, at: c.created_at };
  }
  return null;
}

export interface RawComment { user: { login: string } | null; body: string | null; created_at: string }

/* ------------------------------------------------------------ the relay */

/**
 * Players without a token of their own act through a relay that posts on
 * their behalf with a token of its own. Every comment it posts is signed with
 * a trailer naming the player by a tag that only their browser can produce,
 * and the relay's own account is what makes that trailer worth believing.
 */
export interface Relay { url: string; login: string; key: string; name: string }

const TRAILER_RE = /\n?<!--\s*player\s+(\{[^\n]*?\})\s*-->\s*$/;

/** The public tag a private key signs as. Must match the relay's own derivation exactly. */
export async function playerTag(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bridgebreak:${key}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 20);
}

/**
 * Rewrite each comment as coming from whoever it speaks for. A comment the
 * relay posted becomes the player's own, under the id `~tag`, which no GitHub
 * login can collide with. A trailer on anybody else's comment is ignored —
 * the comment stays theirs — since only the relay's account can vouch for it.
 */
export function asActors(comments: readonly RawComment[], relayLogin: string): { comments: RawComment[]; names: Record<string, string> } {
  const names: Record<string, string> = {};
  const relay = relayLogin.trim().toLowerCase();
  const out = comments.map((c) => {
    const body = c.body ?? '';
    const m = TRAILER_RE.exec(body);
    if (!m || !relay || (c.user?.login ?? '').toLowerCase() !== relay) return c;
    let tag = '';
    let name = '';
    try {
      const j = JSON.parse(m[1] as string) as { t?: unknown; n?: unknown };
      tag = String(j.t ?? '');
      name = String(j.n ?? '');
    } catch { return c; }
    if (!/^[0-9a-f]{20}$/.test(tag)) return c;
    const id = `~${tag}`;
    if (name) names[id] = name;
    return { ...c, user: { login: id }, body: body.slice(0, m.index) };
  });
  return { comments: out, names };
}

/** Is this the id of a player who came through the relay, rather than a GitHub login? */
export const isRelayed = (id: string): boolean => id.startsWith('~');

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
      let skill: Skill | undefined;
      /* `pair:` and `level:` may come in either order after the name. */
      for (;;) {
        const pm = /\bpair:\s*(\S+)\s*$/i.exec(rest);
        if (pm) { pairCode = pm[1]; rest = rest.slice(0, pm.index).trim(); continue; }
        const sm = /\blevel:\s*([A-Za-z][A-Za-z ]*?)\s*$/i.exec(rest);
        const named = sm ? toSkill(sm[1]) : null;
        if (sm && named) { skill = named; rest = rest.slice(0, sm.index).trim(); continue; }
        break;
      }
      const prev = reg.get(login);
      reg.set(login, {
        login, name: rest || login, ...(pairCode ? { pairCode } : {}), ...(skill ? { skill } : {}),
        at: prev?.at ?? c.created_at,
      });
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
  /* Somebody who has a partner is no longer looking for one, so an accepted
     invitation takes both of them off the list without either having to say
     so. Breaking the partnership up puts them back, which is what they want:
     they are looking again. */
  for (const inv of invitations.values()) {
    if (inv.status !== 'accepted') continue;
    seekers.delete(inv.from.toLowerCase());
    seekers.delete(inv.to.toLowerCase());
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
    ...(r.scoring === 'imps' ? [
      '| Rank | Pair | Dir | IMPs |',
      '|---:|---|:-:|---:|',
      ...r.rankings.map((x) => `| ${x.rank} | ${x.players} | ${x.direction} | ${impsText(x.imps ?? 0)} |`),
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

/** How long a cancelled tournament stays on the list, so players can see what became of it. */
export const KEEP_CANCELLED_MS = 24 * 3600 * 1000;

/* ------------------------------------------------------- automatic start */

/** Fewest players a tournament will start with: two tables, so there are results to compare. */
export const MIN_PLAYERS = 8;
/** How long past the start time to wait for the minimum before calling it off. */
export const MIN_WAIT_MS = 5 * 60 * 1000;
/** Short of a full field, entries stay open this much longer, again each time somebody joins. */
export const EXTEND_MS = 60 * 1000;
export const MAX_EXTENSIONS = 5;
/**
 * A comment can take a few seconds to show up for everyone. Nobody acts on a
 * decision until it has been this long past its moment, so every browser has
 * seen the same comments by the time it does.
 */
export const SETTLE_MS = 30 * 1000;

/**
 * Where a tournament's start stands.
 *  - wait: entries are open; nothing can be decided before `until`.
 *  - start: entries closed at `at`; whoever was registered then plays.
 *  - cancel: at `at` there were still too few to play.
 */
export type StartPlan =
  | { kind: 'wait'; until: number; extensions: number }
  | { kind: 'start'; at: number }
  | { kind: 'cancel'; at: number };

/**
 * Work out the start from the registration comments alone, the same way in
 * every browser, so there is nobody who has to press a button:
 *
 *  1. Full at the start time: it starts then.
 *  2. Fewer than four: wait up to five minutes for the fourth; failing that,
 *     it is cancelled.
 *  3. Otherwise, short of full and with a table that would need robots to
 *     fill it: entries stay open one more minute. If anybody registers in
 *     that minute, another minute, up to five times. Whenever the players
 *     registered fill whole tables of four, the waiting ends at once — there
 *     is nobody left to wait for.
 *
 * Times are GitHub's own comment times, not anybody's clock, so all agree.
 */
export function planStart(meta: TournamentMeta, comments: readonly RawComment[], now: number): StartPlan {
  const T0 = Date.parse(meta.startUtc);
  const cap = meta.capacity;
  const sorted = [...comments].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const times = [...new Set(sorted.map((c) => Date.parse(c.created_at)))];
  const regsAt = (t: number): Registration[] => parseRegistrations(sorted.filter((c) => Date.parse(c.created_at) <= t));
  const count = (t: number): number => regsAt(t).length;
  /** The first comment in (from, to] after which `ok` holds. */
  const firstIn = (from: number, to: number, ok: (n: number) => boolean): number | null =>
    times.find((t) => t > from && t <= to && ok(count(t))) ?? null;
  const settled = (plan: StartPlan & { at: number }): StartPlan =>
    now >= plan.at + SETTLE_MS ? plan : { kind: 'wait', until: plan.at, extensions: 0 };

  /*
   * Nothing is gained by waiting once every table is full: the extra minutes
   * exist only to find the players who would otherwise leave a table short
   * and have robots make up the numbers.
   */
  const ready = (n: number): boolean => n >= cap || (n >= MIN_PLAYERS && n % 4 === 0);

  if (now < T0) return { kind: 'wait', until: T0, extensions: 0 };
  if (ready(count(T0))) return settled({ kind: 'start', at: T0 });

  let from = T0;
  if (count(T0) < MIN_PLAYERS) {
    const reached = firstIn(T0, T0 + MIN_WAIT_MS, (n) => n >= MIN_PLAYERS);
    if (reached === null) {
      return now < T0 + MIN_WAIT_MS ? { kind: 'wait', until: T0 + MIN_WAIT_MS, extensions: 0 }
        : settled({ kind: 'cancel', at: T0 + MIN_WAIT_MS });
    }
    if (ready(count(reached))) return settled({ kind: 'start', at: reached });
    from = reached;
  }

  for (let ext = 0; ; ext++) {
    const to = from + EXTEND_MS;
    /* Filling the last table ends the wait, as does filling the tournament. */
    const done = firstIn(from, to, ready);
    if (done !== null) return settled({ kind: 'start', at: done });
    if (now < to) return { kind: 'wait', until: to, extensions: ext };
    const before = new Set(regsAt(from).map((r) => r.login));
    const joined = regsAt(to).some((r) => !before.has(r.login));
    if (joined && ext < MAX_EXTENSIONS) { from = to; continue; }
    /* Withdrawals in the meantime can leave it short again. */
    return settled(count(to) >= MIN_PLAYERS ? { kind: 'start', at: to } : { kind: 'cancel', at: to });
  }
}

/* ------------------------------------------------------- weekly series */

/** Which series a tournament belongs to: the number of the first one. */
export const seriesOf = (meta: TournamentMeta, number: number): number => meta.seriesId ?? number;

/**
 * The next time a weekly tournament is held: the same wall-clock time in its
 * own time zone, a whole number of weeks on, and after `now` — so a series
 * nobody looked at for a while picks up again from the coming week rather
 * than filling the list with dates already gone. Daylight saving is the time
 * zone's business: 7:30 PM stays 7:30 PM.
 */
export function nextWeekly(meta: TournamentMeta, now: number): { start: string; startUtc: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(meta.start);
  if (!m) throw new Error(`Bad start: ${meta.start}`);
  for (let weeks = 1; ; weeks++) {
    const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 7 * weeks));
    const start = `${day.toISOString().slice(0, 10)}T${m[4]}`;
    const at = zonedToUtc(start, meta.timeZone);
    if (at.getTime() > now) return { start, startUtc: at.toISOString() };
  }
}

/** Next week's tournament: the same in every way but the date. */
export function nextInSeries(meta: TournamentMeta, number: number, now: number): TournamentMeta {
  return { ...meta, ...nextWeekly(meta, now), seriesId: seriesOf(meta, number) };
}

/**
 * Weekly tournaments whose latest occurrence has begun and has no successor
 * yet. A series stops when its latest is closed as not planned, or no longer
 * marked as repeating.
 */
export function seriesDue(found: readonly { issue: { number: number; state: string; state_reason?: string | null }; meta: TournamentMeta }[], now: number): number[] {
  const latest = new Map<number, (typeof found)[number]>();
  for (const f of found) {
    const key = seriesOf(f.meta, f.issue.number);
    const cur = latest.get(key);
    if (!cur || f.meta.startUtc > cur.meta.startUtc) latest.set(key, f);
  }
  return [...latest.values()]
    .filter((f) => f.meta.repeat === 'weekly' && now >= Date.parse(f.meta.startUtc)
      && !(f.issue.state === 'closed' && f.issue.state_reason !== 'completed'))
    .map((f) => f.issue.number);
}

/** Same deals in every browser, and nobody's to choose. */
async function seedFor(issue: { number: number; node_id?: string }, at: number, field: readonly Registration[]): Promise<string> {
  const text = `bridgebreak-start:${issue.node_id ?? issue.number}:${at}:${field.map((r) => r.login).join(',')}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/**
 * The order of the list: whatever is still to come first, the soonest at the
 * top, so a player's next game is the first thing they see. What is over
 * comes below it, most recent first, since nobody is waiting on those.
 */
export function byStart(a: Listing, b: Listing): number {
  const over = (l: Listing): number => (l.status === 'upcoming' || l.status === 'starting' || l.status === 'in progress' ? 0 : 1);
  if (over(a) !== over(b)) return over(a) - over(b);
  const d = Date.parse(a.meta.startUtc) - Date.parse(b.meta.startUtc);
  return over(a) ? -d : d;
}

/**
 * What belongs on the tournament list. One that was abandoned is of no use to
 * anybody and goes at once; one that was played stays a week so the results
 * can be read, then goes too. Nothing is deleted on GitHub: the issue is still
 * there to be opened directly, this only decides what the list shows.
 */
export function visibleInList(l: { status: Status; meta: TournamentMeta }, now: number): boolean {
  if (l.status === 'aborted') return false;
  if (l.status === 'finished') return now - Date.parse(l.meta.startUtc) < KEEP_FINISHED_MS;
  if (l.status === 'cancelled') return now - Date.parse(l.meta.startUtc) < KEEP_CANCELLED_MS;
  return true;
}

export function deriveStatus(
  meta: TournamentMeta, issue: { state: string; state_reason?: string | null }, results: TournamentResults | null, now: number,
  entry: { started: boolean; plan: StartPlan | null } = { started: false, plan: null },
): Status {
  if (results) return 'finished';
  if (issue.state === 'closed') return issue.state_reason === 'completed' ? 'finished' : 'cancelled';
  const start = Date.parse(meta.startUtc);
  if (now < start) return 'upcoming';
  /* It began, but no result was ever posted: it ran out of players or was
     abandoned part-way. Either way it is not still in progress. */
  if (now >= start + playingWindowMs(meta)) return 'aborted';
  if (entry.started) return 'in progress';
  if (entry.plan?.kind === 'cancel') return 'cancelled';
  if (entry.plan?.kind === 'wait') return 'starting';
  return 'in progress';
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
  constructor(message: string, readonly status: number, readonly resetAt: Date | null = null) { super(message); }
  /** Nothing is wrong except that we have asked too often. */
  get rateLimited(): boolean { return this.resetAt !== null; }
}

/** 'in 12 minutes', for telling somebody when the list will answer again. */
function inWords(until: Date): string {
  const mins = Math.max(1, Math.round((until.getTime() - Date.now()) / 60000));
  if (mins < 60) return `in ${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = Math.round(mins / 60);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

export class Directory {
  readonly repo: Repo;
  constructor(
    repo: string | Repo,
    private token: string | null = null,
    private fetcher: FetchLike = (u, i) => fetch(u, i),
    private relay: Relay | null = null,
  ) {
    this.repo = typeof repo === 'string' ? parseRepo(repo) : repo;
  }

  /** Can write anything — create, start, publish. Only a token can. */
  get canWrite(): boolean { return !!this.token; }
  /** Can do what a player does — register, withdraw, find a partner. A token or the relay. */
  get canAct(): boolean { return !!this.token || !!this.relay; }
  /** A token of one's own is used for everything; otherwise the relay, where there is one. */
  private get viaRelay(): boolean { return !this.token && !!this.relay; }
  get slug(): string { return `${this.repo.owner}/${this.repo.repo}`; }
  private api(path: string): string {
    const base = this.viaRelay ? (this.relay as Relay).url.replace(/\/+$/, '') : 'https://api.github.com';
    return `${base}/repos/${this.repo.owner}/${this.repo.repo}${path}`;
  }
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
      const stamp = Number(res.headers.get('x-ratelimit-reset'));
      /* When the count starts again, so the player is told rather than left
         to guess. A missing header means we simply do not know. */
      const resetAt = limited && Number.isFinite(stamp) && stamp > 0 ? new Date(stamp * 1000) : null;
      let detail = '';
      try {
        const j = (await res.json()) as { message?: string; error?: string };
        detail = String(j.message ?? j.error ?? '');
      } catch { /* no body */ }
      /* These reach the player as-is, so they say what to do rather than
         naming the service the tournament list happens to be kept on. */
      throw new GitHubError(
        limited ? `The tournament list has been asked for too often from this network${resetAt ? ` — it will answer again ${inWords(resetAt)}` : ''}. `
          + 'Without a token everyone sharing your connection shares one small allowance; adding your own in Settings raises it a long way.'
          : res.status === 401 ? 'That token was rejected.'
          : res.status === 404 ? `Tournament list not found (${this.slug}). Check the name in Settings, and that the list is public.`
          : `Could not reach the tournament list (error ${res.status})${detail ? `: ${detail}` : ''}`,
        res.status, resetAt,
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
    let pinned: PinnedStart | null = null;
    let names: Record<string, string> = {};
    let cs: RawComment[] = [];
    let readable = true;
    if (issue.comments > 0) {
      try {
        const read = asActors(await this.comments(issue.number), this.relay?.login ?? '');
        cs = read.comments;
        names = read.names;
        registrations = parseRegistrations(cs);
        // Only the director or a registered player can publish results.
        const trusted = new Set([issue.user?.login, ...registrations.map((r) => r.login)]);
        results = parseResults(cs.filter((c) => trusted.has(c.user?.login)));
        partners = parsePartners(cs);
        pinned = parseStart(cs, issue.user?.login ?? '');
      } catch { registrations = null; partners = null; readable = false; }
    }
    /* A director's /start, from before starts were automatic, still counts. */
    const plan = readable && !pinned && !results ? planStart(meta, cs, now) : null;
    let field: Registration[] | undefined;
    if (plan?.kind === 'start') {
      field = parseRegistrations(cs.filter((c) => Date.parse(c.created_at) <= plan.at));
      pinned = { seed: await seedFor(issue, plan.at, field), at: new Date(plan.at).toISOString() };
    } else if (pinned) {
      const at = pinned.at;
      field = parseRegistrations(cs.filter((c) => c.created_at <= at));
    }
    return {
      number: issue.number, url: issue.html_url, meta, initiatorLogin: issue.user?.login ?? '',
      status: deriveStatus(meta, issue, results, now, { started: !!pinned, plan }),
      registrations, results, partners, roomId: this.roomId(issue.number),
      pinned, names, plan, ...(field ? { field } : {}),
      ...(issue.state === 'open' && !results && plan?.kind === 'cancel' ? { tooFew: true } : {}),
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
    /* Two visitors may have asked for next week's at the same moment: the first one counts. */
    const seen = new Set<string>();
    const unique = [...found].sort((a, b) => a.issue.number - b.issue.number).filter(({ issue, meta }) => {
      const k = `${seriesOf(meta, issue.number)}@${meta.startUtc}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    this.due = seriesDue(unique, now);
    const out = await Promise.all(unique.map(({ issue, meta }) => this.toListing(issue, meta, now)));
    /* Remember what was left off the list so it can be swept away later; the
       caller decides whether to, and the next listing recomputes this anyway. */
    this.abandoned = out.filter((l) => l.status === 'aborted');
    return out.filter((l) => visibleInList(l, now)).sort(byStart);
  }

  /** Abandoned tournaments found by the last `list()`, ready to be removed. */
  abandoned: Listing[] = [];

  /** Weekly tournaments the last `list()` found in need of next week's. */
  due: number[] = [];

  /**
   * Put next week's tournament on the list for every series that needs one.
   * With a token it is created here; otherwise the relay does it, checking
   * for itself that it is due. Returns how many were asked for.
   */
  async continueSeries(now: number = Date.now()): Promise<number> {
    const due = this.due;
    this.due = [];
    let asked = 0;
    for (const number of due) {
      try {
        if (this.token) {
          const issue = await this.req<RawIssue>(this.api(`/issues/${number}`));
          const meta = parseMeta(issue.body);
          if (!meta || meta.repeat !== 'weekly') continue;
          await this.create(nextInSeries(meta, number, now));
        } else if (this.relay) {
          const res = await this.fetcher(`${this.relay.url.replace(/\/+$/, '')}/act`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ act: 'repeat', issue: number }),
          });
          if (!res.ok) continue;
        } else continue;
        asked++;
      } catch { /* somebody else's visit will try again */ }
    }
    return asked;
  }

  /** Stop a weekly tournament repeating after this one. Needs a token that may edit it. */
  async stopRepeating(l: Listing): Promise<void> {
    if (!this.token) throw new Error('A token is needed to change this tournament.');
    const { repeat: _gone, ...rest } = l.meta;
    await this.req(this.api(`/issues/${l.number}`), 'PATCH', { body: issueBody(rest) });
  }

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

  /**
   * Something a player does on a tournament's page. With a token it is posted
   * as written; without, the relay posts it, building the same line itself
   * from the fields given here.
   */
  private async playerAct(number: number, line: string, act: string, fields: Record<string, unknown> = {}): Promise<unknown> {
    if (this.token) return this.comment(number, line);
    if (!this.relay) throw new Error('A token is needed to do this from here.');
    const res = await this.fetcher(`${this.relay.url.replace(/\/+$/, '')}/act`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ issue: number, key: this.relay.key, name: this.relay.name, act, ...fields }),
    });
    if (!res.ok) {
      let msg = '';
      try { msg = String(((await res.json()) as { error?: string }).error ?? ''); } catch { /* no body */ }
      throw new GitHubError(msg || `That did not go through (error ${res.status}).`, res.status);
    }
    return res.json();
  }

  register(number: number, name: string, pairCode?: string, skill?: MaybeSkill): Promise<unknown> {
    const clean = name.replace(/[\r\n]/g, ' ').trim();
    const code = pairCode?.trim().replace(/\s+/g, '-');
    const level = skill ? ` level:${skill}` : '';
    return this.playerAct(number, `/register ${clean}${code ? ` pair:${code}` : ''}${level}`, 'register',
      { name: clean, ...(code ? { pair: code } : {}), ...(skill ? { level: skill } : {}) });
  }

  withdraw(number: number): Promise<unknown> { return this.playerAct(number, '/withdraw', 'withdraw'); }

  /**
   * Close the entry list and fix the deals. Only the director's own start
   * counts, and only the first one, so this cannot be re-run to redraw a
   * tournament that is already under way.
   */
  pinStart(number: number, seed: string = randomSeed()): Promise<unknown> {
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(seed)) throw new Error('Bad seed');
    return this.comment(number, `/start ${seed}`);
  }

  /** Join (or update your note on) the "looking for a partner" list for this tournament. */
  seekPartner(number: number, note?: string): Promise<unknown> {
    const clean = (note ?? '').replace(/[\r\n]/g, ' ').trim();
    return this.playerAct(number, `/seek-partner${clean ? ` ${clean}` : ''}`, 'seek', clean ? { note: clean } : {});
  }

  cancelSeekingPartner(number: number): Promise<unknown> {
    return this.playerAct(number, '/seek-partner cancel', 'seek-cancel');
  }

  invitePartner(number: number, toId: string, note?: string): Promise<unknown> {
    const clean = (note ?? '').replace(/[\r\n]/g, ' ').trim();
    return this.playerAct(number, `/invite @${toId}${clean ? ` ${clean}` : ''}`, 'invite', { target: toId, ...(clean ? { note: clean } : {}) });
  }

  cancelInvite(number: number, toId: string): Promise<unknown> {
    return this.playerAct(number, `/invite-cancel @${toId}`, 'invite-cancel', { target: toId });
  }

  /** Respond to an invitation you received from `fromId`. */
  respondToInvite(number: number, fromId: string, accept: boolean): Promise<unknown> {
    return this.playerAct(number, `${accept ? '/accept' : '/decline'} @${fromId}`, accept ? 'accept' : 'decline', { target: fromId });
  }

  /** Break up an already-accepted partnership with `otherId` (either side may call this). */
  unpair(number: number, otherId: string): Promise<unknown> {
    return this.playerAct(number, `/unpair @${otherId}`, 'unpair', { target: otherId });
  }

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
