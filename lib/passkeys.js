// Face ID / Touch ID sign-in with WebAuthn platform passkeys. Enrolment needs
// an existing session; a verified assertion issues the same cookie as the
// password login. The RP ID is the hostname the browser used, so passkeys only
// work on the HTTPS hostname they were enrolled on (not on http://nas:port).
const path = require('path');
const crypto = require('crypto');
const { HttpError, writeJsonAtomic, readJson } = require('./store');
const { relyingParty } = require('./auth');

const CHALLENGE_TTL_MS = 2 * 60 * 1000;

// Required lazily: loading the library prints Web Crypto experimental warnings,
// which is noise for anyone who never enables Face ID.
let webauthn;
const lib = () => (webauthn ||= require('@simplewebauthn/server'));

function createPasskeys({ dataDir }) {
  const file = path.join(dataDir, 'passkeys.json');
  const data = readJson(file, { userId: null, credentials: [] });
  if (!data.userId) {
    data.userId = crypto.randomBytes(16).toString('base64url');
    // Written with the first credential, so an unused install leaves no file.
  }
  const save = () => writeJsonAtomic(file, data);
  const challenges = new Map(); // challenge -> { type, expires }

  function remember(type, challenge) {
    const now = Date.now();
    for (const [c, v] of challenges) if (v.expires < now) challenges.delete(c);
    challenges.set(challenge, { type, expires: now + CHALLENGE_TTL_MS });
  }

  // Single use: a challenge is consumed by the first verification attempt.
  const consume = (type) => (challenge) => {
    const entry = challenges.get(challenge);
    challenges.delete(challenge);
    return !!entry && entry.type === type && entry.expires >= Date.now();
  };

  const summary = ({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt });

  return {
    count: () => data.credentials.length,
    list: () => data.credentials.map(summary),

    remove(id) {
      const index = data.credentials.findIndex((c) => c.id === id);
      if (index < 0) throw new HttpError(404, 'Passkey not found');
      data.credentials.splice(index, 1);
      save();
    },

    async registrationOptions(req) {
      const { rpID } = relyingParty(req);
      const options = await lib().generateRegistrationOptions({
        rpName: 'picossh',
        rpID,
        userID: Buffer.from(data.userId, 'base64url'),
        userName: 'picossh',
        userDisplayName: 'picossh',
        attestationType: 'none',
        excludeCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'preferred',
          userVerification: 'required',
        },
      });
      remember('register', options.challenge);
      return options;
    },

    async verifyRegistration(req, body) {
      const { rpID, origin } = relyingParty(req);
      let result;
      try {
        result = await lib().verifyRegistrationResponse({
          response: body && body.response,
          expectedChallenge: consume('register'),
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch (err) {
        throw new HttpError(400, `Face ID enrolment failed: ${err.message}`);
      }
      if (!result.verified) throw new HttpError(400, 'Face ID enrolment could not be verified');

      const { credential } = result.registrationInfo;
      const name = String((body && body.name) || '').trim().slice(0, 60) || 'Passkey';
      data.credentials = data.credentials.filter((c) => c.id !== credential.id);
      data.credentials.push({
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports || [],
        name,
        createdAt: new Date().toISOString(),
      });
      save();
      return summary(data.credentials[data.credentials.length - 1]);
    },

    async authenticationOptions(req) {
      const { rpID } = relyingParty(req);
      if (!data.credentials.length) throw new HttpError(404, 'No passkeys enrolled');
      const options = await lib().generateAuthenticationOptions({
        rpID,
        userVerification: 'required',
        allowCredentials: data.credentials.map((c) => ({ id: c.id, transports: c.transports })),
      });
      remember('login', options.challenge);
      return options;
    },

    // Resolves true when the assertion is valid; throws otherwise.
    async verifyAuthentication(req, body) {
      const { rpID, origin } = relyingParty(req);
      const response = body && body.response;
      const stored = response && data.credentials.find((c) => c.id === response.id);
      if (!stored) throw new HttpError(400, 'This passkey is not enrolled here (it may have been removed)');
      let result;
      try {
        result = await lib().verifyAuthenticationResponse({
          response,
          expectedChallenge: consume('login'),
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, 'base64url'),
            counter: stored.counter,
            transports: stored.transports,
          },
        });
      } catch (err) {
        throw new HttpError(400, `Face ID sign-in failed: ${err.message}`);
      }
      if (!result.verified) throw new HttpError(400, 'Face ID sign-in could not be verified');
      stored.counter = result.authenticationInfo.newCounter;
      stored.lastUsedAt = new Date().toISOString();
      save();
      return true;
    },
  };
}

module.exports = { createPasskeys };
