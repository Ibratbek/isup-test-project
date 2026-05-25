'use strict';

const net    = require('net');
const crypto = require('crypto');
const Redis  = require('ioredis');

const ENCRYPTION_KEY = process.env.ISUP_KEY || 'hrline1234';

const ISUP_PORT     = 7660;
const REDIS_HOST    = '127.0.0.1';
const REDIS_PORT    = 6379;
const EVENTS_CH     = 'hikvision:events';
const COMMANDS_CH   = 'hikvision:commands';
const RESPONSES_PFX = 'hikvision:responses:';

// -----------------------------------------------------------------------
// Hikvision ISUP Binary Protocol
//
// Paket format (reverse-engineered from device traffic):
//
//   Byte 0     : Komanda kategoriya (0x10 = auth/session)
//   Byte 1     : Komanda kodi      (0x52 = register req, 0x55 = keepalive req)
//   Byte 2-3   : Versiya           (0x01 0x01)
//   Byte 4+    : TLV fields
//
// TLV field format:
//   [2 bytes BE length][N bytes value]   — uzun string uchun
//   [1 byte  BE length][N bytes value]   — qisqa string uchun
//
// Ma'lum komandalar:
//   10 52 = Registration Request     → javob: 10 53
//   10 55 = Keepalive Request        → javob: 10 56
//   10 58 = Unregister Request       → javob: 10 59
//   10 5E = Alarm/Event notification → javob: 10 5F
// -----------------------------------------------------------------------

const CMD = {
  // EHome 2.0/4.0
  REG_REQ:       Buffer.from([0x10, 0x52]),
  REG_RSP:       Buffer.from([0x10, 0x53]),
  KEEPALIVE_REQ: Buffer.from([0x10, 0x55]),
  KEEPALIVE_RSP: Buffer.from([0x10, 0x56]),
  UNREG_REQ:     Buffer.from([0x10, 0x58]),
  UNREG_RSP:     Buffer.from([0x10, 0x59]),
  // ISUP 5.0
  REG_REQ_V5:    Buffer.from([0x10, 0x54]),
  REG_RSP_V5:    Buffer.from([0x10, 0x55]),
  KA_REQ_V5:     Buffer.from([0x10, 0x57]),
  KA_RSP_V5:     Buffer.from([0x10, 0x58]),
  // Alarm (shared)
  ALARM_REQ:     Buffer.from([0x10, 0x5E]),
  ALARM_RSP:     Buffer.from([0x10, 0x5F]),
};

// Paket minimum uzunligi: komanda (2) + versiya (2) = 4 bayt
const HDR_LEN = 4;

// -----------------------------------------------------------------------
// Build response packet
// -----------------------------------------------------------------------
function buildResponse(cmdBytes, version, statusCode, extraFields) {
  // Javob paketi: [cmd 2B][ver 2B][status 1B][extra...]
  const extra = extraFields || Buffer.alloc(0);
  const buf = Buffer.alloc(2 + 2 + 1 + extra.length);
  cmdBytes.copy(buf, 0);
  version.copy(buf, 2);
  buf[4] = statusCode; // 0x00 = OK
  extra.copy(buf, 5);
  return buf;
}

// Paket ichidan string qidirish (TLV traversal)
function extractStrings(data) {
  const strings = [];
  let i = 0;
  while (i < data.length) {
    // 2-byte length prefix
    if (i + 1 < data.length) {
      const len2 = data.readUInt16BE(i);
      if (len2 > 0 && len2 < 128 && i + 2 + len2 <= data.length) {
        const str = data.slice(i + 2, i + 2 + len2).toString('utf8');
        if (/^[\x20-\x7E]+$/.test(str)) {
          strings.push({ offset: i, len: len2, value: str, prefix: 2 });
          i += 2 + len2;
          continue;
        }
      }
    }
    // 1-byte length prefix
    const len1 = data[i];
    if (len1 > 0 && len1 < 128 && i + 1 + len1 <= data.length) {
      const str = data.slice(i + 1, i + 1 + len1).toString('utf8');
      if (/^[\x20-\x7E]+$/.test(str)) {
        strings.push({ offset: i, len: len1, value: str, prefix: 1 });
        i += 1 + len1;
        continue;
      }
    }
    i++;
  }
  return strings;
}

function ts() { return new Date().toISOString(); }

// Paketdan auth block ni ajratib olish (29 tag dan keyin: devId + auth bytes)
function extractAuthBlock(body) {
  for (let i = 0; i < body.length - 2; i++) {
    if (body[i] === 0x29) {
      const fieldLen = body[i + 1];
      if (i + 2 + fieldLen <= body.length) {
        const fieldData = body.slice(i + 2, i + 2 + fieldLen);
        const devIdLen  = fieldData[0];
        if (devIdLen + 1 < fieldData.length) {
          return fieldData.slice(devIdLen + 1); // auth bytes
        }
      }
    }
  }
  return null;
}

