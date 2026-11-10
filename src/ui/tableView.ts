import { SEATS, STRAINS, SUIT_SYMBOLS, cardSuit, legalPlays, nextSeat, partnerOf, rankChar, sideOf, sortForDisplay, type Card, type Seat } from '../engine/cards';
import { legalCalls, type AuctionState, type Call } from '../engine/bidding';
import { isVulnerable } from '../engine/deal';
import { isDummyVisible } from '../engine/play';
import { contractToString } from '../engine/scoring';
import { turnAt, type TableState } from '../tournament/state';
import { h } from './dom';

const SEAT_NAMES: Record<Seat, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };
const isRed = (suit: string): boolean => suit === 'H' || suit === 'D';

function cardFace(card: Card, onPlay?: () => void, extraClass = ''): HTMLElement {
  const suit = cardSuit(card);
  const rank = rankChar(card) === 'T' ? '10' : rankChar(card);
  const cls = `pc${isRed(suit) ? '.red' : ''}${extraClass}`;
  const label = `${rank} of ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[suit]}`;
  return onPlay
    ? h(`button.${cls}`, { onclick: onPlay, title: `Play ${label}`, 'aria-label': `Play ${label}` }, rank, h('small', SUIT_SYMBOLS[suit]))
    : h(`div.${cls}`, { 'aria-label': label }, rank, h('small', SUIT_SYMBOLS[suit]));
}

/**
 * Two-step bidding box: pick a level, then a strain. Only levels that have at
 * least one legal strain are shown, and once a level is picked only the
 * strains that would actually outbid the last bid are offered.
 */
function renderBidBox(auction: AuctionState, onCall: (call: Call) => void): HTMLElement {
  const legal = legalCalls(auction);
  const bids = legal.filter((c): c is Extract<Call, { type: 'bid' }> => c.type === 'bid');
  const levels = [...new Set(bids.map((c) => c.level))].sort((x, y) => x - y);

  const callRow = h('div.callrow',
    h('button.pass', { onclick: () => onCall({ type: 'pass' }) }, 'Pass'),
    legal.some((c) => c.type === 'double') ? h('button.dbl', { onclick: () => onCall({ type: 'double' }) }, 'Dbl') : null,
    legal.some((c) => c.type === 'redouble') ? h('button.dbl.rdbl', { onclick: () => onCall({ type: 'redouble' }) }, 'Rdbl') : null);

  const suitRow = h('div.suitrow');
  const levelButtons = new Map<number, HTMLButtonElement>();

  const pickLevel = (level: number): void => {
    for (const [lv, btn] of levelButtons) btn.classList.toggle('selected', lv === level);
    const strains = bids.filter((c) => c.level === level).map((c) => c.strain);
    suitRow.replaceChildren(...STRAINS.filter((s) => strains.includes(s)).map((s) =>
      h(`button.suit${isRed(s) ? '.red' : ''}`, { onclick: () => onCall({ type: 'bid', level, strain: s }), 'aria-label': `Bid ${level} ${s === 'N' ? 'no trump' : s}` }, SUIT_SYMBOLS[s])));
  };

  const levelRow = h('div.levelrow', levels.map((level) => {
    const btn = h('button', { onclick: () => pickLevel(level) }, String(level)) as HTMLButtonElement;
    levelButtons.set(level, btn);
    return btn;
  }));

  return h('div.bidbox2', callRow, levelRow, suitRow);
}

function callCell(call: Call): HTMLElement {
  if (call.type === 'pass') return h('td', 'Pass');
  if (call.type === 'double') return h('td', h('b', 'X'));
  if (call.type === 'redouble') return h('td', h('b', 'XX'));
  return h('td', `${call.level}`, h('span', { class: isRed(call.strain) ? 'r' : '' }, SUIT_SYMBOLS[call.strain]));
}

