// In-process events between modules that should not import each other (e.g. rate changes → Google sync).
import { EventEmitter } from 'node:events';

export const bus = new EventEmitter();
bus.setMaxListeners(50);
