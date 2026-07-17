import fetch from 'node-fetch';

const SLACK_TOKEN     = process.env.SLACK_TOKEN;
const FIREBASE_DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/$/, '');
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const SLACK_CHANNEL   = process.env.SLACK_CHANNEL || 'C0AQFCE263E';
const NOTIFICATION_ID = process.env.NOTIFICATION_ID;
const LANG            = process.env.LANG_INPUT    || 'pt-BR';
const BANCO           = process.env.BANCO      || '';
const AGENTE          = process.env.AGENTE     || '';
const DIA_INICIAL     = process.env.DIA_INICIAL || '';
const DIA_FINAL       = process.env.DIA_FINAL   || '';

const DEFAULT_CHANNEL = 'C0AQFCE263E';
const ERROR_CHANNEL   = 'C0A8PNUADDL';
const CHANNEL_ERRORS  = new Set(['channel_not_found', 'invalid_channel', 'no_permission', 'channel_not_found_for_team_in_scope']);

const ERROR_MSGS = {
  'pt-BR': `Não foi possível reportar -aguardando extrato- do cronograma -accounts- porque o ID do canal Slack preenchido é inválido.`,
  'en':    `Could not report -waiting for statement- from schedule -accounts- because the Slack channel ID is invalid.`,
  'es':    `No fue posible reportar -esperando extracto- del cronograma -accounts- porque el ID del canal Slack ingresado es inválido.`,
};

const MSGS = {
  'pt-BR': DIA_INICIAL === DIA_FINAL
    ? `Olá equipe, Accounts solicita os extratos de *${BANCO}* do agente *${AGENTE}* do dia *${DIA_INICIAL}*, podem nos enviar assim que possível por favor?`
    : `Olá equipe, Accounts solicita os extratos de *${BANCO}* do agente *${AGENTE}* dos dias *${DIA_INICIAL}* até *${DIA_FINAL}*, podem nos enviar assim que possível por favor?`,
  'en': DIA_INICIAL === DIA_FINAL
    ? `Hello team, Accounts is requesting the statements for *${BANCO}* from agent *${AGENTE}* for *${DIA_INICIAL}*, could you send them as soon as possible?`
    : `Hello team, Accounts is requesting the statements for *${BANCO}* from agent *${AGENTE}* from *${DIA_INICIAL}* to *${DIA_FINAL}*, could you send them as soon as possible?`,
  'es': DIA_INICIAL === DIA_FINAL
    ? `Hola equipo, Accounts solicita los extractos de *${BANCO}* del agente *${AGENTE}* del día *${DIA_INICIAL}*, ¿pueden enviárnoslos a la brevedad posible?`
    : `Hola equipo, Accounts solicita los extractos de *${BANCO}* del agente *${AGENTE}* de los días *${DIA_INICIAL}* hasta *${DIA_FINAL}*, ¿pueden enviárnoslos a la brevedad posible?`,
};

const text = MSGS[LANG] || MSGS['pt-BR'];

async function sendErrorNotification() {
  const errText = ERROR_MSGS[LANG] || ERROR_MSGS['pt-BR'];
  console.error(`Channel error — reporting to ${ERROR_CHANNEL}: ${errText}`);
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: ERROR_CHANNEL, text: errText }),
    });
  } catch (e) {
    console.error('Failed to send error notification:', e.message);
  }
}

async function run() {
  if (!SLACK_TOKEN)                             throw new Error('SLACK_TOKEN not set');
  if (!FIREBASE_DB_URL || !FIREBASE_SECRET)     throw new Error('Firebase credentials not set');
  if (!NOTIFICATION_ID)                         throw new Error('NOTIFICATION_ID not set');

  console.log(`Sending [${LANG}] to ${SLACK_CHANNEL}: ${text}`);

  // 1. Post message to Slack
  const postRes  = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: SLACK_CHANNEL, text }),
  });
  const postData = await postRes.json();
  console.log('postMessage:', JSON.stringify(postData));
  if (!postData.ok) {
    if (CHANNEL_ERRORS.has(postData.error) && SLACK_CHANNEL !== DEFAULT_CHANNEL) {
      await sendErrorNotification();
    }
    throw new Error(`Slack postMessage failed: ${postData.error}`);
  }

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
