import fetch from 'node-fetch';

const SLACK_TOKEN     = process.env.SLACK_TOKEN;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const SLACK_CHANNEL   = process.env.SLACK_CHANNEL || 'C01JS1GSR24';
const NOTIFICATION_ID = process.env.NOTIFICATION_ID;
const BANCO           = process.env.BANCO      || '';
const AGENTE          = process.env.AGENTE     || '';
const DIA_INICIAL     = process.env.DIA_INICIAL || '';
const DIA_FINAL       = process.env.DIA_FINAL   || '';

const text = `Olá equipe, Accounts solicita os extratos de *${BANCO}* do agente *${AGENTE}* dos dias *${DIA_INICIAL}* até *${DIA_FINAL}*, podem nos enviar assim que possível por favor?`;

async function run() {
  if (!SLACK_TOKEN)                             throw new Error('SLACK_TOKEN not set');
  if (!FIREBASE_DB_URL || !FIREBASE_SECRET)     throw new Error('Firebase credentials not set');
  if (!NOTIFICATION_ID)                         throw new Error('NOTIFICATION_ID not set');

  console.log(`Sending to ${SLACK_CHANNEL}: ${text}`);

  // 1. Post message to Slack
  const postRes  = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
  const postData = await postRes.json();
  console.log('postMessage:', JSON.stringify(postData));
  if (!postData.ok) throw new Error(`Slack postMessage failed: ${postData.error}`);

  // 2. Retrieve permalink
  const plUrl = `https://slack.com/api/chat.getPermalink?channel=${encodeURIComponent(postData.channel)}&message_ts=${encodeURIComponent(postData.ts)}`;
  const plRes  = await fetch(plUrl, { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } });
  const plData = await plRes.json();
  console.log('getPermalink:', JSON.stringify(plData));
  if (!plData.ok || !plData.permalink) throw new Error(`getPermalink failed: ${plData.error}`);

  // 3. Write permalink to Firebase so the browser can poll for it
  const fbUrl = `${FIREBASE_DB_URL}/slackLinks/${NOTIFICATION_ID}.json?auth=${FIREBASE_SECRET}`;
  const fbRes = await fetch(fbUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(plData.permalink),
  });
  if (!fbRes.ok) throw new Error(`Firebase write failed: ${fbRes.status} ${await fbRes.text()}`);

  console.log(`Done! Permalink: ${plData.permalink}`);
}

run().catch(e => { console.error(e.message); process.exit(1); });
