import { request } from '../lib/api.js';

/**
 * Print a kitchen ticket through a hidden frame (no pop-up window, so it also works when the page
 * prints on its own). With Chrome started in kiosk-printing mode the ticket goes straight to the
 * default printer; otherwise the browser shows its print dialog.
 */
export async function printKot(kotId) {
  const txt = await (await request('GET', `/kots/${kotId}/print`, null, { raw: true })).text();
  await new Promise((resolve) => {
    const f = document.createElement('iframe');
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<style>@page{margin:4mm}</style><pre style="font:13px monospace;margin:0;white-space:pre-wrap">${txt.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`);
    d.close();
    f.contentWindow.focus();
    f.contentWindow.print();
    setTimeout(() => { f.remove(); resolve(); }, 1500);
  });
}
