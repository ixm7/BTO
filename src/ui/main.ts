import { DEFAULT_IDLE_SEC, Directory, LEVELS, MAX_IDLE_SEC, MIN_IDLE_SEC, idleSecOf, inviteCode, makeMeta, type Invitation, type Level, type Listing, type TournamentResults } from '../directory/github';
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
/** While a tournament detail page is open, poll it so a partner's invite/accept/unregister
 * elsewhere shows up here without the person having to hit Refresh themselves. */
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Lets an open "Partners list" dialog be pushed a fresher Listing from outside itself
 * (a refresh() or another action), so it reflects more than just what the dialog did. */
let partnersSync: ((l: Listing) => void) | null = null;

const directory = (): Directory | null => {
  if (!settings.repo.trim()) return null;
  try { return new Directory(settings.repo, settings.token || null); } catch { return null; }
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
  if (!d.canWrite || !settings.name.trim()) return l;
  const open = l.status === 'upcoming' || l.status === 'in progress';
  const myLogin = settings.githubLogin.trim().toLowerCase();
  if (!open || !myLogin || !l.partners) return l;
  const accepted = l.partners.invitations.find((i) =>
    i.status === 'accepted' && (i.from.toLowerCase() === myLogin || i.to.toLowerCase() === myLogin));
  if (!accepted) return l;
  const code = inviteCode(l.number, accepted.from, accepted.to);
  if (settings.pairCode !== code) { settings.pairCode = code; saveSettings(settings); }
  const mine = l.registrations?.find((r) => r.login.toLowerCase() === myLogin);
  if (mine && mine.pairCode?.trim().toLowerCase() === code) return l; // already registered together
  try {
    await d.register(l.number, settings.name, code);
    return await d.get(l.number);
  } catch { return l; } // offline, rate-limited, etc. — try again on the next refresh
}

