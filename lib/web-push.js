// lib/web-push.js — minimal Web Push (RFC 8030 + RFC 8291 aes128gcm + VAPID).
//
// Why hand-rolled? The official `web-push` npm package would add a 200kb tree
// of dependencies, and the spec is well-defined enough that 150 lines of
// crypto suffice. All primitives we need (ECDH, HKDF, AES-GCM, JWT-ES256)
// are in node:crypto.
//
// Public API:
//   generateVapidKeys()                       -> { publicKey, privateKey }  (base64url)
//   sendPush(subscription, payload, opts)     -> Promise<{ok, status, body?}>
//     subscription = { endpoint, keys: { p256dh, auth } }  (browser PushSubscription.toJSON())
//     payload      = string  (we always send JSON)
//     opts.vapidPublic, opts.vapidPrivate, opts.contact = 'mailto:you@example.com'

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { URL } = require('url');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const x = b64urlDecode(pubJwk.x);
  const y = b64urlDecode(pubJwk.y);
  return {
    publicKey: b64urlEncode(Buffer.concat([Buffer.from([0x04]), x, y])),
    privateKey: b64urlEncode(b64urlDecode(privJwk.d))
  };
}

// Build a KeyObject (private) from raw 32-byte d.
function vapidPrivateKeyFromRaw(rawPriv) {
  // Reconstruct an EC private key in PKCS8 form. Easier path: use jwk import.
  // We need the public x/y too — derive from d.
  // Trick: import as JWK with only d? Not allowed. Use createPrivateKey on PEM built from DER? Heavy.
  // Easiest reliable path: import via JWK with d AND derived x/y.
  const d = rawPriv;
  // To get x/y we need scalar multiplication — easiest is to create a KeyObject from "raw private + public" via ASN.1.
  // Use Node's EC SEC1 DER format:
  //  SEQUENCE { INTEGER 1, OCTET STRING d (32B), [0] OID secp256r1, [1] BIT STRING uncompressed-public }
  // But we don't have public point. Workaround: do d*G via crypto.diffieHellman? No.
  // Cleanest: use createPrivateKey with jwk that has d + x + y. Compute x,y via ECDH:
  const tmpEcdh = crypto.createECDH('prime256v1');
  tmpEcdh.setPrivateKey(d);
  const pub = tmpEcdh.getPublicKey(); // 65 bytes uncompressed
  const x = pub.subarray(1, 33);
  const y = pub.subarray(33, 65);
  return crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64urlEncode(d), x: b64urlEncode(x), y: b64urlEncode(y) },
    format: 'jwk'
  });
}

function vapidPublicKeyFromRaw(rawPub65) {
  // rawPub65 = 0x04 || x || y
  if (rawPub65.length !== 65 || rawPub65[0] !== 0x04) throw new Error('bad VAPID public key');
  const x = rawPub65.subarray(1, 33);
  const y = rawPub65.subarray(33, 65);
  return crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y) },
    format: 'jwk'
  });
}

function signVapidJwt(endpoint, vapidPublicB64, vapidPrivateB64, contact) {
  const url = new URL(endpoint);
  const aud = url.origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12h
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: contact || 'mailto:admin@localhost' };
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${h}.${p}`;

  const privKey = vapidPrivateKeyFromRaw(b64urlDecode(vapidPrivateB64));
  const der = crypto.createSign('SHA256').update(signingInput).sign(privKey);
  // DER → raw r||s (64 bytes for ES256)
  const raw = derToRawSignature(der, 32);
  return `${signingInput}.${b64urlEncode(raw)}`;
}

function derToRawSignature(der, partLen) {
  // DER: 0x30 len 0x02 rLen r 0x02 sLen s
  let idx = 2; // skip 0x30 + length
  if (der[1] & 0x80) idx += der[1] & 0x7f; // long form length
  if (der[idx++] !== 0x02) throw new Error('bad DER');
  let rLen = der[idx++];
  let r = der.subarray(idx, idx + rLen); idx += rLen;
  if (der[idx++] !== 0x02) throw new Error('bad DER');
  let sLen = der[idx++];
  let s = der.subarray(idx, idx + sLen);
  // strip leading zeros, pad to partLen
  r = r[0] === 0x00 ? r.subarray(1) : r;
  s = s[0] === 0x00 ? s.subarray(1) : s;
  const pad = (buf) => Buffer.concat([Buffer.alloc(partLen - buf.length, 0), buf]);
  return Buffer.concat([pad(r), pad(s)]);
}

// HKDF (RFC 5869) using SHA-256
function hkdf(salt, ikm, info, length) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  let t = Buffer.alloc(0);
  let okm = Buffer.alloc(0);
  let counter = 1;
  while (okm.length < length) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([counter])])).digest();
    okm = Buffer.concat([okm, t]);
    counter++;
  }
  return okm.subarray(0, length);
}

// aes128gcm content-encoding per RFC 8291 §3 / RFC 8188.
function encryptPayloadAes128Gcm(payload, p256dhB64, authB64) {
  const userAgentPub = b64urlDecode(p256dhB64); // 65 bytes
  const authSecret = b64urlDecode(authB64);     // 16 bytes

  // Generate ephemeral application server key pair
  const appEcdh = crypto.createECDH('prime256v1');
  appEcdh.generateKeys();
  const appPub = appEcdh.getPublicKey(); // 65 bytes uncompressed

  // ECDH shared secret
  const sharedSecret = appEcdh.computeSecret(userAgentPub);

  // Salt (16 random bytes)
  const salt = crypto.randomBytes(16);

  // PRK_key = HKDF(auth, ECDH, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    userAgentPub,
    appPub
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  // CEK = HKDF(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  // NONCE = HKDF(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // Plaintext + 0x02 padding delimiter
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([0x02])]);

  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const body = Buffer.concat([ct, tag]);

  // Header: salt(16) || rs(4, big-endian) || idlen(1) || keyid(idlen bytes)
  // keyid = app server public key (65 bytes)
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([appPub.length]), appPub]);

  return Buffer.concat([header, body]);
}

function sendPush(subscription, payload, opts = {}) {
  return new Promise((resolve) => {
    try {
      if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return resolve({ ok: false, status: 0, body: 'bad-subscription' });
      }
      if (!opts.vapidPublic || !opts.vapidPrivate) {
        return resolve({ ok: false, status: 0, body: 'no-vapid-keys' });
      }

      const body = encryptPayloadAes128Gcm(String(payload), subscription.keys.p256dh, subscription.keys.auth);
      const jwt = signVapidJwt(subscription.endpoint, opts.vapidPublic, opts.vapidPrivate, opts.contact);

      const url = new URL(subscription.endpoint);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'Content-Length': body.length,
        'TTL': String(opts.ttl || 86400),
        'Authorization': `vapid t=${jwt}, k=${opts.vapidPublic}`,
        'Urgency': opts.urgency || 'normal'
      };
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request({
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        headers
      }, (res) => {
        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const respBody = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: respBody });
        });
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, body: String(e?.message || e) }));
      req.setTimeout(10000, () => { try { req.destroy(); } catch (_) {} resolve({ ok: false, status: 0, body: 'timeout' }); });
      req.write(body);
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, body: String(e?.message || e) });
    }
  });
}

module.exports = { generateVapidKeys, sendPush };
