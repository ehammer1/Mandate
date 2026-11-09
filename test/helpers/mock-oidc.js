// A minimal OpenID Connect provider for tests: discovery, authorize (auto-approves the
// configured user), token (checks PKCE and client secret), JWKS, RS256-signed ID tokens.
'use strict';

const http = require('http');
const crypto = require('crypto');

async function createMockOidc({ clientId, clientSecret }) {
  const { generateKeyPair, exportJWK, SignJWT } = await import('jose');
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map();
  let user = { sub: 'user-1', email_verified: true };
  let issuer;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, issuer);
    const json = (o, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      });
    }
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId) return json({ error: 'invalid_client' }, 400);
      const code = crypto.randomBytes(16).toString('hex');
      codes.set(code, { nonce: q.get('nonce'), redirect: q.get('redirect_uri'), challenge: q.get('code_challenge'), user: { ...user } });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      const f = new URLSearchParams(body);
      const entry = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!entry || f.get('client_id') !== clientId || f.get('client_secret') !== clientSecret) return json({ error: 'invalid_grant' }, 400);
      const challenge = crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url');
      if (challenge !== entry.challenge || f.get('redirect_uri') !== entry.redirect) return json({ error: 'invalid_grant' }, 400);
      const { sub, ...claims } = entry.user;
      const idToken = await new SignJWT({ ...claims, nonce: entry.nonce })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer).setAudience(clientId).setSubject(sub).setIssuedAt().setExpirationTime('5m')
        .sign(privateKey);
      return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}`;
  return { server, issuer: () => issuer, setUser: (u) => { user = u; } };
}

module.exports = { createMockOidc };
