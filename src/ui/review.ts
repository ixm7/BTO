/**
 * Looking back over the boards, in the two views a scorecard has: every board
 * you played at your own table, or every table's result on one board. Both
 * read in the same columns — what we scored, what they scored, and the
 * percentage each way — so switching between them does not change how the
 * numbers are read. The deal sits underneath, with the bidding that produced
 * whichever line is selected.
 */
import { SUIT_SYMBOLS, cardSuit, rankChar, sortForDisplay, type Card, type Seat } from '../engine/cards';
import { isVulnerable, type Vulnerability } from '../engine/deal';
import { callToString, type Call } from '../engine/bidding';
import { boardComplete, cardImps, cardTotal, impText, pairAt, reviewBoard, scorecard, type TravellerRow } from '../tournament/review';
import { standings, type BoardResult, type TState } from '../tournament/state';
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
function handBlock(cards: readonly Card[], label: string, highlight: boolean, vul: boolean): HTMLElement {
  const lines = SUIT_ORDER.map((suit) => {
    const inSuit = sortForDisplay(cards.filter((c) => cardSuit(c) === suit));
    const ranks = inSuit.map((c) => (rankChar(c) === 'T' ? '10' : rankChar(c))).join('');
    return h(`div.hl${isRed(suit) ? '.r' : ''}`, h('span.hs', SUIT_SYMBOLS[suit]), h('span.hr', ranks || '—'));
  });
  return h(`div.handblock${highlight ? '.me' : ''}`,
    h(`div.hname${vul ? '.vul' : ''}`, { title: vul ? `${label} is vulnerable` : '' }, label), ...lines);
}

/**
 * The auction as it was bid, in seat columns. Vulnerable sides wear the red
 * over their column, as at the table and as a hand record prints it: without
 * it the bidding cannot be read for what it risked.
 */
