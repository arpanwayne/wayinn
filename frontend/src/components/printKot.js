import { request } from '../lib/api.js';

export async function printKot(kotId) {
  const txt = await (await request('GET', `/kots/${kotId}/print`, null, { raw: true })).text();
  const w = window.open('', '_blank', 'width=320,height=600');
  if (!w) return;
  w.document.write(`<pre style="font:13px monospace;margin:0">${txt.replace(/</g, '&lt;')}</pre>`);
  w.document.close();
  w.focus();
  w.print();
}
