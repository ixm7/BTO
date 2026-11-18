/**
 * Everything this browser knows about you, as one line of text.
 *
 * Who you are here is a key the browser invented on first run, and it lives
 * in that browser on that machine. Nothing carries it across: a browser's own
 * sync takes bookmarks and passwords but never a site's storage. So the same
 * person at a laptop and at a desktop is two strangers, and the second cannot
 * withdraw the first's entry or answer an invitation sent to it.
 *
 * The fix is to let them carry it themselves. Everything the site has stored
 * — the key, the name, the level, the system, the passwords of any locked
 * tournaments — is packed into one string short enough to paste into a
 * message to yourself, and unpacked at the other end.
 *
 * The string is gzipped because it is meant to be pasted by hand: the same
 * settings run to a few hundred characters compressed and a thousand or more
 * plain. It is not encrypted, and it is not obscured for safety — base64 of a
 * deflate stream is as readable to a machine as the JSON it came from. It
 * carries the key that speaks for you, so it is treated like a password
 * wherever it is offered to a person.
 */

/** Only this site's own keys travel, and never a test player's. */
export const ours = (key: string): boolean =>
  key.startsWith('bridge-p2p:') && !/:test\d+$/.test(key);

const MAGIC = 'BBKIT';
const ZIPPED = `${MAGIC}1.`;
const PLAIN = `${MAGIC}0.`;
/** Room for a token and a few remembered passwords, and no room for a prank. */
const MAX_CHARS = 20_000;

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const unb64url = (text: string): Uint8Array => {
  const pad = text.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad + '='.repeat((4 - (pad.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

async function through(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const squeezer = (): typeof CompressionStream | null =>
  (typeof CompressionStream === 'function' ? CompressionStream : null);

/**
 * The settings as one line. Gzipped where the browser can, and plainly
 * encoded where it cannot — an older browser should still be able to hand
 * its settings to a newer one.
 */
export async function pack(items: Record<string, string>): Promise<string> {
  const json = JSON.stringify(items);
  const bytes = new TextEncoder().encode(json);
  const Zip = squeezer();
  if (!Zip) return PLAIN + b64url(bytes);
  const zipped = await through(new Blob([bytes as BlobPart]).stream().pipeThrough(new Zip('gzip')));
  /* On a handful of short settings the wrapper can cost more than it saves. */
  return zipped.length < bytes.length ? ZIPPED + b64url(zipped) : PLAIN + b64url(bytes);
}

export class BackupError extends Error {}

/**
 * The same read back. It throws rather than returning half a set of settings:
 * this replaces who the player is on this device, so a string that is not
 * quite right must not be half-applied.
 */
export async function unpack(text: string): Promise<Record<string, string>> {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (!trimmed) throw new BackupError('Nothing was pasted.');
  if (trimmed.length > MAX_CHARS) throw new BackupError('That is far too long to be a settings code.');
  if (!trimmed.startsWith(ZIPPED) && !trimmed.startsWith(PLAIN)) {
    throw new BackupError('That does not look like a Bridge Break settings code. It should begin with "BBKIT".');
  }
  const zipped = trimmed.startsWith(ZIPPED);
  const body = trimmed.slice((zipped ? ZIPPED : PLAIN).length);
  let bytes: Uint8Array;
  try {
    bytes = unb64url(body);
    if (zipped) {
      if (typeof DecompressionStream !== 'function') {
        throw new BackupError('This browser cannot unpack a compressed settings code. '
          + 'Copy the settings again on the other device using a newer browser.');
      }
      bytes = await through(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
    }
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('That settings code is damaged. Copy it again, all of it, and paste it whole.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch {
    throw new BackupError('That settings code is damaged. Copy it again, all of it, and paste it whole.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BackupError('That settings code does not hold any settings.');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!ours(k) || typeof v !== 'string') continue;
    out[k] = v;
  }
  if (!Object.keys(out).length) throw new BackupError('That settings code does not hold any settings.');
  return out;
}

/** What is in a code, said in a line before it is used. */
export function describe(items: Record<string, string>): { name: string; hasToken: boolean; passwords: number } {
  let name = '';
  let hasToken = false;
  for (const [k, v] of Object.entries(items)) {
    if (k === 'bridge-p2p:settings') {
      try {
        const s = JSON.parse(v) as { name?: unknown; token?: unknown };
        name = typeof s.name === 'string' ? s.name.trim() : '';
        hasToken = typeof s.token === 'string' && s.token.length > 0;
      } catch { /* a settings blob we cannot read is still worth importing */ }
    }
  }
  return { name, hasToken, passwords: Object.keys(items).filter((k) => k.startsWith('bridge-p2p:pw:')).length };
}

/** Everything this site has stored here, ready to pack. */
export function collect(store: Storage, withToken: boolean): Record<string, string> {
  const items: Record<string, string> = {};
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k || !ours(k)) continue;
    const v = store.getItem(k);
    if (v === null) continue;
    items[k] = v;
  }
  const raw = items['bridge-p2p:settings'];
  if (!withToken && raw) {
    try {
      const s = JSON.parse(raw) as Record<string, unknown>;
      /* The login goes with it: without the token it would name an account
         this device cannot act as. */
      items['bridge-p2p:settings'] = JSON.stringify({ ...s, token: '', githubLogin: '' });
    } catch { /* leave it as it is */ }
  }
  return items;
}
