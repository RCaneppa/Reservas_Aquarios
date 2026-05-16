// ====== Painel do Sócio ======
const ICONES = {
  churrasqueira: '🔥', salao: '🎉', campo: '⚽', quadra: '🏐'
};
const FOTOS = {
  churrasqueira: '/img/churrasqueira.jpg',
  salao: '/img/salao.jpg',
  campo: '/img/campo.jpg',
  quadra: '/img/quadra.jpg',
};
let usuario = null;
let espacoSelecionado = null;
let slotSelecionado = null;

async function carregarAparencia() {
  try {
    const a = await fetch('/api/aparencia').then(r => r.json());
    document.getElementById('banner-clube').style.backgroundImage = `url('${a.banner_url}')`;
    if (a.logo_url) {
      const img = document.getElementById('logo-topo');
      img.src = a.logo_url; img.style.display = 'block';
      document.getElementById('logo-topo-fallback').style.display = 'none';
    }
  } catch {}
}

async function carregarUsuario() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }
  usuario = await r.json();
  document.getElementById('user-nome').textContent = usuario.nome;
  if (!usuario.adimplente) {
    mostrarAlertaGlobal('Você está com pendência financeira (mais de 90 dias). Regularize para fazer novas reservas.', 'erro');
  } else if (usuario.bloqueado_ate) {
    mostrarAlertaGlobal(`Você está bloqueado para reservas até ${formatarData(usuario.bloqueado_ate)} por infração de cancelamento.`, 'aviso');
  }
}

function mostrarAlertaGlobal(msg, tipo = 'info') {
  document.getElementById('alerta-global').innerHTML =
    `<div class="alerta alerta-${tipo}">${msg}</div>`;
}

function formatarData(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}

// ====== Tabs ======
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('ativo'));
    t.classList.add('ativo');
    const aba = t.dataset.tab;
    ['reservar', 'minhas', 'comunicados'].forEach(a => {
      document.getElementById('tab-' + a).style.display = a === aba ? '' : 'none';
    });
    if (aba === 'minhas') carregarMinhasReservas();
    if (aba === 'comunicados') carregarComunicados();
  });
});

