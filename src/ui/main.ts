import { BoardError, readBoards } from '../engine/boards';
import { CHAT_MAX, PAIR_NOTE_MAX, pairKey, systemBetween, type ChatMessage, type PairCard, BOARD_MINUTES, BETWEEN_ROUNDS_MINUTES, expectedLength, overlap, SYSTEM_PREFS, systemPref, systemToken, type SystemPref, NEW_IDLE_SEC, WEEKDAYS, repeatStarts, MAX_NAME, MIN_PLAYERS, MIN_TABLES, impsText, scoringName, Directory, type Status, GitHubError, isRelayed, playerTag, MAX_IDLE_SEC, MIN_IDLE_SEC, SKILLS, idleSecOf, inviteCode, levelPhrase, levelText, pinnedRoster, makeMeta, toSkill, welcomes, byLevelThenSystem, type Invitation, type Listing, type Registration, type Skill, type TournamentResults } from '../directory/github';
import { ago, allTimeZones, countdown, formatInZone, localTimeZone } from '../directory/time';
import { MemoryHub, localTransport, type Transport } from '../net/transport';
import { TournamentSession, type SessionMemory } from './session';
import { planConfig, unmannedTables } from '../tournament/plan';
import { cardImps, cardTotal, impText, pairOf, scorecard } from '../tournament/review';
import { collect, describe, pack, unpack } from './backup';
import { qrSvg } from './qr';
import { renderRecords, type RecordsMode } from './review';
import { pairOfName, recordsOf, stateOfRecords, type HandRecords } from '../tournament/records';
import { ROBOT_DELAY_MS, TournamentNode, deviceScore } from '../tournament/node';
import { firstBoardOfRound, originalSeatId, ownerOf, standings, tricksLeft, turnAt, type Standing, type TableState, type TEvent, type TournamentConfig, type TState } from '../tournament/state';
import { SEATS } from '../engine/cards';
import { installHoverTips } from './hoverTip';
import { wakeIn } from './ticker';
import { LIMIT, online, watchOnline } from './presence';
import { makeRobot } from './robot';
import { armSound, cardSwoosh, say, setSound, startFanfare, turnChime } from './sound';
import { TEST_USERS, h, loadSettings, markBusy, saveSettings, testMode, testUser, type Settings } from './dom';
import { renderTable } from './tableView';
import { resultToString } from '../engine/scoring';

const DEFAULT_REPO = (import.meta.env.VITE_DIRECTORY_REPO as string | undefined) ?? '';
const root = document.getElementById('app') as HTMLElement;
const settings: Settings = loadSettings(DEFAULT_REPO);

/** The preference as the form gives it back, or none if it is not one of ours. */
const systemsOf = (v: string): SystemPref => (SYSTEM_PREFS.includes(v as SystemPref) ? (v as SystemPref) : '');

/* Players without a token of their own act through the relay, when one is
   set up for this site's tournament list. Its comments are believed only
   when posted from the account it posts as. */
const RELAY_URL = ((import.meta.env.VITE_RELAY_URL as string | undefined) ?? '').trim();
const RELAY_LOGIN = ((import.meta.env.VITE_RELAY_LOGIN as string | undefined) ?? '').trim()
  || (DEFAULT_REPO.split('/')[0] ?? '');

/** The tag this browser's key signs as, once worked out (it takes a moment). */
let myTag = '';

/**
 * Whether the relay answered when the page loaded. Without it the site works
 * exactly as it did before there was one: the list is read directly, and a
 * player without a token registers on the tournament's own page. So the
 * relay can be switched on, or fall over, without taking anything else down.
 */