// Barcha mumkin bo'lgan auth algoritmlarini hisoblash (qaysi biri to'g'ri ekanligini topish uchun)
function computeAllAuths(authBlock) {
  const keyRaw     = Buffer.from(ENCRYPTION_KEY);
  const keyPadded  = Buffer.alloc(32); keyRaw.copy(keyPadded);          // "hrline1234\x00\x00..."
  const keySha256  = crypto.createHash('sha256').update(keyRaw).digest(); // SHA256("hrline1234")

  return {
    hmac_sha256_key_padded : crypto.createHmac('sha256', keyPadded).update(authBlock).digest(),
    hmac_sha256_key_raw    : crypto.createHmac('sha256', keyRaw).update(authBlock).digest(),
    hmac_sha256_key_sha256 : crypto.createHmac('sha256', keySha256).update(authBlock).digest(),
    sha256_key_plus_block  : crypto.createHash('sha256').update(Buffer.concat([keyPadded, authBlock])).digest(),
    sha256_block_plus_key  : crypto.createHash('sha256').update(Buffer.concat([authBlock, keyPadded])).digest(),
  };
}

// Hozircha eng ko'p ishlatiladigan: key zero-padded to 32
function computeServerAuth(authBlock) {
  const keyPadded = Buffer.alloc(32);
  Buffer.from(ENCRYPTION_KEY).copy(keyPadded);
  return crypto.createHmac('sha256', keyPadded).update(authBlock).digest();
}

// -----------------------------------------------------------------------
// Redis
// -----------------------------------------------------------------------
const pub = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true });
const sub = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true });

pub.on('error', e => console.error('[Redis] pub:', e.message));
sub.on('error', e => console.error('[Redis] sub:', e.message));

const deviceSockets = {};