function stopPolling(): void { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
function startPolling(): void {
  stopPolling();
  pollTimer = setInterval(() => { if (!node) void refresh(); }, 15000);
}

async function refresh(): Promise<void> {
  const d = directory();
  if (!d) { listings = null; render(); return; }
  loading = true; errorMsg = null; render();
  try {
    listings = await d.list();
    if (detail) {
      let updated = listings.find((l) => l.number === detail?.number) ?? detail;
      updated = await applyAutoRegister(d, updated);
      syncListing(updated);
    }
    await sweepAbandoned(d);
  } catch (e) { errorMsg = (e as Error).message; }
  loading = false; render();
}

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

/** Still to be played, and with room for another player. */
const openToJoin = (l: Listing): boolean =>
  l.status === 'upcoming' && (l.registrations?.length ?? 0) < l.meta.capacity;

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
        h('td', l.meta.level),
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
  if (open) {
    if (d.canWrite) {
      actions.append(amRegistered
        ? h('button', { onclick: act(async () => {
            await d.withdraw(l.number);
            // Unregistering breaks the partnership too, so the ex-partner's own browser
            // stops treating us as accepted-and-should-auto-register, and sees we split up.
            if (myPartnerLogin) await d.unpair(l.number, myPartnerLogin);
          }, 'You have unregistered.') }, 'Unregister')
        : h('button.primary', { disabled: full || !settings.name.trim(), onclick: act(() => d.register(l.number, settings.name, settings.pairCode), 'You are registered.') }, full ? 'Full' : 'Register'));
    } else {
      actions.append(h('a', { href: l.url, target: '_blank', rel: 'noopener' }, 'Register on the tournament page'),
        h('span.muted', `(comment “/register ${settings.name.trim() || 'Your Name'}”, or add a token in Settings to register from here)`));
    }
    actions.append(h('button.primary', { disabled: !settings.name.trim(), onclick: () => enterRoom({
      id: l.roomId, name: l.meta.name, boardsPerRound: l.meta.boardsPerRound, rounds: l.meta.rounds, capacity: l.meta.capacity, listing: l, demo: false,
    }) }, 'Enter playing room'));
  }
  if (open) actions.append(h('button', { onclick: () => openPartners(l) }, 'Partners list'));
  if (!settings.name.trim()) actions.append(h('span.muted', 'Set your name in Settings first.'));

  return h('div',
    /* No link out to the underlying page here: everything on it can be done
       from this view, and where it cannot — registering without a token — the
       link sits with the action it belongs to. */
    h('div.row', h('button', { onclick: () => { location.hash = ''; } }, '← All tournaments')),
    h('div.panel', { style: 'margin-top:10px' },
      h('div.row', h('h2', l.meta.name), badge(l.status)),
      h('dl.facts',
        h('dt', 'Director'), h('dd', `${l.meta.director} (@${l.initiatorLogin})`),
        h('dt', 'Type'), h('dd', 'Matchpoints'),
        h('dt', 'Start'), h('dd', when(l)),
        h('dt', 'Time zone'), h('dd', l.meta.timeZone),
        h('dt', 'Level'), h('dd', l.meta.level),
        h('dt', 'Capacity'), h('dd', `${l.meta.capacity} players`),
        h('dt', 'Registered'), h('dd', regs ? `${regs.length}${full ? ' (full)' : ''}` : 'unknown (too many requests just now)'),
        h('dt', 'Format'), h('dd', `${l.meta.rounds} round(s) × ${l.meta.boardsPerRound} board(s)`)),
      actions),
    l.results ? h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Final results'), resultsTable(l.results)) : null,
    h('div.panel', { style: 'margin-top:14px' }, h('h3', 'Registered players'),
      regs && regs.length ? h('div.table-scroll', h('table.list', h('tbody', regs.map((r, i) => h('tr',
        h('td.num', i + 1), h('td', r.name), h('td.muted', `@${r.login}`),
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
    const myLogin = settings.githubLogin.trim().toLowerCase();

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
        !d.canWrite
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
            h('td', h('b', `@${i.from}`), i.note ? h('div.muted', i.note) : null),
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
          rows.push(h('div.note', `You and @${partner} are partnered!`,
            registered ? ' You are both registered together — see Unregister on the tournament page to split up.'
              : d.canWrite ? ' Registering you both automatically…'
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
                  h('td', h('b', `@${s.login}`), isMe ? ' (you)' : '', s.note ? h('div.muted', s.note) : null),
                  h('td', isMe ? null
                    : partnered ? h('span.badge.upcoming', 'Partnered')
                    : sentPending
                      ? h('button', { disabled: busy, onclick: act(() => d.cancelInvite(current.number, s.login)) }, 'Cancel invite')
                      : h('button', { disabled: busy || !myLogin, onclick: () => openNoteDialog(`Invite @${s.login}`, 'Send invite', (note) => void act(() => d.invitePartner(current.number, s.login, note))()) }, 'Invite')));
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
  dlg.append(h('h2', title), build(close));
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
      Object.assign(settings, { name: val(f, 'name'), partnerNote: val(f, 'note'), githubLogin: val(f, 'login').replace(/^@/, ''), token: val(f, 'token'), transport: val(f, 'transport') === 'local' ? 'local' : 'p2p' });
      if (settings.token && settings.repo) {
        try { settings.githubLogin = await new Directory(settings.repo, settings.token).whoAmI(); }
        catch (x) { err.replaceChildren(h('div.error', (x as Error).message)); return; }
      }
      saveSettings(settings);
      close();
      void refresh();
    } },
      field('Your name (shown at the table)', h('input', { name: 'name', value: settings.name, required: true, maxLength: 30, autocomplete: 'name' })),
      field('Player description', h('input', { name: 'note', value: settings.partnerNote, maxLength: 140, placeholder: 'e.g. Strong 2/1, prefers evenings' }),
        'Visible to other players when they click your name at the table.'),
      field('Connection', h('select', { name: 'transport' },
        h('option', { value: 'p2p', selected: settings.transport === 'p2p' }, 'Internet'),
        h('option', { value: 'local', selected: settings.transport === 'local' }, 'This browser only (other tabs) — for testing'))),

      h('details.director-section', { open: !!(settings.token || settings.githubLogin) },
        h('summary', 'Tournament Director'),
        h('div.grid',
          field('Your GitHub username', h('input', { name: 'login', value: settings.githubLogin, placeholder: 'optional', autocomplete: 'username' })),
          h('label', 'Token ',
            h('button.help-icon', { type: 'button', onclick: toggleHelp, title: 'How to get a token' }, '?'),
            h('input.masked', { name: 'token', type: 'text', value: settings.token, autocomplete: 'off', spellcheck: false, placeholder: 'optional' }),
            h('small', 'Lets you create tournaments, register and publish results from here.')),
          helpPanel)),

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
          idleTimeoutSec: Number(val(f, 'idle')),
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
          notice = 'A page opened with the tournament filled in. Press “Create” there, then Refresh here.';
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
      field('Inactivity limit (seconds)',
        h('input', { name: 'idle', type: 'number', min: MIN_IDLE_SEC, max: MAX_IDLE_SEC, step: 5, value: DEFAULT_IDLE_SEC, required: true }),
        `How long a player may keep the table waiting before a robot takes their seat. ${MIN_IDLE_SEC} seconds at the least.`),
      d.canWrite ? null : h('small', 'No token is set, so this opens the tournament page pre-filled for you to submit.'),
      err,
      h('div.row', h('span.spacer'), h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button.primary', { type: 'submit' }, d.canWrite ? 'Create tournament' : 'Continue on the tournament page')));
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
    const table = at?.table ?? state.tables[Math.min(watchTable, state.tables.length - 1)];
    if (!at && state.tables.length > 1) {
      main.append(h('div.row', { style: 'margin-bottom:8px' }, h('span.muted', 'Watching:'),
        state.tables.map((t) => h('button', { disabled: t.index === watchTable, onclick: () => { watchTable = t.index; render(); } }, `Table ${t.index + 1}`))));
    }
    if (table && table.boardNo !== null) {
      main.append(renderTable({
        table, mySeat: at?.seat ?? null,
        onCall: (c, alert) => n.call(c, alert), onPlay: (seat, card) => n.play(seat, card),
        isPresent: (id) => n.isPresent(id),
        playerNotes: n.playerNotes(),
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
      h('div.brand', h('h1', h('span.suits', h('b', '♠'), h('b', '♥'), h('b', '♦'), h('b', '♣')), ' Bridge Break'), h('span', 'free duplicate tournaments')),
      h('span.muted', settings.name ? `Playing as ${settings.name}` : ''),
      h('button', { onclick: openSettings }, 'Settings')),
    errorMsg ? h('div.error', { role: 'alert' }, errorMsg) : null,
    notice ? h('div.note', notice, ' ', h('button.link', { onclick: () => { notice = null; render(); } }, 'dismiss')) : null,
    view));
}

async function route(): Promise<void> {
  const m = /^#t=(\d+)$/.exec(location.hash);
  if (!m) { detail = null; stopPolling(); render(); return; }
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

window.addEventListener('hashchange', () => { if (!node) void route(); else render(); });
window.addEventListener('pagehide', () => node?.close());
render();
void refresh().then(route);
if (!settings.name) openSettings();
