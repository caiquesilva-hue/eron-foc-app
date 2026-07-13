import fetch from 'node-fetch';
import FormData from 'form-data';

// ─── Config ────────────────────────────────────────────────────────────────────
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL; // ex: https://eron-foc-app-da755-default-rtdb.firebaseio.com
const FIREBASE_SECRET = process.env.FIREBASE_SECRET; // Database Secret (Legacy) do Firebase Console
const SLACK_TOKEN = process.env.SLACK_TOKEN;          // xoxb-... com escopo files:write + files:read
const SLACK_CHANNEL = process.env.SLACK_CHANNEL || 'C0BH1SG3EUS';

// Dia da semana em BRT: 1=seg, 2=ter, 3=qua, 4=qui, 5=sex
const OVERRIDE_DAY = process.env.OVERRIDE_DAY ? parseInt(process.env.OVERRIDE_DAY, 10) : null;

// ─── Regra de filtro por dia ────────────────────────────────────────────────────
// Seg/Qui → T1 + Diário | Ter/Sex → T2 + Diário | Qua → TOP 10 + TOP 20
const SCHEDULE = {
  1: { freqs: ['T1', 'Diário'], label: 'Segunda' },
  2: { freqs: ['T2', 'Diário'], label: 'Terça' },
  3: { freqs: ['TOP 10', 'TOP 20'], label: 'Quarta' },
  4: { freqs: ['T1', 'Diário'], label: 'Quinta' },
  5: { freqs: ['T2', 'Diário'], label: 'Sexta' },
};

// ─── Helpers ────────────────────────────────────────────────────────────────────
function todayBRT() {
  // GitHub Actions corre em UTC; BRT = UTC-3
  const now = new Date();
  const brt = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return brt;
}

function fmtDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Gera os dias úteis da semana atual (seg a sex) em BRT
function weekDays(referenceDate) {
  // referenceDate é o "hoje" em BRT (UTC-3), representado como Date UTC
  const dow = referenceDate.getUTCDay(); // 0=dom, 1=seg, ..., 6=sab
  const mon = new Date(referenceDate);
  mon.setUTCDate(referenceDate.getUTCDate() - ((dow + 6) % 7)); // recua até segunda
  const days = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(mon);
    d.setUTCDate(mon.getUTCDate() + i);
    days.push(d);
  }
  return days;
}

function csvEscape(v) {
  const s = String(v ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCSV(rows) {
  return rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
}

// ─── Firebase REST ──────────────────────────────────────────────────────────────
async function fetchStore() {
  if (!FIREBASE_DB_URL) throw new Error('FIREBASE_DB_URL não configurado');

  let url = `${FIREBASE_DB_URL}/store.json`;
  if (FIREBASE_SECRET) url += `?auth=${FIREBASE_SECRET}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Firebase ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Status label ───────────────────────────────────────────────────────────────
const STATUS_LBL = {
  concluido: 'Concluída',
  sem_movimento: 'Sem movimento',
  sem_acesso: 'Sem acesso',
  aguardando_extrato: 'Aguardando extrato',
  pendente: 'Pendente',
};

function statusLabel(key) {
  return STATUS_LBL[key] || key || 'Pendente';
}

// ─── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const today = todayBRT();
  const rawDow = today.getUTCDay(); // 0=dom
  const dow = OVERRIDE_DAY ?? (rawDow === 0 || rawDow === 6 ? null : rawDow);

  if (!dow || !SCHEDULE[dow]) {
    console.log(`Hoje é fim de semana ou dia não previsto (dow=${rawDow}). Nada enviado.`);
    return;
  }

  const { freqs, label } = SCHEDULE[dow];
  console.log(`Dia: ${label} | Frequências: ${freqs.join(', ')}`);

  // Fetch Firebase
  console.log('Buscando dados do Firebase...');
  const store = await fetchStore();

  const contas = Array.isArray(store.contas)
    ? store.contas.filter(Boolean)
    : Object.values(store.contas || {}).filter(Boolean);

  const cronogramaData = store.cronogramaData || {};

  // Filtrar contas pelo schedule do dia
  const filtered = contas.filter(c => {
    if (!c || !c.tipo) return false;
    if (c.status === 'encerrada') return false;
    return freqs.includes(c.tipo);
  });

  console.log(`Contas filtradas: ${filtered.length}`);

  if (!filtered.length) {
    console.log('Nenhuma conta para exportar. Nada enviado.');
    return;
  }

  // Dias da semana para colunas
  const days = weekDays(today);
  const dateHeaders = days.map(fmtDate);

  // Montar CSV
  const headers = [
    'Sigla', 'País', 'Agente', 'Banco', 'Nº Conta',
    'Frequência', 'Tipo', 'Status', 'Acompanhamento',
    ...dateHeaders,
  ];
  const rows = [headers];

  // D-1 para coluna Acompanhamento
  const d1 = new Date(today);
  d1.setUTCDate(today.getUTCDate() - 1);
  const d1Str = fmtDate(d1);

  filtered.forEach(c => {
    const ck = `${c.sigla}_${c.numeroConta}`.replace(/['"]/g, '');

    const d1Entry = cronogramaData[`${ck}_${d1Str}`];
    const d1Status = d1Entry ? statusLabel(d1Entry.status) : 'Pendente';

    const dayCells = days.map(d => {
      const ds = fmtDate(d);
      const e = cronogramaData[`${ck}_${ds}`];
      return e ? statusLabel(e.status) : 'Pendente';
    });

    rows.push([
      c.sigla ?? '',
      c.pais ?? '',
      c.agente ?? '',
      c.banco ?? '',
      c.numeroConta ?? '',
      c.tipo ?? '',
      c.tipoConta ?? '',
      c.status ?? '',
      d1Status,
      ...dayCells,
    ]);
  });

  const csvContent = buildCSV(rows);
  const dateLabel = fmtDate(today);
  const filename = `cronograma-${dateLabel}-${label.toLowerCase()}.csv`;

  console.log(`CSV gerado: ${rows.length - 1} linhas | arquivo: ${filename}`);

  // ─── Upload para Slack ─────────────────────────────────────────────────────
  if (!SLACK_TOKEN) throw new Error('SLACK_TOKEN não configurado');

  const csvBuffer = Buffer.from(csvContent, 'utf-8');

  // 1) Obter URL de upload (API v2)
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename,
      length: csvBuffer.length,
    }),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`files.getUploadURLExternal: ${urlData.error}`);

  const { upload_url, file_id } = urlData;

  // 2) Fazer upload do conteúdo
  const uploadRes = await fetch(upload_url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv' },
    body: csvBuffer,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload falhou: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  // 3) Completar upload e publicar no canal
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: file_id, title: `Cronograma FOC — ${label} ${dateLabel}` }],
      channel_id: SLACK_CHANNEL,
      initial_comment: `📊 *Resumo Cronograma FOC — ${label} ${dateLabel}*\nFrequências: ${freqs.join(' + ')} | ${filtered.length} conta${filtered.length !== 1 ? 's' : ''}`,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`files.completeUploadExternal: ${completeData.error}`);

  console.log(`✅ CSV enviado ao Slack com sucesso (file_id: ${file_id})`);
}

main().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
