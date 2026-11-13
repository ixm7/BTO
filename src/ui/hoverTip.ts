/**
 * Tooltips that survive the table redrawing itself.
 *
 * The table is rebuilt whenever anything changes, several times a second in
 * play. A browser's own tooltip (the `title` attribute) belongs to the element
 * under the mouse, and vanishes the moment that element is replaced — so it
 * flickers away however still the mouse is. This one lives outside the table,
 * and follows whatever is under the pointer with a `data-tip`: a redraw
 * that puts the same label back under the mouse leaves it showing.
 */

let tip: HTMLDivElement | null = null;

function place(x: number, y: number): void {
  if (!tip) return;
  const pad = 12;
  const r = tip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad + 6;
  if (left + r.width > innerWidth - 8) left = Math.max(8, x - r.width - pad);
  if (top + r.height > innerHeight - 8) top = Math.max(8, y - r.height - pad);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hide(): void {
  if (tip) tip.hidden = true;
}

export function installHoverTips(): void {
  if (tip || typeof document === 'undefined') return;
  tip = document.createElement('div');
  tip.className = 'hover-tip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  document.body.append(tip);

  document.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch') return;
    const el = (e.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null;
    const text = el?.dataset.tip;
    if (!text || !tip) { hide(); return; }
    if (tip.textContent !== text) tip.textContent = text;
    tip.hidden = false;
    place(e.clientX, e.clientY);
  }, { passive: true });
  /* Leaving the window, scrolling or clicking puts it away. */
  document.addEventListener('pointerleave', hide);
  document.addEventListener('pointerdown', hide, { passive: true });
  window.addEventListener('blur', hide);
  window.addEventListener('scroll', hide, { passive: true });
}
