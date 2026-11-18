/**
 * The settings code as a square, for carrying it to a phone.
 *
 * Copying works between two machines with a keyboard between them; a phone
 * has a camera instead. A QR code crosses that gap with nothing in the middle
 * — no mail provider, no network, no address to mistype — which is the same
 * reason the rest of this site has nothing in the middle either.
 *
 * It is drawn as one SVG path rather than a grid of rectangles: a code of
 * this size is five thousand dark squares, and five thousand elements is a
 * slow thing to put in a dialog.
 */
import qrcode from 'qrcode-generator';

/** Light squares around the code, which a reader needs to find its edges. */
const QUIET = 4;

export interface QrOptions {
  /** How wide to draw it, in CSS pixels. */
  size?: number;
  /** A label for anyone who cannot see it. */
  title?: string;
}

/**
 * An SVG of the code, or null if it will not fit in one — a QR code holds
 * about 2,900 bytes at this correction level, and a settings string is a
 * tenth of that, but a caller should not have to assume it.
 */
export function qrSvg(text: string, o: QrOptions = {}): SVGSVGElement | null {
  if (!text) return null;
  let qr: ReturnType<typeof qrcode>;
  try {
    /* 0 picks the smallest version that holds it; L leaves the most room,
       which keeps the squares big, and a screen is not a crumpled receipt. */
    qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
  } catch { return null; }

  const n = qr.getModuleCount();
  const span = n + QUIET * 2;
  let d = '';
  for (let row = 0; row < n; row++) {
    /* Runs of dark squares in a row become one rectangle in the path. */
    let from = -1;
    for (let col = 0; col <= n; col++) {
      const dark = col < n && qr.isDark(row, col);
      if (dark && from < 0) from = col;
      if (!dark && from >= 0) {
        d += `M${from + QUIET} ${row + QUIET}h${col - from}v1h-${col - from}z`;
        from = -1;
      }
    }
  }

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('width', String(o.size ?? 240));
  svg.setAttribute('height', String(o.size ?? 240));
  svg.setAttribute('role', 'img');
  svg.setAttribute('shape-rendering', 'crispEdges');
  if (o.title) svg.setAttribute('aria-label', o.title);

  /* White behind it and black on top, whatever the page is wearing: a reader
     expects dark on light, and a code inverted by a dark theme is a code that
     half the phones in the room will not see. */
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', String(span));
  bg.setAttribute('height', String(span));
  bg.setAttribute('fill', '#fff');
  svg.append(bg);

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}
