/**
 * Looking back over the boards, in the two views a scorecard has: every board
 * you played at your own table, or every table's result on one board. Both
 * read in the same columns — what we scored, what they scored, and the
 * percentage each way — so switching between them does not change how the
 * numbers are read. The deal sits underneath, with the bidding that produced
 * whichever line is selected.
 */
import { SUIT_SYMBOLS, cardSuit, rankChar, sortForDisplay, type Card, type Seat } from '../engine/cards';
import { callToString, type Call } from '../engine/bidding';
import { pairAt, reviewBoard, scorecard, type TravellerRow } from '../tournament/review';
import type { BoardResult, TState } from '../tournament/state';
import { h } from './dom';

const SEAT_NAMES: Record<Seat, string> = { N: 'North', E: 'East', S: 'South', W: 'West' };
const isRed = (s: string): boolean => s === 'H' || s === 'D';
const SUIT_ORDER = ['S', 'H', 'D', 'C'] as const;

export type RecordsMode = 'mine' | 'others';

export interface RecordsView {
  /** The board whose deal is shown, and whose tables are listed. */
  board: number | null;
  /** Which table's bidding is shown with the deal. */
  table: number | null;
  mode: RecordsMode;
}

export interface RecordsHandlers {
  pickBoard(board: number): void;
  pickTable(table: number): void;
  setMode(mode: RecordsMode): void;
}

/** One hand written the way a hand record prints it: a line per suit. */
function handBlock(cards: readonly Card[], label: string, highlight: boolean): HTMLElement {
  const lines = SUIT_ORDER.map((suit) => {
    const inSuit = sortForDisplay(cards.filter((c) => cardSuit(c) === suit));
    const ranks = inSuit.map((c) => (rankChar(c) === 'T' ? '10' : rankChar(c))).join('');
    return h(`div.hl${isRed(suit) ? '.r' : ''}`, h('span.hs', SUIT_SYMBOLS[suit]), h('span.hr', ranks || '—'));
  });
  return h(`div.handblock${highlight ? '.me' : ''}`, h('div.hname', label), ...lines);
}

/** The auction as it was bid, in seat columns. */
function auctionTable(calls: readonly { seat: Seat; call: Call; alert?: string }[]): HTMLElement {
  const order: Seat[] = ['W', 'N', 'E', 'S'];
  const cells: HTMLElement[] = [];
  if (calls.length > 0) {
    for (let i = 0; i < order.indexOf(calls[0]!.seat); i++) cells.push(h('td', ''));
    for (const e of calls) {
      const c = e.call;
      const red = c.type === 'bid' && isRed(c.strain);
      const text = c.type === 'bid' ? `${c.level}${SUIT_SYMBOLS[c.strain]}` : callToString(c);
      const kind = c.type === 'bid' ? '.call-bid' : '.call-pass';
      cells.push(h(`td${kind}${red ? '.r' : ''}${e.alert ? '.alerted' : ''}`, e.alert ? { title: e.alert } : {}, text));
    }
  }
  const rows: HTMLElement[] = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(h('tr', cells.slice(i, i + 4)));
  return h('div.auction.review-auction', h('table',
    h('thead', h('tr', order.map((s) => h('th', s)))),
    h('tbody', rows.length ? rows : [h('tr', h('td', { colSpan: 4 }, 'No bidding recorded'))])));
}

/** A score read from the viewer's own direction, as a scorecard keeps it. */
function fromOurSide(result: BoardResult, weAreNS: boolean, nsMp: number, top: number) {
  const ourScore = weAreNS ? result.nsScore : -result.nsScore;
  const ourMp = weAreNS ? nsMp : top - nsMp;
  const pct = top === 0 ? 50 : Math.round((ourMp / top) * 1000) / 10;
  return {
    we: ourScore > 0 ? String(ourScore) : '',
    they: ourScore < 0 ? String(-ourScore) : '',
    wePct: `${pct}%`,
    theyPct: `${Math.round((100 - pct) * 10) / 10}%`,
  };
}

const COLUMNS = ['Board', 'Result', 'We', 'They', 'We %', 'They %'];

