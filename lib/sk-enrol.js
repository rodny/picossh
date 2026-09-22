// Making a secure enclave SSH key (lib/sk-keys.js) is a WebAuthn registration:
// the credential's public key becomes the SSH public key, and the credential
// stays on the device that made it. Kept apart from sk-keys.js so that the
// store can use the key format without pulling in the WebAuthn library.
const crypto = require('crypto');
const { HttpError } = require('./store');
const { relyingParty } = require('./auth');
const { onCurve } = require('./sk-keys');

// `platform` keeps the credential on this device and `discouraged` asks for a
// device-bound one rather than a passkey synced through iCloud: the point of
// these keys is that the private half cannot leave the phone.
const CHALLENGE_TTL_MS = 2 * 60 * 1000;
let webauthn;
const lib = () => (webauthn ||= require('@simplewebauthn/server'));
const helpers = () => require('@simplewebauthn/server/helpers');

function createEnrolment({ store }) {
  const challenges = new Map(); // challenge -> expiry

  // Single use: the first verification attempt consumes it.
  const consume = (challenge) => {
    const expires = challenges.get(challenge);
    challenges.delete(challenge);
    return !!expires && expires >= Date.now();
  };

  return {
    async options(req) {
      const { rpID } = relyingParty(req, 'A Face ID key');
      const options = await lib().generateRegistrationOptions({
        rpName: 'picossh',
        rpID,
        userID: crypto.randomBytes(16),
        userName: 'picossh ssh key',
        userDisplayName: 'picossh ssh key',
        attestationType: 'none',
        // Only P-256: it is the one curve OpenSSH security keys use.
        supportedAlgorithmIDs: [-7],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'discouraged',
          userVerification: 'required',
        },
      });
      const now = Date.now();
      for (const [c, expires] of challenges) if (expires < now) challenges.delete(c);
      challenges.set(options.challenge, now + CHALLENGE_TTL_MS);
      return options;
    },

    async verify(req, body) {
      const { rpID, origin } = relyingParty(req, 'A Face ID key');
      let result;
      try {
        result = await lib().verifyRegistrationResponse({
          response: body && body.response,
          expectedChallenge: consume,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7],
        });
      } catch (err) {
        throw new HttpError(400, `Could not create the key: ${err.message}`);
      }
      if (!result.verified) throw new HttpError(400, 'Could not create the key: the device did not confirm it');

      const { credential } = result.registrationInfo;
      const point = Buffer.from(helpers().convertCOSEtoPKCS(credential.publicKey));
      // With no attestation, nothing has vouched for the point: one off the
      // curve would be saved, and every connection with it refused.
      if (!onCurve(point)) throw new HttpError(400, 'This device made a key picossh cannot use as an SSH key');
      return store.addEnclaveKey({
        name: body && body.name,
        credentialId: credential.id,
        point,
        rpID,
        origin,
        transports: credential.transports,
      });
    },
  };
}

module.exports = { createEnrolment };
