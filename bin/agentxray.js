#!/usr/bin/env node
// CLI entry: parse --port/--host, export them, then boot the server.
const argv = process.argv.slice(2);
let port = process.env.PORT;
let host = process.env.HOST;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const flag = eq === -1 ? arg : arg.slice(0, eq);
  const inline = eq === -1 ? null : arg.slice(eq + 1);
  const next = () => (inline !== null ? inline : argv[++i]);
  if (flag === '--port' || flag === '-p') port = next();
  else if (flag === '--host' || flag === '-H') host = next();
  else if (flag === '--version' || flag === '-v') {
    console.log(require('../package.json').version);
    process.exit(0);
  } else if (flag === '--help' || flag === '-h') {
    console.log('Usage: agentxray [--port <port>] [--host <host>] [--version]');
    process.exit(0);
  } else {
    console.error(`agentxray: unknown option '${arg}'`);
    process.exit(1);
  }
}

if (port) process.env.PORT = String(port);
if (host) process.env.HOST = String(host);

require('../server.js');
