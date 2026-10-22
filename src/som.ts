// Set-of-marks labeler for the real browser (extracted from index.ts for the 80k cap).
// v2 (2026-10-21): wider element coverage (role=tab/link/menuitem..., contenteditable, tabindex, cursor:pointer divs),
// occlusion detection (elements hidden behind a cookie banner / modal are NOT offered as clickable and the overlay is reported),
// viewport-first numbering (what you see gets the lowest ids, so the 100-item cap never drops visible controls),
// href / current value / disabled info per element, and scroll position.
// NOTE: this function is serialised and executed inside the page (page.evaluate), so it must stay self-contained.
// deno-lint-ignore-file no-explicit-any
export const somJs = (): any => {
    document.querySelectorAll('.ai-som-label').forEach((el: any) => el.remove());
    const base = 'a, button, input:not([type="hidden"]), textarea, select, summary, label, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], [contenteditable=""], [contenteditable="true"], [onclick], [tabindex]:not([tabindex="-1"])';
    const vw = window.innerWidth, vh = window.innerHeight;
    const cands: any[] = Array.from(document.querySelectorAll(base));
    const seen = new Set(cands);
    // clickable-looking containers (cursor:pointer) with no semantic marker; bounded scan
    const loose: any[] = Array.from(document.querySelectorAll('div, span, li, img, svg')).slice(0, 1500);
    for (const el of loose) {
        if (seen.has(el) || el.closest(base)) continue;
        if (window.getComputedStyle(el).cursor === 'pointer') { cands.push(el); seen.add(el); }
    }
    const info: any[] = [];
    let blocked = 0;
    let overlayText = '';
    for (const el of cands) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!(rect.width > 5 && rect.height > 5) || style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
        const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
        if (inView) {
            const cx = Math.min(Math.max(rect.left + rect.width / 2, 0), vw - 1);
            const cy = Math.min(Math.max(rect.top + rect.height / 2, 0), vh - 1);
            const top: any = document.elementFromPoint(cx, cy);
            if (top && !(el.contains(top) || top.contains(el))) {
                blocked++;
                if (!overlayText) overlayText = String(top.innerText || top.getAttribute('aria-label') || top.tagName).trim().replace(/\s+/g, ' ').slice(0, 60);
                continue; // covered by something else: a click would land on the overlay instead
            }
        }
        info.push({ el, rect, inView });
    }
    // viewport-first numbering (document order inside each group)
    const ordered = info.filter((x) => x.inView).concat(info.filter((x) => !x.inView && x.rect.top >= vh), info.filter((x) => !x.inView && x.rect.top < vh));
    const items: any[] = [];
    let id = 1;
    for (const { el, rect, inView } of ordered) {
        if (id > 150) break;
        el.setAttribute('data-ai-id', id.toString());
        if (inView) {
            const badge = document.createElement('div');
            badge.className = 'ai-som-label';
            badge.textContent = `[${id}]`;
            Object.assign(badge.style, {
                position: 'fixed',
                left: `${Math.max(0, rect.left)}px`,
                top: `${Math.max(0, rect.top)}px`,
                backgroundColor: '#ff0033',
                color: '#ffffff',
                fontSize: '12px',
                fontWeight: 'bold',
                padding: '1px 4px',
                borderRadius: '3px',
                zIndex: '2147483647',
                pointerEvents: 'none',
                border: '1px solid yellow'
            });
            document.body.appendChild(badge);
        }
        const text = (
            el.innerText || el.value || el.placeholder ||
            el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('name') || ''
        ).trim().replace(/\s+/g, ' ').slice(0, 80);
        const item: any = { id, tag: el.tagName.toLowerCase(), type: el.type || el.getAttribute('role') || '', text, pos: inView ? '' : (rect.top >= vh ? '↓' : '↑') };
        const href = el.tagName === 'A' ? el.getAttribute('href') : '';
        if (href && !href.startsWith('javascript:') && href !== '#') item.href = href.length > 70 ? href.slice(0, 70) + '…' : href;
        if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value && el.type !== 'password') item.val = String(el.value).slice(0, 40);
        if (el.type === 'checkbox' || el.type === 'radio') item.checked = !!el.checked;
        if (el.disabled) item.disabled = true;
        items.push(item);
        id++;
    }
    const doc = document.documentElement;
    return { items, blocked, overlayText, scrollY: Math.round(window.scrollY), docH: Math.round(doc.scrollHeight), vh };
};
