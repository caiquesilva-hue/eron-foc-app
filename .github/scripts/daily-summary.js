import fetch from 'node-fetch';

// ─── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'C0BH1SG3EUS';

// Override para testes manuais: força o dia de referência (D-1) como dia da semana
// 1=seg, 2=ter, 3=qua, 4=qui, 5=sex
const OVERRIDE_DAY = process.env.OVERRIDE_DAY ? parseInt(process.env.OVERRIDE_DAY, 10) : null;

// ─── Schedule: baseado no dia de D-1 (ontem) ──────────────────────────────────
const SCHEDULE = {
  1: { freqs: ['T1', 'Diário'],      label: 'Segunda' },
  2: { freqs: ['T2', 'Diário'],      label: 'Terça'   },
  3: { freqs: ['TOP 10', 'TOP 20'],  label: 'Quarta'  },
  4: { freqs: ['T1', 'Diário'],      label: 'Quinta'  },
  5: { freqs: ['T2', 'Diário'],      label: 'Sexta'   },
};

const DAY_NAMES_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Deve espelhar os labels do app (t('d1-concluida') etc.)
const STATUS_LBL = {
  concluido:          'Concluída',
  sem_movimento:      'Sem Movimento',
  sem_acesso:         'Sem Acesso',
  aguardando_extrato: 'Ag. Extrato',
  pendente:           'Pendente',
};

const STATUS_EMOJI = {
  concluido:          ':white_check_mark:',
  sem_movimento:      ':large_yellow_circle:',
  sem_acesso:         ':no_entry:',
  aguardando_extrato: ':hourglass_flowing_sand:',
  pendente:           ':white_circle:',
};

// ─── Helpers ────────────────────────────────────────────────────────────────────
function nowBRT() {
  const now = new Date();
  return new Date(now.getTime() - 3 * 60 * 60 * 1000);
}

function addDays(d, n) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}