async function carregarComunicados() {
  const r = await fetch('/api/comunicados');
  const lista = await r.json();
  const wrap = document.getElementById('lista-comunicados-socio');
  if (!lista.length) {
    wrap.innerHTML = `<div class="vazio"><div class="icone-grande">📭</div>Nenhum comunicado no momento.</div>`;
    return;
  }
  let html = '<div class="comunicados-lista">';
  lista.forEach(c => {
    html += `
      <div class="comunicado-card ${c.destaque ? 'destaque' : ''}">
        <div class="cab">
          <div class="titulo">${c.destaque ? '⭐ ' : ''}${escapeHtml(c.titulo)}</div>
          <div class="data">${formatarDT(c.criado_em)}</div>
        </div>
        <div class="conteudo">${escapeHtml(c.conteudo)}</div>
      </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;

  // Badge no menu
  const badge = document.getElementById('badge-comunicados');
  if (lista.length > 0) { badge.textContent = lista.length; badge.style.display = ''; }
  else badge.style.display = 'none';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function formatarDT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR');
}

// Pré-carrega contagem na abertura
fetch('/api/comunicados').then(r => r.json()).then(l => {
  const badge = document.getElementById('badge-comunicados');
  if (l.length > 0) { badge.textContent = l.length; badge.style.display = ''; }
}).catch(() => {});

// ====== Disponibilidade ======
document.getElementById('btn-consultar').addEventListener('click', consultarDisponibilidade);

// data default = hoje
const hoje = new Date().toISOString().slice(0, 10);
document.getElementById('data-escolhida').value = hoje;
document.getElementById('data-escolhida').min = hoje;

async function consultarDisponibilidade() {
  const data = document.getElementById('data-escolhida').value;
  if (!data) return alert('Escolha uma data.');
  const r = await fetch('/api/disponibilidade?data=' + data);
  const j = await r.json();
  const wrap = document.getElementById('disponibilidade');

  if (j.aberto === false) {
    wrap.innerHTML = `<div class="card"><div class="alerta alerta-aviso">🚫 ${j.motivo}</div></div>`;
    return;
  }

  const grupos = {
    churrasqueira: { titulo: '🔥 Churrasqueiras (por período)', espacos: [] },
    salao: { titulo: '🎉 Salão de Festas (por período)', espacos: [] },
    campo: { titulo: '⚽ Campo de Futebol (por hora)', espacos: [] },
    quadra: { titulo: '🏐 Quadra de Areia (por hora)', espacos: [] },
  };
  j.espacos.forEach(e => grupos[e.tipo]?.espacos.push(e));

  let html = '';
  for (const tipo in grupos) {
    const g = grupos[tipo];
    if (!g.espacos.length) continue;
    html += `<div class="card"><h3>${g.titulo}</h3><div class="grid-espacos">`;
    g.espacos.forEach(e => {
      let slotsHtml = '';
      e.slots.forEach(s => {
        if (e.modo === 'periodo') {
          const label = s.periodo === 'diurno' ? '☀️ Diurno' : '🌙 Noturno';
          slotsHtml += `<span class="slot ${s.disponivel ? 'livre' : 'ocupado'}"
            data-espaco-id="${e.id}" data-tipo-slot="periodo" data-valor="${s.periodo}"
            ${s.disponivel ? `onclick='selecionarSlot(${JSON.stringify(e).replace(/'/g, "&apos;")}, ${JSON.stringify(s).replace(/'/g, "&apos;")}, "${data}")'` : ''}>${label}</span>`;
        } else {
          slotsHtml += `<span class="slot ${s.disponivel ? 'livre' : 'ocupado'}"
            ${s.disponivel ? `onclick='selecionarSlot(${JSON.stringify(e).replace(/'/g, "&apos;")}, ${JSON.stringify(s).replace(/'/g, "&apos;")}, "${data}")'` : ''}>${s.hora_inicio}</span>`;
        }
      });
      const extra = [];
      if (e.taxa_limpeza > 0) extra.push(`Taxa limpeza: R$ ${e.taxa_limpeza.toFixed(2)}`);
      if (e.conjugado_com) extra.push(`Conjugada com ${e.conjugado_com}`);
      html += `
        <div class="espaco-card">
          <div class="foto" style="background-image:url('${e.foto_url || FOTOS[e.tipo]}')">
            <div class="icone-overlay">${ICONES[e.tipo]}</div>
          </div>
          <div class="corpo">
            <div class="nome">${e.nome}</div>
            <div class="meta">${extra.join(' · ') || '&nbsp;'}</div>
            <div class="slots">${slotsHtml}</div>
          </div>
        </div>`;
    });
    html += `</div></div>`;
  }
  wrap.innerHTML = html;
}

function selecionarSlot(espaco, slot, data) {
  espacoSelecionado = espaco;
  slotSelecionado = { ...slot, data };
  abrirModal();
}

// ====== Modal ======
function abrirModal() {
  const resumo = document.getElementById('resumo-reserva');
  const slot = slotSelecionado;
  const dataFmt = formatarData(slot.data);
  let horarioFmt = '';
  if (slot.periodo) {
    horarioFmt = slot.periodo === 'diurno' ? '☀️ Diurno (09:00–17:00)' : '🌙 Noturno (18:00–02:00)';
  } else {
    horarioFmt = `🕒 ${slot.hora_inicio} às ${slot.hora_fim}`;
  }
  const taxa = espacoSelecionado.taxa_limpeza > 0
    ? `<div><b>Taxa de limpeza:</b> R$ ${espacoSelecionado.taxa_limpeza.toFixed(2)}</div>`
    : '';
  resumo.innerHTML = `
    <div style="background:var(--cinza-bg);padding:14px;border-radius:8px">
      <div><b>Espaço:</b> ${espacoSelecionado.nome}</div>
      <div><b>Data:</b> ${dataFmt}</div>
      <div><b>Horário:</b> ${horarioFmt}</div>
      ${taxa}
    </div>
  `;
  ['art1', 'art2', 'art3'].forEach(id => document.getElementById(id).checked = false);
  document.getElementById('modal-reserva').style.display = 'flex';
}

function fecharModal() {
  document.getElementById('modal-reserva').style.display = 'none';
  espacoSelecionado = null;
  slotSelecionado = null;
}

document.getElementById('btn-confirmar-reserva').addEventListener('click', async () => {
  const termo = {
    artigo1: document.getElementById('art1').checked,
    artigo2: document.getElementById('art2').checked,
    artigo3: document.getElementById('art3').checked,
  };
  if (!termo.artigo1 || !termo.artigo2 || !termo.artigo3) {
    alert('Você precisa aceitar todos os 3 artigos do termo.');
    return;
  }
  const body = {
    espaco_id: espacoSelecionado.id,
    data: slotSelecionado.data,
    periodo: slotSelecionado.periodo || null,
    hora_inicio: slotSelecionado.hora_inicio || null,
    hora_fim: slotSelecionado.hora_fim || null,
    termo
  };
  const r = await fetch('/api/reservas', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) {
    alert('❌ ' + (j.erro || 'Erro ao reservar.'));
    return;
  }
  fecharModal();
  mostrarAlertaGlobal('✅ Reserva confirmada com sucesso!' + (j.taxa_limpeza > 0 ? ` Taxa de limpeza: R$ ${j.taxa_limpeza.toFixed(2)}.` : ''), 'sucesso');
  consultarDisponibilidade();
});

// ====== Minhas reservas ======
async function carregarMinhasReservas() {
  const r = await fetch('/api/reservas/minhas');
  const reservas = await r.json();
  const wrap = document.getElementById('minhas-reservas');

  if (!reservas.length) {
    wrap.innerHTML = `<div class="vazio"><div class="icone-grande">📋</div>Você ainda não tem reservas.</div>`;
    return;
  }

  let html = `<table class="lista">
    <thead><tr>
      <th>Data</th><th>Espaço</th><th>Horário</th><th>Status</th><th>Ações</th>
    </tr></thead><tbody>`;

  reservas.forEach(r => {
    const horario = r.periodo
      ? (r.periodo === 'diurno' ? '☀️ Diurno' : '🌙 Noturno')
      : `🕒 ${r.hora_inicio}–${r.hora_fim}`;
    const badge = r.status === 'confirmada'
      ? '<span class="badge badge-verde">Confirmada</span>'
      : '<span class="badge badge-cinza">Cancelada</span>';
    const acoes = r.status === 'confirmada'
      ? `<button class="btn btn-vermelho btn-sm" onclick="cancelar(${r.id})">Cancelar</button>`
      : '—';
    html += `<tr>
      <td>${formatarData(r.data)}</td>
      <td>${r.espaco_nome}</td>
      <td>${horario}</td>
      <td>${badge}</td>
      <td>${acoes}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function cancelar(id) {
  if (!confirm('Confirma o cancelamento desta reserva? Cancelamentos fora do prazo geram multa e bloqueio de 30 dias.')) return;
  const r = await fetch(`/api/reservas/${id}/cancelar`, { method: 'POST' });
  const j = await r.json();
  if (!r.ok) { alert('❌ ' + (j.erro || 'Erro')); return; }

  if (j.infracao) {
    alert(`⚠️ Cancelamento fora do prazo.\n\n` +
      `Nível: ${j.infracao.nivel}ª infração (${j.infracao.percentual}%)\n` +
      `Multa: R$ ${j.infracao.valor.toFixed(2)}\n` +
      `Bloqueio para reservas até: ${formatarData(j.infracao.bloqueado_ate)}`);
  } else {
    mostrarAlertaGlobal('✅ Reserva cancelada dentro do prazo. Sem cobrança.', 'sucesso');
  }
  carregarMinhasReservas();
  carregarUsuario();
}

// ====== Alterar senha ======
document.getElementById('btn-alterar-senha').addEventListener('click', () => {
  ['senha-atual', 'nova-senha', 'conf-senha'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('alerta-senha').innerHTML = '';
  document.getElementById('modal-senha').style.display = 'flex';
});

document.getElementById('btn-confirmar-senha').addEventListener('click', async () => {
  const atual = document.getElementById('senha-atual').value;
  const nova = document.getElementById('nova-senha').value;
  const conf = document.getElementById('conf-senha').value;
  const alerta = document.getElementById('alerta-senha');
  if (!atual || !nova || !conf) {
    alerta.innerHTML = '<div class="alerta alerta-erro">Preencha todos os campos.</div>'; return;
  }
  if (nova !== conf) {
    alerta.innerHTML = '<div class="alerta alerta-erro">As novas senhas não conferem.</div>'; return;
  }
  if (nova.length < 6) {
    alerta.innerHTML = '<div class="alerta alerta-erro">Nova senha deve ter pelo menos 6 caracteres.</div>'; return;
  }
  const r = await fetch('/api/socio/alterar-senha', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ senha_atual: atual, nova_senha: nova })
  });
  const j = await r.json();
  if (!r.ok) {
    alerta.innerHTML = `<div class="alerta alerta-erro">${j.erro || 'Erro'}</div>`;
    return;
  }
  alerta.innerHTML = '<div class="alerta alerta-sucesso">✅ Senha alterada com sucesso!</div>';
  setTimeout(() => document.getElementById('modal-senha').style.display = 'none', 1500);
});

// ====== Sair ======
document.getElementById('btn-sair').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

// init
carregarAparencia();
carregarUsuario();
