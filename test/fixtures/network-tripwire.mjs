/**
 * Preloaded (`node --import`) into the agent bridge under test. Any network
 * use — an outbound socket, a DNS lookup, a listener, fetch — is reported
 * on stderr and refused, so the end-to-end test can prove the server stayed
 * off the network for a whole session.
 */
import dns from 'node:dns';
import net from 'node:net';
import process from 'node:process';

function trip(what) {
  process.stderr.write(`NETWORK-TRIPWIRE ${what}\n`);
  throw new Error(`network use refused by test: ${what}`);
}

net.Socket.prototype.connect = function connect() {
  trip('net.Socket.connect');
};
net.Server.prototype.listen = function listen() {
  trip('net.Server.listen');
};
dns.lookup = () => trip('dns.lookup');
dns.promises.lookup = async () => trip('dns.promises.lookup');
globalThis.fetch = async () => trip('fetch');