let relayUp = false;
async function probeRelay(): Promise<void> {
  if (!RELAY_URL) return;
  try {
    const res = await fetch(`${RELAY_URL.replace(/\/+$/, '')}/`, { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    relayUp = res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch { relayUp = false; }
}
void playerTag(settings.playerKey).then((t) => { myTag = t; render(); }).catch(() => { /* no Web Crypto: no relay */ });

/**
 * Who this player is on a tournament's page: their GitHub login when they
 * have a token of their own, and otherwise the tag their private key signs.
 */
function myId(): string {
  const login = settings.githubLogin.trim().toLowerCase();
  /* Whichever way this player's actions are posted is who they are. */
  const viaRelay = !settings.token && relayUp;
  if (login && !viaRelay) return login;
  return myTag ? `~${myTag}` : login;
}

/** A player as other players see them: by the name they gave, or their GitHub login. */
function who(l: Listing, id: string): string {
  if (isRelayed(id)) return l.names?.[id] ?? l.registrations?.find((r) => r.login === id)?.name ?? 'a player';
  return `@${id}`;
}

interface RoomInfo {
  id: string;
  name: string;
  boardsPerRound: number;
  rounds?: number;
  capacity?: number;
  minTables?: number;
  listing: Listing | null;
  demo: boolean;
}

let listings: Listing[] | null = null;
let loading = false;
let errorMsg: string | null = null;
let notice: string | null = null;
let detail: Listing | null = null;
let node: TournamentNode | null = null;
let room: RoomInfo | null = null;
let watchTable = 0;
/** When set, the room shows hand records instead of the table. */
let reviewing = false;
let recBoard: number | null = null;
let recTable: number | null = null;
let recMode: RecordsMode = 'mine';
/*
 * The hands of a tournament that is over, read back from its page. The log
 * they were played from is gone with the browsers that held it, so this is
 * the copy the page kept — fetched when somebody asks, because it is the
 * largest thing a tournament carries and most of the time nobody looks.
 */
let pastRecords: { number: number; data: HandRecords } | null = null;
let pastLoading = false;
let pastError: string | null = null;

/** Open the hands of a finished tournament, fetching them the first time. */
function openPastRecords(l: Listing): void {
  if (pastRecords?.number === l.number) { pastRecords = null; render(); return; }
  const d = directory();
  if (!d) return;
  pastLoading = true; pastError = null; recBoard = null; recTable = null; recMode = 'mine';
  render();
  void (async () => {
    try {
      const data = await d.records(l.number);
      if (!data) throw new Error('This tournament did not write its hands down.');
      pastRecords = { number: l.number, data };
    } catch (e) { pastError = (e as Error).message; }
    pastLoading = false;
    render();
  })();
}

/** The records panel for a tournament nobody is playing any more. */
function pastRecordsPanel(l: Listing): HTMLElement | null {
  if (pastLoading) return h('div.panel', h('p.muted', 'Reading the hands\u2026'));
  if (pastError) return h('div.panel', h('div.error', pastError));
  if (pastRecords?.number !== l.number) return null;
  const data = pastRecords.data;
  const state = stateOfRecords(data, l.meta.name);
  return renderRecords(state, pairOfName(data, settings.name), { board: recBoard, table: recTable, mode: recMode }, {
    pickBoard: (b) => { recBoard = b; recTable = null; render(); },
    pickTable: (t) => { recTable = t; render(); },
    setMode: (m) => { recMode = m; recTable = null; render(); },
  });
}
let published = false;
/** Set once this browser has reported a tournament as given up on. */
let markedAbandoned = false;
/** Set while this browser is putting the result up, so it only tries once. */
let publishing = false;
/** Why the result could not be put up, if it could not. */
let publishFailed: string | null = null;
/** While a tournament detail page is open, poll it so a partner's invite/accept/unregister
 * elsewhere shows up here without the person having to hit Refresh themselves. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Lets an open "Partners list" dialog be pushed a fresher Listing from outside itself
 * (a refresh() or another action), so it reflects more than just what the dialog did. */
let partnersSync: ((l: Listing) => void) | null = null;

const directory = (): Directory | null => {
  if (!settings.repo.trim()) return null;
  /* The relay serves this site's own list and nothing else. */
  const relay = relayUp && settings.repo.trim().toLowerCase() === DEFAULT_REPO.toLowerCase()
    ? { url: RELAY_URL, login: RELAY_LOGIN, key: settings.playerKey, name: settings.name.trim() }
    : null;
  try { return new Directory(settings.repo, settings.token || null, undefined, relay); } catch { return null; }
};

/** One brain for every robot this device plays for. */
const robot = makeRobot();
/**
 * The brain for a table of robots this browser is keeping going for the field.
 * It thinks in short order: nobody is watching that table, and the person's
 * own robots ask the same worker.
 */
const spareRobot = makeRobot({ budgetMs: 600, maxSamples: 10 });

const fail = (e: unknown): void => { errorMsg = e instanceof Error ? e.message : String(e); render(); };

/* ------------------------------------------------------------ directory */

/** Keep `detail` and `listings` in sync with a Listing fetched elsewhere (e.g. from
 * inside the Partners dialog), and push it to that dialog too, if one is open for it. */
function syncListing(l: Listing): void {
  /* Never back to a skimmed one: the page being looked at has read its
     comments, and the next poll of the list has not. */
  if (detail && detail.number === l.number && !(l.skimmed && !detail.skimmed)) detail = l;
  if (listings) {
    const i = listings.findIndex((x) => x.number === l.number);
    /* Same for the list itself, so going back and in again does not have to
       read it a second time. */
    if (i >= 0 && !(l.skimmed && !listings[i]?.skimmed)) listings[i] = l;
  }
  partnersSync?.(l);
  notePartnershipChanges();
  render();
}

/**
 * If I have an invitation that's been accepted for this tournament, make sure I'm registered
 * under the matching partner code — so accepting an invite is enough on its own, with no
 * separate Register click needed. Each side's own browser does this for itself; there is no
 * server to do it centrally, so the other side only picks it up once their own browser next
 * refreshes (on a timer, or by opening the Partners dialog).
 */
async function applyAutoRegister(d: Directory, l: Listing): Promise<Listing> {
  if (!d.canAct || !settings.name.trim()) return l;
  const open = l.status === 'upcoming' || l.status === 'starting' || l.status === 'in progress';
  const myLogin = myId();
  if (!open || !myLogin || !l.partners) return l;
  if (!welcomes(l.meta, settings.skill)) return l; // not a tournament for us
  const accepted = l.partners.invitations.find((i) =>
    i.status === 'accepted' && (i.from.toLowerCase() === myLogin || i.to.toLowerCase() === myLogin));
  if (!accepted) return l;
  const code = inviteCode(l.number, accepted.from, accepted.to);
  if (settings.pairCode !== code) { settings.pairCode = code; saveSettings(settings); }
  const mine = l.registrations?.find((r) => r.login.toLowerCase() === myLogin);
  if (mine && mine.pairCode?.trim().toLowerCase() === code) return l; // already registered together
  try {
    await d.register(l.number, settings.name, code, settings.skill, settings.systems, rememberedPassword(l.number));
    return await d.get(l.number);
  } catch { return l; } // offline, rate-limited, etc. — try again on the next refresh
}

/**
 * How often to ask the tournament list for news.
 *
 * Without a token every visitor on a network shares one small allowance of
 * requests an hour, so a page left open must ask sparingly or spend it for
 * everybody. A token of one's own has an allowance hundreds of times larger,
 * and can afford to keep up.
 */
/*
 * How often the tournament list is read. A token of one's own buys a large
 * allowance; the relay answers from a shared 15-second cache, so asking it
 * often costs GitHub nothing. Without either, the allowance is 60 an hour for
 * everyone on the network, so the page asks sparingly.
 */
const pollEvery = (): number => (settings.token ? 15000 : relayUp ? 30000 : 120000);

/** Set while the list has told us to stop asking, until it will answer again. */
let quietUntil = 0;

/** When the list was last asked for. */
let lastRefresh = 0;

/**
 * When this player last walked out of a tournament's room. Leaving one that
 * is under way means "do not haul me back in"; leaving the waiting room
 * before the tournament starts means nothing of the sort, so only a departure
 * after the start keeps them out.
 */
const leftAt = new Map<number, number>();

/**
 * Around the start of a tournament this player is in, the list is read
 * often enough to seat them promptly, even from a tab they are not looking
 * at. Only where reading is cheap: with a token of their own, or through the
 * relay's shared cache.
 */
function myStartIsNear(now = Date.now()): boolean {
  if (!(settings.token || relayUp) || !listings) return false;
  const me = myId();
  return listings.some((l) => {
    const start = Date.parse(l.meta.startUtc);
    return now >= start - 2 * 60000 && now <= start + 20 * 60000
      && (l.status === 'upcoming' || l.status === 'starting' || l.status === 'in progress')
      && !!me && !!l.registrations?.some((r) => r.login.toLowerCase() === me);
  });
}

function stopPolling(): void { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => {
    if (node || room || Date.now() < quietUntil) return;
    const near = myStartIsNear();
    /* A page nobody is looking at has no news to miss, and asking anyway is
       what empties the allowance before the player comes back to it — unless
       their tournament is about to start, when the news is their seat. */
    if (document.hidden && !near) return;
    if (near || Date.now() - lastRefresh >= pollEvery()) void refresh();
  }, 15000);
}

/**
 * Tell the player their tournament has begun, loudly enough to bring them
 * back from another tab: a fanfare and a spoken line, and the tab's title
 * flags it until they look.
 */
function announceStart(name: string): void {
  startFanfare(name);
  if (!document.hidden) return;
  const plain = document.title;
  document.title = '\u{1F514} Your table is ready';
  const back = (): void => {
    if (document.hidden) return;
    document.title = plain;
    document.removeEventListener('visibilitychange', back);
  };
  document.addEventListener('visibilitychange', back);
}

/* ------------------------------------------------- invitations to partner */

/**
 * Break up a partnership, leaving both players in the tournament. The pair
 * code goes with it, so whoever stays registered is paired by the draw like
 * anyone else, and either of them is free to arrange somebody new.
 */
async function endPartnership(l: Listing, partner: string): Promise<void> {
  const d = directory();
  if (!d) return;
  try {
    await d.unpair(l.number, partner);
    if (settings.pairCode) { settings.pairCode = ''; saveSettings(settings); }
    const me = myId();
    const mine = l.registrations?.find((r) => r.login.toLowerCase() === me);
    /* Still in the tournament, but no longer half of a pair. */
    if (mine?.pairCode && settings.name.trim()) {
      await d.register(l.number, settings.name, '', settings.skill, settings.systems, rememberedPassword(l.number));
    }
    await refresh();
  } catch (e) { fail(e); }
}

/** Partnerships as they stood when the list was last read, to notice a change. */
const pairWas = new Map<string, string>();
let pairsSeeded = false;

/**
 * Either player can end a partnership, and the other finds out here: their
 * page is told the moment their browser next reads the list, whatever they
 * happen to be looking at.
 */
function notePartnershipChanges(): void {
  const me = myId();
  if (!listings || !me) return;
  const now = new Map<string, string>();
  const ended: { l: Listing; other: string }[] = [];
  for (const l of listings) {
    for (const i of l.partners?.invitations ?? []) {
      const mine = i.from.toLowerCase() === me || i.to.toLowerCase() === me;
      if (!mine) continue;
      const key = `${l.number}:${i.from.toLowerCase()}->${i.to.toLowerCase()}`;
      now.set(key, i.status);
      if (pairsSeeded && pairWas.get(key) === 'accepted' && i.status === 'unpaired') {
        ended.push({ l, other: i.from.toLowerCase() === me ? i.to : i.from });
      }
    }
  }
  pairWas.clear();
  for (const [k, v] of now) pairWas.set(k, v);
  pairsSeeded = true;
  if (!ended.length) return;
  const { l, other } = ended[0] as { l: Listing; other: string };
  notice = `Your partnership with ${who(l, other)} for “${l.meta.name}” has been cancelled at one player's request.`
    + ' Both of you are still registered, and either can find somebody else from the Partners List.';
  if (settings.pairCode) { settings.pairCode = ''; saveSettings(settings); }
  turnChime();
  /* The other player cleared their own half; this browser clears ours, so
     neither is left registered under a partner code that means nothing. */
  const d = directory();
  const mine = l.registrations?.find((r) => r.login.toLowerCase() === me);
  if (d?.canAct && mine?.pairCode && settings.name.trim()) {
    void d.register(l.number, settings.name, '', settings.skill, settings.systems, rememberedPassword(l.number))
      .then(() => refresh()).catch(() => { /* next refresh */ });
  }
}

/** Invitations waiting for an answer from this player, wherever they are. */
function invitesForMe(): { l: Listing; i: Invitation }[] {
  const me = myId();
  if (!me || !listings) return [];
  const out: { l: Listing; i: Invitation }[] = [];
  for (const l of listings) {
    if (l.status !== 'upcoming' && l.status !== 'starting') continue;
    for (const i of l.partners?.invitations ?? []) {
      if (i.status === 'pending' && i.to.toLowerCase() === me) out.push({ l, i });
    }
  }
  return out;
}

/** The action this page is waiting on, so its button keeps saying so. */
let working: { key: string; label?: string } | null = null;

/** Invitations this player has already been told about, so each is announced once. */
const toldOf = new Set<string>();

/**
 * An invitation can arrive while the player is anywhere in the app, so it is
 * shown as a banner rather than inside the partners dialog, and announced the
 * way the start of a tournament is.
 */
/** One invitation, one answer, one key \u2014 whichever button is pressed. */
const answerKey = (number: number, from: string, yes: boolean): string =>
  `${yes ? 'accept' : 'decline'}:${number}:${from.toLowerCase()}`;

function inviteBanner(): HTMLElement | null {
  const waiting = invitesForMe();
  const fresh = waiting.filter(({ l, i }) => !toldOf.has(`${l.number}:${i.from}`));
  if (fresh.length) {
    for (const { l, i } of fresh) toldOf.add(`${l.number}:${i.from}`);
    const { l, i } = fresh[0] as { l: Listing; i: Invitation };
    announceInvite(who(l, i.from), l.meta.name);
  }
  if (!waiting.length) return null;
  const d = directory();
  /*
   * Answering goes to the page and back, which is a second or two. The button
   * says so from the click rather than at the end of it, and the key survives
   * the redraws in between, so a banner rebuilt while the answer is in flight
   * comes back still waiting rather than looking untouched.
   */
  const answer = (number: number, from: string, yes: boolean, e?: Event): void => {
    if (!d) return;
    const key = answerKey(number, from, yes);
    if (working?.key === key) return;
    working = { key, label: yes ? 'Accepting\u2026' : 'Declining\u2026' };
    const btn = e?.currentTarget;
    if (btn instanceof HTMLButtonElement) markBusy(btn, working.label);
    /* The same answer has a button in the players list as well, and it is the
       answer that is waiting rather than the button that was pressed. */
    render();
    void (async () => {
      try {
        await d.respondToInvite(number, from, yes);
        await refresh();
      } catch (e2) { fail(e2); } finally {
        if (working?.key === key) { working = null; render(); }
      }
    })();
  };
  /** The same look, put back on a button whose answer has not come yet. */
  const stillWaiting = (key: string, btn: HTMLElement): HTMLElement => {
    if (working?.key === key && btn instanceof HTMLButtonElement) markBusy(btn, working.label);
    return btn;
  };
  return h('div.invites', waiting.map(({ l, i }) => h('div.invite',
    h('div.invite-what',
      h('b', who(l, i.from)), ' wants to play with you in ', h('b', l.meta.name), ' ', untilTag(l.meta.startUtc) ?? '', '.',
      i.note ? h('div.muted', i.note) : null),
    h('div.row',
      stillWaiting(answerKey(l.number, i.from, true),
        h('button.primary', { onclick: (e: Event) => answer(l.number, i.from, true, e) }, 'Accept')),
      stillWaiting(answerKey(l.number, i.from, false),
        h('button.danger', { onclick: (e: Event) => answer(l.number, i.from, false, e) }, 'Decline')),
      h('button.link', { onclick: () => openPartners(l) }, 'Partners List')))));
}

/*
 * An invitation is worth hearing about, but several arriving together are
 * not worth hearing about several times over: one is spoken, and nothing
 * else is for the next ten seconds. The moment is kept in this browser, so
 * the quiet holds across tabs and across a reload.
 */
const INVITE_VOICE_GAP_MS = 10_000;
const INVITE_VOICE_KEY = 'bridge-p2p:invite-said';

function sayInvite(from: string, tournament: string): void {
  let last = 0;
  try { last = Number(localStorage.getItem(INVITE_VOICE_KEY)) || 0; } catch { /* no storage */ }
  const now = Date.now();
  if (now - last < INVITE_VOICE_GAP_MS) return;
  try { localStorage.setItem(INVITE_VOICE_KEY, String(now)); } catch { /* no storage */ }
  say(`${from} has invited you to play as partners in ${tournament}.`);
}

/** A chime, a word, and a flag in the tab's title for a player looking elsewhere. */
function announceInvite(from: string, tournament: string): void {
  turnChime();
  sayInvite(from, tournament);
  if (!document.hidden) return;
  const plain = document.title;
  document.title = `\u{1F91D} ${from} invited you`;
  const back = (): void => {
    if (document.hidden) return;
    document.title = plain;
    document.removeEventListener('visibilitychange', back);
  };
  document.addEventListener('visibilitychange', back);
}

/** "4 online", in the header: people with the site open right now. */
function onlineTag(): HTMLElement | null {
  if (settings.transport === 'local') return null;
  const n = online();
  const shown = n > LIMIT ? `${LIMIT}+` : String(n);
  return h('span.online', {
    'data-tip': n === 1
      ? 'You are the only one here right now. The number counts everyone with Bridge Break open.'
      : `${shown} people have Bridge Break open right now, you included.`,
    'aria-label': `${shown} online`,
  }, h('span.dot'), `${shown} online`);
}

/** How to enter a listed tournament's room. */
const roomInfoOf = (l: Listing): RoomInfo => ({
  id: l.roomId, name: l.meta.name, boardsPerRound: l.meta.boardsPerRound, rounds: l.meta.rounds, capacity: l.meta.capacity, listing: l, demo: false,
});

/**
 * A registered player with the site open anywhere is taken to their table
 * when their tournament starts, without having to click anything.
 */
function autoSeat(): void {
  if (room || node || session || !listings) return;
  const me = myId();
  if (!me) return;
  for (const l of listings) {
    if (l.status !== 'in progress' || !l.pinned) continue;
    const gone = leftAt.get(l.number);
    if (gone !== undefined && gone >= Date.parse(l.pinned.at)) continue;
    /* Long under way: they can still go in themselves, but are not pulled in. */
    if (Date.now() - Date.parse(l.pinned.at) > 30 * 60000) continue;
    if (!pinnedRoster(l).some((r) => r.login.toLowerCase() === me)) continue;
    notice = `${l.meta.name} has started \u2014 you have been taken to your table.`;
    announceStart(l.meta.name);
    void enterRoom(roomInfoOf(l));
    return;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * Reload the tournament list. `expect` is the number of a tournament just
 * created: the list takes a moment to catch up with a brand new one, so
 * rather than showing a list without it, wait and ask again.
 */
async function refresh(expect?: number): Promise<void> {
  const d = directory();
  if (!d) { listings = null; render(); return; }
  loading = true; errorMsg = null; render();
  lastRefresh = Date.now();
  try {
    /* Drawn as soon as the tournaments themselves are known, then again as
       the entry lists come in behind them. */
    listings = await d.list(Date.now(), (partial) => {
      listings = partial;
      loading = false;
      render();
    });
    for (let tries = 0; expect !== undefined && tries < 8; tries++) {
      if (listings.some((l) => l.number === expect)) break;
      await sleep(900);
      listings = await d.list();
    }
    if (detail) {
      let updated = listings.find((l) => l.number === detail?.number) ?? detail;
      updated = await applyAutoRegister(d, updated);
      syncListing(updated);
    }
    await sweepAbandoned(d);
    /* Weekly tournaments: once this week's has begun, put next week's up. */
    d.due = d.due.filter((n) => !continued.has(n));
    for (const n of d.due) continued.add(n);
    if (await d.continueSeries()) {
      await sleep(1500);
      listings = await d.list();
      d.due = [];
    }
  } catch (e) {
    errorMsg = (e as Error).message;
    /* Asked too often: stop asking until it will answer again, and leave the
       list we already have on screen rather than replacing it with an error. */
    const until = e instanceof GitHubError ? e.resetAt : null;
    if (until) quietUntil = until.getTime() + 2000;
  }
  loading = false; render();
  notePartnershipChanges();
  autoSeat();
}

/** Weekly tournaments this page has already asked to continue, so it asks once. */
const continued = new Set<number>();

/** Tournaments a sweep has already dealt with, or tried and failed to. */
const sweptAlready = new Set<number>();

/**
 * Clear abandoned tournaments off GitHub, not merely out of the list. Only
 * someone holding a token can do this, and an issue is tried once per session
 * so that a failure does not turn every refresh into another attempt.
 */
async function sweepAbandoned(d: Directory): Promise<void> {
  if (!d.canWrite) return;
  d.abandoned = d.abandoned.filter((l) => !sweptAlready.has(l.number));
  if (d.abandoned.length === 0) return;
  for (const l of d.abandoned) sweptAlready.add(l.number);

  const done = await d.sweepAbandoned();
  const gone = done.filter((x) => x.outcome !== 'failed');
  if (gone.length === 0) return;
  /* Tidying up after tournaments nobody played is housekeeping, and a player
     opening the page has no use for a list of them. It is noted for whoever
     is looking at the console and nowhere else. */
  console.info(`Bridge Break: cleared ${gone.length} abandoned tournament(s): ${gone.map((x) => x.name).join(', ')}`);
  listings = await d.list();
}

/** The countdown as an element, for wherever a tournament is named. */
const untilTag = (startUtc: string): HTMLElement | null => {
  const t = countdown(startUtc);
  return t ? h('span.until', { 'data-tip': 'Hours and minutes until this tournament starts', 'aria-label': `starts in ${t}` }, t) : null;
};

function when(l: Listing): HTMLElement {
  const d = new Date(l.meta.startUtc);
  const mine = localTimeZone();
  const soon = untilTag(l.meta.startUtc);
  return h('div', formatInZone(d, l.meta.timeZone), soon ? [' ', soon] : null,
    mine !== l.meta.timeZone ? h('div.muted', `${formatInZone(d, mine)} (your time)`) : null);
}

const badge = (status: string): HTMLElement => h(`span.badge.${status.replace(' ', '-')}`, status);
/*
 * How many are in it. While there is still room to join, the capacity is the
 * other half of the answer; once it is over, the number who played is the
 * whole of it — and that can be counted from the result even where the entry
 * list was never read.
 */
const playersCell = (l: Listing): string => {
  const done = l.status === 'finished' || l.status === 'abandoned' || l.status === 'cancelled';
  /* Once it is over, the result says who played it, which is the truer
     number: somebody may have entered and never sat down. */
  const played = l.results ? l.results.rankings.length * 2 : null;
  const entered = l.registrations ? l.registrations.length : null;
  const n = done ? played ?? entered : entered;
  return done ? `${n ?? '?'}` : `${n ?? '?'} / ${l.meta.capacity}`;
};
/** Why a list of hundreds shows a question mark instead of a number. */
const PLAYERS_LATER = 'The entry list is read closer to the start, and whenever you open the tournament. Open it to see who has entered.';

/** What becomes of you if you enter without a partner, shown wherever you enter. */
const PARTNERING_NOTE = 'Registered players without a partner will be assigned a player at random (or a robot if no partner is available).';

/** Still to be played, and with room for another player. */
const openToJoin = (l: Listing): boolean =>
  (l.status === 'upcoming' || l.status === 'starting') && (l.registrations?.length ?? 0) < l.meta.capacity;

let onlyOpen = false;

/**
 * The list is kept in four parts, so a player sees what is about to happen
 * without scrolling past what already has. Which parts are open is remembered
 * here, because the page redraws itself whenever the list is read again.
 */
const PANELS = [
  { key: 'pending', title: 'Pending', open: true, holds: (st: Status) => st === 'upcoming' || st === 'starting' },
  { key: 'running', title: 'Running', open: true, holds: (st: Status) => st === 'in progress' },
  { key: 'finished', title: 'Finished', open: false, holds: (st: Status) => st === 'finished' },
  { key: 'cancelled', title: 'Cancelled', open: false, holds: (st: Status) => st === 'cancelled' || st === 'abandoned' },
] as const;
const panelOpen: Record<string, boolean> = {};

/* Neither the director nor the result is here: both are on the tournament's
   own page, which is where somebody who wants them is going anyway. A column
   that is a dash on every tournament still to be played is a column of
   dashes, and who created one says nothing about whether to enter it. */
/* No status of its own: the list is grouped by it, and the one that changes
   while somebody is looking — a tournament going off — is shown on its name. */
const LIST_COLUMNS = ['Tournament', 'Start / Type', 'Boards', 'Level', 'Players'];

/** How many boards a tournament plays in all, and how they are divided up. */
const boardCount = (meta: { rounds: number; boardsPerRound: number }): number => meta.rounds * meta.boardsPerRound;

/** Tournaments this player has entered that this one would run into. */
function clashesWith(l: Listing): Listing[] {
  const me = myId();
  if (!me) return [];
  return (listings ?? []).filter((o) => o.number !== l.number && o.status !== 'finished' && o.status !== 'cancelled'
    && !!o.registrations?.some((r) => r.login.toLowerCase() === me) && overlap(l.meta, o.meta));
}

/** How late a tournament is expected to run, in the reader's own time. */
const endsAt = (l: Listing): string =>
  formatInZone(new Date(Date.parse(l.meta.startUtc) + expectedLength(l.meta)), localTimeZone());

/**
 * Ask before entering a tournament that runs into one already entered. The
 * length is an estimate, so this is a warning and not a refusal: a player who
 * knows better than the estimate may go ahead.
 */
function askAboutClash(l: Listing, go: () => void): void {
  const clash = clashesWith(l);
  if (!clash.length) { go(); return; }
  dialog('These overlap', (close) => h('div',
    h('p', `${l.meta.name} is expected to run until about ${endsAt(l)}.`),
    h('p', clash.length === 1 ? 'You are already entered for:' : 'You are already entered for:'),
    h('ul', clash.map((o) => h('li', `${o.meta.name} — starts ${formatInZone(new Date(o.meta.startUtc), localTimeZone())}, expected to run until about ${endsAt(o)}`))),
    h('p.muted', `Reckoned at ${BOARD_MINUTES} minutes a board and ${BETWEEN_ROUNDS_MINUTES} between rounds, so it is an estimate rather than a promise.`),
    h('div.row', h('span.spacer'),
      h('button', { onclick: close }, 'Cancel'),
      h('button.primary', { onclick: () => { close(); go(); } }, 'Enter Anyway'))));
}
/* "3 rounds x 3 boards": the arithmetic of the number beside it, written the
   way a player would say it rather than as a sentence. */
const boardsText = (meta: { rounds: number; boardsPerRound: number }): string =>
  `${meta.rounds} round${meta.rounds === 1 ? '' : 's'} x ${meta.boardsPerRound} board${meta.boardsPerRound === 1 ? '' : 's'}`;

function listTable(rows: Listing[]): HTMLElement {
  return h('div.table-scroll', h('table.list',
    h('thead', h('tr', LIST_COLUMNS.map((t) => h(t === 'Players' || t === 'Boards' ? 'th.num' : 'th', t)))),
    h('tbody', rows.map((l) => h('tr',
      h('td', h(`button.open${l.status === 'starting' ? '.starting' : ''}${l.meta.lock ? '.locked' : ''}`, {
        title: `${l.status === 'starting' ? 'Starting now — go to this tournament' : 'Go to this tournament'}${l.meta.lock ? ' [Password-Protected]' : ''}`,
        onclick: () => { location.hash = `t=${l.number}`; },
      }, l.meta.lock ? `\u{1F512} ${l.meta.name}` : l.meta.name)),
      /* Two lines in the width of one: the name button has made the row tall
         enough to hold them, and what a tournament is matters less than when
         it starts. */
      h('td', h('div', when(l)), h('div.muted', scoringName(l.meta.scoring))),
      h('td.num', { 'data-tip': boardsText(l.meta), 'aria-label': `${boardCount(l.meta)} boards: ${boardsText(l.meta)}` },
        String(boardCount(l.meta))),
      h('td', levelText(l.meta)),
      h('td.num', l.registrations ? {} : { 'data-tip': PLAYERS_LATER, 'aria-label': PLAYERS_LATER }, playersCell(l)),
    )))));
}

function panel(key: string, title: string, fallback: boolean, body: Node, count: number): HTMLElement {
  const open = panelOpen[key] ?? fallback;
  return h('details.acc', {
    open,
    ontoggle: (e: Event) => { panelOpen[key] = (e.target as HTMLDetailsElement).open; },
  }, h('summary', h('span.acc-title', title), h('span.acc-count', String(count))), body);
}

function directoryView(): HTMLElement {
  const d = directory();
  const body = h('div.panel');
  if (!d) {
    body.append(h('p', 'No tournament directory is configured. You can still try a demo table against robots.'));
  } else if (loading && !listings) {
    body.append(h('p.muted', 'Loading tournaments\u2026'));
  } else if (listings) {
    const shown = onlyOpen ? listings.filter(openToJoin) : listings;
    for (const p of PANELS) {
      const rows = shown.filter((l) => p.holds(l.status));
      /* Pending is always there, so the page never looks empty and the
         'nothing here yet' line has somewhere to live. */
      if (rows.length === 0 && p.key !== 'pending') continue;
      const inside: Node = rows.length
        ? listTable(rows)
        : h('p.muted', { style: 'margin:10px 2px' },
          listings.length === 0 ? 'No tournaments yet. Be the first to create one.'
            : onlyOpen ? 'None open for registration right now.'
              : 'Nothing coming up.');
      body.append(panel(p.key, p.title, p.open, inside, rows.length));
    }
    if (onlyOpen && !shown.length) {
      body.append(h('p', { style: 'margin:10px 2px' },
        h('button.link', { onclick: () => { onlyOpen = false; render(); } }, 'Show All Tournaments')));
    }
  }
  return h('div',
    h('div.row', { style: 'margin-bottom:10px' },
      h('h2', 'Tournaments'),
      h('span.spacer'),
      d ? h('label.check', { title: 'Show only tournaments that have not started and still have room' },
        h('input', { type: 'checkbox', checked: onlyOpen, onchange: (e: Event) => { onlyOpen = (e.target as HTMLInputElement).checked; render(); } }),
        ' Open for Registration') : null,
      h('button', { onclick: joinByCode, title: 'Play with specific people using a shared room code, instead of an open tournament from the list above — good for a private game with friends or a quick test with nothing to sign up for.' }, 'Join Private Room'),
      h('button', { onclick: startDemo }, 'Play a Demo vs Robots'),
      !d ? null : d.canWrite
        ? h('button.primary', { onclick: openCreate }, 'New Tournament')
        /* Only a token can write a tournament into the list. The tooltip hangs
           on a wrapper, since a disabled button is sent no mouse events. */
        : h('span.tip', { title: DIRECTOR_NOTE }, h('button.primary', { disabled: true }, 'New Tournament'))),
    body);
}

/** The hours of the day, as a person reads them. */
const HOURS: readonly { hour: number; name: string }[] = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  name: `${hour === 0 || hour === 12 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`,
}));

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** How the tournament gets going, said in terms of this one's numbers. */
function startNote(l: Listing): string | null {
  const plan = l.plan;
  if (l.status === 'upcoming') {
    /* The whole of the waiting rule used to be set out here, and it ran to
       four lines above a page whose point is the list of players. What a
       player needs to know before the start is that turning up is enough;
       the rest is said at the time, by the lines below, when it is the thing
       actually happening. */
    return 'Tournaments with at least 1 registration always play! '
      + `Robots provide at least ${MIN_TABLES} tables.`;
  }
  if (l.status === 'starting' && plan?.kind === 'wait') {
    const n = l.registrations?.length ?? 0;
    if (Date.now() >= plan.until) return 'Entries have closed. Settling the field and the deals…';
    if (n < MIN_PLAYERS) return `Looking for ${MIN_PLAYERS} players: ${n} so far. Entries stay open until ${clock(plan.until)}, then it starts with whoever is here and robots in the empty seats.`;
    const short = n % 4;
    return `Entries close at ${clock(plan.until)} — later if somebody else joins before then.`
      + (short ? ` ${short === 3 ? 'One more player' : `${4 - short} more players`} would fill the last table, and start it straight away.`
        : ' It starts as soon as the tables come out even.');
  }
  return null;
}

/**
 * The countdown, said aloud as it moves. A player waiting for a tournament to
 * fill has no reason to watch the page, so the number still wanted, each
 * extension of the deadline and the close of entries are spoken — once each,
 * and only for a tournament this player has entered.
 */
let saidNote = '';
function countdownCue(l: Listing | null | undefined, mine: boolean): void {
  if (!l || !mine || l.status !== 'starting') return;
  const note = startNote(l);
  if (!note || note === saidNote) return;
  saidNote = note;
  say(note);
}

const weekdayOf = (l: Listing): string =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: l.meta.timeZone }).format(new Date(l.meta.startUtc));

/** Whoever can edit the tournament's page: its author, or the repository owner. */
function canStop(l: Listing): boolean {
  const d = directory();
  const me = settings.githubLogin.trim().toLowerCase();
  if (!d?.canWrite || !me) return false;
  return l.initiatorLogin.toLowerCase() === me || settings.repo.split('/')[0]?.toLowerCase() === me;
}

/**
 * Boards of the director's own. A tournament deals itself from a seed every
 * browser shares, which is what makes it serverless; a director who wants
 * particular boards — a club's set, a lesson, a hand from a book — brings a
 * file instead, and it goes on the tournament's page for everybody to deal
 * from. Only before it starts: boards cannot change under a field playing
 * them.
 */
async function uploadBoards(l: Listing, file: File): Promise<void> {
  const d = directory();
  if (!d) return;
  const want = boardCount(l.meta);
  try {
    const deals = readBoards(await file.text());
    if (deals.length < want) {
      throw new BoardError(`This tournament plays ${want} boards and that file has ${deals.length}.`);
    }
    await d.setBoards(l.number, deals.slice(0, want));
    notice = deals.length > want
      ? `${want} boards set from ${file.name}; the rest of the file was left out.`
      : `${want} boards set from ${file.name}.`;
    await refresh(l.number);
  } catch (e) { fail(e); }
}

async function clearBoards(l: Listing): Promise<void> {
  const d = directory();
  if (!d) return;
  try {
    await d.setBoards(l.number, []);
    notice = 'This tournament will deal its own boards again.';
    await refresh(l.number);
  } catch (e) { fail(e); }
}

