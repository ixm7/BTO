import { DEFAULT_IDLE_SEC, MIN_PLAYERS, Directory, GitHubError, isRelayed, playerTag, MAX_IDLE_SEC, MIN_IDLE_SEC, SKILLS, idleSecOf, inviteCode, levelPhrase, levelText, pinnedRoster, makeMeta, toSkill, welcomes, type Invitation, type Listing, type Skill, type TournamentResults } from '../directory/github';
import { allTimeZones, formatInZone, localTimeZone } from '../directory/time';
import { MemoryHub, localTransport, type Transport } from '../net/transport';
import { TournamentSession } from './session';
import { planConfig } from '../tournament/plan';
import { pairOf } from '../tournament/review';
import { renderRecords, type RecordsMode } from './review';
import { TournamentNode, deviceScore } from '../tournament/node';
import { originalSeatId, ownerOf, standings, tricksLeft, turnAt, type Standing, type TableState, type TEvent, type TournamentConfig, type TState } from '../tournament/state';
import { SEATS } from '../engine/cards';
import { armSound, cardSwoosh, setSound, startFanfare, turnChime } from './sound';
import { TEST_USERS, h, loadSettings, saveSettings, testMode, testUser, type Settings } from './dom';
import { renderTable } from './tableView';
import { resultToString } from '../engine/scoring';

const DEFAULT_REPO = (import.meta.env.VITE_DIRECTORY_REPO as string | undefined) ?? '';
const root = document.getElementById('app') as HTMLElement;
const settings: Settings = loadSettings(DEFAULT_REPO);

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
let published = false;
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

const fail = (e: unknown): void => { errorMsg = e instanceof Error ? e.message : String(e); render(); };

/* ------------------------------------------------------------ directory */

/** Keep `detail` and `listings` in sync with a Listing fetched elsewhere (e.g. from
 * inside the Partners dialog), and push it to that dialog too, if one is open for it. */
function syncListing(l: Listing): void {
  if (detail && detail.number === l.number) detail = l;
  if (listings) { const i = listings.findIndex((x) => x.number === l.number); if (i >= 0) listings[i] = l; }
  partnersSync?.(l);
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
    await d.register(l.number, settings.name, code, settings.skill);
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
const pollEvery = (): number => (settings.token ? 15000 : 120000);

/** Set while the list has told us to stop asking, until it will answer again. */
let quietUntil = 0;

/** When the list was last asked for. */
let lastRefresh = 0;

/** Tournaments this player walked out of, so they are not hauled back in. */
const leftOnPurpose = new Set<number>();

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
    if (l.status !== 'in progress' || !l.pinned || leftOnPurpose.has(l.number)) continue;
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
    listings = await d.list();
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
  const deleted = gone.filter((x) => x.outcome === 'deleted').length;
  notice = `Cleared ${gone.length} abandoned tournament${gone.length === 1 ? '' : 's'}: ${gone.map((x) => x.name).join(', ')}.`
    + (deleted < gone.length ? ' Some were closed rather than deleted, which needs admin rights on the repository.' : '');
  listings = await d.list();
}

function when(l: Listing): HTMLElement {
  const d = new Date(l.meta.startUtc);
  const mine = localTimeZone();
  return h('div', formatInZone(d, l.meta.timeZone),
    mine !== l.meta.timeZone ? h('div.muted', `${formatInZone(d, mine)} (your time)`) : null);
}

const badge = (status: string): HTMLElement => h(`span.badge.${status.replace(' ', '-')}`, status);
const playersCell = (l: Listing): string => `${l.registrations ? l.registrations.length : '?'} / ${l.meta.capacity}`;

/** What becomes of you if you enter without a partner, shown wherever you enter. */
const PARTNERING_NOTE = 'Registered players without a partner will be assigned a player at random (or a robot if no partner is available).';

/** Still to be played, and with room for another player. */
const openToJoin = (l: Listing): boolean =>
  (l.status === 'upcoming' || l.status === 'starting') && (l.registrations?.length ?? 0) < l.meta.capacity;

let onlyOpen = false;

