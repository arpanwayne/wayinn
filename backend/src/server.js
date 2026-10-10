import { createApp } from './app.js';
import { config } from './config.js';
import { startJobs } from './lib/jobs.js';

const app = createApp();
app.listen(config.port, () => {
  console.log(`Wayinn API listening on :${config.port}`);
  startJobs();
});
