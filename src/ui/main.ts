import { Directory, LEVELS, makeMeta, type Level, type Listing, type TournamentResults } from '../directory/github';
import { allTimeZones, formatInZone, localTimeZone } from '../directory/time';
import { MemoryHub, localTransport, type Transport } from '../net/transport';
import { TournamentNode, deviceScore } from '../tournament/node';
import { standings, type Standing, type TEvent, type TState } from '../tournament/state';
import { h, loadSettings, saveSettings, type Settings } from './dom';
import { renderTable } from './tableView';

const DEFAULT_REPO = (import.meta.env.VITE_DIRECTORY_REPO as string | undefined) ?? '';
const root = document.getElementById('app') as HTMLElement;
const settings: Settings = loadSettings(DEFAULT_REPO);

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
let published = false;

const directory = (): Directory | null => {
  if (!settings.repo.trim()) return null;
  try { return new Directory(settings.repo, settings.token || null); } catch { return null; }
};

const fail = (e: unknown): void => { errorMsg = e instanceof Error ? e.message : String(e); render(); };

/* ------------------------------------------------------------ directory */

async function refresh(): Promise<void> {
  const d = directory();
  if (!d) { listings = null; render(); return; }
  loading = true; errorMsg = null; render();
  try {
    listings = await d.list();
    if (detail) detail = listings.find((l) => l.number === detail?.number) ?? detail;
  } catch (e) { errorMsg = (e as Error).message; }
  loading = false; render();
}

function when(l: Listing): HTMLElement {
  const d = new Date(l.meta.startUtc);
  const mine = localTimeZone();
  return h('div', formatInZone(d, l.meta.timeZone),
    mine !== l.meta.timeZone ? h('div.muted', `${formatInZone(d, mine)} (your time)`) : null);
}

const badge = (status: string): HTMLElement => h(`span.badge.${status.replace(' ', '-')}`, status);
const playersCell = (l: Listing): string => `${l.registrations ? l.registrations.length : '?'} / ${l.meta.capacity}`;

function directoryView(): HTMLElement {
  const d = directory();
  const body = h('div.panel');
  if (!d) {
    body.append(h('p', 'No tournament directory is configured yet. Open ', h('b', 'Settings'),
      ' and enter the public GitHub repository (owner/name) whose Issues list the tournaments. You can still try a demo table against robots right now.'));
  } else if (loading && !listings) {
    body.append(h('p.muted', 'Loading tournaments from GitHub…'));
  } else if (listings && listings.length === 0) {
    body.append(h('p', 'No tournaments yet. Be the first to create one.'));
  } else if (listings) {
    body.append(h('div.table-scroll', h('table.list',
      h('thead', h('tr', ['Tournament', 'Director', 'Type', 'Start', 'Level', 'Players', 'Status', 'Result'].map((t) => h(t === 'Players' ? 'th.num' : 'th', t)))),
      h('tbody', listings.map((l) => h('tr',
        h('td', h('button.link', { onclick: () => { location.hash = `t=${l.number}`; } }, l.meta.name)),
        h('td', l.meta.director, h('div.muted', `@${l.initiatorLogin}`)),
        h('td', 'Matchpoints'),
        h('td', when(l)),
        h('td', l.meta.level),
        h('td.num', playersCell(l)),
        h('td', badge(l.status)),
        h('td', l.results?.rankings[0] ? `1st: ${l.results.rankings[0].players} (${l.results.rankings[0].percent.toFixed(1)}%)` : h('span.muted', '—')),
      ))))));
  }
  return h('div',
    h('div.row', { style: 'margin-bottom:10px' },
      h('h2', 'Tournaments'),
      d ? h('a.muted', { href: `https://github.com/${d.slug}/issues`, target: '_blank', rel: 'noopener' }, d.slug) : null,
      h('span.spacer'),
      d ? h('button', { onclick: () => void refresh(), disabled: loading }, loading ? 'Refreshing…' : 'Refresh') : null,
      h('button', { onclick: joinByCode, title: 'Play with specific people using a shared room code, instead of an open tournament from the list above — good for a private game with friends or a quick test with no GitHub involved.' }, 'Join private room'),
      h('button', { onclick: startDemo }, 'Play a demo vs robots'),
      d ? h('button.primary', { onclick: openCreate }, 'New tournament') : null),
    body);
}