/** The director's own row of board controls, on a tournament not yet played. */
function boardControls(l: Listing): HTMLElement | null {
  /* Only while it is still to be played: boards cannot change under a field
     playing them, and a tournament that is over is a record. */
  if (!canStop(l) || l.pinned || l.results || (l.status !== 'upcoming' && l.status !== 'starting')) return null;
  const pick = h('input', {
    type: 'file', accept: '.pbn,.lin,text/plain', style: 'display:none',
    onchange: (e: Event) => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      input.value = '';
      if (file) void uploadBoards(l, file);
    },
  }) as HTMLInputElement;
  /* Beside the boards they act on rather than under them: one short line of
     a fact does not need a line of its own underneath for its button. */
  return h('span.row.inline',
    pick,
    h('button', {
      /* Both states open the file picker, so both tooltips say so. Going back
         to dealt hands is the other control, and says that there. */
      title: l.boards
        ? 'Upload a different PBN/LIN file to play instead of the boards you uploaded'
        : 'Optional! Instead of defaulting to random hands, you may upload a PBN/LIN file',
      onclick: () => pick.click(),
    }, l.boards ? 'Replace the Boards' : 'Upload Boards'),
    l.boards ? h('button.link', {
      title: 'Revert the boards to randomly dealt hands',
      onclick: () => void clearBoards(l),
    }, 'Deal Them Instead') : null);
}

/** Stop the series: this one and any later one already on the list stop repeating. */
async function stopSeries(l: Listing): Promise<void> {
  const d = directory();
  if (!d) return;
  const key = l.meta.seriesId ?? l.number;
  const these = (listings ?? [l]).filter((x) => (x.meta.seriesId ?? x.number) === key
    && x.meta.repeat === 'weekly' && x.meta.startUtc >= l.meta.startUtc);
  if (!these.some((x) => x.number === l.number)) these.push(l);
  try {
    for (const x of these) await d.stopRepeating(x);
    notice = 'This tournament will not repeat after this one.';
    await refresh();
  } catch (e) { fail(e); }
}

function detailView(l: Listing): HTMLElement {
  const d = directory() as Directory;
  const myLogin = myId();
  const regs = l.registrations;
  const amRegistered = !!myLogin && !!regs?.some((r) => r.login.toLowerCase() === myLogin);
  const full = !!regs && regs.length >= l.meta.capacity;
  countdownCue(l, amRegistered);
  const open = l.status === 'upcoming' || l.status === 'starting' || l.status === 'in progress';
  /*
   * An action holds its button until the page has the answer. Marking the
   * button on the click alone is not enough: the page is redrawn from what
   * it already knows while the write is still in the air, and the button
   * would come back as it was for a moment before changing for good. So the
   * action is remembered by name and the look is put on again each time it
   * is drawn, until the news arrives.
   */
  const act = (fn: () => Promise<unknown>, done: string, busy?: { key: string; label?: string }) =>
    async (e?: Event): Promise<void> => {
      if (busy) working = busy;
      const btn = e?.currentTarget;
      if (btn instanceof HTMLButtonElement) markBusy(btn, busy?.label);
      /* Whatever else on the page is this same action waiting too. */
      if (busy) render();
      try { await fn(); notice = done; await refresh(); } catch (err) { fail(err); } finally {
        if (busy && working?.key === busy.key) { working = null; render(); }
      }
    };

  /** The same look, put back on a button that is still waiting for its answer. */
  const waiting = (key: string, btn: HTMLElement): HTMLElement => {
    if (working?.key === key && btn instanceof HTMLButtonElement) markBusy(btn, working.label);
    return btn;
  };

  // The partner of a registered player, by whoever else is registered under the same code.
  const partnerNameOf = (r: { login: string; pairCode?: string }): string | null => {
    if (!r.pairCode) return null;
    const code = r.pairCode.trim().toLowerCase();
    return regs?.find((o) => o.login !== r.login && o.pairCode?.trim().toLowerCase() === code)?.name ?? null;
  };

  /**
   * The last cell of a registered player's row: who they are playing with, or
   * a way to ask them. Two players who already know each other can pair up
   * here without going near the partner list.
   */
  /* Who a registered player is playing with, where it is settled: an accepted
     invitation says so at once, and a shared pair code covers partners who
     arranged themselves by other means. */
  const pairedWith = (r: { login: string; pairCode?: string }): string | null => {
    const agreed = (l.partners?.invitations ?? []).find((i) => i.status === 'accepted'
      && (i.from.toLowerCase() === r.login.toLowerCase() || i.to.toLowerCase() === r.login.toLowerCase()));
    const other = !agreed ? null : agreed.from.toLowerCase() === r.login.toLowerCase() ? agreed.to : agreed.from;
    return other ? who(l, other) : partnerNameOf(r);
  };

  /**
   * A registered player's name, with their level and description on hover and
   * on click, as at the table: you can see who you are playing with before you
   * sit down. The description is the one they gave on the partner list, which
   * is the only place a player writes one for a tournament.
   */
  const nameCell = (r: { login: string; name: string; skill?: Skill; systems?: SystemPref; pairCode?: string }): Node => {
    const partner = pairedWith(r);
    const note = l.partners?.notes[r.login.toLowerCase()];
    const tip = [r.name, `Level: ${r.skill || 'not given'}`, `Bidding: ${r.systems || 'not given'}`,
      `Description: ${note || 'none'}`, ...(partner ? [`Partner: ${partner}`] : [])].join('\n');
    const show = (): void => openPlayerInfo({
      name: r.name, robot: false,
      ...(r.skill ? { skill: r.skill } : {}), ...(r.systems ? { systems: r.systems } : {}),
      ...(note ? { note } : {}), ...(partner ? { partner } : {}),
    });
    return h('span.pname', {
      role: 'button', tabindex: 0, 'data-tip': tip, 'aria-label': tip, onclick: show,
      onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); } },
    }, r.name);
  };

  const partnerCell = (r: { login: string; name: string; pairCode?: string }): Node | string => {
    const partner = pairedWith(r);
    if (partner) {
      /* On your own row, the way into your partnership: the pair's chat and
         the card they show the table. There is no reason to go looking for it
         in a list of players who are all paired up already. */
      const mine = r.login.toLowerCase() === myLogin && myPartnerLogin;
      return mine
        ? h('div.row', h('span', `Partner: ${partner}`),
          h('button.link', { title: 'Talk to your partner, and agree the system and description your table will see.',
            onclick: () => openPartnership(l, myPartnerLogin) }, 'Chat [Partnership]'))
        : `Partner: ${partner}`;
    }
    const them = r.login.toLowerCase();
    /* Nothing to say in your own partner column while you have no partner:
       the name is already marked as yours in the row beside it. */
    if (them === myLogin) return '—';
    /* Only a registered player with no partner of their own can ask. */
    if (!open || !amRegistered || !myLogin || myPartnerLogin || !d.canAct) return '';
    const invites = l.partners?.invitations ?? [];
    const mine = (i: Invitation): boolean => i.status === 'pending' && i.from.toLowerCase() === myLogin && i.to.toLowerCase() === them;
    const theirs = (i: Invitation): boolean => i.status === 'pending' && i.to.toLowerCase() === myLogin && i.from.toLowerCase() === them;
    if (invites.some(theirs)) {
      return h('div.row',
        h('span', 'Invited you:'),
        /* The same answer has a button here and another in the banner at the
           top of the page; one key for both, so pressing either shows both
           waiting rather than leaving the twin looking untouched. */
        waiting(answerKey(l.number, r.login, true), h('button.primary', { onclick: act(() => d.respondToInvite(l.number, r.login, true), `You and ${r.name} are partners.`, { key: answerKey(l.number, r.login, true), label: 'Accepting\u2026' }) }, 'Accept')),
        waiting(answerKey(l.number, r.login, false), h('button.danger', { onclick: act(() => d.respondToInvite(l.number, r.login, false), 'Invitation declined.', { key: answerKey(l.number, r.login, false), label: 'Declining\u2026' }) }, 'Decline')));
    }
    if (invites.some(mine)) {
      return h('div.row', h('span.muted', 'Invitation sent'),
        waiting(`cancel:${them}`, h('button.link.danger', { onclick: act(() => d.cancelInvite(l.number, r.login), 'Invitation cancelled.', { key: `cancel:${them}` }) }, 'Cancel')));
    }
    return waiting(`invite:${them}`, h('button', {
      title: `Ask ${r.name} to be your partner for this tournament.`,
      onclick: act(() => d.invitePartner(l.number, r.login), `Invitation sent to ${r.name}.`, { key: `invite:${them}` }),
    }, 'Invite to Partner'));
  };

  const myAcceptedInvite = l.partners?.invitations.find((i) =>
    i.status === 'accepted' && !!myLogin && (i.from.toLowerCase() === myLogin || i.to.toLowerCase() === myLogin));
  const myPartnerLogin = myAcceptedInvite
    ? (myAcceptedInvite.from.toLowerCase() === myLogin ? myAcceptedInvite.to : myAcceptedInvite.from)
    : null;

  const actions = h('div.row');
  /* A tournament set aside for particular levels of player. Saying so plainly
     is kinder than letting somebody register and be turned away later. */
  const welcome = amRegistered || welcomes(l.meta, settings.skill);
  /* Why the page is read-only, said once at the top where it is read first,
     and again on the button that is greyed out. */
  const whyNot = !open || welcome ? null : settings.skill === ''
    ? `This tournament is for ${levelPhrase(l.meta)}. Set your skill level in Settings, and if it matches you are very welcome to register here.`
    : `This tournament is for ${levelPhrase(l.meta)}, and your settings say ${settings.skill}, so registration is closed for this one. Do have a look at the others on the list — or start a private room and play with whoever you invite.`;
  if (whyNot) {
    /* The tooltip hangs on the wrapper: a disabled button receives no mouse
       events of its own, so a title on it is never shown. */
    actions.append(h('span.tip', { title: whyNot }, h('button.primary', { disabled: true }, 'Register')),
      h('span.muted', 'Not open to your level.'));
  }
  if (open && welcome && myPartnerLogin && d.canAct) {
    actions.append(h('span.tip', { title: `End your partnership with ${who(l, myPartnerLogin)}. You both stay in the tournament, and either of you can find somebody else.` },
      h('button', { onclick: () => void endPartnership(l, myPartnerLogin) }, 'Cancel Partnership')));
  }
  if (open && welcome) {
    if (d.canAct) {
      actions.append(amRegistered
        ? waiting('withdraw', h('button.danger', { onclick: act(async () => {
            await d.withdraw(l.number);
            // Unregistering breaks the partnership too, so the ex-partner's own browser
            // stops treating us as accepted-and-should-auto-register, and sees we split up.
            if (myPartnerLogin) await d.unpair(l.number, myPartnerLogin);
          }, 'You have unregistered.', { key: 'withdraw', label: 'Unregistering…' }) }, 'Unregister'))
        : waiting('register', h('button.primary', { title: PARTNERING_NOTE, disabled: full || !settings.name.trim(), onclick: (e: Event) => {
          const btn = e.currentTarget;
          askAboutClash(l, () => {
            const go = (password: string): void => {
              if (btn instanceof HTMLButtonElement) markBusy(btn, 'Registering…');
              void act(async () => {
                try {
                  await d.register(l.number, settings.name, settings.pairCode, settings.skill, settings.systems, password);
                } catch (x) {
                  /* A password that is not taken is not worth keeping. */
                  if (password) forgetPassword(l.number);
                  throw x;
                }
                if (password) rememberPassword(password, l.number);
              }, 'You are registered.', { key: 'register', label: 'Registering…' })();
            };
            /* A token is no way past this: the password is what the relay
               asks for, and the relay is what makes an entry count. */
            if (l.meta.lock) askPassword(l, go); else go('');
          });
        } }, full ? 'Full' : 'Register')));
    } else {
      actions.append(h('a', { href: l.url, target: '_blank', rel: 'noopener', title: PARTNERING_NOTE }, 'Register on the Tournament Page'),
        h('span.muted', `(comment “/register ${settings.name.trim() || 'Your Name'}”, or add a token in Settings to register from here)`));
    }
    /*
     * Only while there is a table to go to. Before the start this said
     * "enter" for a room the app takes everybody into by itself; once play is
     * under way it is the only way back for somebody who left, or who came
     * back after the half hour the automatic seating gives up at — and the
     * way a latecomer joins, by taking over a seat a robot is playing.
     */
    if (l.status === 'in progress' && l.pinned) {
      const seated = !!myLogin && pinnedRoster(l).some((r) => r.login.toLowerCase() === myLogin);
      actions.append(h('button.primary', {
        disabled: !settings.name.trim(),
        title: seated ? 'Go back to your table.'
          : 'Join by taking over a seat where a robot is playing for somebody who dropped out.',
        onclick: () => { leftAt.delete(l.number); void enterRoom(roomInfoOf(l)); },
      }, seated ? 'Return to Your Table' : 'Take Over a Robot\u2019s Seat'));
    }
  }
  if (open && welcome) {
    const seeking = l.partners?.seekers.length;
    actions.append(h('button', {
      /* Finding a partner is something a player in the tournament does:
         inviting anybody from here needs an entry of your own first. */
      disabled: !amRegistered,
      onclick: () => openPartners(l),
      title: amRegistered
        ? 'Players looking for a partner for this tournament'
        : 'Register first — then you can look for a partner, and be found.',
    }, seeking === undefined ? 'Partners List' : `Partners List [${seeking}]`));
  }
  if (!settings.name.trim()) actions.append(h('span.muted', 'Set your name in Settings first.'));

  return h('div',
    /* No link out to the underlying page here: everything on it can be done
       from this view, and where it cannot — registering without a token — the
       link sits with the action it belongs to. */
    h('div.row.backrow',
      h('button.open.inline', { onclick: () => { location.hash = ''; } }, '← All Tournaments'),
      noticeTag()),
    whyNot ? h('div.note', { style: 'margin-top:10px' }, whyNot) : null,
    l.noPlayers ? h('div.note', { style: 'margin-top:10px' },
      'Cancelled: nobody had registered by the time entries closed.') : null,
    h('div.panel', { style: 'margin-top:10px' },
      /* The name, how it stands and when it starts, all on the line that is
         read first: a page whose facts run down a column in ones pushes the
         players who have entered off the bottom of the window, and they are
         what somebody comes here to see. */
      h('div.row.titlerow', h('h2', l.meta.name), badge(l.status),
        h('span.startline', when(l), h('span.muted', ` ${l.meta.timeZone}`))),
      h('dl.facts.pairs',
        h('dt', 'Director'), h('dd', `${l.meta.director} (@${l.initiatorLogin})`),
        /* How many are in and how many it holds is one fact, not two. */
        /* When it is not known, say that it is not known. The reason is the
           one the service gave, and it goes below where there is room for it,
           rather than being guessed at in four words here. */
        h('dt', 'Players'), h('dd', { title: regs ? '' : l.readError ?? '' }, regs
          ? `${regs.length} of ${l.meta.capacity}${full ? ' \u2014 full' : ''}`
          : `? of ${l.meta.capacity}${l.skimmed ? ' (still loading)' : ''}`),
        h('dt', 'Type'), h('dd', `${scoringName(l.meta.scoring)} \u00b7 robots bid ${l.meta.robots === '2/1' ? '2/1' : 'SAYC'}`),
        h('dt', 'Open to'), h('dd', levelText(l.meta),
          l.meta.lock ? h('span', ` \u00b7 \u{1F512} password needed${rememberedPassword(l.number) ? ' (you have it)' : ' \u2014 ask the director'}`) : null),
        h('dt', 'Boards'), ((controls) => h('dd', `${boardCount(l.meta)}:  ${boardsText(l.meta)}`,
          l.boards ? h('span.muted', ` \u00b7 from the director's own file${controls ? ', and can still be changed' : ''}`) : null,
          controls))(boardControls(l)),
        l.meta.repeat === 'weekly' ? [h('dt', 'Repeats'), h('dd', `Every ${weekdayOf(l)} at the same time`,
          canStop(l) ? [' ', h('button.link.danger', { onclick: () => void stopSeries(l) }, 'Stop Repeating')] : null)] : null),
      /* How the tournament gets going sits beside the button that puts you in
         it rather than on a line of its own above the panel: it is about
         that button, and a line to itself was a line of the page spent. */
      ((note) => { if (note) actions.append(h('span.startnote.muted', note)); return null; })(startNote(l)),
      actions,
      /* Said once, in full, where it can be read and reported. */
      l.readError ? h('div.error', { style: 'margin-top:10px' },
        `The entry list could not be read, so this page cannot tell who has registered. ${l.readError}`) : null),
    l.results
      ? h('div.panel', { style: 'margin-top:14px' },
          h('div.row', h('h3', 'Final Results'), h('span.spacer'),
            /* The hands outlive the session that played them, so a player can
               go back over a board a week later, from any browser. */
            l.records
              ? h('button.open.inline', {
                  onclick: () => openPastRecords(l),
                  title: 'The deal, the bidding at every table and what it scored, board by board',
                }, pastRecords?.number === l.number ? 'Hide Hand Records' : 'Show Hand Records')
              : null),
          resultsTable(l.results))
      : null,
    l.results ? pastRecordsPanel(l) : null,
    h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Registered Players'),
      regs && regs.length ? h('div.table-scroll', h('table.list',
        h('thead', h('tr', h('th.num', ''), h('th', 'Player'), h('th', 'Level'), h('th', 'Bidding'), h('th', 'Partner'), h('th', ''))),
        /*
         * Strongest first, and players of a system together within that: the
         * list is read to find somebody to play with, and that is the order
         * the question is asked in. The number stays the one they entered
         * under, because it is what decides who has a seat and who is on the
         * waiting list — sorting the rows must not move anybody up the queue.
         */
        h('tbody', byLevelThenSystem(regs).map(({ r, entry }) => h('tr',
          h('td.num', entry + 1), h('td', nameCell(r)),
          h('td.muted', r.skill ?? ''),
          h('td.muted', r.systems ?? ''),
          h('td.muted', partnerCell(r)),
          h('td.muted', entry >= l.meta.capacity ? 'waiting list' : ''))))))
        : h('p.muted', regs ? 'Nobody yet.'
          : l.skimmed ? 'Reading the entry list\u2026'
          : l.readError ?? 'Could not load registrations.')));
}

function resultsTable(r: TournamentResults): HTMLElement {
  if (r.scoring === 'imps') {
    return h('div.table-scroll', h('table.list',
      h('thead', h('tr', h('th.num', 'Rank'), h('th', 'Pair'), h('th', 'Dir'), h('th.num', 'IMPs'))),
      h('tbody', r.rankings.map((x) => h('tr', h('td.num', x.rank), h('td', x.players), h('td', x.direction), h('td.num', impsText(x.imps ?? 0)))))));
  }
  return h('div.table-scroll', h('table.list',
    h('thead', h('tr', h('th.num', 'Rank'), h('th', 'Pair'), h('th', 'Dir'), h('th.num', 'Score'), h('th.num', 'MP'))),
    h('tbody', r.rankings.map((x) => h('tr', h('td.num', x.rank), h('td', x.players), h('td', x.direction),
      h('td.num', `${Math.round(x.percent)}%`), h('td.num', `${x.matchpoints}/${x.maxMatchpoints}`))))));
}

/** The system a player prefers, said in the few words they chose. */
const biddingLine = (systems: string): HTMLElement | null =>
  (systems ? h('div.muted', `Bidding: ${systems}`) : null);

