import dgram from 'node:dgram';
import { performance } from 'node:perf_hooks';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 38000);
const text = process.argv[4] ?? 'Hello through RouteLab';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port');
const payload = Buffer.from(text, 'utf8');
if (payload.length > 1200) throw new Error('Payload exceeds 1200 bytes');
const socket = dgram.createSocket('udp4');
const started = performance.now();
const timer = setTimeout(() => { console.error('No reply within 3 seconds. Check path health and the configured authorized target.'); socket.close(); process.exitCode = 1; }, 3000);
socket.once('error', error => { clearTimeout(timer); console.error(error.message); socket.close(); process.exitCode = 1; });
socket.once('message', message => {
  clearTimeout(timer);
  console.log(`Reply: ${message.toString('utf8')}`);
  console.log(`Application round-trip: ${(performance.now() - started).toFixed(1)} ms`);
  socket.close();
});
socket.send(payload, port, host, error => { if (error) socket.emit('error', error); });
