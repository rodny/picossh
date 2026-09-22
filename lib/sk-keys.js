// SSH keys held in a phone's secure enclave. The browser's WebAuthn credential
// (Face ID, Touch ID, Windows Hello) *is* the SSH key: OpenSSH calls these
// security keys, type sk-ecdsa-sha2-nistp256@openssh.com, and accepts
// signatures made by a web browser under the name
// webauthn-sk-ecdsa-sha2-nistp256@openssh.com (OpenSSH 8.4 and later).
//
// A webauthn signature is not over the SSH data itself: the authenticator signs
// `authenticatorData || SHA256(clientDataJSON)`, and the data we wanted signed
// only appears as the challenge inside clientDataJSON. The server rebuilds that
// same message, which works because
//   authenticatorData = SHA256(rp id) || flags || counter || extensions
// and the server hashes the key's "application" field in place of the rp id.
// So the application of these keys must be the exact hostname the app is
// served from, and a key stops working if that hostname changes.
//
// No private key exists here or on the phone's disk: the enclave signs, and
// every connection needs a face or a fingerprint.
const crypto = require('crypto');
const { BaseAgent, utils: sshUtils } = require('ssh2');
// ssh2 keeps the packet writer to itself, so this reaches inside it (ssh2 1.x).
// Looked up here rather than while connecting, so that an ssh2 which moved it
// breaks Face ID keys alone and not the app.
let sendPacket = null;
try {
  ({ sendPacket } = require('ssh2/lib/protocol/utils.js'));
} catch {}

// The public key type that goes in authorized_keys, and the signature
// algorithm the browser's assertion is sent under.
const KEY_TYPE = 'sk-ecdsa-sha2-nistp256@openssh.com';
const SIG_ALGO = 'webauthn-sk-ecdsa-sha2-nistp256@openssh.com';
// Authenticator data flags: user present, user verified (a face, not just a
// tap), attested credential data, extension data.
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AD = 0x40;
const FLAG_ED = 0x80;
const USERAUTH_REQUEST = 50;

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

// An SSH "string": four length bytes, then the bytes.
const str = (value) => {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([u32(buf.length), buf]);
};