/** The "looking for a partner" list for one tournament, with invite/accept/decline. */
function openPartners(initial: Listing): void {
  const d = directory();
  if (!d) return;
  let current = initial;
  let busy = false;
  let err: string | null = null;
  let closed = false;
  let draw: () => void = () => {};
  // Lets refresh() (and the polling timer) push a fresher Listing into this dialog
  // while it's open, so it reflects what the other side has done too, not just mine.
  const sync = (l: Listing): void => { if (!closed && l.number === current.number) { current = l; draw(); } };
  partnersSync = sync;

  dialog(`Partners — ${initial.meta.name}`, () => {
    const body = h('div');
    const myLogin = myId();

    /*
     * Which button is waiting, so the redraw that follows the click can put
     * the spinner back on it. Disabling every button says something is
     * happening; it does not say which thing, and the one that was pressed is
     * the one the eye is on.
     */
    let pending: { key: string; label?: string } | null = null;
    const act = (fn: () => Promise<unknown>, pend?: { key: string; label?: string }) =>
      async (e?: Event): Promise<void> => {
        if (busy) return;
        busy = true; err = null; pending = pend ?? null;
        const btn = e?.currentTarget;
        if (btn instanceof HTMLButtonElement) markBusy(btn, pend?.label);
        draw();
        try {
          await fn();
          current = await d.get(current.number);
          current = await applyAutoRegister(d, current);
          syncListing(current);
        } catch (e2) { err = (e2 as Error).message; }
        busy = false; pending = null; draw();
      };
    const pendingOn = (key: string, btn: HTMLElement): HTMLElement => {
      if (pending?.key === key && btn instanceof HTMLButtonElement) markBusy(btn, pending.label);
      return btn;
    };

    const openNoteDialog = (title: string, submitLabel: string, onSubmit: (note: string) => void, defaultValue = ''): void => {
      dialog(title, (close2) => h('form.grid', { onsubmit: (e: Event) => {
        e.preventDefault();
        onSubmit(val(e.target as HTMLFormElement, 'note'));
        close2();
      } },
        field('Optional note (skill level, convention card, availability…)', h('input', { name: 'note', maxLength: 140, value: defaultValue })),
        h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close2 }, 'Cancel'), h('button.primary', { type: 'submit' }, submitLabel))));
    };

    draw = (): void => {
      const p = current.partners;
      /* What each player said in Settings, as it came in with their entry. */
      const systemsOf = (login: string): string =>
        current.registrations?.find((r) => r.login.toLowerCase() === login.toLowerCase())?.systems ?? '';
      const amSeeking = !!myLogin && !!p?.seekers.some((s) => s.login.toLowerCase() === myLogin);
      const rows: (HTMLElement | null)[] = [
        h('p.muted', { style: 'margin-top:0' }, 'Players here are looking for a partner for this tournament. Add yourself, then invite someone — or wait to be invited.'),
        err ? h('div.error', err) : null,
        !d.canAct
          ? h('div.note', 'Add a token in Settings to do this from here. Until then, comment directly on ',
              h('a', { href: current.url, target: '_blank', rel: 'noopener' }, 'the tournament page'), ': ',
              h('code', '/seek-partner'), ', ', h('code', '/invite @username'), ', ', h('code', '/accept @username'), ' or ', h('code', '/decline @username'), '.')
          : !myLogin ? h('div.note', 'Set your username in Settings so invitations addressed to you can be recognized.') : null,
      ];

      if (!p) {
        rows.push(h('p.muted', 'Could not load the partner list — too many requests just now.'));
      } else {
        const toMe = p.invitations.filter((i) => i.status === 'pending' && !!myLogin && i.to.toLowerCase() === myLogin);
        if (toMe.length) {
          const inviteRow = (i: Invitation): HTMLElement => h('tr',
            h('td', h('b', who(current, i.from)), biddingLine(systemsOf(i.from)), i.note ? h('div.muted', i.note) : null),
            h('td', h('div.row',
              pendingOn(`accept:${i.from}`, h('button.primary', { disabled: busy,
                onclick: act(() => d.respondToInvite(current.number, i.from, true), { key: `accept:${i.from}`, label: 'Accepting\u2026' }) }, 'Accept')),
              pendingOn(`decline:${i.from}`, h('button.danger', { disabled: busy,
                onclick: act(() => d.respondToInvite(current.number, i.from, false), { key: `decline:${i.from}`, label: 'Declining\u2026' }) }, 'Decline')))));
          rows.push(h('h3', 'Invitations for You'), h('div.table-scroll', h('table.list', h('tbody', toMe.map(inviteRow)))));
        }

        const myAccepted = p.invitations.filter((i) => i.status === 'accepted' && !!myLogin && (i.from.toLowerCase() === myLogin || i.to.toLowerCase() === myLogin));
        for (const i of myAccepted) {
          const partner = i.from.toLowerCase() === myLogin ? i.to : i.from;
          const code = inviteCode(current.number, i.from, i.to);
          if (settings.pairCode !== code) { settings.pairCode = code; saveSettings(settings); }
          const mine = current.registrations?.find((r) => r.login.toLowerCase() === myLogin);
          const registered = !!mine && mine.pairCode?.trim().toLowerCase() === code;
          rows.push(h('div.note', `You and ${who(current, partner)} are partnered!`,
            registered ? ' You are both registered for the tournament together.'
              : d.canAct ? ' Registering you both automatically…'
              : ` Comment “/register ${settings.name.trim() || 'Your Name'} pair:${code}” on the issue to register.`,
            h('div.row', { style: 'margin-top:8px' },
              h('button.primary', {
                title: 'Talk to your partner, and agree the system and description your table will see.',
                onclick: () => openPartnership(current, partner),
              }, 'Chat [Partnership]'),
              d.canAct ? h('button.danger', {
                disabled: busy,
                title: 'End this partnership. You both stay in the tournament, and either of you can find somebody else.',
                onclick: act(() => endPartnership(current, partner)),
              }, 'Cancel Partnership') : null)));
        }

        rows.push(h('h3', 'Looking for a Partner'), h('div.table-scroll', h('table.list', h('tbody',
          p.seekers.length === 0
            ? [h('tr', h('td.muted', 'Nobody yet.'))]
            : p.seekers.map((s) => {
                const isMe = s.login.toLowerCase() === myLogin;
                const withThem = (i: Invitation): boolean =>
                  (i.from.toLowerCase() === myLogin && i.to.toLowerCase() === s.login.toLowerCase())
                  || (i.to.toLowerCase() === myLogin && i.from.toLowerCase() === s.login.toLowerCase());
                const partnered = p.invitations.find((i) => i.status === 'accepted' && withThem(i));
                const sentPending = p.invitations.find((i) => i.status === 'pending' && i.from.toLowerCase() === myLogin && i.to.toLowerCase() === s.login.toLowerCase());
                return h('tr',
                  h('td', h('b', who(current, s.login)), isMe ? ' (you)' : '',
                    biddingLine(systemsOf(s.login)), s.note ? h('div.muted', s.note) : null),
                  h('td', isMe ? null
                    : partnered ? h('span.badge.upcoming', 'Partnered')
                    : sentPending
                      ? h('button', { disabled: busy, onclick: act(() => d.cancelInvite(current.number, s.login)) }, 'Cancel Invite')
                      : h('button', { disabled: busy || !myLogin, onclick: () => openNoteDialog(`Invite ${who(current, s.login)}`, 'Send Invite', (note) => void act(() => d.invitePartner(current.number, s.login, note))()) }, 'Invite')));
              })))));

        rows.push(h('div.row', { style: 'margin-top:10px' },
          amSeeking
            ? h('button', { disabled: busy, onclick: act(() => d.cancelSeekingPartner(current.number)) }, 'Remove Me from the List')
            : h('button.primary', { disabled: busy || !myLogin, onclick: act(() => d.seekPartner(current.number, settings.partnerNote)) }, 'Add Me to the List')));
      }

      body.replaceChildren(...rows.filter((x): x is HTMLElement => x !== null));
    };

    draw();
    // The list is paintable right away from whatever snapshot the page already had,
    // but someone else may have joined, invited or responded since then — refetch
    // on every open so reopening the dialog shows more than just my own actions.
    void (async () => {
      try {
        current = await d.get(current.number);
        current = await applyAutoRegister(d, current);
        syncListing(current);
      } catch (e) { err = (e as Error).message; }
      draw();
    })();
    return body;
  }, () => { closed = true; if (partnersSync === sync) partnersSync = null; }, 'Close');
}

/* --------------------------------------------------------------- dialogs */

function dialog(title: string, build: (close: () => void) => HTMLElement, onClose?: () => void,
  headButton?: string): void {
  const dlg = h('dialog') as HTMLDialogElement;
  const close = (): void => { dlg.close(); dlg.remove(); onClose?.(); };
  /* The cross is the same door as Escape and as whatever button the dialog
     carries at its foot — useful when that foot is a scroll away. A dialog
     with nothing to fill in has no foot worth keeping, and says Close in
     words up here instead. */
  dlg.append(h('div.dlg-head', h('h2', title),
    headButton
      ? h('button.open.inline.dlg-close', { type: 'button', onclick: close }, headButton)
      : h('button.x', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, '\u00d7')),
  build(close));
  dlg.addEventListener('cancel', () => { dlg.remove(); onClose?.(); });
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => h('label', label, input, hint ? h('small', hint) : null);
/** The same, with the explanation on hover rather than under the box. */
const tipped = (label: string, input: HTMLElement, tip: string): HTMLElement =>
  h('label', { 'data-tip': tip, 'aria-label': `${label}. ${tip}` }, label, input);
const val = (f: HTMLFormElement, name: string): string => String(new FormData(f).get(name) ?? '').trim();

function tokenHelpSteps(): HTMLElement {
  const repoSlug = settings.repo.trim() || 'owner/repository';
  const repoUrl = `https://github.com/${repoSlug}`;
  const tokenUrl = 'https://github.com/settings/tokens?type=beta';
  return h('div.help-steps',
    h('h3', 'How to get a GitHub token'),
    h('ol',
      h('li', 'Sign up or log in at ', h('a', { href: 'https://github.com', target: '_blank', rel: 'noopener' }, 'github.com'), '.'),
      h('li', 'Open ', h('a', { href: tokenUrl, target: '_blank', rel: 'noopener' }, 'Fine-grained tokens'), ' (Settings → Developer settings → Personal access tokens → Fine-grained tokens).'),
      h('li', 'Click “Generate new token”. Name it anything (e.g. “Bridge Break”).'),
      h('li', 'Under Repository access, choose “Only select repositories” and pick ', h('a', { href: repoUrl, target: '_blank', rel: 'noopener' }, repoSlug), '.'),
      h('li', 'Under Permissions → Repository permissions, set Issues to “Read and write”. Leave everything else unchanged.'),
      h('li', 'Click “Generate token” and copy the value into the token field above.')),
    h('p.muted', 'The token is stored only in this browser and sent only to api.github.com.'));
}

const MAIL = 'ido@MilletSoftware.com';
const SITE = 'www.MilletSoftware.com';

/**
 * What the application is, for somebody who has just arrived. Everything
 * here is also discoverable by poking about, but a new player should not
 * have to poke about to find out whether this is for them.
 */
/**
 * Testing as somebody else. Each choice reloads the page as that player,
 * keeping the tournament you are looking at. Open a tab per player to have
 * them all at once: the address says who each tab is.
 */
function testSwitcher(): HTMLElement {
  const current = testUser();
  const go = (n: number | null): void => {
    const q = new URLSearchParams(location.search);
    q.delete('as');
    if (n) q.set('as', `test${n}`); else q.set('test', '');
    const qs = q.toString().replace(/=(&|$)/g, '$1');
    location.href = `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`;
  };
  const pick = h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; go(v ? Number(v) : null); } },
    h('option', { value: '', selected: current === null }, 'Me'),
    Array.from({ length: TEST_USERS }, (_, i) => h('option', { value: String(i + 1), selected: current === i + 1 }, `Test ${i + 1}`)));
  return h('span.tester', { title: 'Test mode: each tab can be a different player. The choice is in the address, so copy it into another tab to have both.' },
    'Testing as ', pick, current && settings.name !== `Test ${current}` ? ` (${settings.name})` : '');
}

/**
 * Level and description for everyone at the table: what each player's own
 * browser says, filled in from their registration where they have not said.
 */
function tablePlayerInfo(n: TournamentNode): Map<string, TableInfo> {
  const out: Map<string, TableInfo> = n.playerInfo();
  for (const r of room?.listing?.registrations ?? []) {
    const had = out.get(r.login);
    if (r.skill && !had?.skill) out.set(r.login, { ...had, skill: r.skill });
    if (r.systems && !out.get(r.login)?.systems) out.set(r.login, { ...out.get(r.login), systems: r.systems });
  }
  /*
   * What each pair at each table plays, so that nobody has to guess: their
   * own card where they have saved one, the system they both own to where
   * they have not, and the robots' own system wherever a robot sits.
   */
  const robots = n.state?.config.robots === '2/1' ? '2/1' : 'SAYC';
  for (const t of n.state?.tables ?? []) {
    for (const [a, b] of [['N', 'S'], ['E', 'W']] as const) {
      const pa = t.seats[a];
      const pb = t.seats[b];
      if (!pa || !pb) continue;
      const card: PairCard = pa.bot || pb.bot
        ? { system: robots, vsNt: '', note: '' }
        : pairAgreement({ id: pa.id, systems: out.get(pa.id)?.systems as SystemPref },
          { id: pb.id, systems: out.get(pb.id)?.systems as SystemPref });
      /* A card the two of them wrote, as against a system worked out from
         what each plays: only the first speaks for the partnership, and only
         the first stands in for what a player says about himself. */
      const written = !pa.bot && !pb.bot && pairCards.has(pairKey(pa.id, pb.id));
      for (const id of [pa.id, pb.id]) {
        out.set(id, { ...out.get(id), pairSystem: card.system, ...(written ? { pairCard: true } : {}),
          ...(card.vsNt ? { pairVsNt: card.vsNt } : {}), ...(card.note ? { pairNote: card.note } : {}) });
      }
    }
  }
  return out;
}

/** What the table knows about one player: their own words, and their pair's. */
export interface TableInfo {
  note?: string; skill?: string; systems?: string;
  pairSystem?: string; pairVsNt?: string; pairNote?: string;
  /** True only where the pair wrote a card, not where one was inferred. */
  pairCard?: boolean;
}

/** A name with the level in square brackets after it, where one is known. */
const playerTitle = (p: { name: string; skill?: string }): string =>
  (p.skill ? `${p.name} [${p.skill}]` : p.name);

/** A player's name, level and description, with room to read them. */
function openPlayerInfo(
  p: { name: string; robot: boolean; skill?: string; systems?: string; pairSystem?: string; pairVsNt?: string; pairNote?: string; pairCard?: boolean; note?: string; partner?: string },
  robots?: 'sayc' | '2/1',
): void {
  if (p.robot) {
    dialog(playerTitle(p), () => h('div.about',
      h('ul',
        robots === '2/1'
          ? h('li', h('b', '2/1:'), ' two-over-one game forcing, forcing 1NT over a major, 5-card majors, 15\u201317 1NT, Stayman, Jacoby transfers, '
            + 'strong 2\u2663, weak twos and pre-empts, weak jump raises, Jacoby 2NT, take-out and negative doubles, '
            + 'Michaels over a minor, unusual 2NT and Blackwood.')
          : h('li', h('b', 'SAYC:'), ' 5-card majors, 15\u201317 1NT, Stayman, Jacoby transfers, strong 2\u2663, weak twos and pre-empts, '
            + 'weak jump raises, Jacoby 2NT, take-out and negative doubles, Michaels over a minor, unusual 2NT and Blackwood.'),
        h('li', 'Explains own bids via alert.'),
        h('li', 'For each card play, the robot solves multiple random hands that match the visible information. '
          + 'It plays the card that does best on average. The random hands respect the cards played, who has shown out of a suit, '
          + 'and what each player\u2019s bidding showed. The robot only uses what a player in its seat could see (Fair Play).')),
      ), undefined, 'Close');
    return;
  }
  /*
   * Where a pair has filled in a card, the card answers for the partnership
   * and the player's own system and description are the same answer written
   * twice — so they give way to it, and the card is set apart under a heading
   * of its own rather than listed among the player's own facts.
   */
  const hasPair = !!p.pairCard;
  /* The card is two short things: what they play, and what they say about it.
     Under a heading of its own neither needs a word in front of it. */
  const agreed = [p.pairSystem, p.pairVsNt].filter(Boolean).join(', ');
  dialog(playerTitle(p), () => h('div',
    h('dl.facts',
      hasPair ? null : [h('dt', 'Bidding'), h('dd', p.systems || h('span.muted', 'Not given'))],
      hasPair ? null : [h('dt', 'Description'), h('dd', p.note || h('span.muted', 'No description'))],
      p.partner ? [h('dt', 'Partner'), h('dd', p.partner)] : null),
    hasPair
      ? h('div.paircard', h('h4', 'Pair Card'),
          agreed ? h('div.plays', agreed) : null,
          p.pairNote ? h('p.pairnote', p.pairNote) : null)
      : null), undefined, 'Close');
}

function openAbout(): void {
  dialog('About Bridge Break', () => h('div.about',
    h('p', 'Bridge Break runs ', h('b', 'free duplicate bridge tournaments'), ' in your browser.'),

    h('h3', 'What It Does'),
    h('ul',
      h('li', h('b', 'Private rooms.'), ' Enter or share a private room code with the players you wish to invite.'),
      h('li', h('b', 'Robots.'), ' They fill any empty, timed-out, or withdrawn seat. You can hand your seat '
        + 'to a robot, and take it back later. Latecomers can take a robot\u2019s place.'),
      h('li', h('b', 'Rejoin after Timeouts.'), ' A button click allows you to replace the robot that replaced you.'),
      h('li', h('b', 'Start tournaments.'), ' Save a token under Settings and create public or password-protected '
        + 'tournaments. Optionally, upload boards using PBN or LIN formats.'),
      h('li', h('b', 'Skill Levels.'), ' Tournaments may limit the range of allowed skill levels.')),

    h('h3', 'First Steps'),
    h('ol',
      h('li', 'Open ', h('b', 'Settings'), ' and enter a name, skill level, and a short description.'),
      h('li', 'Click ', h('b', 'Play a Demo vs Robots'), ' to learn how bidding, alerting, and playing works.'),
      h('li', 'Pick a tournament from the list and ', h('b', 'Register'),
        ' to be randomly paired or join/use the Partners List.'),
      h('li', 'If you exceed the timeout limit set by the tournament director for each bid/play, '
        + 'you will be replaced by a Robot. ',
        h('b', 'However, you can re-select the tournament and click an option to be reseated to '
          + 'rejoin your partner.'))),

    h('h3', 'Who Made It'),
    h('p', 'Bridge Break is written by Ido Millet, owner of Millet Software (',
      h('a', { href: `https://${SITE}`, target: '_blank', rel: 'noopener' }, SITE), ').'),
    h('p', 'Please email feedback and suggestions to ',
      h('a', { href: `mailto:${MAIL}` }, MAIL), '.'),
    ), undefined, 'Close');
}

/* ----------------------------------------------------------- passwords */

/**
 * A password this browser has had accepted for a tournament, so that leaving
 * the table, timing out or coming back tomorrow does not mean asking again.
 * It is kept for the one tournament, never shown, and goes when it stops
 * working.
 */
const passwordKey = (number: number): string => `bridge-p2p:pw:${settings.repo}:${number}`;

function rememberPassword(password: string, number: number): void {
  try { localStorage.setItem(passwordKey(number), password); } catch { /* no storage */ }
}

function rememberedPassword(number: number): string {
  try { return localStorage.getItem(passwordKey(number)) ?? ''; } catch { return ''; }
}

function forgetPassword(number: number): void {
  try { localStorage.removeItem(passwordKey(number)); } catch { /* no storage */ }
}

/**
 * Ask for the password of a tournament that takes one, and hand it on. The
 * answer is tried by the relay, so a wrong one comes back as a refusal and
 * the asking starts again.
 */
