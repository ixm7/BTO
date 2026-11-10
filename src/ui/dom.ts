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
  repo: string;
  githubLogin: string;
  token: string;
  pairCode: string;
  playerId: string;
  /** 'p2p' = WebRTC over the internet; 'local' = other tabs of this browser. */
  transport: 'p2p' | 'local';
}

const KEY = 'bridge-p2p:settings';

export function loadSettings(defaultRepo: string): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>; } catch { /* first visit */ }
  const s: Settings = {
    name: saved.name ?? '', repo: saved.repo ?? defaultRepo, githubLogin: saved.githubLogin ?? '', token: saved.token ?? '',
    pairCode: saved.pairCode ?? '', playerId: saved.playerId ?? '', transport: saved.transport === 'local' ? 'local' : 'p2p',
  };
  if (!s.playerId) {
    const b = new Uint8Array(9);
    crypto.getRandomValues(b);
    s.playerId = 'u' + Array.from(b, (x) => x.toString(36)).join('');
    saveSettings(s);
  }
  return s;
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