// An SSH "mpint": a positive number, shortest form, with a leading zero byte
// when the top bit would otherwise make it negative.
function mpint(bytes) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const value = bytes.subarray(start);
  return str(value[0] & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

// The two integers of an ECDSA signature, which WebAuthn gives as ASN.1 DER.
function derToRS(der) {
  const fail = () => new Error('the authenticator returned a malformed signature');
  if (der.length < 8 || der[0] !== 0x30) throw fail();
  let p = der[1] & 0x80 ? 2 + (der[1] & 0x7f) : 2;
  const next = () => {
    if (der[p] !== 0x02) throw fail();
    const len = der[p + 1];
    if (len & 0x80 || p + 2 + len > der.length) throw fail(); // r and s are short
    const value = der.subarray(p + 2, p + 2 + len);
    p += 2 + len;
    return value;
  };
  const r = next();
  const s = next();
  if (p !== der.length) throw fail();
  return [r, s];
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

// One line for authorized_keys. `application` is the rp id the credential was
// made for; the server hashes it as the rp id when it checks a signature.
function publicKeyBlob({ point, application }) {
  return Buffer.concat([str(KEY_TYPE), str('nistp256'), str(point), str(application)]);
}

const publicLine = ({ point, application, name }) =>
  `${KEY_TYPE} ${publicKeyBlob({ point, application }).toString('base64')}${name ? ` ${name}` : ''}`;

// The parts of an assertion we need, as buffers.
const fromB64 = (value, what) => {
  const buf = Buffer.from(String(value || ''), 'base64url');
  if (!buf.length) throw new Error(`the browser sent no ${what}`);
  return buf;
};

// Turns the browser's credential into an SSH signature blob for `data`.
// Everything the server checks is checked here too, so a mismatch is reported
// as itself instead of as a plain authentication failure.
function signatureBlob({ credential, data, application }) {
  const response = (credential && credential.response) || {};
  const authData = fromB64(response.authenticatorData, 'authenticator data');
  const clientData = fromB64(response.clientDataJSON, 'client data');
  const der = fromB64(response.signature, 'signature');
  if (authData.length < 37) throw new Error('the authenticator returned truncated data');

  const flags = authData[32];
  const counter = authData.readUInt32BE(33);
  const extensions = authData.subarray(37);
  if (!authData.subarray(0, 32).equals(sha256(application))) {
    throw new Error(`This key belongs to ${application}. Open picossh on that address to use it.`);
  }
  if (!(flags & FLAG_UP)) throw new Error('the authenticator was not used by anyone present');
  if (!(flags & FLAG_UV)) throw new Error('Face ID (or a PIN) did not confirm it was you');
  // Both would make the server reject the signature as malformed.
  if (flags & FLAG_AD) throw new Error('the authenticator returned credential data in an assertion');
  if (!(flags & FLAG_ED) !== !extensions.length) throw new Error('the authenticator returned inconsistent extension data');

  // The server looks for this exact preamble, so the browser's origin and
  // challenge must sit where it expects them.
  let origin;
  try {
    origin = JSON.parse(clientData.toString('utf8')).origin;
  } catch {
    throw new Error('the browser sent client data that is not JSON');
  }
  const preamble = `{"type":"webauthn.get","challenge":"${b64url(data)}","origin":"${origin}"`;
  if (typeof origin !== 'string' || origin.includes('"') || !clientData.subarray(0, preamble.length).equals(Buffer.from(preamble))) {
    throw new Error('the browser signed something other than this connection');
  }

  const [r, s] = derToRS(der);
  return Buffer.concat([
    str(SIG_ALGO),
    str(Buffer.concat([mpint(r), mpint(s)])),
    Buffer.from([flags]),
    u32(counter),
    str(origin),
    str(clientData),
    str(extensions),
  ]);
}

// ssh2 has no security keys: it cannot parse the public key, and it writes
// signatures as `string algorithm, string signature`, while a webauthn
// signature carries the flags, counter, origin and client data after the
// signature. Both are worked around below, around an otherwise stock ssh2.

// An uncompressed P-256 point (0x04, x, y) that is on the curve. ssh2's own
// parser takes any 65 bytes, so this asks OpenSSL.
function onCurve(point) {
  if (!Buffer.isBuffer(point) || point.length !== 65 || point[0] !== 4) return false;
  try {
    const jwk = { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') };
    crypto.createPublicKey({ key: jwk, format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

// Something ssh2 accepts as an already-parsed key. It only ever asks these for
// the key blob and its algorithm name; the prototype is the same public point
// parsed as a plain ECDSA key, to pass ssh2's own "is this a parsed key?"
// check. A point off the curve is refused first: ssh2 would take it, and the
// SSH server refuse every signature made for it.
function parsedKeyFor({ point, application }) {
  if (!onCurve(point)) throw new Error('this key is not a usable P-256 public key: not a point on the curve');
  const blob = publicKeyBlob({ point, application });
  const plain = Buffer.concat([str('ecdsa-sha2-nistp256'), str('nistp256'), str(point)]);
  const sample = sshUtils.parseKey(`ecdsa-sha2-nistp256 ${plain.toString('base64')}`);
  if (sample instanceof Error) throw new Error(`this key is not a usable P-256 public key: ${sample.message}`);
  return Object.create(sample, {
    type: { value: SIG_ALGO },
    getPublicSSH: { value: () => blob },
    isPrivateKey: { value: () => false },
    equals: { value: (other) => Buffer.isBuffer(other) && other.equals(blob) },
    comment: { value: '' },
  });
}

// An agent is the only place ssh2 lets a signature be made asynchronously,
// which is what asking a phone for a face amounts to. `sign(data)` resolves
// with the browser's assertion.
class EnclaveAgent extends BaseAgent {
  constructor({ point, application, sign }) {
    super();
    this.key = parsedKeyFor({ point, application });
    this.application = application;
    this.signWithBrowser = sign;
  }

  getIdentities(cb) {
    cb(null, [this.key]);
  }

  sign(pubKey, data, options, cb) {
    this.signWithBrowser(data)
      .then((credential) => cb(null, signatureBlob({ credential, data, application: this.application })))
      .catch(cb);
  }
}

// Replaces the connection's public key authentication with one that speaks the
// webauthn signature format. ssh2's own version would mangle the signature and
// cannot write the key blob, so this sends the two USERAUTH_REQUEST packets
// itself: the offer, then the signed request.
function useWebauthnAuth(client) {
  if (!sendPacket) throw new Error('this version of ssh2 cannot send a webauthn signature');
  const proto = client._protocol;

  const send = (payload) => {
    const packet = proto._packetRW.write.alloc(payload.length);
    packet.set(payload, proto._packetRW.write.allocStart);
    proto._authsQueue.push('publickey');
    sendPacket(proto, proto._packetRW.write.finalize(packet));
  };

  proto.authPK = (username, pubKey, keyAlgo, cbSign) => {
    const request = (signed) => Buffer.concat([
      Buffer.from([USERAUTH_REQUEST]),
      str(username), str('ssh-connection'), str('publickey'),
      Buffer.from([signed ? 1 : 0]), str(SIG_ALGO), str(pubKey.getPublicSSH()),
    ]);
    if (!cbSign) return send(request(false));
    // What is signed is the session id and the request about to be sent.
    cbSign(Buffer.concat([str(proto._kex.sessionID), request(true)]), (signature) => {
      send(Buffer.concat([request(true), str(signature)]));
    });
  };
}

module.exports = { KEY_TYPE, SIG_ALGO, onCurve, publicKeyBlob, publicLine, signatureBlob, EnclaveAgent, useWebauthnAuth };
