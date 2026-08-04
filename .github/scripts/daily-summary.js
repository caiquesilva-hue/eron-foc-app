import fetch from 'node-fetch';

// ─── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const FIREBASE_SECRET = process.env.FIREBASE_SECRET;
const SLACK_TOKEN = process.env.SLACK_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'C0BH1SG3EUS';

// Override para testes manuais: força o dia de referência (D-1) como dia da semana
// 1=seg, 2=ter, 3=qua, 4=qui, 5=sex
const OVERRIDE_DAY = process.env.OVERRIDE_DAY ? parseInt(process.env.OVERRIDE_DAY, 10) : null;

// Override para testes manuais: força o envio do relatório "1 vez ao mês" (dia 5)
const OVERRIDE_MONTHLY = process.env.OVERRIDE_MONTHLY === '1';

// ─── Schedule: baseado no dia de D-1 (ontem) ──────────────────────────────────
const SCHEDULE = {
  1: { freqs: ['T1', 'Diário'],      label: 'Segunda' },
  2: { freqs: ['T2', 'Diário'],      label: 'Terça'   },
  3: { freqs: ['TOP 10', 'TOP 20'],  label: 'Quarta'  },
  4: { freqs: ['T1', 'Diário'],      label: 'Quinta'  },
  5: { freqs: ['T2', 'Diário'],      label: 'Sexta'   },
};

const DAY_NAMES_PT = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const STATUS_RANK = { pendente: 0, sem_acesso: 1, sem_movimento: 2, aguardando_extrato: 3, concluido: 4 };

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

// ─── Slack: upload de arquivo + mensagem ────────────────────────────────────────
async function uploadAndSend(csvBuffer, filename, fileTitle, message) {
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
      files: [{ id: file_id, title: fileTitle }],
      channel_id: SLACK_CHANNEL,
      initial_comment: message,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`completeUpload: ${completeData.error}`);

  console.log(`✅ Enviado ao Slack (file_id: ${file_id})`);
}

