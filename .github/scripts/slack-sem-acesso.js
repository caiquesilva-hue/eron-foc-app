import fetch from 'node-fetch';

const SLACK_TOKEN    = process.env.SLACK_TOKEN;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const SLACK_CHANNEL  = process.env.SLACK_CHANNEL || 'C0AQFCE263E';
const NOTIFICATION_ID = process.env.NOTIFICATION_ID;
const LANG   = process.env.LANG_INPUT  || 'pt-BR';
const MODULE = process.env.MODULE      || 'accounts';
const BANCO  = process.env.BANCO       || '';
const AGENTE = process.env.AGENTE      || '';
const ENV_LABEL = process.env.ENV_LABEL || 'Eron';

const MSGS = {
  'pt-BR': {
    accounts:      `Olá equipe, informo que *Accounts* não conseguiu acessar a conta *${BANCO}* do agente *${AGENTE}*, podem verificar por favor?`,
    conciliacoes:  `Olá equipe, informo que *Conciliações* não conseguiu acessar a conta *${BANCO}* do agente *${AGENTE}*, podem verificar por favor?`,
  },
  'en': {
    accounts:     `Hello team, Accounts couldn't access account *${BANCO}* from agent *${AGENTE}*, could you please check?`,
    conciliacoes: `Hello team, Reconciliations couldn't access account *${BANCO}* from agent *${AGENTE}*, could you please check?`,
  },
  'es': {
    accounts:     `Hola equipo, les informo que *Accounts* no pudo acceder a la cuenta *${BANCO}* del agente *${AGENTE}*, ¿pueden verificar por favor?`,
    conciliacoes: `Hola equipo, les informo que *Conciliaciones* no pudo acceder a la cuenta *${BANCO}* del agente *${AGENTE}*, ¿pueden verificar por favor?`,
  },
};

const text = (MSGS[LANG] || MSGS['pt-BR'])[MODULE] || MSGS['pt-BR']['accounts'];

async function run() {
  if (!SLACK_TOKEN)           throw new Error('SLACK_TOKEN not set');
  if (!FIREBASE_DB_URL || !FIREBASE_SECRET) throw new Error('Firebase credentials not set');
  if (!NOTIFICATION_ID)       throw new Error('NOTIFICATION_ID not set');

  console.log(`Sending [${LANG}/${MODULE}] to ${SLACK_CHANNEL}: ${text}`);

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

  // 3. Write permalink to Eron Firebase (notification bus) so the browser can poll for it
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