function askPassword(l: Listing, use: (password: string) => void): void {
  const had = rememberedPassword(l.number);
  if (had) { use(had); return; }
  dialog(`${l.meta.name} takes a password`, (close) => {
    const box = h('input', { type: 'password', autocomplete: 'off', maxLength: 128,
      placeholder: 'The password the director gave you' }) as HTMLInputElement;
    setTimeout(() => box.focus(), 50);
    return h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      const said = box.value.trim();
      if (!said) return;
      close();
      use(said);
    } },
      h('p.muted', { style: 'margin-top:0' }, 'Only the players the director gave it to can enter this one. You will not be asked again on this device once it is accepted.'),
      box,
      h('div.row', { style: 'margin-top:12px' }, h('span.spacer'),
        h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button.primary', { type: 'submit' }, 'Enter')));
  });
}

/* ---------------------------------------------------------- partnership */

/** Pair cards, read once and kept for the page: they change rarely. */
let pairCards: Map<string, PairCard> = new Map();
let pairCardsAt = 0;

async function loadPairCards(force = false): Promise<void> {
  const d = directory();
  if (!d) return;
  if (!force && Date.now() - pairCardsAt < 60_000) return;
  try { pairCards = await d.pairCards(); pairCardsAt = Date.now(); } catch { /* next time */ }
}

/**
 * What a pair play, and what they want the table to know: their own card
 * where they have saved one, otherwise the system they both own to.
 */
function pairAgreement(a: { id: string; systems?: SystemPref }, b: { id: string; systems?: SystemPref }): PairCard {
  const card = pairCards.get(pairKey(a.id, b.id));
  return card ?? { system: systemBetween(a, b), vsNt: '', note: '' };
}

/**
 * The room where two partners talk. Live only: what is said here is said
 * between them and kept by neither, unlike the card below it.
 */
function openPartnership(l: Listing, partner: string): void {
  const d = directory();
  const me = myId();
  if (!d || !me) return;
  const key = pairKey(me, partner);
  const theirName = who(l, partner);
  let said: { name: string; text: string }[] = [];
  let transport: Transport | null = null;
  let err: string | null = null;
  let busy = false;
  let closed = false;
  let draw: () => void = () => {};

  /* The card as it stands, and whether this side has it in hand unsaved: a
     card read from the page must not overwrite what somebody is writing. */
  let card = pairAgreement(
    { id: me, systems: settings.systems },
    { id: partner, systems: l.registrations?.find((r) => r.login.toLowerCase() === partner.toLowerCase())?.systems },
  );
  let unsaved = false;
  let sysEl: HTMLSelectElement | null = null;
  let vsEl: HTMLInputElement | null = null;
  let noteEl: HTMLTextAreaElement | null = null;
  let sending: ReturnType<typeof setTimeout> | null = null;
  /* Whether the partner has this open too, which is what decides whether
     their side of the card arrives as it is written or only once saved. */
  let together = false;

  const show = (c: PairCard): void => {
    card = c;
    /* Never under the cursor: whoever is typing in a field keeps it. */
    if (sysEl && document.activeElement !== sysEl) sysEl.value = c.system;
    if (vsEl && document.activeElement !== vsEl) vsEl.value = c.vsNt;
    if (noteEl && document.activeElement !== noteEl) noteEl.value = c.note;
  };

  /** What the two of them have saved, when nothing is being written here. */
  const readSaved = async (): Promise<void> => {
    await loadPairCards(true);
    const saved = pairCards.get(key);
    if (saved && !unsaved && !closed) show(saved);
  };

  /** What this side is writing, as it is written: the pad is shared. */
  const sendDraft = (): void => {
    if (sending) clearTimeout(sending);
    sending = setTimeout(() => {
      sending = null;
      transport?.send({ k: 'draft', system: sysEl?.value ?? card.system, vsNt: vsEl?.value ?? card.vsNt, note: noteEl?.value ?? card.note });
    }, 500);
  };

  const typing = (): void => { unsaved = true; sendDraft(); };

  void (async () => {
    try {
      transport = settings.transport === 'local'
        ? localTransport(`pair:${key}`)
        : (await import('../net/trystero')).trysteroTransport(`pair:${key}`);
      transport.onPeerJoin(() => { together = true; draw(); sendDraft(); });
      transport.onPeerLeave(() => { together = (transport?.peers().length ?? 0) > 0; draw(); });
      together = transport.peers().length > 0;
      transport.onMessage((msg) => {
        const m = msg as { k?: string; text?: string; name?: string; system?: string; vsNt?: string; note?: string };
        if (m.k === 'say' && typeof m.text === 'string') {
          said.push({ name: String(m.name ?? theirName).slice(0, 40), text: m.text.slice(0, CHAT_MAX) });
          said = said.slice(-50);
          draw();
          return;
        }
        /* Their side of the card: what they are writing, or what they saved. */
        if (m.k === 'draft' || m.k === 'card') {
          if (m.k === 'draft') unsaved = true;
          show({
            system: m.system === '2/1' ? '2/1' : 'SAYC',
            vsNt: String(m.vsNt ?? '').slice(0, PAIR_NOTE_MAX),
            note: String(m.note ?? '').slice(0, PAIR_NOTE_MAX),
          });
          if (m.k === 'card') { unsaved = false; void loadPairCards(true); }
          return;
        }
        /* Somebody has just opened their side: show them where this one is. */
        if (m.k === 'here') { together = true; draw(); if (unsaved) sendDraft(); }
      });
      transport.send({ k: 'here' });
    } catch { err = 'Could not open the chat.'; draw(); }
  })();

  void readSaved();
  /* And a look at the page now and then, for a partner who saved while this
     side was closed, or whose message did not reach it. */
  const poll = setInterval(() => { if (!closed) void readSaved(); }, 20_000);

  dialog(`Chat — you and ${theirName}`, (close) => {
    const body = h('div');
    const box = h('input', { maxLength: CHAT_MAX, placeholder: `Say something to ${theirName}…`, autocomplete: 'off' }) as HTMLInputElement;
    noteEl = h('textarea', { name: 'note', rows: 2, maxLength: PAIR_NOTE_MAX, oninput: typing,
      placeholder: 'e.g. Natural discards, weak 1NT, 1C can be short, Bergen raises' }, card.note) as HTMLTextAreaElement;
    vsEl = h('input', { name: 'vsnt', maxLength: PAIR_NOTE_MAX, oninput: typing, autocomplete: 'off',
      placeholder: 'Natural, Cappelletti, DONT, \u2026 ?', value: card.vsNt }) as HTMLInputElement;
    sysEl = h('select', { onchange: typing },
      ['SAYC', '2/1'].map((x) => h('option', { value: x, selected: card.system === x }, x))) as HTMLSelectElement;

    const save = async (): Promise<void> => {
      if (busy) return;
      busy = true; err = null; draw();
      const system = sysEl?.value === '2/1' ? '2/1' : 'SAYC';
      const vsNt = vsEl?.value ?? '';
      const note = noteEl?.value ?? '';
      try {
        if (d.canWrite) await d.openPairs();
        await d.savePairCard(key, system, vsNt, note);
        await loadPairCards(true);
        unsaved = false;
        /* So the other side has it without waiting for the page to be read. */
        transport?.send({ k: 'card', system, vsNt, note });
        notice = 'Your pair card is saved.';
      } catch (e) { err = (e as Error).message; }
      busy = false; draw();
      render();
    };

    const where = h('p.muted');
    draw = (): void => {
      where.textContent = together
        ? `${theirName} has this open: what either of you types appears on the other's screen within a second.`
        : `${theirName} does not have this open. Anything you save is waiting for them when they do, and the page is looked at every 20 seconds for their side of it.`;
      body.replaceChildren(...[
        err ? h('div.error', err) : null,
        said.length
          ? h('div.chat', said.map((m) => h('div.chat-line', h('b', `[${m.name}]: `), m.text)))
          : h('p.muted', 'Nothing said yet. What is said here is live between the two of you and is not kept.'),
      ].filter((x): x is HTMLElement => x !== null));
    };
    draw();

    return h('div',
      body,
      h('form.row', { style: 'margin-top:10px', onsubmit: (e: Event) => {
        e.preventDefault();
        const text = box.value.trim().slice(0, CHAT_MAX);
        if (!text) return;
        box.value = '';
        said = [...said, { name: settings.name || 'You', text }].slice(-50);
        transport?.send({ k: 'say', text, name: settings.name || 'A partner' });
        draw();
      } }, box, h('button.primary', { type: 'submit' }, 'Send')),
      h('div.panel', { style: 'margin-top:14px' },
        h('h3', 'Your Pair Card'),
        h('p.muted', { style: 'margin-top:0' }, 'Both of you write this one, and it is shown at the table to everybody. Save it and it will be waiting the next time you play together.'),
        where,
        h('form.grid', { onsubmit: (e: Event) => { e.preventDefault(); void save(); } },
          tipped('Bidding System', sysEl, 'The system the two of you have agreed to play.'),
          tipped('Over Opponents 1NT', vsEl, 'Natural, Cappelletti, DONT, \u2026 ?'),
          tipped('Pair Description', noteEl, 'Carding, notrump range, and anything else the table should know.'),
          h('div.row', h('span.spacer'),
            h('button.primary', { type: 'submit', disabled: !d.canAct }, 'Save Pair Card')))),
      h('div.row', { style: 'margin-top:10px' }, h('span.spacer'), h('button', { onclick: close }, 'Close')));
  }, () => {
    closed = true;
    clearInterval(poll);
    if (sending) clearTimeout(sending);
    transport?.leave();
    transport = null;
  });
}

/* --------------------------------------------------------------- lobby */

/**
 * Is this player in the middle of a tournament? The lobby is put away while
 * they are: a table is no place to be reading the room.
 */
function inLiveTournament(): boolean {
  /*
   * Only a table still being played counts. Waiting for one to start is not
   * being in it, and neither is sitting on a tournament that has finished or
   * been called off — which is what being timed out of a table of robots
   * amounts to, and the lobby is exactly where such a player wants to be.
   */
  const state = node?.state;
  return !!state && !state.finished;
}

let lobbySync: (() => void) | null = null;

/** Messages players leave each other between tournaments. */
function openLobby(): void {
  const d = directory();
  if (!d) return;
  let msgs: ChatMessage[] = [];
  let err: string | null = null;
  let busy = false;
  let loaded = false;
  let closed = false;
  let draw: () => void = () => {};

  const load = async (): Promise<void> => {
    try {
      if (d.canWrite) {
        /* The two pages this all lives on, made once by whoever can. */
        await d.openLobby();
        await d.openPairs().catch(() => { /* the lobby is the one in hand */ });
      }
      msgs = await d.messages();
      err = null;
    } catch (e) { err = (e as Error).message; }
    loaded = true;
    if (!closed) draw();
  };

  dialog('Lobby', (close) => {
    const body = h('div');
    const box = h('textarea.chat-box', { maxLength: CHAT_MAX, rows: 2, placeholder: 'Say something to the room…' }) as HTMLTextAreaElement;

    const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
      if (busy) return;
      busy = true; err = null; draw();
      try { await fn(); await load(); } catch (e) { err = (e as Error).message; }
      busy = false; draw();
    };

    /* Anybody may take back what they said themselves; a token may take back
       anything. A pinned message is held until it is unpinned. */
    const me = myId();
    const line = (m: ChatMessage): HTMLElement => h(`div.chat-line${m.pinned ? '.pinned' : ''}`,
      h('div', h('b', `[${m.name}]: `), m.text),
      h('div.chat-meta', h('span.muted', ago(m.at)),
        d.canWrite ? [' ', h('button.link', { disabled: busy, onclick: act(() => d.pinMessage(m.id, !m.pinned)) }, m.pinned ? 'Unpin' : 'Pin')] : null,
        !m.pinned && (d.canWrite || (!!me && m.who.toLowerCase() === me))
          ? [' ', h('button.link.danger', { disabled: busy, onclick: act(() => d.removeMessage(m.id)) }, 'Delete')]
          : null));

    draw = (): void => {
      body.replaceChildren(...[
        err ? h('div.error', err) : null,
        !d.canAct ? h('div.note', 'Set your name in Settings to post here.') : null,
        !loaded ? h('p.muted', 'Reading the lobby…')
          : msgs.length ? h('div.chat', msgs.map(line))
          : h('p.muted', d.canWrite || msgs.length ? 'Nothing has been said yet.'
            : 'The lobby has not been set up yet.'),
      ].filter((x): x is HTMLElement => x !== null));
    };

    draw();
    void load();
    lobbySync = () => { if (!closed) void load(); };

    /* The box has the width to itself, and Send sits with Close: a message
       is a line or two, and it is easier to read them written wide. */
    return h('form', { onsubmit: (e: Event) => {
      e.preventDefault();
      const text = box.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      box.value = '';
      void act(() => d.say(text))();
    } },
      body,
      h('div', { style: 'margin-top:10px' }, box),
      h('div.row', { style: 'margin-top:10px' }, h('span.spacer'),
        h('button', { type: 'button', onclick: close }, 'Close'),
        h('button.primary', { type: 'submit', disabled: !d.canAct }, 'Send')));
  }, () => { closed = true; lobbySync = null; });
}

function openSettings(): void {
  dialog('Settings', (close) => {
    const err = h('div');
    const helpPanel = h('div.token-help');
    const toggleHelp = (): void => {
      if (helpPanel.children.length) helpPanel.replaceChildren();
      else helpPanel.replaceChildren(tokenHelpSteps());
    };
    const form = h('form.grid', { onsubmit: async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      Object.assign(settings, { sound: (f.elements.namedItem('sound') as HTMLInputElement | null)?.checked !== false,
        name: val(f, 'name'), skill: toSkill(val(f, 'skill')) ?? '',
        /* The description travels as one line of a comment on the tournament
           page, so the lines it was typed on become spaces. */
        partnerNote: val(f, 'note').replace(/\s*\n\s*/g, ' '),
        systems: systemsOf(val(f, 'systems')),
        token: val(f, 'token') });
      /* The GitHub username comes from the token itself; without one there is none. */
      if (!settings.token) settings.githubLogin = '';
      if (settings.token && settings.repo) {
        try { settings.githubLogin = await new Directory(settings.repo, settings.token).whoAmI(); }
        catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); return; }
      }
      saveSettings(settings);
      setSound(settings.sound);
      close();
      void refresh();
    } },
      /* Name and level side by side: both are a word long, and the room they
         leave is room for the rest of the form. */
      h('div.two',
        tipped('Your name (shown at the table)',
          h('input', { name: 'name', value: settings.name, required: true, maxLength: 30, autocomplete: 'name' }),
          'What other players see at the table and on the entry list.'),
        tipped('Skill Level',
          h('select', { name: 'skill' },
            h('option', { value: '', selected: settings.skill === '' }, 'Prefer not to say'),
            SKILLS.map((x) => h('option', { value: x, selected: settings.skill === x }, x))),
          'How you would describe your own game. Some tournaments are open only to certain levels.')),
      tipped('Bidding System',
        h('select', { name: 'systems' },
          SYSTEM_PREFS.map((x) => h('option', { value: x, selected: settings.systems === x }, x || ' '))),
        'Select the bidding system(s) you prefer.'),
      tipped('Player Description',
        h('textarea', { name: 'note', rows: 2, maxLength: 140, placeholder: 'e.g. Strong 2/1, prefers evenings' }, settings.partnerNote),
        'Visible to other players when they click your name at the table.'),
      h('label.check', { title: 'A chime when the table is waiting on you, and the brush of each card as it is played' },
        h('input', { type: 'checkbox', name: 'sound', checked: settings.sound }), ' Play sounds at the table'),

      /* Shut to begin with, like the section below it: most people play on
         one machine and never need to think about any of this. */
      deviceSection(),

      /* Always shut to begin with: a player who has a token has long since
         set it up, and the section is of no interest to anybody else. */
      h('details.director-section',
        h('summary', { title: 'Click to show options required only for players who wish to add tournaments.' }, 'Tournament Creator'),
        h('div.grid',
          /* The word and its help mark share one line: the label lays out each
             of its children as a row of its own. */
          h('label', h('span', 'Token ',
            h('button.help-icon', { type: 'button', onclick: toggleHelp, title: 'How to get a token' }, '?')),
            h('input.masked', { name: 'token', type: 'text', value: settings.token, autocomplete: 'off', spellcheck: false, placeholder: 'optional' }),
            h('small', settings.token && settings.githubLogin
              ? `Lets you create tournaments. This token belongs to GitHub user @${settings.githubLogin}.`
              : 'Lets you create tournaments.')),
          helpPanel)),

      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Save')));
    return form;
  });
}

/**
 * Moving yourself to a second machine.
 *
 * Who you are here is a key the browser invented on first run, kept in that
 * browser on that machine; the name, the level and the system sit beside it.
 * Nothing carries any of it across — a browser's own sync takes bookmarks and
 * passwords but never a site's storage — so the same person at a laptop and
 * at a desktop was two strangers, each unable to withdraw the other's entry
 * or answer the other's invitations.
 *
 * So the player carries it themselves: everything this site has stored, in
 * one line, there to be copied the moment the section is opened.
 */
