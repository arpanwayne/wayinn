import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { errorHandler } from './middleware/error.js';
import { pool } from './db.js';

import auth from './routes/auth.js';
import hotel from './routes/hotel.js';
import staff from './routes/staff.js';
import rooms from './routes/rooms.js';
import guests from './routes/guests.js';
import bookings from './routes/bookings.js';
import folios from './routes/folios.js';
import pos from './routes/pos.js';
import operations from './routes/operations.js';
import reports from './routes/reports.js';
import portal from './routes/portal.js';
import platform from './routes/platform.js';
import channel from './routes/channel.js';
import documents from './routes/documents.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigins, credentials: false }));
  // rawBody is kept for webhook signature checks (Razorpay).
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  if (config.env !== 'test') app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));

  app.get('/api/health', async (_req, res) => {
    await pool.query('SELECT 1');
    res.json({ ok: true, service: 'wayinn-api', time: new Date().toISOString() });
  });

  app.use('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }));
  app.use('/api/platform/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 10 }));

  const api = express.Router();
  for (const r of [auth, platform, channel, portal, hotel, staff, rooms, guests, documents, bookings, folios, pos, operations, reports]) api.use(r);
  app.use('/api', api);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