// -----------------------------------------------------------------------
// TCP Server
// -----------------------------------------------------------------------
const server = net.createServer(socket => {
  const remote  = `${socket.remoteAddress}:${socket.remotePort}`;
  let deviceId  = null;
  let rxBuf     = Buffer.alloc(0);
  let seqNo     = 0;

  console.log(`\n[${ts()}] ► Yangi ulanish: ${remote}`);

  socket.on('data', chunk => {
    rxBuf = Buffer.concat([rxBuf, chunk]);
    processBuffer();
  });

  function processBuffer() {
    while (rxBuf.length >= HDR_LEN) {
      const cmd  = rxBuf.slice(0, 2);
      const ver  = rxBuf.slice(2, 4);
      const body = rxBuf.slice(HDR_LEN);

      // Debug: har bir paketning to'liq hex'ini ko'rsat
      console.log(`\n[${ts()}] RAW ← [${remote}]`);
      console.log(`  HEX: ${rxBuf.toString('hex')}`);
      console.log(`  CMD: ${cmd.toString('hex').toUpperCase()}  VER: ${ver.toString('hex')}`);

      const cmdHex = cmd.toString('hex');

      // -------- Registration (ISUP 5.0: 1054, EHome: 1052) --------
      if (cmdHex === '1054' || cmdHex === '1052') {
        const isV5    = cmdHex === '1054';
        const strings = extractStrings(body);
        console.log(`  Strings:`, strings.map(s => s.value));

        const serial = strings[0]?.value || '';
        const model  = strings[1]?.value || '';
        const devId  = strings[2]?.value || serial || remote;
        deviceId = devId;
        deviceSockets[devId] = socket;

        console.log(`  ✓ REGISTER (${isV5 ? 'ISUP 5.0' : 'EHome'}): id=${devId} model=${model} serial=${serial}`);

        // Server auth proof ni hisoblash
        const authBlock = extractAuthBlock(body);
        let extraFields = Buffer.alloc(0);
        if (authBlock && authBlock.length > 0) {
          const auths = computeAllAuths(authBlock);
          console.log(`  Auth block (${authBlock.length}B): ${authBlock.toString('hex')}`);
          Object.entries(auths).forEach(([k, v]) => console.log(`    ${k}: ${v.toString('hex')}`));

          const serverAuth = auths.hmac_sha256_key_padded; // << bu qatorni o'zgartiring
          extraFields = Buffer.concat([Buffer.from([0x29, serverAuth.length]), serverAuth]);
        }

        const rspCmd = isV5 ? CMD.REG_RSP_V5 : CMD.REG_RSP;
        const rsp    = buildResponse(rspCmd, ver, 0x00, extraFields);
        socket.write(rsp);
        console.log(`  ► RSP (${rsp.length}B): ${rsp.toString('hex').toUpperCase()}`);

        pub.publish(EVENTS_CH, JSON.stringify({
          type: 'device_online', deviceId: devId,
          ip: socket.remoteAddress, model, serial,
          timestamp: ts(),
        }));

        rxBuf = rxBuf.slice(rxBuf.length);
        return;
      }

      // -------- Keepalive ISUP 5.0 (10 57) --------
      if (cmdHex === '1057') {
        const rsp = buildResponse(CMD.KA_RSP_V5, ver, 0x00);
        socket.write(rsp);
        process.stdout.write(`♥`);
        rxBuf = rxBuf.slice(rxBuf.length);
        return;
      }

      // -------- Keepalive EHome (10 55) --------
      if (cmdHex === '1055') {
        const rsp = buildResponse(CMD.KEEPALIVE_RSP, ver, 0x00);
        socket.write(rsp);
        process.stdout.write(`♥`);
        rxBuf = rxBuf.slice(rxBuf.length);
        return;
      }

      // -------- Unregister (10 58 / 10 59) --------
      if (cmdHex === '1058' || cmdHex === '105a') {
        const rspCmd = cmdHex === '1058' ? CMD.UNREG_RSP : Buffer.from([0x10, 0x5B]);
        const rsp = buildResponse(rspCmd, ver, 0x00);
        socket.write(rsp);
        console.log(`  UNREGISTER: ${deviceId}`);
        rxBuf = rxBuf.slice(rxBuf.length);
        return;
      }

      // -------- Alarm / Event --------
      if (cmdHex === '105e') {
        const strings = extractStrings(body);
        console.log(`  ALARM strings:`, strings.map(s => s.value));

        const rsp = buildResponse(CMD.ALARM_RSP, ver, 0x00);
        socket.write(rsp);

        // Redis ga event publish
        const event = {
          type:     'alarm',
          deviceId: deviceId || remote,
          raw:      strings.map(s => s.value),
          timestamp: ts(),
        };
        pub.publish(EVENTS_CH, JSON.stringify(event));

        rxBuf = Buffer.alloc(0);
        return;
      }

      // -------- Noma'lum paket --------
      console.log(`  [?] Noma'lum CMD ${cmdHex}, body(${body.length}B):`, body.slice(0, 32).toString('hex'));
      rxBuf = Buffer.alloc(0);
      return;
    }
  }

  socket.on('close', () => {
    console.log(`\n[${ts()}] ✗ Ulanish yopildi: ${remote} (device=${deviceId})`);
    if (deviceId) {
      delete deviceSockets[deviceId];
      pub.publish(EVENTS_CH, JSON.stringify({
        type: 'device_offline', deviceId, timestamp: ts(),
      }));
    }
  });

  socket.on('error', err => {
    console.error(`[${ts()}] Socket xato (${remote}):`, err.message);
  });
});

// -----------------------------------------------------------------------
// Redis Commands → Device
// -----------------------------------------------------------------------
async function connectRedis() {
  await pub.connect();
  await sub.connect();
  await sub.subscribe(COMMANDS_CH);
  console.log(`[Redis] OK — pub/sub tayyor`);
}

sub.on('message', (channel, message) => {
  let cmd;
  try { cmd = JSON.parse(message); } catch { return; }

  const { commandId, command, deviceId, params } = cmd;
  const socket = deviceSockets[deviceId];

  if (!socket || socket.destroyed) {
    respond(commandId, false, `Device offline: ${deviceId}`);
    return;
  }

  console.log(`\n[${ts()}] ► Komanda: ${command} → ${deviceId}`);
  respond(commandId, false, `Command '${command}' TODO: protocol dokumentasiyasi kerak`);
});

function respond(commandId, success, message) {
  if (!commandId) return;
  pub.publish(RESPONSES_PFX + commandId, JSON.stringify({ commandId, success, message }));
}

// -----------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------
connectRedis().catch(e => console.error('[Redis] ulanish xato:', e.message));

server.listen(ISUP_PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════╗
║  Hikvision ISUP Bridge (Node.js)          ║
║  Port : ${ISUP_PORT}  │  Redis: ${REDIS_HOST}:${REDIS_PORT}  ║
║  Debug mode: barcha paketlar ko'rsatiladi ║
╚═══════════════════════════════════════════╝
Qurilma ulanishini kutmoqda...
`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n✗ Port ${ISUP_PORT} band! → lsof -i :${ISUP_PORT}`);
  } else {
    console.error('Server xato:', err.message);
  }
  process.exit(1);
});

process.on('SIGINT',  () => { console.log('\nTo\'xtatildi.'); server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