function detailView(l: Listing): HTMLElement {
  const d = directory() as Directory;
  const myLogin = settings.githubLogin.trim().toLowerCase();
  const regs = l.registrations;
  const amRegistered = !!myLogin && !!regs?.some((r) => r.login.toLowerCase() === myLogin);
  const full = !!regs && regs.length >= l.meta.capacity;
  const open = l.status === 'upcoming' || l.status === 'in progress';
  const act = (fn: () => Promise<unknown>, done: string) => async (): Promise<void> => {
    try { await fn(); notice = done; await refresh(); } catch (e) { fail(e); }
  };

  const actions = h('div.row');
  if (open) {
    if (d.canWrite) {
      actions.append(amRegistered
        ? h('button', { onclick: act(() => d.withdraw(l.number), 'You have withdrawn.') }, 'Withdraw')
        : h('button.primary', { disabled: full || !settings.name.trim(), onclick: act(() => d.register(l.number, settings.name, settings.pairCode), 'You are registered.') }, full ? 'Full' : 'Register'));
    } else {
      actions.append(h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'Register on GitHub'),
        h('span.muted', `(comment “/register ${settings.name.trim() || 'Your Name'}”, or add a token in Settings to register from here)`));
    }
    actions.append(h('button.primary', { disabled: !settings.name.trim(), onclick: () => enterRoom({
      id: l.roomId, name: l.meta.name, boardsPerRound: l.meta.boardsPerRound, rounds: l.meta.rounds, capacity: l.meta.capacity, listing: l, demo: false,
    }) }, 'Enter playing room'));
  }
  if (!settings.name.trim()) actions.append(h('span.muted', 'Set your name in Settings first.'));

  return h('div',
    h('div.row', h('button', { onclick: () => { location.hash = ''; } }, '← All tournaments'), h('span.spacer'),
      h('a', { href: l.url, target: '_blank', rel: 'noopener' }, `Issue #${l.number} on GitHub`)),
    h('div.panel', { style: 'margin-top:10px' },
      h('div.row', h('h2', l.meta.name), badge(l.status)),
      h('dl.facts',
        h('dt', 'Director'), h('dd', `${l.meta.director} (@${l.initiatorLogin})`),
        h('dt', 'Type'), h('dd', 'Matchpoints'),
        h('dt', 'Start'), h('dd', when(l)),
        h('dt', 'Time zone'), h('dd', l.meta.timeZone),
        h('dt', 'Level'), h('dd', l.meta.level),
        h('dt', 'Capacity'), h('dd', `${l.meta.capacity} players`),
        h('dt', 'Registered'), h('dd', regs ? `${regs.length}${full ? ' (full)' : ''}` : 'unknown (GitHub rate limit)'),
        h('dt', 'Format'), h('dd', `${l.meta.rounds} round(s) × ${l.meta.boardsPerRound} board(s)`)),
      actions),
    l.results ? h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Final results'), resultsTable(l.results)) : null,
    h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Registered players'),
      regs && regs.length ? h('div.table-scroll', h('table.list', h('tbody', regs.map((r, i) => h('tr',
        h('td.num', i + 1), h('td', r.name), h('td.muted', `@${r.login}`), h('td.muted', r.pairCode ? `pair: ${r.pairCode}` : ''),
        h('td.muted', i >= l.meta.capacity ? 'waiting list' : ''))))))
        : h('p.muted', regs ? 'Nobody yet.' : 'Could not load registrations.')));
}

function resultsTable(r: TournamentResults): HTMLElement {
  return h('div.table-scroll', h('table.list',
    h('thead', h('tr', h('th.num', 'Rank'), h('th', 'Pair'), h('th', 'Dir'), h('th.num', 'Score'), h('th.num', 'MP'))),
    h('tbody', r.rankings.map((x) => h('tr', h('td.num', x.rank), h('td', x.players), h('td', x.direction),
      h('td.num', `${x.percent.toFixed(2)}%`), h('td.num', `${x.matchpoints}/${x.maxMatchpoints}`))))));
}

/* --------------------------------------------------------------- dialogs */

