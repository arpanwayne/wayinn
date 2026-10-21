// Direct printing to a thermal printer from the kitchen screen (Chrome / Edge), with no print dialog.
//  - "usb":    WebUSB. Works on Android tablets, ChromeOS, Linux and macOS. On Windows the printer's own driver
//              holds the USB port, so use "serial" or the browser print with --kiosk-printing there.
//  - "serial": Web Serial. For printers that show up as a COM port (USB-serial or Bluetooth).
// The browser remembers the permission, so after the first "Connect" the printer reconnects on its own.
import { request } from './api.js';

let usbDevice = null;
let usbEndpoint = null;
let serialPort = null;

export const supported = {
  usb: typeof navigator !== 'undefined' && !!navigator.usb,
  serial: typeof navigator !== 'undefined' && !!navigator.serial,
};

async function openUsb(device) {
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  // Prefer the printer-class interface (7); otherwise any interface with a bulk OUT endpoint.
  const ifaces = device.configuration.interfaces;
  const pick = ifaces.find((i) => i.alternate.interfaceClass === 7) || ifaces.find((i) => i.alternate.endpoints.some((e) => e.direction === 'out'));
  if (!pick) throw new Error('This USB device is not a printer');
  await device.claimInterface(pick.interfaceNumber);
  usbEndpoint = pick.alternate.endpoints.find((e) => e.direction === 'out').endpointNumber;
  usbDevice = device;
}

async function openSerial(port) {
  if (!port.writable) await port.open({ baudRate: 9600 });
  serialPort = port;
}

/** Ask the user to pick the printer (needs a click). */
export async function connect(kind) {
  if (kind === 'usb') await openUsb(await navigator.usb.requestDevice({ filters: [] }));
  else if (kind === 'serial') await openSerial(await navigator.serial.requestPort());
  return describe(kind);
}

/** Reconnect to a printer the user already allowed. Returns false if there is none. */
export async function reconnect(kind) {
  try {
    if (kind === 'usb' && supported.usb) {
      const [d] = await navigator.usb.getDevices();
      if (d) { await openUsb(d); return true; }
    }
    if (kind === 'serial' && supported.serial) {
      const [p] = await navigator.serial.getPorts();
      if (p) { await openSerial(p); return true; }
    }
  } catch { /* unplugged or busy */ }
  return false;
}

export function describe(kind) {
  if (kind === 'usb' && usbDevice) return usbDevice.productName || 'USB printer';
  if (kind === 'serial' && serialPort) return 'Serial printer';
  return null;
}

async function write(kind, bytes) {
  if (kind === 'usb') {
    if (!usbDevice) throw new Error('Printer not connected');
    for (let i = 0; i < bytes.length; i += 4096) await usbDevice.transferOut(usbEndpoint, bytes.slice(i, i + 4096));
  } else if (kind === 'serial') {
    if (!serialPort?.writable) throw new Error('Printer not connected');
    const w = serialPort.writable.getWriter();
    try { await w.write(bytes); } finally { w.releaseLock(); }
  }
}

/** Print one kitchen ticket. width 32 = 58 mm paper, 48 = 80 mm. */
export async function printKotDirect(kind, kotId, { width = 32, beep = false } = {}) {
  const res = await request('GET', `/kots/${kotId}/print?format=escpos&width=${width}${beep ? '&beep=1' : ''}`, null, { raw: true });
  await write(kind, new Uint8Array(await res.arrayBuffer()));
}

/** A short test slip. */
export async function printTest(kind, width = 32) {
  const t = new TextEncoder();
  const line = '-'.repeat(width);
  const bytes = new Uint8Array([0x1b, 0x40, 0x1b, 0x61, 1, ...t.encode(`Wayinn printer test\n${line}\nIf you can read this,\ndirect printing works.\n${line}\n`), 0x1b, 0x64, 4, 0x1d, 0x56, 0x42, 0]);
  await write(kind, bytes);
}
