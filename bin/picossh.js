#!/usr/bin/env node
// picossh command: starts the server with its data in ~/.picossh unless
// DATA_DIR says otherwise. Configured through the environment (see README.md).
const os = require('os');
const path = require('path');
const pkg = require('../package.json');

const args = process.argv.slice(2);
const usage = `picossh ${pkg.version}: ${pkg.description}

Usage: picossh [--port <port>] [--data-dir <dir>]

Environment:
  APP_PASSWORD  password to sign in with (required)
  APP_SECRET    key that encrypts stored passwords and keys
                (default: generated into <data-dir>/secret.key)
  PORT          port to listen on (default 3000)
  DATA_DIR      where data is kept (default ~/.picossh)
  DNS_SERVERS   DNS servers to look server names up with first
`;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  const value = () => {
    const v = args[++i];
    if (v === undefined) {
      console.error(`${arg} needs a value\n\n${usage}`);
      process.exit(2);
    }
    return v;
  };
  if (arg === '-h' || arg === '--help') {
    process.stdout.write(usage);
    process.exit(0);
  } else if (arg === '-v' || arg === '--version') {
    console.log(pkg.version);
    process.exit(0);
  } else if (arg === '-p' || arg === '--port') {
    process.env.PORT = value();
  } else if (arg === '--data-dir') {
    process.env.DATA_DIR = value();
  } else {
    console.error(`Unknown option: ${arg}\n\n${usage}`);
    process.exit(2);
  }
}

if (!process.env.DATA_DIR) process.env.DATA_DIR = path.join(os.homedir(), '.picossh');
if (!process.env.APP_PASSWORD) console.warn('APP_PASSWORD is not set: the app only shows a setup page until it is.');

require('../server.js');