function dialog(title: string, build: (close: () => void) => HTMLElement): void {
  const dlg = h('dialog') as HTMLDialogElement;
  const close = (): void => { dlg.close(); dlg.remove(); };
  dlg.append(h('h2', title), build(close));
  dlg.addEventListener('cancel', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
}

const field = (label: string, input: HTMLElement, hint?: string): HTMLElement => h('label', label, input, hint ? h('small', hint) : null);
const val = (f: HTMLFormElement, name: string): string => String(new FormData(f).get(name) ?? '').trim();

function openSettings(): void {
  dialog('Settings', (close) => {
    const err = h('div');
    const form = h('form.grid', { onsubmit: async (e: Event) => {
      e.preventDefault();
      const f = e.target as HTMLFormElement;
      const repo = val(f, 'repo');
      if (repo) { try { new Directory(repo); } catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); return; } }
      Object.assign(settings, { name: val(f, 'name'), repo, githubLogin: val(f, 'login').replace(/^@/, ''), token: val(f, 'token'), pairCode: val(f, 'pair'), transport: val(f, 'transport') === 'local' ? 'local' : 'p2p' });
      if (settings.token && repo) {
        try { settings.githubLogin = await new Directory(repo, settings.token).whoAmI(); }
        catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); return; }
      }
      saveSettings(settings);
      close();
      void refresh();
    } },
      field('Your name (shown at the table)', h('input', { name: 'name', value: settings.name, required: true, maxLength: 30, autocomplete: 'name' })),
      field('Tournament directory (public GitHub repository)', h('input', { name: 'repo', value: settings.repo, placeholder: 'owner/repository' }),
        'Tournaments are Issues in this repository. Everyone in your club uses the same one.'),
      field('Your GitHub username', h('input', { name: 'login', value: settings.githubLogin, placeholder: 'optional', autocomplete: 'username' }),
        'Lets the app recognise you as director of tournaments you created.'),
      field('GitHub token (optional)', h('input', { name: 'token', type: 'password', value: settings.token, autocomplete: 'off' }),
        'A fine-grained token with “Issues: read and write” on the directory repository lets you create tournaments, register and publish results from here. It is stored only in this browser and sent only to api.github.com. Without it you do those steps on github.com.'),
      field('Partner code (optional)', h('input', { name: 'pair', value: settings.pairCode, maxLength: 20 }),
        'Two players who enter the same code are seated as partners.'),
      field('Connection', h('select', { name: 'transport' },
        h('option', { value: 'p2p', selected: settings.transport === 'p2p' }, 'Internet (peer-to-peer WebRTC)'),
        h('option', { value: 'local', selected: settings.transport === 'local' }, 'This browser only (other tabs) — for testing'))),
      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Save')));
    return form;
  });
}

function openCreate(): void {
  const d = directory();
  if (!d) return;
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
          level: val(f, 'level') as Level, capacity: Number(val(f, 'capacity')),
          boardsPerRound: Number(val(f, 'boards')), rounds: Number(val(f, 'rounds')),
        });
        if (d.canWrite) {
          const number = await d.create(meta);
          close();
          notice = `Tournament created (issue #${number}).`;
          location.hash = `t=${number}`;
          await refresh();
        } else {
          window.open(d.newIssueUrl(meta), '_blank', 'noopener');
          close();
          notice = 'A GitHub page opened with the tournament filled in. Press “Create” there, then Refresh here.';
          render();
        }
      } catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); }
    } },
      field('Tournament name', h('input', { name: 'name', required: true, maxLength: 60 })),
      field('Director (your name)', h('input', { name: 'director', required: true, value: settings.name, maxLength: 30 })),
      h('div.two',
        field('Type', h('select', { name: 'type' }, h('option', 'Matchpoints'))),
        field('Player level', h('select', { name: 'level' }, LEVELS.map((x) => h('option', x))))),
      h('div.two',
        field('Start time', h('input', { name: 'start', type: 'datetime-local', required: true, value: defaultStart })),
        field('Time zone', h('select', { name: 'tz' }, allTimeZones().map((z) => h('option', { selected: z === tz }, z))))),
      h('div.two',
        field('Capacity (max players)', h('input', { name: 'capacity', type: 'number', min: 4, max: 200, step: 4, value: 16, required: true })),
        h('div.two',
          field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 4, required: true })),
          field('Boards / round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2, required: true })))),
      d.canWrite ? null : h('small', 'No token is set, so this opens github.com with the tournament pre-filled for you to submit.'),
      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button.primary', { type: 'submit' }, d.canWrite ? 'Create tournament' : 'Continue on GitHub')));
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
    h('p.muted', { style: 'margin:0' }, 'Everyone who enters the same code lands in the same room — no GitHub needed. Good for a quick game or a test.'),
    field('Your name', h('input', { name: 'name', required: true, value: settings.name, maxLength: 30 })),
    field('Room code', h('input', { name: 'code', required: true, minLength: 3, maxLength: 30, placeholder: 'e.g. tuesday-club' })),
    h('div.two',
      field('Rounds', h('input', { name: 'rounds', type: 'number', min: 1, max: 20, value: 2 })),
      field('Boards / round', h('input', { name: 'boards', type: 'number', min: 1, max: 8, value: 2 }))),
    h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'), h('button.primary', { type: 'submit' }, 'Join'))));
}

/* ------------------------------------------------------------------ room */

function leaveRoom(): void {
  node?.close();
  // The saved log only exists to survive a page refresh; leaving on purpose discards it.
  if (room) { try { sessionStorage.removeItem(`bridge-p2p:log:${room.id}`); } catch { /* storage unavailable */ } }
  node = null; room = null; published = false; watchTable = 0;
  render();
}

