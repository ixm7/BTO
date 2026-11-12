import { toSkill, type MaybeSkill } from '../directory/github';

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper: h('button.primary', { onclick }, 'Start'). */
export function h(spec: string, attrs?: Attrs | Child, ...children: Child[]): HTMLElement {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  const isAttrs = attrs !== null && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs);
  if (isAttrs) {
    for (const [k, v] of Object.entries(attrs as Attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = `${el.className} ${String(v)}`.trim();
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  } else {
    children.unshift(attrs as Child);
  }
  const add = (c: Child): void => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : String(c));
  };
  children.forEach(add);
  return el;
}

export interface Settings {
  name: string;
  /** How the player describes their own game; '' until they have said. */
  skill: MaybeSkill;
  /** Whether the table chimes when it is your turn. */
  sound: boolean;
  repo: string;
  githubLogin: string;
  token: string;
  pairCode: string;
  playerId: string;
  /**
   * Private to this browser: it signs this player's registrations and partner
   * requests, so that nobody else can withdraw them or speak for them. Never
   * shown to other players or posted anywhere.
   */
  playerKey: string;
  /** Remembered from the last time you added yourself to a "looking for a partner"
   * list, so it's offered again as the default next time rather than starting blank. */
  partnerNote: string;
  /** 'p2p' = WebRTC over the internet; 'local' = other tabs of this browser. */
  transport: 'p2p' | 'local';
}

const KEY = 'bridge-p2p:settings';

export function loadSettings(defaultRepo: string): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>; } catch { /* first visit */ }
  const s: Settings = {
    name: saved.name ?? '', skill: toSkill(saved.skill) ?? '', sound: saved.sound !== false,
    repo: saved.repo ?? defaultRepo,
    githubLogin: saved.githubLogin ?? '', token: saved.token ?? '',
    pairCode: saved.pairCode ?? '', playerId: saved.playerId ?? '', partnerNote: saved.partnerNote ?? '',
    playerKey: /^[A-Za-z0-9_-]{32,128}$/.test(saved.playerKey ?? '') ? (saved.playerKey as string) : '',
    /* Players always connect over the Internet. A choice saved from when this
       was a setting is ignored, so nobody is left on a mode they can no
       longer see. `?transport=local` keeps several players in one browser,
       for testing only. */
    transport: typeof location !== 'undefined' && new URLSearchParams(location.search).get('transport') === 'local'
      ? 'local' : 'p2p',
  };
  let fresh = false;
  if (!s.playerId) {
    const b = new Uint8Array(9);
    crypto.getRandomValues(b);
    s.playerId = 'u' + Array.from(b, (x) => x.toString(36)).join('');
    fresh = true;
  }
  if (!s.playerKey) {
    const b = new Uint8Array(32);
    crypto.getRandomValues(b);
    /* base64url, the alphabet the relay accepts. */
    s.playerKey = btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    fresh = true;
  }
  if (fresh) saveSettings(s);
  return s;
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