function directoryView(): HTMLElement {
  const d = directory();
  const body = h('div.panel');
  if (!d) {
    body.append(h('p', 'No tournament directory is configured. You can still try a demo table against robots.'));
  } else if (loading && !listings) {
    body.append(h('p.muted', 'Loading tournaments…'));
  } else if (listings && listings.length === 0) {
    body.append(h('p', 'No tournaments yet. Be the first to create one.'));
  } else if (listings && onlyOpen && !listings.some(openToJoin)) {
    body.append(h('p', 'No tournaments are open for registration right now. '),
      h('button.link', { onclick: () => { onlyOpen = false; render(); } }, 'Show all tournaments'));
  } else if (listings) {
    const shown = onlyOpen ? listings.filter(openToJoin) : listings;
    body.append(h('div.table-scroll', h('table.list',
      h('thead', h('tr', ['Tournament', 'Director', 'Type', 'Start', 'Level', 'Players', 'Status', 'Result'].map((t) => h(t === 'Players' ? 'th.num' : 'th', t)))),
      h('tbody', shown.map((l) => h('tr',
        h('td', h('button.link', { onclick: () => { location.hash = `t=${l.number}`; } }, l.meta.name)),
        h('td', l.meta.director, h('div.muted', `@${l.initiatorLogin}`)),
        h('td', 'Matchpoints'),
        h('td', when(l)),
        h('td', levelText(l.meta)),
        h('td.num', playersCell(l)),
        h('td', badge(l.status)),
        h('td', l.results?.rankings[0] ? `1st: ${l.results.rankings[0].players} (${l.results.rankings[0].percent.toFixed(1)}%)` : h('span.muted', '—')),
      ))))));
  }
  return h('div',
    h('div.row', { style: 'margin-bottom:10px' },
      h('h2', 'Tournaments'),
      h('span.spacer'),
      d ? h('label.check', { title: 'Show only tournaments that have not started and still have room' },
        h('input', { type: 'checkbox', checked: onlyOpen, onchange: (e: Event) => { onlyOpen = (e.target as HTMLInputElement).checked; render(); } }),
        ' Open for registration') : null,
      d ? h('button', { onclick: () => void refresh(), disabled: loading }, loading ? 'Refreshing…' : 'Refresh') : null,
      h('button', { onclick: joinByCode, title: 'Play with specific people using a shared room code, instead of an open tournament from the list above — good for a private game with friends or a quick test with nothing to sign up for.' }, 'Join private room'),
      h('button', { onclick: startDemo }, 'Play a demo vs robots'),
      !d ? null : d.canWrite
        ? h('button.primary', { onclick: openCreate }, 'New tournament')
        /* Only a token can write a tournament into the list. The tooltip hangs
           on a wrapper, since a disabled button is sent no mouse events. */
        : h('span.tip', { title: DIRECTOR_NOTE }, h('button.primary', { disabled: true }, 'New tournament'))),
    body);
}

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** How the tournament gets going, said in terms of this one's numbers. */
function startNote(l: Listing): string | null {
  const plan = l.plan;
  if (l.status === 'upcoming') {
    return `Starts automatically at the start time if all ${l.meta.capacity} places are taken. Otherwise entries stay open `
      + `a minute longer, and another minute each time somebody joins (up to five more). It needs at least ${MIN_PLAYERS} players, `
      + 'and is cancelled if it does not have them within five minutes of the start time.';
  }
  if (l.status === 'starting' && plan?.kind === 'wait') {
    const n = l.registrations?.length ?? 0;
    if (Date.now() >= plan.until) return 'Entries have closed. Settling the field and the deals…';
    if (n < MIN_PLAYERS) return `Waiting for at least ${MIN_PLAYERS} players: ${n} so far. Entries stay open until ${clock(plan.until)}, then it is cancelled if there are still too few.`;
    return `Entries close at ${clock(plan.until)} — later if somebody else joins before then, or sooner if all places are taken.`;
  }
  return null;
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
  const open = l.status === 'upcoming' || l.status === 'starting' || l.status === 'in progress';
  const act = (fn: () => Promise<unknown>, done: string) => async (): Promise<void> => {
    try { await fn(); notice = done; await refresh(); } catch (e) { fail(e); }
  };

  // The partner of a registered player, by whoever else is registered under the same code.
  const partnerNameOf = (r: { login: string; pairCode?: string }): string | null => {
    if (!r.pairCode) return null;
    const code = r.pairCode.trim().toLowerCase();
    return regs?.find((o) => o.login !== r.login && o.pairCode?.trim().toLowerCase() === code)?.name ?? null;
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
  if (open && welcome) {
    if (d.canAct) {
      actions.append(amRegistered
        ? h('button', { onclick: act(async () => {
            await d.withdraw(l.number);
            // Unregistering breaks the partnership too, so the ex-partner's own browser
            // stops treating us as accepted-and-should-auto-register, and sees we split up.
            if (myPartnerLogin) await d.unpair(l.number, myPartnerLogin);
          }, 'You have unregistered.') }, 'Unregister')
        : h('button.primary', { title: PARTNERING_NOTE, disabled: full || !settings.name.trim(), onclick: act(() => d.register(l.number, settings.name, settings.pairCode, settings.skill), 'You are registered.') }, full ? 'Full' : 'Register'));
    } else {
      actions.append(h('a', { href: l.url, target: '_blank', rel: 'noopener', title: PARTNERING_NOTE }, 'Register on the tournament page'),
        h('span.muted', `(comment “/register ${settings.name.trim() || 'Your Name'}”, or add a token in Settings to register from here)`));
    }
    actions.append(h('button.primary', { disabled: !settings.name.trim(), onclick: () => { leftOnPurpose.delete(l.number); void enterRoom(roomInfoOf(l)); } }, 'Enter playing room'));
  }
  if (open && welcome) {
    const seeking = l.partners?.seekers.length;
    actions.append(h('button', {
      onclick: () => openPartners(l),
      title: 'Players looking for a partner for this tournament',
    }, seeking === undefined ? 'Partners List' : `Partners List [${seeking}]`));
  }
  if (!settings.name.trim()) actions.append(h('span.muted', 'Set your name in Settings first.'));

  return h('div',
    /* No link out to the underlying page here: everything on it can be done
       from this view, and where it cannot — registering without a token — the
       link sits with the action it belongs to. */
    h('div.row', h('button', { onclick: () => { location.hash = ''; } }, '← All tournaments')),
    whyNot ? h('div.note', { style: 'margin-top:10px' }, whyNot) : null,
    l.tooFew ? h('div.note', { style: 'margin-top:10px' },
      `Cancelled: fewer than ${MIN_PLAYERS} players had registered five minutes after the start time.`) : null,
    startNote(l) ? h('p.muted', { style: 'margin-top:10px' }, startNote(l)) : null,
    h('div.panel', { style: 'margin-top:10px' },
      h('div.row', h('h2', l.meta.name), badge(l.status)),
      h('dl.facts',
        h('dt', 'Director'), h('dd', `${l.meta.director} (@${l.initiatorLogin})`),
        h('dt', 'Type'), h('dd', 'Matchpoints'),
        h('dt', 'Start'), h('dd', when(l)),
        h('dt', 'Time zone'), h('dd', l.meta.timeZone),
        h('dt', 'Open to'), h('dd', levelText(l.meta)),
        h('dt', 'Capacity'), h('dd', `${l.meta.capacity} players`),
        h('dt', 'Registered'), h('dd', regs ? `${regs.length}${full ? ' (full)' : ''}` : 'unknown (too many requests just now)'),
        h('dt', 'Format'), h('dd', `${l.meta.rounds} round(s) × ${l.meta.boardsPerRound} board(s)`),
        l.meta.repeat === 'weekly' ? [h('dt', 'Repeats'), h('dd', `Every ${weekdayOf(l)} at the same time`,
          canStop(l) ? [' ', h('button.link', { onclick: () => void stopSeries(l) }, 'Stop repeating')] : null)] : null),
      actions),
    l.results ? h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Final results'), resultsTable(l.results)) : null,
    h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Registered players'),
      regs && regs.length ? h('div.table-scroll', h('table.list', h('tbody', regs.map((r, i) => h('tr',
        h('td.num', i + 1), h('td', r.name), h('td.muted', isRelayed(r.login) ? '' : `@${r.login}`),
        h('td.muted', r.skill ?? ''),
        h('td.muted', partnerNameOf(r) ? `Partner: ${partnerNameOf(r)}` : ''),
        h('td.muted', i >= l.meta.capacity ? 'waiting list' : ''))))))
        : h('p.muted', regs ? 'Nobody yet.' : 'Could not load registrations.')));
}