function attach(transport: Transport, info: RoomInfo, isDirector: boolean, botDelayMs: number): TournamentNode {
  const key = `bridge-p2p:log:${info.id}`;
  const n = new TournamentNode(transport, {
    playerId: settings.playerId, name: settings.name.trim() || 'Guest', deviceScore: deviceScore(), isDirector,
    pairCode: settings.pairCode || undefined,
  }, {
    botDelayMs,
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
  errorMsg = null; notice = null; published = false;
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

function roomView(n: TournamentNode, info: RoomInfo): HTMLElement {
  const state = n.state;
  const head = h('div.row', { style: 'margin-bottom:10px' },
    h('button', { onclick: leaveRoom }, '← Leave'), h('h2', info.name), h('span.spacer'),
    info.demo ? null : h('span.muted', `Host: ${n.coordinatorName}${n.isCoordinator ? ' (this device)' : ''} · ${n.lobby().length} connected`));

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
            try { n.start({ id: info.id, name: info.name, boardsPerRound: info.boardsPerRound, rounds: info.rounds, capacity: info.capacity, minTables: info.minTables }); } catch (e) { fail(e); }
          } }, 'Start tournament'),
          h('span.muted', n.me.isDirector || !info.listing ? 'This device is hosting.' : 'The director is not connected, so this device is hosting.'))
        : h('p.muted', `Waiting for ${n.coordinatorName} to start the tournament.`)));
  }

  const side = h('div.side');
  const at = n.mySeat();
  const main = h('div');

  if (state.finished) {
    main.append(h('div.panel', h('h3', 'Tournament finished'), resultsTable(toResults(state))));
    const d = directory();
    if (info.listing && d) {
      const l = info.listing;
      main.append(h('div.row', { style: 'margin-top:10px' }, published
        ? h('span', 'Results published to ', h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'the tournament page'), '.')
        : d.canWrite
          ? h('button.primary', { onclick: async () => {
              try { await d.publishResults(l.number, toResults(state)); published = true; render(); void refresh(); } catch (e) { fail(e); }
            } }, 'Publish results to GitHub')
          : h('span.muted', 'Add a GitHub token in Settings to publish the results to the tournament page.')));
    }
  } else {
    const table = at?.table ?? state.tables[Math.min(watchTable, state.tables.length - 1)];
    if (!at && state.tables.length > 1) {
      main.append(h('div.row', { style: 'margin-bottom:8px' }, h('span.muted', 'Watching:'),
        state.tables.map((t) => h('button', { disabled: t.index === watchTable, onclick: () => { watchTable = t.index; render(); } }, `Table ${t.index + 1}`))));
    }
    if (table && table.boardNo !== null) {
      main.append(renderTable({
        table, mySeat: at?.seat ?? null,
        onCall: (c) => n.call(c), onPlay: (seat, card) => n.play(seat, card),
        isPresent: (id) => n.isPresent(id),
      }));
      if (n.lastError) main.append(h('div.error', n.lastError));
    } else {
      main.append(h('div.panel', h('h3', 'Round complete at your table'), h('p.muted', 'Waiting for the other tables to finish this round…')));
    }
    if (table) {
      side.append(h('div.panel', h('h3', `Round ${state.round + 1} of ${state.config.rounds} · Table ${table.index + 1}`),
        h('div.muted', `${state.results.length} of ${state.config.tables * state.config.rounds * state.config.boardsPerRound} boards played in the room`),
        table.lastResult ? h('p', { style: 'margin:8px 0 0' }, `Last board (${table.lastResult.board}): `, h('b', table.lastResult.text),
          `, N-S ${table.lastResult.nsScore > 0 ? '+' : ''}${table.lastResult.nsScore}`) : null));
    }
  }
  side.append(standingsPanel(state, state.finished ? 'Final standings' : 'Standings so far'));
  return h('div', head, h('div.room', main, side));
}

/* ---------------------------------------------------------------- render */

function render(): void {
  const view = node && room ? roomView(node, room) : detail ? detailView(detail) : directoryView();
  root.replaceChildren(h('div.wrap',
    h('header.top',
      h('div.brand', h('h1', h('span.suits', h('b', '♠'), h('b', '♥'), h('b', '♦'), h('b', '♣')), ' Bridge P2P'), h('span', 'duplicate tournaments, no server')),
      h('span.muted', settings.name ? `Playing as ${settings.name}` : ''),
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
  if (!detail) {
    const d = directory();
    if (!d) return;
    try { detail = await d.get(number); render(); } catch (e) { fail(e); }
  }
}

window.addEventListener('hashchange', () => { if (!node) void route(); else render(); });
window.addEventListener('pagehide', () => node?.close());
render();
void refresh().then(route);
if (!settings.name) openSettings();