export function auctionTable(calls: readonly { seat: Seat; call: Call; alert?: string }[],
  vul: Vulnerability): HTMLElement {
  const order: Seat[] = ['W', 'N', 'E', 'S'];
  const cells: HTMLElement[] = [];
  if (calls.length > 0) {
    for (let i = 0; i < order.indexOf(calls[0]!.seat); i++) cells.push(h('td', ''));
    for (const e of calls) {
      const c = e.call;
      const red = c.type === 'bid' && isRed(c.strain);
      const text = c.type === 'bid' ? `${c.level}${SUIT_SYMBOLS[c.strain]}` : callToString(c);
      const kind = c.type === 'bid' ? '.call-bid' : '.call-pass';
      cells.push(h(`td${kind}${red ? '.r' : ''}${e.alert ? '.alerted' : ''}`, e.alert ? { 'data-tip': e.alert, 'aria-label': e.alert } : {}, text));
    }
  }
  const rows: HTMLElement[] = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(h('tr', cells.slice(i, i + 4)));
  const red = (s: Seat): boolean => isVulnerable(vul, s === 'N' || s === 'S' ? 'NS' : 'EW');
  return h('div.auction.review-auction', h('table',
    h('thead', h('tr', order.map((s) => h(`th${red(s) ? '.vul' : ''}`,
      { title: red(s) ? `${SEAT_NAMES[s]} is vulnerable` : '' }, s)))),
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

/** "2nd", "3rd": a rank as it is read aloud. */
const ordinal = (n: number): string => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th'
    : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
};

/**
 * The four hands as a hand record prints them, with the board between them.
 * Used by the records, and by the table at the end of a board, where it is
 * the one look everybody gets at what the other three were holding.
 */
export function dealDiagram(o: {
  hands: Record<Seat, readonly Card[]>; board: number; dealer: Seat; vul: Vulnerability;
  /** "NS", "EW" or "": the hands this reader held, marked with a halo. */
  ourSeats: string;
  /** Anything to add under the board's own particulars, such as the result. */
  foot?: (HTMLElement | null)[] | null;
}): HTMLElement {
  const red = (seat: Seat): boolean => isVulnerable(o.vul, seat === 'N' || seat === 'S' ? 'NS' : 'EW');
  return h('div.deal',
    h('div.d-top', handBlock(o.hands.N, 'North', o.ourSeats.includes('N'), red('N'))),
    h('div.d-left', handBlock(o.hands.W, 'West', o.ourSeats.includes('W'), red('W'))),
    h('div.d-mid',
      h('div', h('b', `Board ${o.board}`)),
      h('div.muted', `Dealer ${SEAT_NAMES[o.dealer]}`),
      h('div.muted', `Vul ${o.vul}`),
      ...(o.foot ?? [])),
    h('div.d-right', handBlock(o.hands.E, 'East', o.ourSeats.includes('E'), red('E'))),
    h('div.d-bottom', handBlock(o.hands.S, 'South', o.ourSeats.includes('S'), red('S'))));
}

const COLUMNS = ['Board', 'Result', 'We', 'They', 'We %', 'They %'];
const IMP_COLUMNS = ['Board', 'Result', 'We', 'They', 'IMPs'];

export function renderRecords(state: TState, myPair: number | null, view: RecordsView, on: RecordsHandlers): HTMLElement {
  const boards = [...new Set(state.results.map((r) => r.board))].sort((a, b) => a - b);
  if (boards.length === 0) {
    return h('div.panel', h('h3', 'Hand Records'),
      h('p.muted', 'Nothing finished yet. Boards appear here as they are played.'));
  }

  const card = scorecard(state, myPair);
  /* Somebody reading a tournament they did not play has no card of their own,
     so there is nothing to show but what the tables did — which is most of
     what the records are. */
  const played = myPair !== null && card.length > 0;
  const board = view.board ?? card[card.length - 1]?.board ?? (boards[boards.length - 1] as number);
  const review = reviewBoard(state, board, myPair);
  /* Which way round we sat on this board decides which column is "we". */
  const weAreNS = review.own ? review.own.result.nsPair === myPair : true;
  const others = view.mode === 'others' || !played;
  const byImps = state.config.scoring === 'imps';
  /* Until the field has finished a board, the only line on it that is yours
     to read is your own. */
  const complete = boardComplete(state, board);
  const traveller = complete ? review.traveller : review.traveller.filter((t) => t.mine);

  /*
   * Where the card adds up to. A scorecard without its total is a list of
   * boards: the one number a player wants from it is the one at the bottom,
   * and the one after that is where it puts them in the field. The traveller
   * has no such line — it is one board, and the field's own standings are
   * not what that table did.
   */
  const total = cardTotal(card);
  const mySeat = myPair === null ? undefined : standings(state).find((x) => x.pair.id === myPair);
  const footer = played && !others
    ? h('tfoot', h('tr.total',
        h('td', { colSpan: 2 }, mySeat && mySeat.boardsPlayed > 0
          ? `Overall \u2014 ${ordinal(mySeat.rank)} of ${standings(state).length}`
          : 'Overall'),
        h('td.num', ''), h('td.num', ''),
        ...(byImps
          ? [h('td.num', impText(cardImps(card)))]
          : [h('td.num', `${total.we}%`), h('td.num.muted', `${total.they}%`)])))
    : null;

  const rows = others
    ? traveller.map((t: TravellerRow) => {
        const s = fromOurSide(t.result, weAreNS, t.nsMatchpoints, t.top);
        const names = [pairAt(state, t.result.nsPair), pairAt(state, t.result.ewPair)]
          .map((p) => (p ? p.players.map((x) => x.name).join(' & ') : '—')).join(' v ');
        return h(`tr.pick${t.mine ? '.me' : ''}${t.result.table === view.table ? '.sel' : ''}`,
          { onclick: () => on.pickTable(t.result.table), title: `Table ${t.result.table + 1}: ${names}` },
          h('td', String(t.result.board)), h('td', t.result.text),
          h('td.num', s.we), h('td.num', s.they),
          ...(byImps ? [h('td.num', impText(weAreNS ? t.nsImps : -t.nsImps))] : [h('td.num', s.wePct), h('td.num.muted', s.theyPct)]));
      })
    : card.map((r) => h(`tr.pick${r.board === board ? '.sel' : ''}`, { onclick: () => on.pickBoard(r.board) },
        h('td', String(r.board)), h('td', r.result.text),
        h('td.num', r.weScore === null ? '' : String(r.weScore)),
        h('td.num', r.theyScore === null ? '' : String(r.theyScore)),
        ...(byImps ? [h('td.num', impText(r.weImps))] : [h('td.num', `${r.wePercent}%`), h('td.num.muted', `${r.theyPercent}%`)])));

  /* Whichever line is selected supplies the bidding. A reader who was not in
     the field has no line of their own, so the first is shown until they
     choose another — better than a deal with no auction under it. */
  const shown = others && view.table !== null
    ? traveller.find((t) => t.result.table === view.table) ?? review.own
    : review.own ?? (played ? null : traveller[0] ?? null);
  const { N, E, S, W } = review.hands;
  const ourSeats = review.own ? (review.own.result.nsPair === myPair ? 'NS' : 'EW') : '';

  const diagram = dealDiagram({
    hands: review.hands, board, dealer: review.dealer, vul: review.vul, ourSeats,
    foot: shown ? [h('div.muted', { style: 'margin-top:6px' }, `Table ${shown.result.table + 1}`), h('div', h('b', shown.result.text))] : null,
  });

  /*
   * The boards, always on screen. In "other tables" the list below is that
   * one board's traveller, so without this the only way to the next board was
   * out to "my table", down the card and back again — three clicks to read
   * the board after the one you were reading.
   */
  const mine = played ? card.map((r) => r.board) : boards;
  const at = mine.indexOf(board);
  const step = (by: number): (() => void) | undefined => {
    const to = mine[at + by];
    return at < 0 || to === undefined ? undefined : () => on.pickBoard(to);
  };
  const hop = (by: number, label: string, what: string): HTMLElement => {
    const go = step(by);
    return h('button.bstep', { disabled: !go, title: go ? what : `No ${by < 0 ? 'earlier' : 'later'} board`, onclick: go }, label);
  };
  const strip = h('div.boardstrip',
    hop(-1, '\u2039', 'The board before this one'),
    h('div.bnums', mine.map((b) => h(`button.bnum${b === board ? '.sel' : ''}`, {
      title: `Board ${b}`, onclick: () => on.pickBoard(b),
    }, String(b)))),
    hop(1, '\u203a', 'The board after this one'));

  return h('div.panel',
    h('div.row', h('h3', others
        ? complete ? `Board ${board} at every table` : `Board ${board}, so far`
        : 'Your Boards'),
      /* The way between the two halves of the records, and the thing most
         people come here to press. It was over on the far edge, away from
         the boards it works with, and in the quietest style on the page:
         somebody opening the records for the first time had no reason to
         think it was there. It sits by the heading now, in the colour the
         site uses for going somewhere. */
      played
        ? h('button.open.swap', {
            onclick: () => on.setMode(others ? 'mine' : 'others'),
            title: others
              ? 'Go back to every board you played at your own table'
              : 'See what every other table did with this same board',
          }, others ? 'My Table' : 'Other Tables')
        : null),
    strip,
    /* A line of explanation above your own card told you what a scorecard is;
       anybody reading one knows. The two states that are not obvious — no
       card of your own, or a board the field has not finished — still say so. */
    !played
      ? h('p.muted', 'You did not play in this tournament, so there is no card of your own here \u2014 these are the tables that did.')
      : others && !complete
        ? h('p.muted', 'Some of the field is still playing this board, so only your own line is here. '
          + 'The rest appear once everyone has finished it.')
        : null,
    h('div.table-scroll', h('table.list.gridded.scorecard',
      /* "We" and "they" belong to somebody who was there; to a reader who
         was not, the two sides are just the two sides. */
      h('thead', h('tr', (byImps ? IMP_COLUMNS : COLUMNS)
        .map((t) => (played ? t : t.replace(/^We/, 'N-S').replace(/^They/, 'E-W')))
        .map((t, i) => h(i >= 2 ? 'th.num' : 'th', t)))),
      h('tbody', rows),
      footer)),
    /*
     * The deal is three columns with the top hand in the middle, so the
     * corner beside it is empty: wide enough and the bidding sits there,
     * level with the hands, instead of below the whole diagram where it was
     * a scroll away. Too narrow for both and it drops back underneath.
     */
    h('div.deal-wrap',
      shown?.result.auction
        ? h('div.bidblock', h('h4', !played || (others && view.table !== null)
              ? `Table ${shown.result.table + 1} Auction`
              : 'My Table Auction'),
            auctionTable(shown.result.auction, review.vul))
        : null,
      diagram));
}