// ─── Gera e envia um relatório para um conjunto de contas ──────────────────────
async function sendReport({ contas, cronogramaData, label, freqsLabel, d1Str, todayStr }) {
  if (!contas.length) {
    console.log(`Nenhuma conta para "${label}". Pulando.`);
    return;
  }

  const getD1Status = c => {
    const ck = `${c.sigla}_${c.numeroConta}`.replace(/['"]/g, '');
    const entry = cronogramaData[`${ck}_${d1Str}`];
    return entry?.status && STATUS_RANK[entry.status] !== undefined ? entry.status : 'pendente';
  };

  // Contagem de status
  const statusCount = { pendente: 0, sem_acesso: 0, sem_movimento: 0, aguardando_extrato: 0, concluido: 0 };
  contas.forEach(c => { statusCount[getD1Status(c)]++; });

  // Ordenação por status
  contas.sort((a, b) => (STATUS_RANK[getD1Status(a)] ?? 99) - (STATUS_RANK[getD1Status(b)] ?? 99));

  // CSV
  const headers = [
    'Sigla', 'País', 'Agente', 'Banco', 'Nº Conta',
    'Frequência', 'Tipo', 'Status', 'Acompanhamento',
  ];
  const csvRows = [headers];
  contas.forEach(c => {
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
  const slugLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const filename = `cronograma-${todayStr}-${slugLabel}.csv`;
  const csvBuffer = Buffer.from(csvContent, 'utf-8');
  console.log(`CSV gerado: ${csvRows.length - 1} linhas | ${filename}`);

  // Mensagem Slack
  const statusLines = Object.entries(statusCount)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${STATUS_EMOJI[k]} *${STATUS_LBL[k]}:* ${n} conta${n !== 1 ? 's' : ''}`)
    .join('\n');

  const message =
    `:bar_chart: *Resumo Cronograma Accounts — ${label} ${todayStr}*\n` +
    `Frequências: ${freqsLabel} | ${contas.length} contas\n\n` +
    statusLines;

  await uploadAndSend(csvBuffer, filename, `Cronograma Accounts — ${label} ${todayStr}`, message);
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const today = nowBRT();                    // hoje em BRT — define o schedule e a label
  const d1 = addDays(today, -1);             // D-1 = ontem — data dos status no relatório
  const d1Str = fmtDate(d1);
  const todayStr = fmtDate(today);
  const todayDowRaw = today.getUTCDay();     // 0=dom
  const todayDom = today.getUTCDate();       // dia do mês

  const todayDow = OVERRIDE_DAY ?? (todayDowRaw === 0 || todayDowRaw === 6 ? null : todayDowRaw);
  const hasSchedule = todayDow && !!SCHEDULE[todayDow];
  const isFifth = OVERRIDE_MONTHLY || todayDom === 5;

  if (!hasSchedule && !isFifth) {
    console.log(`Hoje é fim de semana ou não previsto (${DAY_NAMES_PT[todayDowRaw]}). Nada enviado.`);
    return;
  }

  const dayName = hasSchedule ? SCHEDULE[todayDow].label : DAY_NAMES_PT[todayDowRaw];
  const parts = [hasSchedule && SCHEDULE[todayDow].freqs.join('+'), isFifth && '1×/mês'].filter(Boolean);
  console.log(`Hoje: ${dayName} ${todayStr} | Relatórios: ${parts.join(', ')} | Status de D-1: ${d1Str}`);

  // Firebase (busca única para ambos os relatórios)
  console.log('Buscando dados do Firebase...');
  const store = await fetchStore();

  const allContas = Array.isArray(store.contas)
    ? store.contas.filter(Boolean)
    : Object.values(store.contas || {}).filter(Boolean);

  // Firebase proíbe '.' em chaves — o app substitui por ','. Decodificar ao buscar.
  const cronogramaData = {};
  Object.entries(store.cronogramaData || {}).forEach(([k, v]) => {
    cronogramaData[k.replace(/,/g, '.')] = v;
  });

  // Slack auth (verificação única antes de qualquer envio)
  if (!SLACK_TOKEN) throw new Error('SLACK_TOKEN não configurado');
  const authRes = await fetch('https://slack.com/api/auth.test', {
    headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
  });
  const authData = await authRes.json();
  if (!authData.ok) throw new Error(`auth.test: ${authData.error}`);
  console.log(`Slack: ${authData.bot_id || authData.user} (${authData.team})`);

  // ─── 1) Relatório regular (T1/T2/etc.) ─────────────────────────────────────
  if (hasSchedule) {
    const { freqs, label } = SCHEDULE[todayDow];
    const filtered = allContas.filter(c =>
      c && c.tipo && freqs.includes(c.tipo) && c.status !== 'encerrada'
    );
    console.log(`[${label}] Contas filtradas: ${filtered.length}`);
    await sendReport({
      contas: filtered,
      cronogramaData,
      label,
      freqsLabel: freqs.join(' + '),
      d1Str,
      todayStr,
    });
  }

  // ─── 2) Relatório mensal (dia 5 de cada mês) ────────────────────────────────
  if (isFifth) {
    const filteredMensal = allContas.filter(c =>
      c && c.tipo === '1 vez ao mês' && c.status !== 'encerrada'
    );
    const mensalLabel = `${dayName} — 1× ao Mês`;
    // Status do último dia do mês anterior (ex: dia 5/08 → reflete 31/07)
    const lastDayPrevMonth = new Date(today);
    lastDayPrevMonth.setUTCDate(0);
    const prevMonthLastStr = fmtDate(lastDayPrevMonth);
    console.log(`[Mensal] Contas filtradas: ${filteredMensal.length} | Status de: ${prevMonthLastStr}`);
    await sendReport({
      contas: filteredMensal,
      cronogramaData,
      label: mensalLabel,
      freqsLabel: '1 vez ao mês',
      d1Str: prevMonthLastStr,
      todayStr,
    });
  }
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