function resultsTable(r: TournamentResults): HTMLElement {
  return h('div.table-scroll', h('table.list',
    h('thead', h('tr', h('th.num', 'Rank'), h('th', 'Pair'), h('th', 'Dir'), h('th.num', 'Score'), h('th.num', 'MP'))),
    h('tbody', r.rankings.map((x) => h('tr', h('td.num', x.rank), h('td', x.players), h('td', x.direction),
      h('td.num', `${x.percent.toFixed(2)}%`), h('td.num', `${x.matchpoints}/${x.maxMatchpoints}`))))));
}

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

  dialog(`Partners — ${initial.meta.name}`, (close) => {
    const body = h('div');
    const myLogin = myId();

    const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
      if (busy) return;
      busy = true; err = null; draw();
      try {
        await fn();
        current = await d.get(current.number);
        current = await applyAutoRegister(d, current);
        syncListing(current);
      } catch (e) { err = (e as Error).message; }
      busy = false; draw();
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
            h('td', h('b', who(current, i.from)), i.note ? h('div.muted', i.note) : null),
            h('td', h('div.row',
              h('button.primary', { disabled: busy, onclick: act(() => d.respondToInvite(current.number, i.from, true)) }, 'Accept'),
              h('button', { disabled: busy, onclick: act(() => d.respondToInvite(current.number, i.from, false)) }, 'Decline'))));
          rows.push(h('h3', 'Invitations for you'), h('div.table-scroll', h('table.list', h('tbody', toMe.map(inviteRow)))));
        }

        const myAccepted = p.invitations.filter((i) => i.status === 'accepted' && !!myLogin && (i.from.toLowerCase() === myLogin || i.to.toLowerCase() === myLogin));
        for (const i of myAccepted) {
          const partner = i.from.toLowerCase() === myLogin ? i.to : i.from;
          const code = inviteCode(current.number, i.from, i.to);
          if (settings.pairCode !== code) { settings.pairCode = code; saveSettings(settings); }
          const mine = current.registrations?.find((r) => r.login.toLowerCase() === myLogin);
          const registered = !!mine && mine.pairCode?.trim().toLowerCase() === code;
          rows.push(h('div.note', `You and ${who(current, partner)} are partnered!`,
            registered ? ' You are both registered together — see Unregister on the tournament page to split up.'
              : d.canAct ? ' Registering you both automatically…'
              : ` Comment “/register ${settings.name.trim() || 'Your Name'} pair:${code}” on the issue to register.`));
        }

        rows.push(h('h3', 'Looking for a partner'), h('div.table-scroll', h('table.list', h('tbody',
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
                  h('td', h('b', who(current, s.login)), isMe ? ' (you)' : '', s.note ? h('div.muted', s.note) : null),
                  h('td', isMe ? null
                    : partnered ? h('span.badge.upcoming', 'Partnered')
                    : sentPending
                      ? h('button', { disabled: busy, onclick: act(() => d.cancelInvite(current.number, s.login)) }, 'Cancel invite')
                      : h('button', { disabled: busy || !myLogin, onclick: () => openNoteDialog(`Invite ${who(current, s.login)}`, 'Send invite', (note) => void act(() => d.invitePartner(current.number, s.login, note))()) }, 'Invite')));
              })))));

        rows.push(h('div.row', { style: 'margin-top:10px' },
          amSeeking
            ? h('button', { disabled: busy, onclick: act(() => d.cancelSeekingPartner(current.number)) }, 'Remove me from the list')
            : h('button.primary', { disabled: busy || !myLogin, onclick: act(() => d.seekPartner(current.number, settings.partnerNote)) }, 'Add me to the list')));
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
    return h('div', body, h('div.row', { style: 'margin-top:10px' }, h('span.spacer'), h('button', { onclick: close }, 'Close')));
  }, () => { closed = true; if (partnersSync === sync) partnersSync = null; });
}