export interface TableViewOptions {
  table: TableState;
  /** Seat of the viewer, or null for a spectator (who sees all four hands). */
  mySeat: Seat | null;
  onCall(call: Call): void;
  onPlay(seat: Seat, card: Card): void;
  isPresent(playerId: string): boolean;
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
      for (const suit of ['S', 'H', 'D', 'C'] as const) {
        const inSuit = sortForDisplay(cards.filter((c) => cardSuit(c) === suit));
        if (inSuit.length === 0) continue;
        groups.push(h('div.suit-group', inSuit.map((c) => {
          if (!canPlayHere) return cardFace(c);
          const btn = cardFace(c, () => o.onPlay(seat, c)) as HTMLButtonElement;
          btn.disabled = !legal.has(c);
          return btn;
        })));
      }
      hand = h(`div.hand${canPlayHere || !iControl ? '' : '.dim'}`, groups);
    } else {
      hand = h('div.backs', `${cards.length} card${cards.length === 1 ? '' : 's'}`);
    }
    const tags = [isDummy ? 'dummy' : '', play && play.contract.declarer === seat ? 'declarer' : '', player.bot ? 'robot' : '', away ? 'away' : ''].filter(Boolean).join(', ');
    return h(`div.seat.${pos[seat]}${turn?.seat === seat ? '.turn' : ''}`,
      h(`div.who${vul ? '.vul' : ''}`, { title: `${SEAT_NAMES[seat]}${vul ? ' (vulnerable)' : ''}` },
        h('i', seat), h('span', player.name + (seat === mySeat ? ' (you)' : '') + (tags ? ` · ${tags}` : ''))),
      hand);
  };

  /* Centre: the trick in progress, or the trick just completed. */
  const showingLast = !!play && play.trick.length === 0 && !!play.lastTrick;
  const trick = play ? (showingLast ? play.lastTrick ?? [] : play.trick) : [];
  const center = h(`div.center${showingLast ? '.last' : ''}`, trick.map((tc) => cardFace(tc.card, undefined, `.t-${pos[tc.seat]}`)));
  if (!play) center.append(h('div.msg', 'Bidding in progress'));
  else if (showingLast && play.lastWinner) center.append(h('div.msg', `${SEAT_NAMES[play.lastWinner]} won the trick`));
  else if (play.cardsPlayed === 0) center.append(h('div.msg', `${SEAT_NAMES[play.turn]} to make the opening lead`));

  /* Auction grid, starting from West so partnerships line up in columns. */
  const order: Seat[] = ['W', 'N', 'E', 'S'];
  const cells: HTMLElement[] = [];
  if (table.auction) {
    for (let i = 0; i < order.indexOf(table.auction.dealer); i++) cells.push(h('td', ''));
    for (const e of table.auction.calls) cells.push(callCell(e.call));
    if (!play) cells.push(h('td', '?'));
  }
  const rows: HTMLElement[] = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(h('tr', cells.slice(i, i + 4)));
  const auction = h('div.auction', h('table',
    h('thead', h('tr', order.map((s) => h(`th${isVulnerable(table.vul, sideOf(s)) ? '.vul' : ''}`, s)))),
    h('tbody', rows)));

  const info = h('div.info',
    h('div', h('b', `Board ${table.boardNo}`)),
    h('div', `Dealer ${SEAT_NAMES[table.dealer]}`),
    h('div', `Vul: ${table.vul}`),
    play ? h('div', 'Contract ', h('b', contractToString(play.contract))) : null,
    play ? h('div', `Tricks: declarer ${play.declarerTricks}, defence ${play.defenderTricks}`) : null,
  );

  const felt = h('div.felt', info, auction, SEATS.map(seatEl), center);
  const out = h('div', felt);

  /* Status line + bidding box. */
  let status = '';
  if (turn) {
    const actor = table.seats[turn.controller];
    if (iControl) status = turn.phase === 'auction' ? 'Your call.' : turn.seat === mySeat ? 'Your turn — play a card.' : 'Your turn — play a card from dummy.';
    else status = `Waiting for ${actor.name} (${SEAT_NAMES[turn.controller]})…`;
  }
  out.append(h('div.status-line', { role: 'status' }, iControl ? h('b', status) : status));

  if (iControl && turn?.phase === 'auction' && table.auction && mySeat) {
    out.append(renderBidBox(table.auction, (c) => o.onCall(c)));
  }
  return out;
}