function deviceSection(): HTMLElement {
  /* Open on arrival, because the person is here to answer one question. */
  const arriving = !!scanned;
  const said = h('small.device-said');
  const square = h('div.qrbox');
  const code = h('textarea.devcode', {
    rows: 4, readOnly: true, spellcheck: false, 'aria-label': 'Your settings, to copy to your other device',
  }) as HTMLTextAreaElement;
  /* The code itself is the fallback, not the first thing to look at: a phone
     reads the square, and a second computer wants the string. */
  const codeBox = h('label.codebox', { hidden: true }, h('span', 'The Code Itself'), code);
  const reveal = h('button', {
    type: 'button',
    title: 'The same settings as the square, written out \u2014 for carrying them to another computer, '
      + 'which has no camera to read a square with.',
    onclick: () => {
      const shut = codeBox.hidden;
      codeBox.hidden = !shut;
      reveal.replaceChildren(shut ? 'Hide the Code' : 'Show the Code');
      if (shut) { code.focus(); code.select(); }
    },
  }, 'Show the Code') as HTMLButtonElement;
  const paste = h('textarea.devcode', {
    name: 'devcode', rows: 3, spellcheck: false, autocomplete: 'off',
    placeholder: 'Paste the code from your other device',
    'aria-label': 'A settings code from another device',
  }) as HTMLTextAreaElement;

  /* A copy is over before the eye registers it, so the button says so for a
     moment: pressed, then done, then itself again. Without that the only
     evidence of a press is a clipboard nobody can see. */
  const flash = (btn: HTMLButtonElement, label: string, then: string, ms = 1800): void => {
    btn.disabled = true;
    btn.classList.add('done');
    btn.replaceChildren(label);
    setTimeout(() => {
      btn.disabled = false;
      btn.classList.remove('done');
      btn.replaceChildren(then);
    }, ms);
  };

  const copy = h('button', {
    type: 'button',
    title: 'Copy this code, then paste it into Settings on your other device under this same heading. '
      + 'It carries your player key, name, level, bidding system, any tournament passwords and your '
      + 'tournament-creator token, so treat it like a password.',
    onclick: (e: Event) => {
      const btn = e.currentTarget as HTMLButtonElement;
      void (async () => {
        if (!code.value) return;
        markBusy(btn, 'Copying\u2026');
        try {
          await navigator.clipboard.writeText(code.value);
          btn.dataset.busy = '';
          btn.classList.remove('busy');
          flash(btn, '\u2713 Copied', 'Copy');
          said.replaceChildren('Copied. Paste it into Settings on your other device, under this same heading \u2014 '
            + 'or into an email to yourself, to carry it there.');
        } catch {
          btn.dataset.busy = '';
          btn.classList.remove('busy');
          btn.disabled = false;
          btn.replaceChildren('Copy');
          code.focus();
          code.select();
          said.replaceChildren('Your browser would not let the page copy it. It is selected above \u2014 copy it yourself.');
        }
      })();
    },
  }, 'Copy') as HTMLButtonElement;

  /* The usual way this gets from one machine to the other. A real link, so
     the browser opens the mail program the way it opens any other: on a
     machine that sends no mail nothing happens, which is why this stands
     beside Copy rather than instead of it. */
  const mail = h('a.actionbtn', {
    role: 'button',
    /* A tab of its own where mail is a website, rather than this page being
       navigated away from the tournament it is showing. */
    target: '_blank',
    rel: 'noopener',
    title: 'Open a new email with the code in it, to send to yourself and open on the other device. '
      + 'Delete the message once you have used it: it is a password, and mail keeps copies.',
    onclick: () => {
      said.replaceChildren('The email window belongs to your mail program, not to Bridge Break. The code is the '
        + 'first thing in the message, so it is readable even if the window opens too small. If no email opened '
        + 'at all, this device has no mail program set up \u2014 use Copy instead.');
    },
  }, 'Email the Code') as HTMLAnchorElement;

  /**
   * The letter the button opens.
   *
   * The code comes first and the explanation after it. The window belongs to
   * whatever program the machine sends mail with, and some of them open it
   * too small for the message and will not be resized — so the one part that
   * must survive being cut off the bottom is put at the top, where it can be
   * read and copied whatever the window does. The rest is three short lines.
   */
  const addressed = (text: string): string => {
    const body = [text, '',
      'Bridge Break settings, to copy this player to another device.',
      'At the other device, in Bridge Break, Settings \u2192 "Playing on more than one device" '
        + '\u2192 paste into "Settings from another device".'].join('\n');
    return `mailto:?subject=${encodeURIComponent('Bridge Break settings')}&body=${encodeURIComponent(body)}`;
  };

  /* Pressing once says what is in the code and what will go; pressing again
     does it. Replacing who you are on a device is not a thing to do by a
     stray click, and there is nothing to undo it with afterwards. */
  let ready: Record<string, string> | null = null;
  const use = h('button.primary', { type: 'button' }, 'Use these settings here');
  const arm = (): void => {
    ready = null;
    use.replaceChildren('Use these settings here');
    use.classList.remove('danger');
    use.title = 'Replace this device\u2019s settings with the ones in the code, so both devices are the same player '
      + 'with the same name. Takes effect at once, whether or not you press Save.';
  };
  arm();
  paste.addEventListener('input', () => { if (ready) { arm(); said.replaceChildren(); } });
  /* Scanned a moment ago on the other device: show it the way a pasted one
     looks after the first press, so the same second press applies it. */
  if (scanned) {
    paste.value = scanned;
    scanned = null;
    setTimeout(() => use.click(), 0);
  }
  use.addEventListener('click', () => {
    if (ready) {
      for (const [k, v] of Object.entries(ready)) {
        try { localStorage.setItem(k, v); } catch { /* storage full or blocked */ }
      }
      /* Everything downstream of the settings is already drawn, so the page
         starts again rather than being patched piece by piece. */
      location.reload();
      return;
    }
    void (async () => {
      try {
        const items = await unpack(paste.value);
        const what = describe(items);
        ready = items;
        use.replaceChildren('Replace My Settings');
        use.classList.add('danger');
        use.title = 'Press again to replace this device\u2019s settings. There is no undo.';
        said.replaceChildren(h('span.warn-text', 'This will replace everything on this device. '),
          `The code holds ${what.name ? `the settings of ${what.name}` : 'a player with no name set'}`
          + `${what.hasToken ? ', a tournament-creator token' : ''}`
          + `${what.passwords ? `, and ${what.passwords} remembered tournament password${what.passwords > 1 ? 's' : ''}` : ''}`
          + '. Press again to go ahead.');
      } catch (e) {
        said.replaceChildren(h('span.error-text', (e as Error).message));
      }
    })();
  });

  /* Ready before it is asked for: there is nothing to decide, and a code
     nobody has pressed a button for is one less thing in the way. */
  void (async () => {
    try {
      const text = await pack(collect(localStorage, true));
      code.value = text;
      /* Tall enough for the whole of it, so what you are copying is in view. */
      code.rows = Math.min(12, Math.max(3, Math.ceil(text.length / 46)));
      mail.href = addressed(text);
      /* A link, not a blob: a camera turns a URL into something to tap, and
         a phone that taps it lands here with the settings in hand. The
         fragment is never sent to any server, so the key goes no further
         than the two devices looking at it. */
      const svg = qrSvg(`${location.origin}${location.pathname}#kit=${text}`,
        { size: 268, title: 'Your Bridge Break settings, as a code to scan' });
      if (svg) square.replaceChildren(svg);
      else square.replaceChildren(h('small.muted', 'These settings are too long to put in a square \u2014 use the code below.'));
    } catch (e) {
      code.value = '';
      said.replaceChildren(h('span.error-text', (e as Error).message));
    }
  })();

  return h('details.device-section', { open: arriving },
    h('summary', { title: 'Only needed if you play on more than one device \u2014 a laptop and a desktop, say. '
      + 'Bridge Break knows you by a key kept in this browser alone, and no browser sync copies it across.' },
      'Playing on more than one device'),
    h('div.grid',
      h('p.muted.device-why', 'Bridge Break identifies you by a key stored in this browser. On another device you '
        + 'are a different player even if the name is the same. Copy the string below to the other device, and both '
        + 'devices would see you as the same player.'),
      h('div.qrrow', square,
        h('div.qrwords',
          h('p', h('b', 'On a phone or tablet:'), ' point its camera at this square, open the link it offers, '
            + 'and the settings come across with it.'),
          h('small.muted', h('span.warn-text', 'Treat it like a password. '),
            'The square and the code both carry your player key, your settings, any tournament passwords you '
            + 'have been given and your tournament-creator token if you have one.'))),
      h('div.row', copy, mail, reveal),
      codeBox,
      h('label', h('span', 'Settings from Another Device'), paste,
        h('small', 'Everything on this device is replaced by what the code holds, and the page starts again.')),
      h('div.row', use),
      said));
}

const DIRECTOR_NOTE = 'To create tournaments, expand the Tournament Creator section in Settings '
  + 'and follow the instructions to generate a token.';

function openCreate(): void {
  const d = directory();
  if (!d?.canWrite) return;
  dialog('New Tournament', (close) => {
    const err = h('div');
    const tz = localTimeZone();
    const soon = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const defaultStart = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T19:30`;
    const form = h('form.grid', { onsubmit: async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      try {
        const hourly = (f.elements.namedItem('hourly') as HTMLInputElement).checked;
        const from = Number(val(f, 'from')), to = Number(val(f, 'to'));
        if (hourly && to < from) throw new Error('The last hour comes before the first one');
        const common = {
          name: val(f, 'name'), director: val(f, 'director'), timeZone: val(f, 'tz'),
          levels: SKILLS.filter((x) => (f.elements.namedItem(`lvl-${x}`) as HTMLInputElement | null)?.checked),
          capacity: Number(val(f, 'capacity')),
          boardsPerRound: Number(val(f, 'boards')), rounds: Number(val(f, 'rounds')),
          idleTimeoutSec: Number(val(f, 'idle')),
          scoring: val(f, 'type') === 'imps' ? 'imps' as const : 'matchpoints' as const,
          ...(val(f, 'robots') === '2/1' ? { robots: '2/1' as const } : {}),
          ...((f.elements.namedItem('weekly') as HTMLInputElement).checked ? { repeat: 'weekly' as const } : {}),
        };
        const days = WEEKDAYS.filter((x) => (f.elements.namedItem(`day-${x.day}`) as HTMLInputElement | null)?.checked).map((x) => x.day);
        const hours = hourly ? Array.from({ length: to - from + 1 }, (_, i) => from + i) : [];
        const starts = repeatStarts(val(f, 'start'), days, hours);
        /* Everything is checked before anything is made, so a form that is
           not quite right does not leave half a week of tournaments behind. */
        const metas = starts.map((start) => makeMeta({ ...common, start }));
        /* A password is kept nowhere: what goes on the page is the verifier
           the relay makes of it, which is no use to anybody reading it. */
        const password = val(f, 'password').trim();
        if (password) {
          const lock = await d.lockFor(password);
          for (const meta of metas) meta.lock = lock;
        }
        close();
        let first = 0;
        let made = 0;
        try {
          for (const [i, meta] of metas.entries()) {
            notice = metas.length === 1 ? 'Creating the tournament…'
              : `Creating tournaments… ${i + 1} of ${metas.length}. Leave this page open until it is done.`;
            render();
            const number = await d.create(meta);
            made++;
            /* The director does not have to type their own password back. */
            if (password) rememberPassword(password, number);
            if (!first) { first = number; location.hash = `t=${number}`; }
            /* Gently, so GitHub does not take a run of new issues for a flood. */
            if (i + 1 < metas.length) await new Promise((r) => setTimeout(r, 1200));
          }
        } catch (x) {
          /* The dialog has gone, so this has to be said on the page itself. */
          notice = null;
          errorMsg = `${made} of ${metas.length} tournaments were created, and then GitHub refused: ${(x as Error).message}`;
          render();
          if (made > 0) await refresh(first);
          return;
        }
        /* Only say it is done once it is on the list, so that going back to
           the list shows it there. */
        await refresh(first);
        const done = metas.length === 1 ? 'Tournament created.' : `${metas.length} tournaments created.`;
        notice = listings?.some((x) => x.number === first) ? done : `${done} They may take a moment to appear on the list.`;
        render();
      } catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); render(); }
    } },
      field('Tournament Name', h('input', { name: 'name', required: true, maxLength: MAX_NAME })),
      field('Director (Your Name)', h('input', { name: 'director', required: true, value: settings.name, maxLength: 30 })),
      h('div.two',
        field('Type', h('select', { name: 'type', title: 'Matchpoints: beat as many other tables as you can on each board. IMP Pairs: the size of the difference counts, as in a team match, but you play as a pair.' },
          h('option', { value: 'matchpoints' }, 'Matchpoints'), h('option', { value: 'imps' }, 'IMP Pairs'))),
        field('Open to', h('div.levels', SKILLS.map((x) => h('label.check',
          h('input', { type: 'checkbox', name: `lvl-${x}`, checked: true }), x))))),
      h('div.two',
        field('Start Time', h('input', { name: 'start', type: 'datetime-local', required: true, value: defaultStart })),
        field('Time Zone', h('select', { name: 'tz' }, allTimeZones().map((z) => h('option', { selected: z === tz }, z))))),
      h('div.two',
        field('Capacity (Max Players)', h('input', { name: 'capacity', type: 'number', min: 8, max: 200, step: 4, value: 16, required: true })),
        h('div.two',
          field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 4, required: true })),
          field('Boards / Round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2, required: true })))),
      field('Inactivity Limit (Seconds)',
        h('input', { name: 'idle', type: 'number', min: MIN_IDLE_SEC, max: MAX_IDLE_SEC, step: 5, value: NEW_IDLE_SEC, required: true }),
        'How long a player may keep the table waiting before a robot takes their seat.'),
      field('Robots Bid',
        h('select', { name: 'robots' }, h('option', { value: 'sayc' }, 'SAYC (Standard American)'), h('option', { value: '2/1' }, '2/1 (Two-over-One game forcing)')),
        'The system robots use when they fill a seat. They explain every bid they make.'),
      field('Password (Optional)',
        h('input', { name: 'password', type: 'text', autocomplete: 'off', maxLength: 128,
          placeholder: 'Leave empty for a tournament anybody may enter' }),
        'Set one and only the players you give it to can register — for a club night or a class. '
        + 'It is not kept anywhere: the page carries a signature of it that cannot be read back, and the relay checks it.'),
      h('label.check', h('input', { type: 'checkbox', name: 'weekly' }),
        'Repeat every week on the same day and time'),
      h('small', { style: 'margin-top:-6px' }, 'Once each week\u2019s tournament starts, next week\u2019s appears on the list, ready for players to register.'),
      h('label.check', h('input', { type: 'checkbox', name: 'hourly' }),
        'Hold it on every hour, and on more than one day'),
      h('div.two',
        field('From', h('select', { name: 'from' }, HOURS.map((x) => h('option', { value: x.hour, selected: x.hour === 10 }, x.name)))),
        field('To', h('select', { name: 'to' }, HOURS.map((x) => h('option', { value: x.hour, selected: x.hour === 13 }, x.name))))),
      field('On These Days', h('div.levels', WEEKDAYS.map((x) => h('label.check',
        h('input', { type: 'checkbox', name: `day-${x.day}` }), x.name))),
        'One tournament for every hour on every day ticked, the first week only \u2014 each then repeats weekly if that is ticked too. '
        + 'The start time above gives the week to start from, and must be on the hour. No day ticked means the day it starts on.'),
      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button.primary', { type: 'submit' }, 'Create Tournament')));
    return form;
  });
}

function joinByCode(): void {
  dialog('Private Room', (close) => h('form.grid', { onsubmit: (e: Event) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const code = val(f, 'code').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    settings.name = val(f, 'name'); saveSettings(settings);
    close();
    enterRoom({ id: `private:${code}`, name: `Private room “${code}”`, boardsPerRound: Number(val(f, 'boards')) || 2, rounds: Number(val(f, 'rounds')) || undefined, listing: null, demo: false });
  } },
    h('p.muted', { style: 'margin:0' }, 'Everyone who enters the same code lands in the same room — nothing to sign up for. Good for a quick game or a test.'),
    field('Your Name', h('input', { name: 'name', required: true, value: settings.name, maxLength: 30 })),
    field('Room Code', h('input', { name: 'code', required: true, minLength: 3, maxLength: 30, placeholder: 'e.g. tuesday-club' })),
    h('div.two',
      field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 2 })),
      field('Boards / Round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2 }))),
    h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Join'))));
}

/* ------------------------------------------------------------------ room */

/**
 * A tournament whose field has been settled is played a table at a time: the
 * session joins only the room of the table this player is sitting at, and
 * moves itself on between rounds. Everything else — private rooms, the demo,
 * and a tournament whose director has not called the start yet — keeps to a
 * single room, which is all a handful of players needs.
 */
let session: TournamentSession | null = null;
/** Tables of robots this browser is running for the field; see `unmannedTables`. */
const spares: TournamentSession[] = [];
/** Set while a tournament is under way: puts this browser forward to run them. */
let openSpares: (() => void) | null = null;
let awaitingStart = false;
let startPoll: ReturnType<typeof setInterval> | null = null;

function stopStartPoll(): void {
  if (startPoll) { clearInterval(startPoll); startPoll = null; }
}

function leaveRoom(): void {
  if (room?.listing) leftAt.set(room.listing.number, Date.now());
  node?.close();
  openSpares = null;
  stopRoundWatch();
  closeSpares();
  session?.close();
  stopStartPoll();
  // What was saved only exists to survive a page refresh; leaving on purpose discards it.
  if (room) { try { sessionStorage.removeItem(`bridge-p2p:log:${room.id}`); } catch { /* storage unavailable */ } }
  forgetSessions();
  node = null; session = null; awaitingStart = false; room = null; published = false; watchTable = 0;
  render();
}

function closeSpares(): void {
  for (const s of spares.splice(0)) s.close();
}

/** How long a field may sit waiting on a table of robots before we take it on ourselves. */
const STALL_MS = 60_000;
let roundWatch: ReturnType<typeof setInterval> | null = null;
let lastMoved = 0;
let lastSeenResults = -1;

function stopRoundWatch(): void {
  if (roundWatch) { clearInterval(roundWatch); roundWatch = null; }
  lastSeenResults = -1;
}

/*
 * The field moves together, so a table of robots that nobody is running stops
 * everybody. The browser that was running it may have been closed, or sent to
 * the back of somebody's screen; either way, if the only tables still owing
 * boards are robot ones and nothing anywhere has been played for a minute,
 * this browser stops waiting on whoever had it and takes the table on itself.
 */
function watchRound(): void {
  stopRoundWatch();
  lastMoved = Date.now();
  roundWatch = setInterval(() => {
    const state = session?.node?.state;
    if (!state || state.finished) return;
    if (state.results.length !== lastSeenResults) {
      lastSeenResults = state.results.length;
      lastMoved = Date.now();
      return;
    }
    if (Date.now() - lastMoved < STALL_MS) return;
    const c = state.config;
    const first = firstBoardOfRound(c, state.round);
    const done = (table: number): number =>
      state.results.filter((r) => r.table === table && r.board >= first && r.board < first + c.boardsPerRound).length;
    const behind = state.tables.filter((t) => done(t.index) < c.boardsPerRound).map((t) => t.index);
    const robotOnly = new Set(unmannedTables(c).map((t) => t.table));
    if (behind.length === 0 || !behind.every((i) => robotOnly.has(i))) return;
    lastMoved = Date.now();
    closeSpares();
    openSpares?.();
  }, 15_000);
}

/*
 * A table of robots is only ever run by a tab somebody is looking at. A
 * browser slows a background tab's timers right down — to a tick a minute
 * after a while — so a hidden tab that had won the right to run that table
 * would leave the whole field waiting on a hand being played at a crawl. On
 * the way out it hands the table over; on the way back it offers again.
 */
let sparesWereVisible = false;
document.addEventListener('visibilitychange', () => {
  /* Coming back to the tab: offer again, now as the better host. Leaving it
     changes nothing — whoever is running that table keeps running it. */
  if (document.hidden || !openSpares) return;
  if (!sparesWereVisible) closeSpares();
  openSpares();
});

/**
 * Where a browser leaves what it has seen of a tournament, so that a reload
 * rejoins the round being played rather than starting the tournament again.
 * One per table this browser plays, the robot tables included. It lasts as
 * long as the tab, and leaving the room on purpose throws it away.
 */
function sessionMemory(id: string, which = 'me'): { load(): SessionMemory | null; save(m: SessionMemory): void } {
  const key = `bridge-p2p:ses:${id}:${which}`;
  memoryKeys.add(key);
  return {
    load: () => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as SessionMemory | null; } catch { return null; } },
    save: (m) => { try { sessionStorage.setItem(key, JSON.stringify(m)); } catch { /* quota, or no storage */ } },
  };
}
const memoryKeys = new Set<string>();
function forgetSessions(): void {
  for (const k of memoryKeys) { try { sessionStorage.removeItem(k); } catch { /* none to remove */ } }
  memoryKeys.clear();
}

/*
 * A tournament nobody is left to play is reported as such at once, rather
 * than sitting in the list as a tournament in progress until the time it
 * would have taken has run out. The tables this browser can see have all gone
 * quiet, and only the director's word is taken for it, so a player whose own
 * table empties cannot call off a tournament the rest of the field is still
 * playing.
 */
function maybeMarkAbandoned(n: TournamentNode): void {
  const l = room?.listing;
  if (markedAbandoned || !l || !n.state?.aborted) return;
  const d = directory();
  if (!d?.canAct) return;
  markedAbandoned = true;
  void d.markAbandoned(l.number).then(() => refresh()).catch(() => { markedAbandoned = false; });
}

/**
 * The result goes up on its own. Nobody here is in charge of a tournament —
 * the person who created it may be asleep — so the browsers that played it
 * post it themselves, and whichever gets there first is the one that counts.
 * They go in turn, a few seconds apart in an order every one of them works
 * out the same way, so the usual case is one browser posting and the rest
 * finding it already done.
 */
function maybePublish(n: TournamentNode): void {
  const l = room?.listing;
  const state = n.state;
  /* A tournament that was given up on is reported as that, not finished:
     half a result is not the result of a tournament. */
  if (published || publishing || !l || !state?.finished || state.aborted || state.results.length === 0) return;
  const d = directory();
  if (!d?.canAct) return;
  publishing = true;
  const people = [...new Set(state.config.pairs.flatMap((p) => p.players).filter((p) => !p.bot).map((p) => p.id))].sort();
  const turn = Math.max(0, people.indexOf(n.me.playerId));
  setTimeout(() => {
    void (async () => {
      try {
        /* The hands first and the result after: for a browser with a token
           the result closes the issue, and a closed page is a worse place to
           be adding to. If the hands do not go up the tournament is still
           scored — they are a convenience, not the outcome. */
        try { await d.publishRecords(l.number, recordsOf(state)); } catch { /* the result matters more */ }
        await d.publishResults(l.number, toResults(state));
        published = true;
        render();
        void refresh();
      } catch (e) {
        publishing = false;
        /* Somebody else's browser may yet manage it, and the player can do
           nothing about it either way, so this is said quietly beside the
           result rather than thrown across the page. */
        publishFailed = (e as Error).message;
        render();
      }
    })();
  }, 1500 + turn * 5000);
}

/** The field, as it stood when entries closed. */
function pinnedPlan(l: Listing): TournamentConfig | null {
  if (!l.pinned) return null;
  const entries = pinnedRoster(l);
  if (entries.length < 1) return null;
  return planConfig({
    id: l.roomId, name: l.meta.name, seed: l.pinned.seed,
    roster: entries.map((r) => ({ id: r.login, name: r.name, pairCode: r.pairCode, joinedAt: Date.parse(r.at) })),
    boardsPerRound: l.meta.boardsPerRound, rounds: l.meta.rounds, capacity: l.meta.capacity,
    /* However few turn up, the boards are played twice, so there is a score
       rather than a practice hand: robots make up the rest of the field. */
    minTables: MIN_TABLES,
    idleTimeoutMs: idleSecOf(l.meta) * 1000,
    scoring: l.meta.scoring,
    robots: l.meta.robots,
    ...(l.boards ? { deals: l.boards } : {}),
  });
}

/** Join the table we are sitting at, once there is a field to sit in. */
async function openSession(l: Listing): Promise<void> {
  const config = pinnedPlan(l);
  if (!config || session) return;
  /* What the pairs at this tournament have agreed, so that the table can say
     what each of them plays from the first board. */
  void loadPairCards(true).then(render);
  stopStartPoll();
  awaitingStart = false;
  node?.close();
  node = null;

  const me = {
    playerId: myId() || settings.playerId,
    name: settings.name.trim() || 'Guest',
    deviceScore: deviceScore(),
    isDirector: !!settings.githubLogin && l.initiatorLogin.toLowerCase() === settings.githubLogin.trim().toLowerCase(),
    pairCode: settings.pairCode || undefined,
    note: settings.partnerNote || undefined,
    skill: settings.skill || undefined,
    systems: settings.systems || undefined,
  };
  const connect = async (roomName: string): Promise<Transport> => settings.transport === 'local'
    ? localTransport(roomName)
    : (await import('../net/trystero')).trysteroTransport(roomName);

  session = new TournamentSession({
    config, me, connect,
    onChange: () => {
      node = session?.node ?? null;
      if (node) { timeoutCue(node); maybeMarkAbandoned(node); maybePublish(node); }
      render();
    },
    robot, wake: wakeIn, remember: sessionMemory(config.id),
  });
  await session.start();
  node = session.node;
  render();

  /*
   * A field too small to fill two tables leaves one with four robots at it and
   * nobody in its room to play them. Every browser here offers to run it; the
   * room settles on one of them, and the boards come back to the field like
   * any other table's, so the people who turned up have something to compare
   * their scores against.
   */
  closeSpares();
  openSpares = () => {
    if (spares.length || !session) return;
    sparesWereVisible = !document.hidden;
    for (const t of unmannedTables(config)) {
      const spare = new TournamentSession({
        config, connect, actingAs: t.follow, robot: spareRobot, unmanned: true, wake: wakeIn,
        remember: sessionMemory(config.id, `t${t.table}`),
        /* Nobody is at that table to follow the cards, and the field waits for
           its boards before it can move on, so it plays them without the pause
           that lets a person keep up. */
        botDelayMs: 0,
        /* A tab somebody is looking at is the better host — its robots are
           quicker and it is less likely to vanish — but a tab in the
           background still offers, because the alternative is a table nobody
           plays and a field that never moves on. */
        me: {
          playerId: `spare:${t.table}:${me.playerId}`, name: `Table ${t.table + 1}`,
          deviceScore: sparesWereVisible ? 40 : 2, isDirector: false,
        },
        onChange: () => { /* nobody is watching this table */ },
      });
      spares.push(spare);
      void spare.start().catch(() => { /* the field plays on without it */ });
    }
  };
  openSpares();
  watchRound();
}

function attach(transport: Transport, info: RoomInfo, isDirector: boolean, botDelayMs: number): TournamentNode {
  const key = `bridge-p2p:log:${info.id}`;
  const n = new TournamentNode(transport, {
    playerId: settings.playerId, name: settings.name.trim() || 'Guest', deviceScore: deviceScore(), isDirector,
    pairCode: settings.pairCode || undefined,
    note: settings.partnerNote || undefined,
    skill: settings.skill || undefined,
    systems: settings.systems || undefined,
  }, {
    botDelayMs,
    robot,
    /* In the demo you are the only person at the table, so nobody is kept
       waiting and a long think should not cost you your seat. */
    idleTimeoutMs: info.demo ? 0 : undefined,
    persist: info.demo ? undefined : {
      load: () => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as TEvent[] | null; } catch { return null; } },
      save: (events) => { try { sessionStorage.setItem(key, JSON.stringify(events)); } catch { /* quota */ } },
    },
  });
  n.onChange(() => { timeoutCue(n); render(); });
  return n;
}

async function enterRoom(info: RoomInfo): Promise<void> {
  node?.close();
  openSpares = null;
  stopRoundWatch();
  closeSpares();
  session?.close();
  session = null;
  stopStartPoll();
  errorMsg = null; notice = null; published = false; markedAbandoned = false; publishing = false; publishFailed = null;
  steppedAside = false; autoReseats = 0;

  /* A listed tournament plays a table at a time once its field is settled.
     Until entries close there is nothing to join, so we wait
     and look again rather than gathering everyone into one room. */
  if (info.listing && !info.demo) {
    room = info;
    const current = info.listing;
    if (pinnedPlan(current)) { await openSession(current); return; }
    awaitingStart = true;
    render();
    /* Same allowance, same restraint: this one runs while somebody sits and
       waits, which is exactly when it could run all day. */
    startPoll = setInterval(() => { void lookForStart(); }, settings.token || relayUp ? 10000 : 45000);
    return;
  }

  try {
    let transport: Transport;
    if (settings.transport === 'local') transport = localTransport(info.id);
    else transport = (await import('../net/trystero')).trysteroTransport(info.id);
    const login = settings.githubLogin.trim().toLowerCase();
    const isDirector = !!info.listing && !!login && info.listing.initiatorLogin.toLowerCase() === login;
    room = info;
    node = attach(transport, info, isDirector, ROBOT_DELAY_MS);
    render();
  } catch (e) { fail(e); }
}

/** Has the director called the start yet? */
async function lookForStart(): Promise<void> {
  const d = directory();
  const info = room;
  if (!d || !info?.listing || session) { stopStartPoll(); return; }
  try {
    const fresh = await d.get(info.listing.number);
    info.listing = fresh;
    syncListing(fresh);
    if (pinnedPlan(fresh)) {
      /* Only for players in the field: anybody else here is just watching. */
      const me = myId();
      if (me && pinnedRoster(fresh).some((r) => r.login.toLowerCase() === me)) announceStart(fresh.meta.name);
      await openSession(fresh);
    }
  } catch { /* a refresh that fails just means waiting a little longer */ }
}

function startDemo(): void {
  node?.close();
  errorMsg = null; notice = null; published = false;
  const info: RoomInfo = { id: 'demo', name: 'Demo: you and seven robots', boardsPerRound: 2, rounds: 2, minTables: 2, listing: null, demo: true };
  room = info;
  node = attach(new MemoryHub().connect(), info, true, ROBOT_DELAY_MS);
  node.start({ id: info.id, name: info.name, boardsPerRound: 2, rounds: 2, minTables: 2 });
  render();
}

const pairNames = (s: Standing): string => s.pair.players.map((p) => p.name).join(' & ');

/**
 * The player's own card, which is what a player at a table actually wants
 * beside them: where they stand, and then every board they have played with
 * what it was worth. The full ranking is a tournament-wide thing and waits
 * for the end; this is their evening.
 */
/**
 * The card down the side of the table. A board that has been scored carries
 * its contract as a way into the hand records for that board — the place a
 * player looks after a board is the line for it on their own card.
 */
function myCardPanel(state: TState, meId: string, onBoard?: (board: number) => void): HTMLElement {
  const byImps = state.config.scoring === 'imps';
  const c = state.config;
  const rows = scorecard(state, pairOf(state, meId));
  const table = standings(state);
  const us = table.find((r) => r.pair.players.some((p) => p.id === meId));
  /*
   * A place in the field only when there is a field to have a place in. Said
   * after one board of nine, "4th of 4" is not a standing but an accident of
   * which board came back first, and it reads as a verdict.
   */
  const total = byImps ? `${impText(cardImps(rows))} IMPs` : `${Math.round(cardTotal(rows).we)}%`;
  const place = state.finished && us && us.boardsPlayed
    ? `${ordinal(us.rank)} of ${table.length} \u00b7 ${total}`
    : rows.length === 0 ? 'Nothing scored yet'
      : `${rows.length} board${rows.length === 1 ? '' : 's'} scored \u00b7 ${total} so far`;
  const score = (r: typeof rows[number]): string =>
    r.weScore !== null ? `+${r.weScore}` : r.theyScore !== null ? `\u2212${r.theyScore}` : '0';
  /*
   * Every board of the tournament has a line of its own from the start, so the
   * card itself says how far along this table is — the boards played, against
   * the boards still to come — rather than a count of what other tables have
   * sent in. A heavier rule falls between rounds.
   */
  const boards = c.rounds * c.boardsPerRound;
  const played = new Map(rows.map((r) => [r.board, r]));
  const line = (board: number): HTMLElement => {
    const r = played.get(board);
    const starts = board > 1 && (board - 1) % c.boardsPerRound === 0;
    const said = r ? (r.result.contract ? r.result.text : 'Passed out') : null;
    const contract = said === null
      ? h('td.muted', '\u00b7')
      : onBoard
        ? h(`td${r?.result.contract ? '' : '.muted'}`, h('button.link', {
            title: `The deal, the bidding and every table's result on board ${board}`,
            onclick: () => onBoard(board),
          }, said))
        : h(`td${r?.result.contract ? '' : '.muted'}`, said);
    return h(`tr${starts ? '.round-start' : ''}${r ? '' : '.to-come'}`,
      h('td.num', board),
      contract,
      h('td.num.muted', r?.result.contract ? score(r) : ''),
      h('td.num', r ? (byImps ? impText(r.weImps) : Math.round(r.wePercent)) : ''));
  };
  return h('div.panel',
    h('h3', 'Your Card'),
    h('div.muted', place),
    h('div.table-scroll', { style: 'margin-top:8px' }, h('table.list.card',
      h('thead', h('tr', h('th.num', '#'), h('th', 'Contract'), h('th.num', 'Score'), h('th.num', byImps ? 'IMPs' : '%'))),
      h('tbody', Array.from({ length: boards }, (_, i) => line(i + 1))))),
    rows.length === 0
      ? h('p.muted', { style: 'margin:8px 0 0' }, 'The boards you play appear here as the field scores them.')
      : null);
}