/* --------------------------------------------------------------- dialogs */

function dialog(title: string, build: (close: () => void) => HTMLElement, onClose?: () => void): void {
  const dlg = h('dialog') as HTMLDialogElement;
  const close = (): void => { dlg.close(); dlg.remove(); onClose?.(); };
  /* The cross is the same door as Escape and as whatever button the dialog
     carries at its foot — useful when that foot is a scroll away. */
  dlg.append(h('div.dlg-head', h('h2', title),
    h('button.x', { type: 'button', title: 'Close', 'aria-label': 'Close', onclick: close }, '\u00d7')), build(close));
  dlg.addEventListener('cancel', () => { dlg.remove(); onClose?.(); });
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => h('label', label, input, hint ? h('small', hint) : null);
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

function openAbout(): void {
  dialog('About Bridge Break', (close) => h('div.about',
    h('p', 'Bridge Break runs ', h('b', 'free duplicate bridge tournaments'), ' in your browser.'),

    h('h3', 'What it does'),
    h('ul',
      h('li', h('b', 'Private rooms.'), ' Enter or share a private room code with the players you wish to invite.'),
      h('li', h('b', 'Robots.'), ' They fill any empty, timed-out, or withdrawn seat. You can hand your seat '
        + 'to a robot, and take it back later. Latecomers can take a robot\u2019s place.'),
      h('li', h('b', 'Rejoin after Timeouts.'), ' A button click allows you to replace the robot that replaced you.'),
      h('li', h('b', 'Start tournaments.'), ' To create your own tournaments, expand the \u2018Tournament Creator\u2019 '
        + 'section under \u2018Settings\u2019, and follow the instructions to generate a token.'),
      h('li', h('b', 'Skill Levels.'), ' Tournaments may limit the range of allowed skill levels.')),

    h('h3', 'First steps'),
    h('ol',
      h('li', 'Open ', h('b', 'Settings'), ' and enter a name, skill level, and a short description.'),
      h('li', 'Click ', h('b', 'Play a demo vs robots'), ' to learn how bidding, alerting, and playing works.'),
      h('li', 'Pick a tournament from the list and ', h('b', 'Register'),
        ' to be randomly paired or join/use the Partners List.'),
      h('li', 'If you exceed the timeout limit set by the tournament director for each bid/play, '
        + 'you will be replaced by a Robot. ',
        h('b', 'However, you can re-select the tournament and click an option to be reseated to '
          + 'rejoin your partner.'))),

    h('h3', 'Who made it'),
    h('p', 'Bridge Break is written by Ido Millet, owner of Millet Software (',
      h('a', { href: `https://${SITE}`, target: '_blank', rel: 'noopener' }, SITE), ').'),
    h('p', 'Please email feedback and suggestions to ',
      h('a', { href: `mailto:${MAIL}` }, MAIL), '.'),
    h('div.row', h('span.spacer'), h('button.primary', { onclick: close }, 'Close'))));
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
        name: val(f, 'name'), skill: toSkill(val(f, 'skill')) ?? '', partnerNote: val(f, 'note'), token: val(f, 'token') });
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
      field('Your name (shown at the table)', h('input', { name: 'name', value: settings.name, required: true, maxLength: 30, autocomplete: 'name' })),
      field('Player description', h('input', { name: 'note', value: settings.partnerNote, maxLength: 140, placeholder: 'e.g. Strong 2/1, prefers evenings' }),
        'Visible to other players when they click your name at the table.'),
      field('Skill level', h('select', { name: 'skill', title: 'How you would describe your own game. Some tournaments are set aside for particular levels.' },
        h('option', { value: '', selected: settings.skill === '' }, 'Prefer not to say'),
        SKILLS.map((x) => h('option', { value: x, selected: settings.skill === x }, x))),
        'Some tournaments are open only to certain levels.'),
      h('label.check', { title: 'A chime when the table is waiting on you, and the brush of each card as it is played' },
        h('input', { type: 'checkbox', name: 'sound', checked: settings.sound }), ' Play sounds at the table'),

      h('details.director-section', { open: !!(settings.token || settings.githubLogin) },
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

const DIRECTOR_NOTE = 'To create tournaments, expand the Tournament Creator section in Settings '
  + 'and follow the instructions to generate a token.';

function openCreate(): void {
  const d = directory();
  if (!d?.canWrite) return;
  dialog('New tournament', (close) => {
    const err = h('div');
    const tz = localTimeZone();
    const soon = new Date(Date.now() + 24 * 3600 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const defaultStart = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T19:30`;
    const form = h('form.grid', { onsubmit: async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      try {
        const meta = makeMeta({
          name: val(f, 'name'), director: val(f, 'director'), start: val(f, 'start'), timeZone: val(f, 'tz'),
          levels: SKILLS.filter((x) => (f.elements.namedItem(`lvl-${x}`) as HTMLInputElement | null)?.checked),
          capacity: Number(val(f, 'capacity')),
          boardsPerRound: Number(val(f, 'boards')), rounds: Number(val(f, 'rounds')),
          idleTimeoutSec: Number(val(f, 'idle')),
          ...((f.elements.namedItem('weekly') as HTMLInputElement).checked ? { repeat: 'weekly' as const } : {}),
        });
        const number = await d.create(meta);
        close();
        notice = 'Creating the tournament…';
        location.hash = `t=${number}`;
        /* Only say it is done once it is on the list, so that going back to
           the list shows it there. */
        await refresh(number);
        notice = listings?.some((x) => x.number === number)
          ? 'Tournament created.'
          : 'Tournament created. It may take a moment to appear on the list.';
        render();
      } catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); }
    } },
      field('Tournament name', h('input', { name: 'name', required: true, maxLength: 60 })),
      field('Director (your name)', h('input', { name: 'director', required: true, value: settings.name, maxLength: 30 })),
      h('div.two',
        field('Type', h('select', { name: 'type' }, h('option', 'Matchpoints'))),
        field('Open to', h('div.levels', SKILLS.map((x) => h('label.check',
          h('input', { type: 'checkbox', name: `lvl-${x}`, checked: true }), x))))),
      h('div.two',
        field('Start time', h('input', { name: 'start', type: 'datetime-local', required: true, value: defaultStart })),
        field('Time zone', h('select', { name: 'tz' }, allTimeZones().map((z) => h('option', { selected: z === tz }, z))))),
      h('div.two',
        field('Capacity (max players)', h('input', { name: 'capacity', type: 'number', min: 8, max: 200, step: 4, value: 16, required: true })),
        h('div.two',
          field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 4, required: true })),
          field('Boards / round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2, required: true })))),
      field('Inactivity limit (seconds)',
        h('input', { name: 'idle', type: 'number', min: MIN_IDLE_SEC, max: MAX_IDLE_SEC, step: 5, value: DEFAULT_IDLE_SEC, required: true }),
        'How long a player may keep the table waiting before a robot takes their seat.'),
      h('label.check', h('input', { type: 'checkbox', name: 'weekly' }),
        'Repeat every week on the same day and time'),
      h('small', { style: 'margin-top:-6px' }, 'Once each week\u2019s tournament starts, next week\u2019s appears on the list, ready for players to register.'),
      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button.primary', { type: 'submit' }, 'Create tournament')));
    return form;
  });
}

function joinByCode(): void {
  dialog('Private room', (close) => h('form.grid', { onsubmit: (e: Event) => {
    e.preventDefault();
    const f = e.target as HTMLFormElement;
    const code = val(f, 'code').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    settings.name = val(f, 'name'); saveSettings(settings);
    close();
    enterRoom({ id: `private:${code}`, name: `Private room “${code}”`, boardsPerRound: Number(val(f, 'boards')) || 2, rounds: Number(val(f, 'rounds')) || undefined, listing: null, demo: false });
  } },
    h('p.muted', { style: 'margin:0' }, 'Everyone who enters the same code lands in the same room — nothing to sign up for. Good for a quick game or a test.'),
    field('Your name', h('input', { name: 'name', required: true, value: settings.name, maxLength: 30 })),
    field('Room code', h('input', { name: 'code', required: true, minLength: 3, maxLength: 30, placeholder: 'e.g. tuesday-club' })),
    h('div.two',
      field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 2 })),
      field('Boards / round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2 }))),
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
let awaitingStart = false;
let startPoll: ReturnType<typeof setInterval> | null = null;

function stopStartPoll(): void {
  if (startPoll) { clearInterval(startPoll); startPoll = null; }
}

function leaveRoom(): void {
  if (room?.listing) leftOnPurpose.add(room.listing.number);
  node?.close();
  session?.close();
  stopStartPoll();
  // The saved log only exists to survive a page refresh; leaving on purpose discards it.
  if (room) { try { sessionStorage.removeItem(`bridge-p2p:log:${room.id}`); } catch { /* storage unavailable */ } }
  node = null; session = null; awaitingStart = false; room = null; published = false; watchTable = 0;
  render();
}

/** The field, as it stood when entries closed. */
function pinnedPlan(l: Listing): TournamentConfig | null {
  if (!l.pinned) return null;
  const entries = pinnedRoster(l);
  if (entries.length < 4) return null;
  return planConfig({
    id: l.roomId, name: l.meta.name, seed: l.pinned.seed,
    roster: entries.map((r) => ({ id: r.login, name: r.name, pairCode: r.pairCode, joinedAt: Date.parse(r.at) })),
    boardsPerRound: l.meta.boardsPerRound, rounds: l.meta.rounds, capacity: l.meta.capacity,
    idleTimeoutMs: idleSecOf(l.meta) * 1000,
  });
}

/** Join the table we are sitting at, once there is a field to sit in. */
async function openSession(l: Listing): Promise<void> {
  const config = pinnedPlan(l);
  if (!config || session) return;
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
  };
  session = new TournamentSession({
    config, me,
    connect: async (roomName) => settings.transport === 'local'
      ? localTransport(roomName)
      : (await import('../net/trystero')).trysteroTransport(roomName),
    onChange: () => { node = session?.node ?? null; render(); },
  });
  await session.start();
  node = session.node;
  render();
}

function attach(transport: Transport, info: RoomInfo, isDirector: boolean, botDelayMs: number): TournamentNode {
  const key = `bridge-p2p:log:${info.id}`;
  const n = new TournamentNode(transport, {
    playerId: settings.playerId, name: settings.name.trim() || 'Guest', deviceScore: deviceScore(), isDirector,
    pairCode: settings.pairCode || undefined,
    note: settings.partnerNote || undefined,
  }, {
    botDelayMs,
    /* In the demo you are the only person at the table, so nobody is kept
       waiting and a long think should not cost you your seat. */
    idleTimeoutMs: info.demo ? 0 : undefined,
    persist: info.demo ? undefined : {
      load: () => { try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as TEvent[] | null; } catch { return null; } },
      save: (events) => { try { sessionStorage.setItem(key, JSON.stringify(events)); } catch { /* quota */ } },
    },
  });
  n.onChange(render);
  return n;
}

async function enterRoom(info: RoomInfo): Promise<void> {
  node?.close();
  session?.close();
  session = null;
  stopStartPoll();
  errorMsg = null; notice = null; published = false;

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
    node = attach(transport, info, isDirector, 900);
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
  node = attach(new MemoryHub().connect(), info, true, 900);
  node.start({ id: info.id, name: info.name, boardsPerRound: 2, rounds: 2, minTables: 2 });
  render();
}

const pairNames = (s: Standing): string => s.pair.players.map((p) => p.name).join(' & ');

function standingsPanel(state: TState, title: string): HTMLElement {
  const rows = standings(state);
  const me = settings.playerId;
  return h('div.panel', h('h3', title), h('div.table-scroll', h('table.list',
    h('thead', h('tr', h('th.num', '#'), h('th', 'Pair'), h('th.num', '%'))),
    h('tbody', rows.map((r) => h(`tr${r.pair.players.some((p) => p.id === me) ? '.me' : ''}`,
      h('td.num', r.boardsPlayed ? r.rank : '–'), h('td', pairNames(r), h('div.muted', `${r.direction} · ${r.boardsPlayed} board${r.boardsPlayed === 1 ? '' : 's'}`)),
      h('td.num', r.boardsPlayed ? r.percent.toFixed(1) : '–')))))));
}

function toResults(state: TState): TournamentResults {
  return {
    v: 1, finishedAt: new Date().toISOString(), tables: state.config.tables,
    boards: state.config.rounds * state.config.boardsPerRound,
    rankings: standings(state).map((s) => ({ rank: s.rank, players: pairNames(s), direction: s.direction, percent: s.percent, matchpoints: s.matchpoints, maxMatchpoints: s.maxMatchpoints })),
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
    h('button', { onclick: leaveRoom }, '← Leave'), h('h2', info.name), h('span.spacer'));

  if (session?.notPlaying) {
    return h('div', head, h('div.panel',
      h('h3', 'Looking for a seat'),
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

  return h('div', head, h('div.panel',
    h('h3', 'Waiting room'),
    h('p.muted', 'Everyone plays at their own table, so there is nothing to connect to until entries close. Entries so far:'),
    h('div.table-scroll', h('table.list', h('tbody', entries.map((r, i) => h(`tr${r.login.toLowerCase() === myId() ? '.me' : ''}`,
      h('td.num', i + 1), h('td', r.name), h('td.muted', r.pairCode ? `pair: ${r.pairCode}` : '')))))),
    h('p', entries.length < MIN_PLAYERS
      ? `At least ${MIN_PLAYERS} players are needed to start.`
      : `Starting now would make ${tables} table${tables === 1 ? '' : 's'}; robots fill any empty seats.`),
    l && startNote(l) ? h('p.muted', startNote(l)) : null,
    h('p.muted', 'This page moves you to your table by itself once the tournament starts.')));
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
    return h('button', { title: 'Please replace me with a Robot', onclick: () => { n.withdraw(); render(); } }, 'Withdraw');
  }

  /* A seat already asked for is given out when the board in progress ends. */
  const asked = Object.entries(state.pendingSeats)
    .some(([id, who]) => (who === null ? id === me : who?.id === me));
  if (asked) return h('span.muted', 'You sit down when this board is over.');

  if (state.retired.includes(me) && !state.substitutes[me]) {
    const mate = partnerName(state, me);
    return h('button.primary', {
      title: `Reseat me on next hand with${mate ? ` ${mate}` : ''}`,
      onclick: () => { n.takeSeat(me); render(); },
    }, 'Reseat me');
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
  return h('div.panel', h('h3', 'Stood down'),
    h('table.list', h('tbody', rows)),
    h('p.muted', { style: 'margin:6px 0 0' }, 'A player who comes back takes their own seat again from the next board.'));
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
  dialog(declaring ? 'Claim tricks' : 'Concede tricks', (close) => h('div',
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
  const head = h('div.row', { style: 'margin-bottom:10px' },
    h('button', { onclick: leaveRoom }, '← Leave'), h('h2', info.name), h('span.spacer'),
    state && state.results.length > 0
      ? h('button', { onclick: () => { reviewing = !reviewing; recBoard = null; recTable = null; recMode = 'mine'; render(); },
          title: 'Look back over the boards: all four hands, the bidding, and what every other table did' },
        reviewing ? 'Back to the table' : 'Hand records')
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
      h('h3', 'Waiting room'),
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
          } }, 'Start tournament'),
          h('span.muted', n.me.isDirector || !info.listing ? 'This device is hosting.' : 'The director is not connected, so this device is hosting.'))
        : h('p.muted', `Waiting for ${n.coordinatorName} to start the tournament.`)));
  }

  const side = h('div.side');
  const at = n.mySeat();
  const main = h('div');

  if (state.finished) {
    main.append(state.aborted
      ? h('div.panel',
          h('h3', 'Tournament aborted'),
          h('p', 'Every table was left without a player, so the tournament was called off. The boards played so far are below.'),
          resultsTable(toResults(state)))
      : h('div.panel', h('h3', 'Tournament finished'), resultsTable(toResults(state))));
    const d = directory();
    if (info.listing && d) {
      const l = info.listing;
      main.append(h('div.row', { style: 'margin-top:10px' }, published
        ? h('span', 'Results published to ', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'the tournament page'), '.')
        : d.canWrite
          ? h('button.primary', { onclick: async () => {
              try { await d.publishResults(l.number, toResults(state)); published = true; render(); void refresh(); } catch (e) { fail(e); }
            } }, 'Publish results')
          : h('span.muted', 'Add a token in Settings to publish the results to the tournament page.')));
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
        playerNotes: n.playerNotes(),
      }));
      if (n.lastError) main.append(h('div.error', n.lastError));
    } else {
      main.append(h('div.panel', h('h3', 'Round complete at your table'), h('p.muted', 'Waiting for the other tables to finish this round…')));
    }
    if (table) {
      const left = replacedPanel(state, table);
      if (left) side.append(left);
      side.append(h('div.panel', h('h3', `Round ${state.round + 1} of ${state.config.rounds} · Table ${table.index + 1}`),
        h('div.muted', `${state.results.length} of ${state.config.tables * state.config.rounds * state.config.boardsPerRound} boards played in the room`),
        table.lastResult ? h('p', { style: 'margin:8px 0 0' }, `Last board (${table.lastResult.board}): `, h('b', table.lastResult.text),
          table.lastResult.claimed ? ' (claimed)' : '',
          `, N-S ${table.lastResult.nsScore > 0 ? '+' : ''}${table.lastResult.nsScore}`) : null));
    }
  }
  side.append(standingsPanel(state, state.finished ? 'Final standings' : 'Standings so far'));
  return h('div', head, h('div.room', main, side));
}

/* ---------------------------------------------------------------- render */

function render(): void {
  const view = room && (awaitingStart || session) && !node ? waitingRoom(room)
    : node && room ? roomView(node, room)
    : detail ? detailView(detail) : directoryView();
  root.replaceChildren(h('div.wrap',
    h('header.top',
      h('div.brand', h('h1', h('span.suits', h('b', '♠'), h('b', '♥'), h('b', '♦'), h('b', '♣')), ' Bridge Break'), h('span', 'free duplicate tournaments')),
      testMode() ? testSwitcher() : h('span.muted', settings.name ? `Playing as ${settings.name}` : ''),
      h('button', { onclick: openAbout, title: 'What this is, what it does, and how to start' }, 'About'),
      h('button', { onclick: openSettings }, 'Settings')),
    errorMsg ? h('div.error', { role: 'alert' }, errorMsg) : null,
    notice ? h('div.note', notice, ' ', h('button.link', { onclick: () => { notice = null; render(); } }, 'dismiss')) : null,
    view));
}

async function route(): Promise<void> {
  const m = /^#t=(\d+)$/.exec(location.hash);
  if (!m) { detail = null; render(); return; }
  const number = Number(m[1]);
  detail = listings?.find((l) => l.number === number) ?? null;
  render();
  startPolling(); // catches a partner's invite/accept/unregister while this page stays open
  if (!detail) {
    const d = directory();
    if (!d) return;
    try {
      let l = await d.get(number);
      l = await applyAutoRegister(d, l);
      detail = l; render();
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
void probeRelay().then(() => refresh()).then(route).then(startPolling);
if (!settings.name) openSettings();
