import { useEffect, useRef } from 'preact/hooks';
import type { TooltipData } from '../pricing-ui.js';

/** Serialize a tooltip payload into a `data-tt` attribute value. */
export function ttAttr(data: TooltipData): string {
  return JSON.stringify(data);
}

/**
 * A single fixed tooltip driven by `data-tt` attributes on bars — the same
 * hover + keyboard-focus model as the original meter, ported to a Preact effect.
 */
export function TooltipLayer() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tt = ref.current;
    if (!tt) return;

    function show(el: Element, x: number, y: number): void {
      let d: TooltipData;
      try {
        d = JSON.parse((el as HTMLElement).dataset.tt ?? '');
      } catch {
        return;
      }
      if (!tt) return;
      tt.textContent = '';
      if (d.t) {
        const h = document.createElement('div');
        h.className = 'hd';
        h.textContent = d.t;
        tt.appendChild(h);
      }
      for (const r of d.rows ?? []) {
        const row = document.createElement('div');
        row.className = 'r';
        if (r[0]) {
          const k = document.createElement('span');
          k.className = 'k';
          k.style.background = r[0];
          row.appendChild(k);
        }
        const l = document.createElement('span');
        l.className = 'l';
        l.textContent = r[1];
        row.appendChild(l);
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = r[2];
        row.appendChild(v);
        tt.appendChild(row);
      }
      if (d.n) {
        const n = document.createElement('div');
        n.className = 'nt';
        n.textContent = d.n;
        tt.appendChild(n);
      }
      tt.style.display = 'block';
      move(x, y);
    }

    function move(x: number, y: number): void {
      if (!tt) return;
      const r = tt.getBoundingClientRect();
      let L = x + 14;
      let T = y + 14;
      if (L + r.width > innerWidth - 8) L = x - r.width - 10;
      if (T + r.height > innerHeight - 8) T = y - r.height - 10;
      tt.style.left = `${Math.max(8, L)}px`;
      tt.style.top = `${Math.max(8, T)}px`;
    }
    const hide = () => {
      if (tt) tt.style.display = 'none';
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element)?.closest('[data-tt]');
      if (el) show(el, e.clientX, e.clientY);
    };
    const onMove = (e: PointerEvent) => {
      if (tt.style.display !== 'block') return;
      if ((e.target as Element)?.closest('[data-tt]')) move(e.clientX, e.clientY);
      else hide();
    };
    const onOut = (e: PointerEvent) => {
      const el = (e.target as Element)?.closest('[data-tt]');
      if (el && !(e.relatedTarget && el.contains(e.relatedTarget as Node))) hide();
    };
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as Element)?.closest('[data-tt]');
      if (el) {
        const r = el.getBoundingClientRect();
        show(el, r.left + r.width / 2, r.bottom);
      }
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', hide);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', hide);
    };
  }, []);

  return <div id="tt" role="tooltip" ref={ref} />;
}