/** "1st", "2nd", "3rd" \u2014 a rank as it is spoken. */
function ordinal(n: number): string {
  const last = n % 10, two = n % 100;
  const suffix = last === 1 && two !== 11 ? 'st' : last === 2 && two !== 12 ? 'nd' : last === 3 && two !== 13 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

function toResults(state: TState): TournamentResults {
  return {
    v: 1, ...(state.config.scoring === 'imps' ? { scoring: 'imps' as const } : {}),
    finishedAt: new Date().toISOString(), tables: state.config.tables,
    boards: state.config.rounds * state.config.boardsPerRound,
    rankings: standings(state).map((s) => ({ rank: s.rank, players: pairNames(s), direction: s.direction, percent: s.percent, matchpoints: s.matchpoints, maxMatchpoints: s.maxMatchpoints, ...(state.config.scoring === 'imps' ? { imps: s.imps } : {}) })),
  };
}

/**
 * Before the field is settled there is no table to join, so this shows who has
 * entered and lets the director call the start. It also covers the moment
 * between rounds, when the old table has broken up and the new one is forming.
 */
function waitingRoom(info: RoomInfo): HTMLElement {
  const l = info.listing;
  const d = directory();
  const head = h('div.row', { style: 'margin-bottom:10px' },
    h('button.open.inline', { onclick: leaveRoom }, '← Leave'),
    h('h2', info.name, info.listing ? [' ', untilTag(info.listing.meta.startUtc) ?? ''] : null),
    h('span.spacer'));

  if (session?.notPlaying) {
    return h('div', head, h('div.panel',
      h('h3', 'Looking for a Seat'),
      h('p', 'The entry list was closed before you registered, so there is no seat of your own in this one. '
        + 'Where a player has dropped out and left a robot playing their cards, you can take that seat over: '
        + 'this looks at one table after another until it finds one.')));
  }
  if (session?.moving || session) {
    return h('div', head, h('div.panel',
      h('h3', `Round ${(session.round ?? 0) + 1}`),
      h('p.muted', 'Finding your next table. The other three players are on their way to it too.')));
  }

  const entries = l?.registrations ?? [];
  const tables = Math.ceil(entries.length / 4);
  countdownCue(l, true);

  return h('div', head, h('div.panel',
    h('h3', 'Waiting Room'),
    h('p.muted', 'Everyone plays at their own table, so there is nothing to connect to until entries close. Entries so far:'),
    h('div.table-scroll', h('table.list', h('tbody', entries.map((r, i) => h(`tr${r.login.toLowerCase() === myId() ? '.me' : ''}`,
      h('td.num', i + 1), h('td', r.name), h('td.muted', r.pairCode ? `pair: ${r.pairCode}` : '')))))),
    h('p', `Starting now would make ${Math.max(MIN_TABLES, tables)} tables; robots fill any empty seats.`),
    l && startNote(l) ? h('p.muted', startNote(l)) : null,
    h('p.muted', 'This page moves you to your table by itself once the tournament starts.')));
}

/**
 * What the field is still waiting for, for a player whose own table has
 * finished the round. Without this the wait looks like a hang; with it you can
 * watch the last table count its boards off — and see that the table holding
 * everybody up is robots, which is a table this browser may be playing itself.
 */
function roundProgress(state: TState): HTMLElement {
  const c = state.config;
  const first = firstBoardOfRound(c, state.round);
  const spare = new Set(unmannedTables(c).map((t) => t.table));
  const rows = state.tables
    .map((t) => {
      const done = state.results.filter((r) => r.table === t.index && r.board >= first && r.board < first + c.boardsPerRound).length;
      return { index: t.index, done };
    })
    .filter((t) => t.done < c.boardsPerRound);
  if (rows.length === 0) return h('p.muted', 'All in. Moving on…');
  return h('div',
    h('div.table-scroll', h('table.list', h('tbody', rows.map((t) => h('tr',
      h('td', `Table ${t.index + 1}`, spare.has(t.index) ? h('div.muted', 'robots') : null),
      h('td.num.muted', `${t.done} of ${c.boardsPerRound} board${c.boardsPerRound === 1 ? '' : 's'}`)))))),
    [...spare].some((i) => rows.some((r) => r.index === i))
      ? h('p.muted', { style: 'margin-bottom:0' }, 'A table of robots plays its own boards through before the field moves on. It takes a minute or two.')
      : null);
}

/** The name of whoever the entry list paired this player with. */
function partnerName(state: TState, playerId: string): string | null {
  const pair = state.config.pairs.find((x) => x.players.some((p) => p.id === playerId));
  return pair?.players.find((p) => p.id !== playerId)?.name ?? null;
}

/**
 * Leaving a seat and coming back to one. A player at the table may stand down
 * and let a robot play on; one who has stood down may ask for their own seat
 * back; and anyone with no seat at all may offer to take a robot's place.
 * Either way the change waits for the next board, so no hand is interrupted.
 */
function seatControls(n: TournamentNode, state: TState, demo: boolean): HTMLElement | null {
  if (state.finished) return null;
  const me = n.me.playerId;

  /* In the demo you are the only player, so standing down would leave the
     tournament with nobody in it and end it there and then. */
  if (n.mySeat()) {
    if (demo) return null;
    return h('button', { title: 'Please replace me with a Robot', onclick: () => { steppedAside = true; n.withdraw(); render(); } }, 'Withdraw');
  }

  /* A seat already asked for is given out when the board in progress ends. */
  const asked = Object.entries(state.pendingSeats)
    .some(([id, who]) => (who === null ? id === me : who?.id === me));
  if (asked) return h('span.muted', 'You sit down when this board is over.');

  if (state.retired.includes(me) && !state.substitutes[me]) {
    const mate = partnerName(state, me);
    return h('button.primary', {
      title: `Reseat me on next hand with${mate ? ` ${mate}` : ''}`,
      onclick: () => { steppedAside = false; noteActivity(); n.takeSeat(me); render(); },
    }, 'Reseat Me');
  }

  /* No seat: a latecomer, or somebody whose own seat was taken on while they
     were away. Either way, a robot's seat is there for the asking. */
  const free = n.robotSeats();
  return h('div.row',
    h('button.primary', {
      disabled: free.length === 0, title: 'Please replace a random Robot with me',
      onclick: () => { claimRobotSeat(n); render(); },
    }, 'Replace a Robot'),
    h('span.muted', free.length
      ? `${free.length} robot seat${free.length === 1 ? '' : 's'} free here.`
      : session?.notPlaying
        ? 'No robot is playing at this table; looking at another one shortly.'
        : 'No robot is playing at this table.'));
}

/**
 * A seat lost to the clock is given back without asking. A player who stood
 * down on purpose is left alone, and so is one whose page is merely open
 * somewhere: without a sign that somebody is actually there, putting them
 * back would only hand the seat to a robot again a minute later.
 */
let steppedAside = false;
let lastSeenHere = Date.now();
const BACK_WITHIN_MS = 2 * 60_000;
const AUTO_RESEATS = 3;
let autoReseats = 0;

export function noteActivity(): void { lastSeenHere = Date.now(); }

function maybeReseat(n: TournamentNode): boolean {
  const state = n.state;
  if (!state || state.finished || steppedAside || autoReseats >= AUTO_RESEATS) return false;
  const me = n.me.playerId;
  if (n.mySeat() || !state.retired.includes(me) || state.substitutes[me]) return false;
  if (document.hidden || Date.now() - lastSeenHere > BACK_WITHIN_MS) return false;
  /* Already asked for: it comes back when the board in progress ends. */
  if (Object.entries(state.pendingSeats).some(([id, who]) => (who === null ? id === me : who?.id === me))) return false;
  autoReseats++;
  notice = 'You timed out, so a robot played for you. You have been put back in your seat for the next board.';
  turnChime();
  n.takeSeat(me);
  return true;
}

/** Sit down in place of one of the robots, from the next board. */
function claimRobotSeat(n: TournamentNode): void {
  if (session) { session.claimRobotSeat(); return; }
  const free = n.robotSeats();
  const pick = free[Math.floor(Math.random() * free.length)];
  if (pick) n.takeSeat(pick.forPlayerId);
}

/** Who has left this table, and who is playing their cards now. */
function replacedPanel(state: TState, table: TableState): HTMLElement | null {
  const rows = SEATS.map((seat) => {
    const owner = originalSeatId(state.config, table, seat);
    if (!owner) return null;
    const sitting = table.seats[seat];
    if (sitting.id === owner) return null;
    return h('tr', h('td', ownerOf(state.config, owner)?.name ?? owner), h('td.muted', '→'), h('td', sitting.name));
  }).filter((x): x is HTMLElement => x !== null);
  if (rows.length === 0) return null;
  return h('div.panel', h('h3', 'Stood Down'),
    h('table.list', h('tbody', rows)),
    h('p.muted', { style: 'margin:6px 0 0' }, 'A player who comes back takes their own seat again from the next board.'));
}

/**
 * The clock speaks twice: once while there is still time to act on it, and
 * again if it runs out, with the way back to the table. Both are for a player
 * who has looked away, so both are spoken rather than drawn.
 */
/*
 * When the warning is spoken is the node's business, not the page's: every
 * peer works it out from the same clock, so the moment the player hears
 * about is the moment the seat is really at risk. The page only guards
 * against speaking to somebody who has just arrived at a turn already
 * running — on a reseat, say.
 */
const SETTLE_WARN_MS = 3_000;
let warnedTurn = '';
let seenTurn = '';
let seenAt = 0;
let warnTimer: (() => void) | null = null;
let warnKey = '';
let wasRetired = false;

/** This seat's clock at my table, when it is my turn and the clock is running. */
function myClock(): { key: string; leftMs: number; warnInMs: number } | null {
  const n = node;
  if (!n) return null;
  const at = n.mySeat();
  if (!at) return null;
  const turn = turnAt(at.table);
  if (!turn || at.table.seats[turn.controller].id !== n.me.playerId) return null;
  return n.idleClock(at.table.index);
}

function sayWarning(key: string): void {
  if (warnedTurn === key) return;
  if (seenTurn === key && Date.now() - seenAt < SETTLE_WARN_MS) return;
  warnedTurn = key;
  say('Ten seconds to time out.');
}

function watchMyClock(): void {
  const clock = myClock();
  /* No clock to read: the turn has moved on, or this device has not started
     one for it yet. Either way there is nothing to book and nothing to say. */
  if (!clock) return;
  if (seenTurn !== clock.key) { seenTurn = clock.key; seenAt = Date.now(); }
  if (warnedTurn === clock.key || clock.leftMs <= 0) return;
  if (clock.warnInMs <= 0) { sayWarning(clock.key); return; }
  /* Book the warning for the moment it falls due rather than leaving it to a
     tick to notice the moment has passed. Re-booked whenever the turn changes
     or the booking has been used up, so a missed tick cannot lose it. */
  if (!warnTimer || warnKey !== clock.key) {
    if (warnTimer) warnTimer();
    warnKey = clock.key;
    warnTimer = wakeIn(() => {
      warnTimer = null;
      const c = myClock();
      if (c && c.key === warnKey && c.leftMs > 0) sayWarning(c.key);
    }, clock.warnInMs);
  }
}

/**
 * Has the clock just taken this player's seat? Asked before the page tries to
 * put them back, so the answer is about the timeout and not about the cure.
 */
function justTimedOut(n: TournamentNode): boolean {
  const state = n.state;
  const me = n.me.playerId;
  /* Not conditional on the tournament still running: the last human timing
     out is what calls it off, and that is the moment most worth hearing. */
  const out = !!state && state.retired.includes(me)
    && !state.substitutes[me] && !n.mySeat()
    /* Asked for already: the page is putting them back from an earlier one. */
    && !Object.entries(state.pendingSeats).some(([id, who]) => (who === null ? id === me : who?.id === me));
  /* Standing down on purpose is not the clock running out. */
  const fresh = out && !wasRetired && !steppedAside;
  wasRetired = out;
  return fresh;
}

/** The clock's own announcement, with the way back to the table. */
function timeoutCue(n: TournamentNode): void {
  const out = justTimedOut(n);
  const back = maybeReseat(n);
  if (!out) return;
  const state = n.state;
  say(state?.aborted
    ? 'You got timed out and the tournament was canceled due to no real players left.'
    : state?.finished
      ? 'Your time ran out, so a robot played the last of your cards. The tournament is over.'
      : back
        ? 'Your time ran out, so a robot played for you. You are back in your seat for the next board.'
        : 'Your time ran out, so a robot is playing your cards. Press the reseat me button to come back for the next board.');
}

/* What the table sounded like last time it was drawn, so that a sound marks
   something happening rather than the page being redrawn. */
let heardBoard = '';
let heardCards = 0;
let heardMyTurn = false;

/**
 * The table speaks up twice: when it is your turn, so you can look away
 * between hands, and as each card goes down, which is the sound a table
 * makes anyway.
 */
function soundCues(n: TournamentNode, table: TableState): void {
  const board = `${table.index}:${table.boardNo ?? 0}`;
  const cards = table.play?.cardsPlayed ?? 0;
  if (board !== heardBoard) {
    /* A new board: start again rather than reading the reset as play. */
    heardBoard = board;
    heardCards = cards;
    heardMyTurn = false;
  }
  if (cards > heardCards) cardSwoosh();
  heardCards = cards;

  const turn = turnAt(table);
  const mine = !!turn && table.seats[turn.controller].id === n.me.playerId;
  if (mine && !heardMyTurn) turnChime();
  heardMyTurn = mine;
}

/**
 * Declarer picks how many of the remaining tricks to claim; a defender, how
 * many to concede. Either way the number is declarer's, which is what the
 * table is asked to agree to.
 */
function openClaim(n: TournamentNode): void {
  const at = n.mySeat();
  const p = at?.table.play;
  if (!at || !p) return;
  const left = tricksLeft(p);
  const declaring = at.seat === p.contract.declarer;
  const pick = h('select', Array.from({ length: left + 1 }, (_, i) => left - i)
    .map((k) => h('option', { value: String(k) }, String(k)))) as HTMLSelectElement;
  const preview = h('p.muted');
  const show = (): void => {
    const k = Number(pick.value);
    const total = p.declarerTricks + k;
    preview.textContent = `Declarer would end with ${total} trick${total === 1 ? '' : 's'}: ${resultToString(p.contract, total)}.`;
  };
  pick.onchange = show;
  show();
  const who = declaring ? 'the two defenders' : 'declarer and your partner';
  dialog(declaring ? 'Claim Tricks' : 'Concede Tricks', (close) => h('div',
    h('p', declaring ? 'How many of the ' : 'How many of the ', h('b', `${left} remaining trick${left === 1 ? '' : 's'}`),
      declaring ? ' do you claim?' : ' do you concede to declarer?'),
    h('div.row', pick, h('span', declaring ? 'tricks for you' : 'tricks to declarer')),
    preview,
    h('p.muted', `Your hand is shown to the table while ${who} decide. Play stops until they both accept; if either rejects, play carries on.`),
    h('div.row', h('span.spacer'),
      h('button', { onclick: close }, 'Cancel'),
      h('button.primary', { onclick: () => { n.claim(Number(pick.value)); close(); } }, declaring ? 'Claim' : 'Concede'))));
}

function roomView(n: TournamentNode, info: RoomInfo): HTMLElement {
  const state = n.state;
  const myPair = state ? pairOf(state, n.me.playerId) : null;
  /*
   * Whether the table is waiting on this player right now. Dummy is never
   * waited on — declarer plays those cards — so dummy keeps the records open
   * through the whole hand, which is the one seat with nothing else to do.
   */
  const seated = n.mySeat();
  const myTurn = !!seated && turnAt(seated.table)?.controller === seated.seat;
  /* The hand records take over the page, and the turn clock does not stop for
     them. Being on turn closes them rather than leaving somebody reading a
     traveller while their own clock runs out. */
  if (myTurn && reviewing) { reviewing = false; recBoard = null; recTable = null; }
  const head = h('div.row', { style: 'margin-bottom:10px' },
    h('button.open.inline', { onclick: leaveRoom }, '← Leave'),
    h('h2', info.name, info.listing ? [' ', untilTag(info.listing.meta.startUtc) ?? ''] : null),
    h('span.spacer'),
    state && state.results.length > 0
      ? h('button.open.inline', {
          disabled: myTurn,
          onclick: () => { reviewing = !reviewing; recBoard = null; recTable = null; recMode = 'mine'; render(); },
          title: myTurn
            ? 'The table is waiting for you. The records open again once you have called or played.'
            : 'Look back over the boards: all four hands, the bidding, and what every other table did' },
        reviewing ? 'Back to the Table' : 'Hand Records')
      : null,
    state ? seatControls(n, state, info.demo) : null,
    info.demo ? null : h('span.muted', `Host: ${n.coordinatorName}${n.isCoordinator ? ' (this device)' : ''} · ${n.lobby().length} connected`));

  if (state && reviewing) {
    return h('div', head, renderRecords(state, myPair, { board: recBoard, table: recTable, mode: recMode }, {
      pickBoard: (b) => { recBoard = b; recTable = null; render(); },
      pickTable: (t) => { recTable = t; render(); },
      setMode: (m) => { recMode = m; recTable = null; render(); },
    }));
  }

  if (!state) {
    const lobby = n.lobby();
    const tables = Math.max(1, Math.ceil(Math.min(lobby.length, info.capacity ?? Infinity) / 4));
    return h('div', head, h('div.panel',
      h('h3', 'Waiting Room'),
      h('p.muted', settings.transport === 'local'
        ? 'Connection: this browser only. Open this page in more tabs and enter the same room to add players.'
        : 'Players connect directly to each other. It can take a few seconds for everyone to appear.'),
      h('div.table-scroll', h('table.list', h('tbody', lobby.map((p, i) => h(`tr${p.id === settings.playerId ? '.me' : ''}`,
        h('td.num', i + 1), h('td', p.name), h('td.muted', p.pairCode ? `pair: ${p.pairCode}` : '')))))),
      h('p', `Starting now would make ${tables} table${tables === 1 ? '' : 's'}; robots fill any empty seats.`),
      n.isCoordinator
        ? h('div.row', h('button.primary', { onclick: () => {
            try {
              n.start({
                id: info.id, name: info.name, boardsPerRound: info.boardsPerRound, rounds: info.rounds,
                capacity: info.capacity, minTables: info.minTables,
                /* The director's setting travels in the config, so whichever
                   device ends up hosting applies the same limit. The demo has
                   nobody waiting, so the rule is off there. */
                idleTimeoutMs: info.demo ? 0 : info.listing ? idleSecOf(info.listing.meta) * 1000 : undefined,
              });
            } catch (e) { fail(e); }
          } }, 'Start Tournament'),
          h('span.muted', n.me.isDirector || !info.listing ? 'This device is hosting.' : 'The director is not connected, so this device is hosting.'))
        : h('p.muted', `Waiting for ${n.coordinatorName} to start the tournament.`)));
  }

  const side = h('div.side');
  /* Once play starts the auction goes here rather than the foot of the rail
     beside the table: read beside your own hand it can be a comfortable size,
     and the cards get the width the rail was spending. It carries its own
     edge, so it is not given a panel to sit inside — that would only be a
     second border around the same thing. */
  const boardPanel = h('div.board-panel');
  const at = n.mySeat();
  const main = h('div');

  if (state.finished) {
    main.append(state.aborted
      ? h('div.panel',
          h('h3', 'Tournament Aborted'),
          h('p', 'Every table was left without a player, so the tournament was called off. The boards played so far are below.'),
          resultsTable(toResults(state)))
      : h('div.panel', h('h3', 'Tournament Finished'), resultsTable(toResults(state))));
    const d = directory();
    if (info.listing && d) {
      const l = info.listing;
      main.append(h('div.row', { style: 'margin-top:10px' }, published
        ? h('span', 'Results published to ', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'the tournament page'), '.')
        : publishFailed
          ? h('span.muted', `These results are not on the tournament page: ${publishFailed}`)
          : d.canAct
            ? h('span.muted', 'Publishing the results to the tournament page\u2026')
            : h('span.muted', 'These results stay on this device: there is no way from here to put them on the tournament page.')));
    }
  } else {
    /* A latecomer looking for a seat watches the one table whose room they
       are in, which is the only one their state really knows about. */
    const watched = session?.notPlaying && session.watching !== null ? session.watching : watchTable;
    const table = at?.table ?? state.tables[Math.min(watched, state.tables.length - 1)];
    if (!at && !session && state.tables.length > 1) {
      main.append(h('div.row', { style: 'margin-bottom:8px' }, h('span.muted', 'Watching:'),
        state.tables.map((t) => h('button', { disabled: t.index === watchTable, onclick: () => { watchTable = t.index; render(); } }, `Table ${t.index + 1}`))));
    }
    if (table && table.boardNo !== null) {
      /* Somebody who has stood down still sees their own hand — a robot is
         playing those cards for them — but no more than that. */
      const ownSeat = at?.seat ?? SEATS.find((x) => originalSeatId(state.config, table, x) === n.me.playerId) ?? null;
      /* Only our own table is worth listening to; a watched one is not ours
         to be prompted about. */
      if (at) soundCues(n, table);
      main.append(renderTable({
        table, mySeat: at?.seat ?? null, viewSeat: ownSeat,
        onCall: (c, alert) => n.call(c, alert), onPlay: (seat, card) => n.play(seat, card),
        onClaim: () => openClaim(n), onAnswerClaim: (yes) => n.answerClaim(yes), onWithdrawClaim: () => n.withdrawClaim(),
        isPresent: (id) => n.isPresent(id),
        playerInfo: tablePlayerInfo(n),
        onPlayerInfo: (p) => openPlayerInfo(p, n.state?.config.robots),
        robots: n.state?.config.robots,
        panel: boardPanel,
      }));
      if (n.lastError) main.append(h('div.error', n.lastError));
    } else {
      main.append(h('div.panel', h('h3', 'Round complete at your table'),
        h('p.muted', 'Waiting for the other tables to finish this round…'),
        roundProgress(state)));
    }
    if (table) {
      const left = replacedPanel(state, table);
      if (left) side.append(left);
      /* No panel of its own for the round: a count of what every table has
         sent in said more about the robots' table than about this one, and
         the card below shows this table's own place in the boards. */
    }
  }
  if (boardPanel.childElementCount) side.append(boardPanel);
  /* On turn the records are shut and the way in is closed with them: the
     table is waiting, and the clock does not stop for a traveller. */
  side.append(myCardPanel(state, n.me.playerId, myTurn ? undefined : (board) => {
    reviewing = true; recBoard = board; recTable = null; recMode = 'mine';
    render();
  }));
  return h('div', head, h('div.room', main, side));
}

