const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("dotenv");

const env = {
  ...parse(fs.readFileSync(path.join(__dirname, ".env"), "utf8")),
  NODE_ENV: "production",
};
const common = {
  cwd: __dirname,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,
  watch: false,
  exp_backoff_restart_delay: 100,
  kill_timeout: 300000,
  env,
};

module.exports = {
  apps: [
    { ...common, name: "talkmart-api", script: "src/index.js" },
    { ...common, name: "talkmart-worker", script: "src/worker.js" },
  ],
};
