// ESC/POS bytes for 58 mm / 80 mm thermal printers (Epson-compatible: TVS, Epson, Xprinter, Rugtek…).
// The kitchen screen sends these straight to a USB printer, so tickets print with no browser dialog.
const ESC = 0x1b;
const GS = 0x1d;

const ascii = (s) => Buffer.from(String(s ?? '').normalize('NFKD').replace(/[^\x20-\x7e\n]/g, ''), 'ascii');

/** Wrap text to the paper width (32 characters on 58 mm, 48 on 80 mm). */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const indent = para.match(/^ */)[0].slice(0, Math.floor(width / 2)); // keep the indent of "  2 x" and "     + extras"
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = indent + word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else { out.push(line); line = word; }
      while (line.length > width) { out.push(line.slice(0, width)); line = line.slice(width); }
    }
    out.push(line);
  }
  return out;
}

/**
 * Kitchen ticket. `k` = { kot_no, order_no, where, time, station, items: [{quantity, name, variant, addons, notes}], notes }.
 * width: 32 (58 mm) or 48 (80 mm).
 */
export function kotEscpos(k, { width = 32, cut = true, beep = false } = {}) {
  const parts = [];
  const cmd = (...b) => parts.push(Buffer.from(b));
  const text = (s) => parts.push(ascii(s));
  const line = (s = '') => { for (const l of wrap(s, width)) text(`${l}\n`); };

  cmd(ESC, 0x40);                 // initialise
  cmd(ESC, 0x61, 1);              // centre
  cmd(ESC, 0x45, 1); line(`KOT ${k.kot_no}${k.station ? `  [${k.station}]` : ''}`); cmd(ESC, 0x45, 0);
  cmd(GS, 0x21, 0x11);            // double width + height
  line(k.where);
  cmd(GS, 0x21, 0x00);
  line(`${k.order_no}   ${k.time}`);
  cmd(ESC, 0x61, 0);              // left
  line('-'.repeat(width));
  for (const i of k.items) {
    cmd(GS, 0x21, 0x01);          // double height for the dish
    cmd(ESC, 0x45, 1); line(`${String(i.quantity).padStart(2)} x ${i.name}${i.variant ? ` (${i.variant})` : ''}`); cmd(ESC, 0x45, 0);
    cmd(GS, 0x21, 0x00);
    if (i.addons?.length) line(`     + ${i.addons.map((a) => a.name).join(', ')}`);
    if (i.notes) line(`     * ${i.notes}`);
  }
  line('-'.repeat(width));
  if (k.notes) { cmd(ESC, 0x45, 1); line(`NOTE: ${k.notes}`); cmd(ESC, 0x45, 0); }
  if (beep) cmd(ESC, 0x42, 2, 2); // buzzer on printers that have one
  cmd(ESC, 0x64, 4);              // feed 4 lines
  if (cut) cmd(GS, 0x56, 0x42, 0x00); // partial cut
  return Buffer.concat(parts);
}