/* ---------------------------------------------------------------- render */

/**
 * What was just done, said once and dismissable. It is drawn at the head of
 * the page, except on a tournament's own page, where it goes on the line the
 * back button is already using: that page is read for the list of players at
 * the foot of it, and a banner across the top pushed them further down.
 */
function noticeTag(): HTMLElement | null {
  return notice
    ? h('div.note', notice, ' ', h('button.link', { onclick: () => { notice = null; render(); } }, 'Dismiss'))
    : null;
}

function render(): void {
  const onDetail = !(room && (awaitingStart || session) && !node) && !(node && room) && !!detail;
  const view = room && (awaitingStart || session) && !node ? waitingRoom(room)
    : node && room ? roomView(node, room)
    : detail ? detailView(detail) : directoryView();
  /*
   * Everything but the felt is held in. A page of panels stretched across a
   * large window stands its columns an inch apart and is read worse for the
   * room it was given; the table is the one place where more width is more
   * game, so it alone keeps the full measure. The records shown from the
   * table are a page of panels like any other.
   */
  const atTable = !!(node && room) && !reviewing;
  root.replaceChildren(h(`div.wrap${atTable ? '.wide' : ''}`,
    h('header.top',
      h('div.brand', h('h1', h('span.suits', h('b', '♠'), h('b', '♥'), h('b', '♦'), h('b', '♣')), ' Bridge Break'), h('span', 'free duplicate tournaments')),
      testMode() ? testSwitcher() : h('span.muted', settings.name ? `Playing as ${settings.name}` : ''),
      onlineTag(),
      inLiveTournament() ? null
        : h('button', { onclick: openLobby, title: 'Public message board' }, 'Lobby'),
      h('button', { onclick: openAbout, title: 'What this is, what it does, and how to start' }, 'About'),
      h('button', { onclick: openSettings }, 'Settings')),
    errorMsg ? h('div.error', { role: 'alert' }, errorMsg) : null,
    onDetail ? null : noticeTag(),
    inviteBanner(),
    view));
}

/**
 * A code that arrived by camera.
 *
 * Scanning the square on the other device lands here with the settings in
 * the fragment. It is taken out of the address at once: a fragment is never
 * sent to a server, but it would otherwise sit in this phone's history, and
 * it is a password. Nothing is applied without being confirmed — the code is
 * put where a pasted one would go, already read and waiting on a press.
 */
let scanned: string | null = null;

function takeScannedKit(): boolean {
  const m = /^#kit=([A-Za-z0-9._-]+)$/.exec(location.hash);
  if (!m) return false;
  scanned = m[1] as string;
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return true;
}

async function route(): Promise<void> {
  if (takeScannedKit()) { openSettings(); return; }
  const m = /^#t=(\d+)$/.exec(location.hash);
  if (!m) { detail = null; render(); return; }
  const number = Number(m[1]);
  detail = listings?.find((l) => l.number === number) ?? null;
  render();
  startPolling(); // catches a partner's invite/accept/unregister while this page stays open
  /*
   * A listing taken from the list may never have had its comments read: the
   * list skims everything that is not about to start, being played or lately
   * finished, because reading all of them every minute is more than the
   * allowance will bear. That is right for a list, where only the numbers
   * show, and wrong here, where the page is the entry list. So anything
   * skimmed is read in full on the way in, as it always meant to be.
   */
  if (!detail || detail.skimmed) {
    const d = directory();
    if (!d) return;
    try {
      let l = await d.get(number);
      l = await applyAutoRegister(d, l);
      syncListing(l);
    } catch (e) { fail(e); }
  }
}

/* A tab that was left in the background has not been asking for news; catch
   up the moment it is looked at again. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden || node || !pollTimer || Date.now() < quietUntil) return;
  void refresh();
});

setSound(settings.sound);
/* A browser will not make a sound until the page has been touched, so the
   audio waits for that first click rather than being refused now. */
armSound();
window.addEventListener('hashchange', () => { if (!node) void route(); else render(); });
window.addEventListener('pagehide', () => node?.close());
render();
/* Ask the relay first — it answers in a few milliseconds, or not at all — so
   the very first look at the list already goes the right way. */
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, noteActivity, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  /* Coming back to the tab is the moment a timed-out player is here again. */
  noteActivity();
  if (node) { timeoutCue(node); render(); }
});
installHoverTips();
/* A countdown that never moves is worse than none, and the list is read far
   less often than once a minute, so the page redraws itself on the minute. */
setInterval(() => {
  const soon = (l: Listing): boolean => !!countdown(l.meta.startUtc);
  if ((listings ?? []).some(soon) || (room?.listing && soon(room.listing))) render();
}, 30000);
/* The turn clock is worth hearing about from a background tab above all, so
   it ticks on the worker clock rather than on a timer the browser throttles. */
const tickClock = (): void => { watchMyClock(); wakeIn(tickClock, 1000); };
tickClock();
watchOnline(() => render(), settings.transport !== 'local');
void probeRelay().then(() => refresh()).then(route).then(startPolling);
if (!settings.name) openSettings();
