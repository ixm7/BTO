import { SEATS, STRAINS, SUIT_SYMBOLS, cardSuit, legalPlays, nextSeat, partnerOf, rankChar, sideOf, sortForDisplay, type Card, type Seat, type Strain, type Suit } from '../engine/cards';
import { legalCalls, type AuctionState, type Call, type Contract } from '../engine/bidding';
import { isVulnerable, type Vulnerability } from '../engine/deal';
import { isDummyVisible } from '../engine/play';
import { contractToString } from '../engine/scoring';
import { ALERT_MAX, turnAt, type TableState } from '../tournament/state';
import { h } from './dom';

const SEAT_NAMES: Record<Seat, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };
const isRed = (suit: string): boolean => suit === 'H' || suit === 'D';

/* Hands read most easily when neighbouring suits differ in colour, so a card
   is never mistaken for the one beside it. Spades, hearts, clubs, diamonds by
   default; once a contract exists the trump suit leads and the rest follow,
   still alternating black and red. */
export function suitOrder(trump?: Strain): Suit[] {
  const base: Suit[] = ['S', 'H', 'C', 'D'];
  if (!trump || trump === 'N') return base;
  const rest = base.filter((s) => s !== trump);
  const out: Suit[] = [trump];
  let prev: Suit = trump;
  while (rest.length > 0) {
    const i = Math.max(0, rest.findIndex((s) => isRed(s) !== isRed(prev)));
    prev = rest[i];
    out.push(prev);
    rest.splice(i, 1);
  }
  return out;
}

/* ---- BBO-style card rendering: large rank with suit beside it ---- */

function cardFace(card: Card, onPlay?: () => void, extraClass = ''): HTMLElement {
  const suit = cardSuit(card);
  const rank = rankChar(card) === 'T' ? '10' : rankChar(card);
  const colorCls = isRed(suit) ? '.red' : '.black';
  const cls = `pc${colorCls}${extraClass}`;
  const label = `${rank} of ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[suit]}`;
  const inner = [h('span.rank', rank), h('span.suit', SUIT_SYMBOLS[suit])];
  return onPlay
    ? h(`button.${cls}`, { onclick: onPlay, title: `Play ${label}`, 'aria-label': `Play ${label}` }, inner)
    : h(`div.${cls}`, { 'aria-label': label }, inner);
}

/* ---- Card back (opponent's hidden cards) ---- */

function cardBack(): HTMLElement {
  return h('div.pc.card-back');
}

/* ---- BBO-style bidding box: Pass/Dbl, then levels, then strains ---- */

/* The whole table is re-rendered whenever anything at all changes — a robot
   acting at another table, a peer joining, the clock ticking. That would wipe
   out a half-finished bid, so what the player has started is remembered here
   and restored on the next render. The key ties the draft to one point in one
   auction, so it is dropped as soon as any call is actually made. */
interface BidDraft { key: string; level: number | null; alert: string }
let draft: BidDraft | null = null;

const draftFor = (key: string): BidDraft => {
  if (!draft || draft.key !== key) draft = { key, level: null, alert: '' };
  return draft;
};

