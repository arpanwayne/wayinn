// PM2: pm2 start deploy/ecosystem.config.cjs  (run from repo root)
module.exports = {
  apps: [{
    name: 'wayinn-api',
    cwd: './backend',
    script: 'src/server.js',
    instances: 1, // background jobs (auto night audit) run in this process; keep 1 or set RUN_JOBS=false on extras
    env: { NODE_ENV: 'production' },
    max_memory_restart: '400M',
  }],
};
