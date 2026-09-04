import crypto from 'node:crypto';
import fetch from 'node-fetch';

// Troca a chave de uma service account por um access_token OAuth2 (fluxo
// JWT-bearer, sem SDK nenhum — mesma técnica usada no Apps Script e no
// credential_sync.py do robô). Substitui o antigo "?auth=<database secret>"
// (mecanismo legado do Realtime Database que parou de funcionar em
// 2026-09-03 — provavelmente descontinuado pelo Firebase) por Bearer token,
// que é a forma atual e suportada de autenticar como admin no RTDB.
function _b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function getFirebaseAccessToken(saJson, scopes = [
  'https://www.googleapis.com/auth/firebase.database',
  'https://www.googleapis.com/auth/userinfo.email',
]) {
  const sa = typeof saJson === 'string' ? JSON.parse(saJson) : saJson;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const toSign = `${_b64url(JSON.stringify(header))}.${_b64url(JSON.stringify(claim))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(toSign);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const jwt = `${toSign}.${_b64url(signature)}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const json = await resp.json();
  if (!json.access_token) throw new Error(`Falha ao obter access_token: ${JSON.stringify(json)}`);
  return json.access_token;
}