export function renderRecords(state: TState, myPair: number | null, view: RecordsView, on: RecordsHandlers): HTMLElement {
  const boards = [...new Set(state.results.map((r) => r.board))].sort((a, b) => a - b);
  if (boards.length === 0 || myPair === null) {
    return h('div.panel', h('h3', 'Hand records'),
      h('p.muted', myPair === null
        ? 'You are not playing in this tournament, so there is no card for you.'
        : 'Nothing finished yet. Boards appear here as they are played.'));
  }

  const card = scorecard(state, myPair);
  const board = view.board ?? card[card.length - 1]?.board ?? (boards[boards.length - 1] as number);
  const review = reviewBoard(state, board, myPair);
  /* Which way round we sat on this board decides which column is "we". */
  const weAreNS = review.own ? review.own.result.nsPair === myPair : true;
  const others = view.mode === 'others';

  const rows = others
    ? review.traveller.map((t: TravellerRow) => {
        const s = fromOurSide(t.result, weAreNS, t.nsMatchpoints, t.top);
        const names = [pairAt(state, t.result.nsPair), pairAt(state, t.result.ewPair)]
          .map((p) => (p ? p.players.map((x) => x.name).join(' & ') : '—')).join(' v ');
        return h(`tr.pick${t.mine ? '.me' : ''}${t.result.table === view.table ? '.sel' : ''}`,
          { onclick: () => on.pickTable(t.result.table), title: `Table ${t.result.table + 1}: ${names}` },
          h('td', String(t.result.board)), h('td', t.result.text),
          h('td.num', s.we), h('td.num', s.they), h('td.num', s.wePct), h('td.num.muted', s.theyPct));
      })
    : card.map((r) => h(`tr.pick${r.board === board ? '.sel' : ''}`, { onclick: () => on.pickBoard(r.board) },
        h('td', String(r.board)), h('td', r.result.text),
        h('td.num', r.weScore === null ? '' : String(r.weScore)),
        h('td.num', r.theyScore === null ? '' : String(r.theyScore)),
        h('td.num', `${r.wePercent}%`), h('td.num.muted', `${r.theyPercent}%`)));

  /* Whichever line is selected supplies the bidding shown with the deal. */
  const shown = others && view.table !== null
    ? review.traveller.find((t) => t.result.table === view.table) ?? review.own
    : review.own;
  const { N, E, S, W } = review.hands;
  const ourSeats = review.own ? (review.own.result.nsPair === myPair ? 'NS' : 'EW') : '';

  const diagram = h('div.deal',
    h('div.d-top', handBlock(N, 'North', ourSeats.includes('N'))),
    h('div.d-left', handBlock(W, 'West', ourSeats.includes('W'))),
    h('div.d-mid',
      h('div', h('b', `Board ${board}`)),
      h('div.muted', `Dealer ${SEAT_NAMES[review.dealer]}`),
      h('div.muted', `Vul ${review.vul}`),
      shown ? h('div.muted', { style: 'margin-top:6px' }, `Table ${shown.result.table + 1}`) : null,
      shown ? h('div', h('b', shown.result.text)) : null),
    h('div.d-right', handBlock(E, 'East', ourSeats.includes('E'))),
    h('div.d-bottom', handBlock(S, 'South', ourSeats.includes('S'))));

  return h('div.panel',
    h('div.row', h('h3', others ? `Board ${board} at every table` : 'Your boards'), h('span.spacer'),
      h('button', {
        onclick: () => on.setMode(others ? 'mine' : 'others'),
        title: others
          ? 'Go back to every board you played at your own table'
          : 'See what every other table did with this same board',
      }, others ? 'My table' : 'Other tables')),
    h('p.muted', others
      ? 'The same deal as everyone else held it. Pick a line to see how that table bid it.'
      : 'Every board you have played, scored against the tables that played it. Pick a board to see the deal.'),
    h('div.table-scroll', h('table.list.scorecard',
      h('thead', h('tr', COLUMNS.map((t, i) => h(i >= 2 ? 'th.num' : 'th', t)))),
      h('tbody', rows))),
    h('div.deal-wrap', diagram),
    shown?.result.auction
      ? h('div', h('h4', others && view.table !== null ? `How table ${shown.result.table + 1} bid it` : 'How you bid it'),
          auctionTable(shown.result.auction))
      : null);
}