function renderBidBox(key: string, auction: AuctionState, onCall: (call: Call, alert: string) => void): HTMLElement {
  const legal = legalCalls(auction);
  const bids = legal.filter((c): c is Extract<Call, { type: 'bid' }> => c.type === 'bid');
  const levels = [...new Set(bids.map((c) => c.level))].sort((x, y) => x - y);
  const d = draftFor(key);

  /* The old table is still mounted while this runs, so the live DOM tells us
     whether the player is mid-sentence in the alert box and where the caret is. */
  const active = document.activeElement;
  const typing = active instanceof HTMLInputElement && active.classList.contains('alert-text');
  const caret = typing ? active.selectionStart : null;

  const suitRow = h('div.suitrow');
  const levelButtons = new Map<number, HTMLButtonElement>();

  const makeCall = (call: Call): void => {
    const alert = d.alert;
    draft = null;
    onCall(call, alert);
  };

  const pickLevel = (level: number): void => {
    d.level = level;
    for (const [lv, btn] of levelButtons) btn.classList.toggle('selected', lv === level);
    const strains = bids.filter((c) => c.level === level).map((c) => c.strain);
    suitRow.replaceChildren(...STRAINS.filter((s) => strains.includes(s)).map((s) =>
      h(`button.suit${isRed(s) ? '.red' : ''}`, { onclick: () => makeCall({ type: 'bid', level, strain: s }), 'aria-label': `Bid ${level} ${s === 'N' ? 'no trump' : s}` }, SUIT_SYMBOLS[s])));
  };

  /* Pass/Dbl on one line, the seven levels on the next, and the strains
     appearing underneath once a level is chosen. Nothing ever wraps. */
  const callRow = h('div.bidrow.calls',
    h('button.pass', { onclick: () => makeCall({ type: 'pass' }) }, 'Pass'),
    legal.some((c) => c.type === 'double') ? h('button.dbl', { onclick: () => makeCall({ type: 'double' }) }, 'Dbl') : null,
    legal.some((c) => c.type === 'redouble') ? h('button.dbl.rdbl', { onclick: () => makeCall({ type: 'redouble' }) }, 'Rdbl') : null);

  const levelRow = h('div.bidrow.levels', levels.map((level) => {
    const btn = h('button.lvl', { onclick: () => pickLevel(level) }, String(level)) as HTMLButtonElement;
    levelButtons.set(level, btn);
    return btn;
  }));

  /* An explanation for the opponents, attached to whatever call is made next. */
  const alertInput = h('input.alert-text', {
    type: 'text', value: d.alert, maxLength: ALERT_MAX, autocomplete: 'off', spellcheck: false,
    placeholder: 'Explain a non-standard call',
    'aria-label': 'Explanation of your next call, shown to the other players',
  }) as HTMLInputElement;
  alertInput.oninput = () => { d.alert = alertInput.value; };
  const alertRow = h('div.alertrow', h('label.alert-label', { for: 'alert-text' }, 'Alert:'), alertInput);
  alertInput.id = 'alert-text';

  /* Restore a level chosen before the last re-render. */
  if (d.level !== null && levels.includes(d.level)) pickLevel(d.level);

  /* A microtask, not an animation frame: it runs once this render's DOM swap
     has finished but still inside the same task, so no keystroke can land in
     the discarded input in between. */
  if (typing) {
    queueMicrotask(() => {
      alertInput.focus();
      if (caret !== null) alertInput.setSelectionRange(caret, caret);
    });
  }

  return h('div.bidbox', callRow, levelRow, suitRow, alertRow);
}

/* ---- Board badge: vulnerability, board number and dealer in one glyph ----

   The square's four edges are the four seats. An edge is red when that side is
   vulnerable, so you can read the risk at a glance without parsing "Vul: EW".
   The board number sits in the middle and the dealer's edge is marked D. */

