import { isIPv4 } from 'node:net';

export function endpoint(value, zero = false) {
  if (!value || !isIPv4(value.host) || !Number.isInteger(value.port) || value.port < (zero ? 0 : 1) || value.port > 65535) throw new Error('Endpoint requires an IPv4 literal and valid port');
  if (!zero && (value.host === '0.0.0.0' || Number(value.host.split('.')[0]) >= 224)) throw new Error('Remote endpoint must be a unicast IPv4 address');
  return { host: value.host, port: value.port };
}
export const peerKey = value => `${value.address ?? value.host}:${value.port}`;
export const samePeer = (from, configured) => from.address === configured.host && from.port === configured.port;
export function boundedInteger(value, fallback, min, max, name) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Invalid ${name}`);
  return number;
}
export async function bindSocket(socket, bind) {
  await new Promise((resolve, reject) => {
    const failed = error => { socket.removeListener('listening', ready); reject(error); };
    const ready = () => { socket.removeListener('error', failed); resolve(); };
    socket.once('error', failed); socket.once('listening', ready); socket.bind(bind.port, bind.host);
  });
}
export function send(socket, data, to, onError = () => {}) {
  try { socket.send(data, to.port, to.address ?? to.host, error => { if (error) onError(error); }); }
  catch (error) { onError(error); }
}
export async function closeSocket(socket) { await new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }); }