function csvEscape(v) {
  const s = String(v ?? '');
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function buildCSV(rows) {
  // BOM UTF-8 para Excel abrir corretamente (igual ao app)
  return '﻿' + rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}

// ─── Firebase ───────────────────────────────────────────────────────────────────
async function fetchStore() {
  if (!FIREBASE_DB_URL) throw new Error('FIREBASE_DB_URL não configurado');
  let url = `${FIREBASE_DB_URL}/store.json`;
  if (FIREBASE_SECRET) url += `?auth=${FIREBASE_SECRET}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const today = nowBRT();                    // hoje em BRT — define o schedule e a label
  const d1 = addDays(today, -1);             // D-1 = ontem — data dos status no relatório
  const d1Str = fmtDate(d1);
  const todayStr = fmtDate(today);
  const todayDowRaw = today.getUTCDay();     // 0=dom

  const todayDow = OVERRIDE_DAY ?? (todayDowRaw === 0 || todayDowRaw === 6 ? null : todayDowRaw);

  if (!todayDow || !SCHEDULE[todayDow]) {
    console.log(`Hoje é fim de semana ou não previsto (${DAY_NAMES_PT[todayDowRaw]}). Nada enviado.`);
    return;
  }

  const { freqs, label } = SCHEDULE[todayDow];
  console.log(`Hoje: ${label} ${todayStr} | Frequências: ${freqs.join(', ')} | Status de D-1: ${d1Str}`);

  // Firebase
  console.log('Buscando dados do Firebase...');
  const store = await fetchStore();

  const contas = Array.isArray(store.contas)
    ? store.contas.filter(Boolean)
    : Object.values(store.contas || {}).filter(Boolean);

  // Firebase proíbe '.' em chaves — o app substitui por ','. Decodificar ao buscar.
  const cronogramaData = {};
  Object.entries(store.cronogramaData || {}).forEach(([k, v]) => {
    cronogramaData[k.replace(/,/g, '.')] = v;
  });

  // Filtrar contas pelo schedule de D-1 (inclui encerradas, igual ao app)
  const filtered = contas.filter(c =>
    c && c.tipo && freqs.includes(c.tipo)
  );

  console.log(`Contas filtradas: ${filtered.length}`);
  if (!filtered.length) { console.log('Nenhuma conta. Nada enviado.'); return; }

  // ─── Contagem de status para D-1 ─────────────────────────────────────────────
  const statusCount = { pendente: 0, sem_acesso: 0, sem_movimento: 0, aguardando_extrato: 0, concluido: 0 };

  filtered.forEach(c => {
    const ck = `${c.sigla}_${c.numeroConta}`.replace(/['"]/g, '');
    const entry = cronogramaData[`${ck}_${d1Str}`];
    const key = entry?.status && statusCount[entry.status] !== undefined ? entry.status : 'pendente';
    statusCount[key]++;
  });

  // ─── CSV (formato idêntico ao app: Acompanhamento + coluna data) ─────────────
  const headers = [
    'Sigla', 'País', 'Agente', 'Banco', 'Nº Conta',
    'Frequência', 'Tipo', 'Status', 'Acompanhamento',
  ];
  const csvRows = [headers];

  const STATUS_RANK = { pendente: 0, sem_acesso: 1, sem_movimento: 2, aguardando_extrato: 3, concluido: 4 };
  const getD1Status = c => {
    const ck = `${c.sigla}_${c.numeroConta}`.replace(/['"]/g, '');
    const entry = cronogramaData[`${ck}_${d1Str}`];
    return entry?.status && STATUS_RANK[entry.status] !== undefined ? entry.status : 'pendente';
  };
  filtered.sort((a, b) => (STATUS_RANK[getD1Status(a)] ?? 99) - (STATUS_RANK[getD1Status(b)] ?? 99));

  filtered.forEach(c => {
    const ck = `${c.sigla}_${c.numeroConta}`.replace(/['"]/g, '');
    const d1Entry = cronogramaData[`${ck}_${d1Str}`];
    const d1Status = d1Entry ? (STATUS_LBL[d1Entry.status] || d1Entry.status) : 'Pendente';
    csvRows.push([
      c.sigla ?? '', c.pais ?? '', c.agente ?? '', c.banco ?? '',
      c.numeroConta ?? '', c.tipo ?? '', c.tipoConta ?? '', c.status ?? '',
      d1Status,
    ]);
  });

  const csvContent = buildCSV(csvRows);
  const filename = `cronograma-${todayStr}-${label.toLowerCase()}.csv`;
  const csvBuffer = Buffer.from(csvContent, 'utf-8');
  console.log(`CSV gerado: ${csvRows.length - 1} linhas | ${filename}`);

  // ─── Mensagem Slack ───────────────────────────────────────────────────────────
  const statusLines = Object.entries(statusCount)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${STATUS_EMOJI[k]} *${STATUS_LBL[k]}:* ${n} conta${n !== 1 ? 's' : ''}`)
    .join('\n');

  const message =
    `:bar_chart: *Resumo Cronograma Accounts — ${label} ${todayStr}*\n` +
    `Frequências: ${freqs.join(' + ')} | ${filtered.length} contas\n\n` +
    statusLines;

  // ─── Upload Slack ─────────────────────────────────────────────────────────────
  if (!SLACK_TOKEN) throw new Error('SLACK_TOKEN não configurado');

  const authRes = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const authData = await authRes.json();
  if (!authData.ok) throw new Error(`auth.test: ${authData.error}`);
  console.log(`Slack: ${authData.bot_id || authData.user} (${authData.team})`);

  // 1) URL de upload
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ filename, length: String(csvBuffer.length) }).toString(),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`getUploadURLExternal: ${urlData.error}`);
  const { upload_url, file_id } = urlData;

  // 2) Upload do conteúdo
  const uploadRes = await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: csvBuffer,
  });
  if (!uploadRes.ok) throw new Error(`Upload: ${uploadRes.status} ${await uploadRes.text()}`);

  // 3) Completar e publicar
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      files: [{ id: file_id, title: `Cronograma Accounts — ${label} ${todayStr}` }],
      channel_id: SLACK_CHANNEL,
      initial_comment: message,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`completeUpload: ${completeData.error}`);

  console.log(`✅ Enviado ao Slack (file_id: ${file_id})`);
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