function vulBadge(boardNo: number | null, vul: Vulnerability, dealer: Seat): HTMLElement {
  const ns = isVulnerable(vul, 'NS') ? 'vul' : 'nv';
  const ew = isVulnerable(vul, 'EW') ? 'vul' : 'nv';
  const side: Record<Seat, string> = { N: ns, S: ns, E: ew, W: ew };
  /* Centred in that seat's trapezoid, which spans 22 units at each edge. */
  const dPos: Record<Seat, [number, number]> = { N: [50, 11], E: [89, 50], S: [50, 89], W: [11, 50] };
  const [dx, dy] = dPos[dealer];
  const vulText = vul === 'None' ? 'nobody vulnerable' : vul === 'Both' ? 'both sides vulnerable' : `${vul} vulnerable`;

  const el = h('div.vulbadge', {
    title: `Board ${boardNo ?? '—'} · dealer ${SEAT_NAMES[dealer]} · ${vulText}`,
    role: 'img', 'aria-label': `Board ${boardNo ?? 'none'}, dealer ${SEAT_NAMES[dealer]}, ${vulText}`,
  });
  /* Every value below is a number or one of the four seat letters. */
  el.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true">
    <polygon class="${side.N}" points="0,0 100,0 78,22 22,22"/>
    <polygon class="${side.E}" points="100,0 100,100 78,78 78,22"/>
    <polygon class="${side.S}" points="100,100 0,100 22,78 78,78"/>
    <polygon class="${side.W}" points="0,100 0,0 22,22 22,78"/>
    <rect class="mid" x="22" y="22" width="56" height="56"/>
    <text class="bno" x="50" y="51">${boardNo ?? '–'}</text>
    <text class="dlr ${side[dealer] === 'vul' ? 'on-vul' : ''}" x="${dx}" y="${dy}">D</text>
  </svg>`;
  return el;
}

/* ---- Contract and declarer ---- */

const DOUBLING = ['', 'X', 'XX'] as const;

function contractBox(c: Contract): HTMLElement {
  const strain = SUIT_SYMBOLS[c.strain];
  return h('div.contract-box', { title: `Contract ${contractToString(c)}` },
    h(`b.ct${isRed(c.strain) ? '.r' : ''}`, `${c.level}${strain}${DOUBLING[c.doubled]}`),
    h('span.decl', SEAT_NAMES[c.declarer]));
}

/* ---- Trick counters: upright for tricks won, on its side for tricks lost,
   the way won and lost tricks are stacked at a real table. ---- */

function trickCounts(won: number, lost: number): HTMLElement {
  return h('div.tricks',
    h('div.tcount.won', { title: `${won} trick${won === 1 ? '' : 's'} won` }, h('i.bar.v'), h('span', String(won))),
    h('div.tcount.lost', { title: `${lost} trick${lost === 1 ? '' : 's'} lost` }, h('i.bar.h'), h('span', String(lost))));
}

/* ---- Auction cell (bid display in the history table) ---- */

function callCell(call: Call, alert?: string): HTMLElement {
  /* An alerted call is tinted and carries its explanation as a tooltip. */
  const a = alert ? '.alerted' : '';
  const attrs = alert ? { title: alert } : {};
  if (call.type === 'pass') return h(`td.call-pass${a}`, attrs, 'Pass');
  if (call.type === 'double') return h(`td.call-dbl${a}`, attrs, 'X');
  if (call.type === 'redouble') return h(`td.call-rdbl${a}`, attrs, 'XX');
  const strain = call.strain;
  return h(`td.call-bid${isRed(strain) ? '.r' : ''}${a}`, attrs, `${call.level}`, h('span', SUIT_SYMBOLS[strain]));
}

export interface TableViewOptions {
  table: TableState;
  mySeat: Seat | null;
  onCall(call: Call, alert?: string): void;
  onPlay(seat: Seat, card: Card): void;
  isPresent(playerId: string): boolean;
  playerNotes?: Map<string, string>;
}

export function renderTable(o: TableViewOptions): HTMLElement {
  const { table, mySeat } = o;
  const bottom: Seat = mySeat ?? 'S';
  const pos: Record<Seat, string> = { N: '', E: '', S: '', W: '' };
  pos[bottom] = 'bottom';
  pos[nextSeat(bottom)] = 'left';
  pos[partnerOf(bottom)] = 'top';
  pos[nextSeat(partnerOf(bottom))] = 'right';

  const turn = turnAt(table);
  const play = table.play;
  const iControl = !!turn && mySeat !== null && turn.controller === mySeat;

  const seatEl = (seat: Seat): HTMLElement => {
    const player = table.seats[seat];
    const vul = isVulnerable(table.vul, sideOf(seat));
    const cards = play ? play.hands[seat] : table.deal?.[seat] ?? [];
    const isDummy = !!play && play.dummy === seat;
    const visible = mySeat === null || seat === mySeat || (isDummy && !!play && isDummyVisible(play));
    const canPlayHere = iControl && turn?.phase === 'play' && turn.seat === seat;
    const legal = canPlayHere && play ? new Set(legalPlays(play.hands[seat], play.trick)) : new Set<Card>();
    const away = !player.bot && !o.isPresent(player.id);

    let hand: HTMLElement;
    if (visible) {
      const groups: HTMLElement[] = [];
      for (const suit of suitOrder(play?.contract.strain)) {
        const inSuit = sortForDisplay(cards.filter((c) => cardSuit(c) === suit));
        if (inSuit.length === 0) continue;
        groups.push(h('div.suit-group', inSuit.map((c) => {
          if (!canPlayHere) return cardFace(c);
          const btn = cardFace(c, () => o.onPlay(seat, c)) as HTMLButtonElement;
          btn.disabled = !legal.has(c);
          return btn;
        })));
      }
      /* Only fade a hand while cards are in play and it is not the one to act. */
      hand = h(`div.hand${!play || canPlayHere || !iControl ? '' : '.dim'}`, groups);
    } else {
      /* BBO-style card backs */
      hand = h('div.hand.backs', Array.from({ length: cards.length }, () => cardBack()));
    }
    const tags = [isDummy ? 'dummy' : '', play && play.contract.declarer === seat ? 'declarer' : '', player.bot ? 'robot' : '', away ? 'away' : ''].filter(Boolean).join(', ');
    const noteText = o.playerNotes?.get(player.id) ?? 'No description';
    const label = h(`div.who${vul ? '.vul' : ''}${turn?.seat === seat ? '.active' : ''}`,
      { title: `${SEAT_NAMES[seat]}${vul ? ' (vulnerable)' : ''}` },
      h('b.seat-letter', seat),
      h('span.pname', { onclick: (e: MouseEvent) => {
        e.stopPropagation();
        // Remove any existing tooltip
        document.querySelectorAll('.player-tooltip').forEach((t) => t.remove());
        const tip = h('div.player-tooltip', h('b', player.name), h('p', noteText));
        const dismiss = (ev: MouseEvent): void => { if (!tip.contains(ev.target as Node)) { tip.remove(); document.removeEventListener('click', dismiss); } };
        document.addEventListener('click', dismiss);
        (e.currentTarget as HTMLElement).parentElement!.appendChild(tip);
      } }, player.name + (seat === mySeat ? ' (you)' : '') + (tags ? ` · ${tags}` : '')));
    return h(`div.seat.${pos[seat]}`, label, hand);
  };

  /* Centre: during the auction it holds the bidding history + box (BBO-style);
     during play it holds the trick in progress, or the trick just completed. */
  const showingLast = !!play && play.trick.length === 0 && !!play.lastTrick;
  const trick = play ? (showingLast ? play.lastTrick ?? [] : play.trick) : [];
  const center = h(`div.center${showingLast ? '.last' : ''}${play ? '' : '.bidding'}`, trick.map((tc) => cardFace(tc.card, undefined, `.t-${pos[tc.seat]}`)));
  if (play && showingLast && play.lastWinner) center.append(h('div.msg', `${SEAT_NAMES[play.lastWinner]} won the trick`));
  else if (play && play.cardsPlayed === 0) center.append(h('div.msg', `${SEAT_NAMES[play.turn]} to make the opening lead`));

  /* Auction grid (BBO-style: W N E S columns, centred in the play area). */
  const order: Seat[] = ['W', 'N', 'E', 'S'];
  const cells: HTMLElement[] = [];
  if (table.auction) {
    for (let i = 0; i < order.indexOf(table.auction.dealer); i++) cells.push(h('td', ''));
    for (const e of table.auction.calls) cells.push(callCell(e.call, e.alert));
    if (!play) cells.push(h('td.pending', '?'));
  }
  const rows: HTMLElement[] = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(h('tr', cells.slice(i, i + 4)));
  const auction = h('div.auction', h('table',
    h('thead', h('tr', order.map((s) => h(`th${isVulnerable(table.vul, sideOf(s)) ? '.vul' : ''}`, s)))),
    h('tbody', rows)));

  /* Tricks are counted from the viewer's own side, as they would be at a real
     table. A spectator has no side of their own, so they watch declarer's. */
  const mySide = mySeat ? sideOf(mySeat) : play ? sideOf(play.contract.declarer) : 'NS';
  const declaring = play ? mySide === sideOf(play.contract.declarer) : false;
  const won = play ? (declaring ? play.declarerTricks : play.defenderTricks) : 0;
  const lost = play ? (declaring ? play.defenderTricks : play.declarerTricks) : 0;

  const info = h('div.info',
    h('div.tablename', `Table ${table.index + 1}`),
    vulBadge(table.boardNo, table.vul, table.dealer),
    play ? contractBox(play.contract) : h('div.contract-box.pending', h('span.decl', 'Bidding')),
    play ? trickCounts(won, lost) : null,
  );

  let status = '';
  if (turn) {
    const actor = table.seats[turn.controller];
    if (iControl) status = turn.phase === 'auction' ? 'Your call.' : turn.seat === mySeat ? 'Your turn — play a card.' : 'Your turn — play a card from dummy.';
    else status = `Waiting for ${actor.name} (${SEAT_NAMES[turn.controller]})…`;
  }

  /* During the auction the history and the bidding box sit together in the
     centre of the table, the way Bridge Base Online lays them out. */
  if (!play) {
    center.append(auction);
    if (iControl && turn?.phase === 'auction' && table.auction && mySeat) {
      const key = `${table.boardNo}:${table.auction.calls.length}`;
      center.append(renderBidBox(key, table.auction, (c, alert) => o.onCall(c, alert)));
    } else if (status) {
      center.append(h('div.bidwait', status));
    }
  }

  const felt = h('div.felt', info, play ? auction : null, SEATS.map(seatEl), center);
  const out = h('div', felt);
  out.append(h('div.status-line', { role: 'status' }, iControl ? h('b', status) : status));
  return out;
}
