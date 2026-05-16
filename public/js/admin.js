// ====== Painel Admin ======
let usuario = null;

async function carregarAparencia() {
  try {
    const a = await fetch('/api/aparencia').then(r => r.json());
    document.getElementById('banner-clube').style.backgroundImage = `url('${a.banner_url}')`;
    if (a.logo_url) {
      const img = document.getElementById('logo-topo');
      img.src = a.logo_url; img.style.display = 'block';
      document.getElementById('logo-topo-fallback').style.display = 'none';
    }
    // Preview na aba aparência
    const prevLogo = document.getElementById('prev-logo');
    if (prevLogo) prevLogo.src = a.logo_url || '/img/site/__placeholder__';
    const prevBanner = document.getElementById('prev-banner');
    if (prevBanner) prevBanner.style.backgroundImage = `url('${a.banner_url}')`;
  } catch {}
}

async function init() {
  const r = await fetch('/api/me');
  if (!r.ok) { window.location.href = '/'; return; }
  usuario = await r.json();
  if (usuario.papel !== 'admin') { window.location.href = '/painel'; return; }
  document.getElementById('user-nome').textContent = usuario.nome;
  await Promise.all([carregarAparencia(), carregarReservas(), carregarKPIs()]);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function formatarData(iso) {
  if (!iso) return '';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
}
function formatarDT(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('pt-BR');
}

// Tabs
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('ativo'));
    t.classList.add('ativo');
    const aba = t.dataset.tab;
    ['reservas', 'socios', 'cadastros', 'espacos', 'comunicados', 'aparencia', 'infracoes', 'audit'].forEach(a => {
      document.getElementById('tab-' + a).style.display = a === aba ? '' : 'none';
    });
    if (aba === 'socios') carregarSocios();
    if (aba === 'infracoes') carregarInfracoes();
    if (aba === 'audit') carregarAudit();
    if (aba === 'espacos') carregarEspacos();
    if (aba === 'comunicados') carregarComunicadosAdmin();
    if (aba === 'aparencia') carregarAparencia();
    if (aba === 'cadastros') { /* nada a carregar */ }
  });
});

async function carregarKPIs() {
  const [reservas, infracoes, socios] = await Promise.all([
    fetch('/api/admin/reservas').then(r => r.json()),
    fetch('/api/admin/infracoes').then(r => r.json()),
    fetch('/api/admin/socios').then(r => r.json()),
  ]);
  const hoje = new Date().toISOString().slice(0, 10);
  const hojeReservas = reservas.filter(r => r.data === hoje && r.status === 'confirmada').length;
  const totalConfirmadas = reservas.filter(r => r.status === 'confirmada').length;
  const bloqueados = socios.filter(s => s.bloqueado_ate && s.bloqueado_ate >= hoje).length;
  const inadimplentes = socios.filter(s => !s.adimplente).length;

  document.getElementById('kpis').innerHTML = `
    <div class="kpi">
      <div class="rotulo">Reservas hoje</div>
      <div class="valor">${hojeReservas}</div>
    </div>
    <div class="kpi verde">
      <div class="rotulo">Confirmadas (total)</div>
      <div class="valor">${totalConfirmadas}</div>
    </div>
    <div class="kpi amarelo">
      <div class="rotulo">Infrações (12 meses)</div>
      <div class="valor">${infracoes.length}</div>
    </div>
    <div class="kpi vermelho">
      <div class="rotulo">Sócios bloqueados</div>
      <div class="valor">${bloqueados}</div>
    </div>
    <div class="kpi vermelho">
      <div class="rotulo">Inadimplentes</div>
      <div class="valor">${inadimplentes}</div>
    </div>
    <div class="kpi">
      <div class="rotulo">Total de sócios</div>
      <div class="valor">${socios.length}</div>
    </div>
  `;
}

// ====== Reservas ======
document.getElementById('btn-filtrar').addEventListener('click', carregarReservas);
document.getElementById('btn-limpar').addEventListener('click', () => {
  document.getElementById('filtro-data').value = '';
  document.getElementById('filtro-status').value = '';
  carregarReservas();
});

async function carregarReservas() {
  const data = document.getElementById('filtro-data').value;
  const status = document.getElementById('filtro-status').value;
  const qs = new URLSearchParams();
  if (data) qs.set('data', data);
  if (status) qs.set('status', status);
  const r = await fetch('/api/admin/reservas?' + qs.toString());
  const lista = await r.json();
  const wrap = document.getElementById('lista-reservas');

  if (!lista.length) {
    wrap.innerHTML = `<div class="vazio"><div class="icone-grande">📅</div>Nenhuma reserva encontrada.</div>`;
    return;
  }

  let html = `<table class="lista">
    <thead><tr>
      <th>Data</th><th>Espaço</th><th>Horário</th><th>Sócio</th><th>Status</th><th>Criada em</th><th>Ações</th>
    </tr></thead><tbody>`;
  lista.forEach(r => {
    const horario = r.periodo ? (r.periodo === 'diurno' ? '☀️ Diurno' : '🌙 Noturno')
      : `🕒 ${r.hora_inicio}–${r.hora_fim}`;
    const badge = r.status === 'confirmada'
      ? '<span class="badge badge-verde">Confirmada</span>'
      : '<span class="badge badge-cinza">Cancelada</span>';
    const acoes = r.status === 'confirmada'
      ? `<button class="btn btn-vermelho btn-sm" onclick="cancelarAdmin(${r.id})">Cancelar</button>` : '—';
    html += `<tr>
      <td>${formatarData(r.data)}</td>
      <td>${r.espaco_nome}</td>
      <td>${horario}</td>
      <td>${r.matricula} — ${r.socio_nome}</td>
      <td>${badge}</td>
      <td>${formatarDT(r.criado_em)}</td>
      <td>${acoes}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function cancelarAdmin(id) {
  if (!confirm('Cancelar esta reserva como ADMIN? (não gera infração para o sócio)')) return;
  const r = await fetch(`/api/reservas/${id}/cancelar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forcar: true })
  });
  if (!r.ok) { alert('Erro ao cancelar'); return; }
  carregarReservas();
  carregarKPIs();
}

// ====== Sócios ======
async function carregarSocios() {
  const r = await fetch('/api/admin/socios');
  const lista = await r.json();
  const wrap = document.getElementById('lista-socios');
  const hoje = new Date().toISOString().slice(0, 10);

  let html = `<table class="lista">
    <thead><tr><th>Matrícula</th><th>Nome</th><th>Papel</th><th>Adimplência</th><th>Bloqueio</th><th>Ações</th></tr></thead><tbody>`;
  lista.forEach(s => {
    const bloqueado = s.bloqueado_ate && s.bloqueado_ate >= hoje;
    const adimp = s.adimplente
      ? '<span class="badge badge-verde">Em dia</span>'
      : '<span class="badge badge-vermelho">Inadimplente</span>';
    const bloq = bloqueado
      ? `<span class="badge badge-vermelho">Até ${formatarData(s.bloqueado_ate)}</span>`
      : '<span class="badge badge-cinza">Livre</span>';
    const acoes = [];
    if (bloqueado) acoes.push(`<button class="btn btn-outline btn-sm" onclick="desbloquear(${s.id})">Desbloquear</button>`);
    acoes.push(`<button class="btn btn-outline btn-sm" onclick="alternarAdimp(${s.id}, ${s.adimplente ? 0 : 1})">${s.adimplente ? 'Marcar inadimplente' : 'Marcar adimplente'}</button>`);
    html += `<tr>
      <td><b>${s.matricula}</b></td>
      <td>${s.nome}</td>
      <td><span class="badge badge-${s.papel === 'admin' ? 'amarelo' : 'azul'}">${s.papel}</span></td>
      <td>${adimp}</td>
      <td>${bloq}</td>
      <td>${acoes.join(' ')}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

async function desbloquear(id) {
  if (!confirm('Remover bloqueio deste sócio?')) return;
  await fetch(`/api/admin/socios/${id}/desbloquear`, { method: 'POST' });
  carregarSocios();
  carregarKPIs();
}

async function alternarAdimp(id, novo) {
  await fetch(`/api/admin/socios/${id}/adimplencia`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adimplente: novo === 1 })
  });
  carregarSocios();
  carregarKPIs();
}

// ====== Infrações ======
async function carregarInfracoes() {
  const r = await fetch('/api/admin/infracoes');
  const lista = await r.json();
  const wrap = document.getElementById('lista-infracoes');
  if (!lista.length) {
    wrap.innerHTML = `<div class="vazio"><div class="icone-grande">✅</div>Sem infrações registradas.</div>`;
    return;
  }
  let html = `<table class="lista">
    <thead><tr><th>Data</th><th>Sócio</th><th>Nível</th><th>%</th><th>Valor</th><th>Motivo</th></tr></thead><tbody>`;
  lista.forEach(i => {
    html += `<tr>
      <td>${formatarDT(i.criada_em)}</td>
      <td>${i.matricula} — ${i.socio_nome}</td>
      <td><span class="badge badge-${i.nivel === 1 ? 'amarelo' : (i.nivel === 2 ? 'vermelho' : 'vermelho')}">${i.nivel}ª</span></td>
      <td>${i.percentual}%</td>
      <td><b>R$ ${i.valor.toFixed(2)}</b></td>
      <td>${i.motivo || '—'}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ====== Audit ======
async function carregarAudit() {
  const r = await fetch('/api/admin/audit');
  const lista = await r.json();
  const wrap = document.getElementById('lista-audit');
  let html = `<table class="lista">
    <thead><tr><th>Quando</th><th>Sócio</th><th>Ação</th><th>Entidade</th><th>IP</th><th>Detalhes</th></tr></thead><tbody>`;
  lista.forEach(a => {
    let det = a.detalhes || '';
    try { det = '<code style="font-size:11px">' + (a.detalhes || '') + '</code>'; } catch {}
    html += `<tr>
      <td>${formatarDT(a.criado_em)}</td>
      <td>${a.matricula ? a.matricula + ' — ' + a.socio_nome : '—'}</td>
      <td><span class="badge badge-azul">${a.acao}</span></td>
      <td>${a.entidade || '—'} ${a.entidade_id || ''}</td>
      <td>${a.ip || '—'}</td>
      <td>${det}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ====== Espaços (upload de fotos) ======
const ICONES_ESPACO = { churrasqueira: '🔥', salao: '🎉', campo: '⚽', quadra: '🏐' };
const FOTOS_FALLBACK = {
  churrasqueira: '/img/churrasqueira.jpg',
  salao: '/img/salao.jpg',
  campo: '/img/campo.jpg',
  quadra: '/img/quadra.jpg',
};

async function carregarEspacos() {
  const r = await fetch('/api/espacos');
  const lista = await r.json();
  const wrap = document.getElementById('grid-espacos-admin');
  let html = '';
  lista.forEach(e => {
    const foto = e.foto_url || FOTOS_FALLBACK[e.tipo];
    const temFotoPropria = !!e.foto_url;
    html += `
      <div class="espaco-card" data-codigo="${e.codigo}">
        <div class="foto" style="background-image:url('${foto}?t=${Date.now()}')">
          <div class="icone-overlay">${ICONES_ESPACO[e.tipo]}</div>
          ${temFotoPropria ? '<div class="badge-foto-propria">Foto real</div>' : '<div class="badge-foto-generica">Genérica</div>'}
        </div>
        <div class="corpo">
          <div class="nome">${e.nome}</div>
          <div class="meta">${e.codigo} · ${e.tipo}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <label class="btn btn-amarelo btn-sm" style="margin:0;cursor:pointer">
              📤 Enviar foto
              <input type="file" accept="image/jpeg,image/png,image/webp" style="display:none"
                onchange="enviarFotoEspaco('${e.codigo}', this)">
            </label>
            ${temFotoPropria
              ? `<button class="btn btn-outline btn-sm" onclick="removerFotoEspaco('${e.codigo}')">Remover</button>`
              : ''}
          </div>
        </div>
      </div>`;
  });
  wrap.innerHTML = html;
}

async function enviarFotoEspaco(codigo, input) {
  const f = input.files[0];
  if (!f) return;
  if (f.size > 3 * 1024 * 1024) {
    alert('Arquivo muito grande (máx. 3 MB).');
    return;
  }
  const fd = new FormData();
  fd.append('foto', f);
  const card = document.querySelector(`.espaco-card[data-codigo="${codigo}"]`);
  if (card) card.style.opacity = '0.5';

  const r = await fetch(`/api/admin/espacos/${codigo}/foto`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok) { alert('❌ ' + (j.erro || 'Erro no upload')); }
  carregarEspacos();
}

async function removerFotoEspaco(codigo) {
  if (!confirm(`Remover a foto do espaço ${codigo}? Voltará a usar a foto genérica.`)) return;
  const r = await fetch(`/api/admin/espacos/${codigo}/foto`, { method: 'DELETE' });
  if (!r.ok) { alert('Erro ao remover'); return; }
  carregarEspacos();
}

// ====== Cadastro individual ======
document.getElementById('form-novo-socio').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const dados = Object.fromEntries(new FormData(form));
  dados.adimplente = Number(dados.adimplente);
  const r = await fetch('/api/admin/socios', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  const j = await r.json();
  const alerta = document.getElementById('alerta-cadastro');
  if (!r.ok) {
    alerta.innerHTML = `<div class="alerta alerta-erro">❌ ${j.erro || 'Erro ao cadastrar'}</div>`;
    return;
  }
  const senhaTxt = j.senha_inicial
    ? `<br><b>Senha inicial gerada:</b> <code>${j.senha_inicial}</code> (anote e repasse ao sócio)`
    : '';
  alerta.innerHTML = `<div class="alerta alerta-sucesso">✅ Sócio <b>${j.matricula}</b> cadastrado com sucesso.${senhaTxt}</div>`;
  form.reset();
  carregarKPIs();
});

// ====== Importação xlsx ======
const inputArquivo = document.getElementById('arquivo-import');
const btnImportar = document.getElementById('btn-importar');
const arquivoNome = document.getElementById('arquivo-nome');

inputArquivo.addEventListener('change', () => {
  const f = inputArquivo.files[0];
  if (!f) {
    arquivoNome.textContent = 'Nenhum arquivo selecionado';
    btnImportar.disabled = true;
    return;
  }
  arquivoNome.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
  btnImportar.disabled = false;
});

btnImportar.addEventListener('click', async () => {
  const f = inputArquivo.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('arquivo', f);
  btnImportar.disabled = true;
  btnImportar.textContent = 'Importando…';

  const r = await fetch('/api/admin/socios/importar', { method: 'POST', body: fd });
  const j = await r.json();

  btnImportar.disabled = false;
  btnImportar.textContent = 'Importar';

  const wrap = document.getElementById('resultado-import');
  if (!r.ok) {
    wrap.innerHTML = `<div class="alerta alerta-erro">❌ ${j.erro || 'Erro na importação'}</div>`;
    return;
  }

  let html = `
    <div class="import-resumo">
      <div class="bloco azul"><div class="num">${j.total}</div><div class="rot">Linhas lidas</div></div>
      <div class="bloco verde"><div class="num">${j.criados}</div><div class="rot">Criados</div></div>
      <div class="bloco vermelho"><div class="num">${j.ignorados}</div><div class="rot">Ignorados</div></div>
    </div>
  `;

  if (j.criados_detalhes.length) {
    html += `<h3>✅ Sócios criados</h3>
      <div class="import-tabela"><table class="lista">
      <thead><tr><th>Linha</th><th>Matrícula</th><th>Senha inicial</th></tr></thead><tbody>`;
    j.criados_detalhes.forEach(d => {
      html += `<tr><td>${d.linha}</td><td><b>${d.matricula}</b></td><td><code>${d.senha_inicial || '(definida na planilha)'}</code></td></tr>`;
    });
    html += '</tbody></table></div>';
  }
  if (j.erros.length) {
    html += `<h3>⚠️ Linhas ignoradas</h3>
      <div class="import-tabela"><table class="lista">
      <thead><tr><th>Linha</th><th>Matrícula</th><th>Motivo</th></tr></thead><tbody>`;
    j.erros.forEach(e => {
      html += `<tr><td>${e.linha}</td><td>${e.matricula || '—'}</td><td>${e.erro}</td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  wrap.innerHTML = html;
  carregarKPIs();
  inputArquivo.value = '';
  arquivoNome.textContent = 'Nenhum arquivo selecionado';
  btnImportar.disabled = true;
});

// ====== Adimplência: carga delta ======
const adimpArquivo = document.getElementById('adimp-arquivo');
const btnAdimp = document.getElementById('btn-adimp-importar');
const adimpNome = document.getElementById('adimp-nome');

adimpArquivo.addEventListener('change', () => {
  const f = adimpArquivo.files[0];
  if (!f) { adimpNome.textContent = 'Nenhum arquivo selecionado'; btnAdimp.disabled = true; return; }
  adimpNome.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
  btnAdimp.disabled = false;
});

btnAdimp.addEventListener('click', async () => {
  const f = adimpArquivo.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('arquivo', f);
  btnAdimp.disabled = true;
  btnAdimp.textContent = 'Importando…';

  const r = await fetch('/api/admin/adimplencia/importar', { method: 'POST', body: fd });
  const j = await r.json();

  btnAdimp.disabled = false;
  btnAdimp.textContent = 'Importar';

  const wrap = document.getElementById('adimp-resultado');
  if (!r.ok) {
    wrap.innerHTML = `<div class="alerta alerta-erro">❌ ${j.erro || 'Erro'}</div>`;
    return;
  }

  let html = `
    <div class="import-resumo">
      <div class="bloco azul"><div class="num">${j.total}</div><div class="rot">Linhas lidas</div></div>
      <div class="bloco verde"><div class="num">${j.atualizados}</div><div class="rot">Atualizados</div></div>
      <div class="bloco azul"><div class="num">${j.inalterados}</div><div class="rot">Inalterados</div></div>
      <div class="bloco vermelho"><div class="num">${j.nao_encontrados}</div><div class="rot">Não encontrados</div></div>
    </div>
  `;

  if (j.detalhes && j.detalhes.length) {
    html += `<div class="import-tabela"><table class="lista">
      <thead><tr><th>Linha</th><th>Matrícula</th><th>Nome</th><th>Status</th><th>Resultado</th></tr></thead><tbody>`;
    j.detalhes.forEach(d => {
      let res = '';
      if (d.status === 'atualizado') {
        const de = d.de ? 'Em dia' : 'Inadimplente';
        const para = d.para ? 'Em dia' : 'Inadimplente';
        const corBadge = d.para ? 'badge-verde' : 'badge-vermelho';
        res = `${de} → <span class="badge ${corBadge}">${para}</span>`;
      } else if (d.status === 'inalterado') {
        res = `<span class="badge badge-cinza">Sem alteração</span>`;
      } else {
        res = `<span class="badge badge-vermelho">Não encontrado</span>`;
      }
      html += `<tr>
        <td>${d.linha}</td>
        <td><b>${d.matricula}</b></td>
        <td>${d.nome || '—'}</td>
        <td>${d.status}</td>
        <td>${res}</td>
      </tr>`;
    });
    html += '</tbody></table></div>';
  }
  if (j.erros && j.erros.length) {
    html += `<h3>⚠️ Linhas com erro</h3><div class="import-tabela"><table class="lista">
      <thead><tr><th>Linha</th><th>Matrícula</th><th>Motivo</th></tr></thead><tbody>`;
    j.erros.forEach(e => {
      html += `<tr><td>${e.linha}</td><td>${e.matricula || '—'}</td><td>${e.erro}</td></tr>`;
    });
    html += '</tbody></table></div>';
  }

  wrap.innerHTML = html;
  carregarKPIs();
  adimpArquivo.value = '';
  adimpNome.textContent = 'Nenhum arquivo selecionado';
  btnAdimp.disabled = true;
});

// ====== Comunicados ======
document.getElementById('form-comunicado').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const dados = {
    titulo: form.titulo.value.trim(),
    conteudo: form.conteudo.value.trim(),
    destaque: form.destaque.checked,
  };
  const r = await fetch('/api/admin/comunicados', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados)
  });
  const j = await r.json();
  const alerta = document.getElementById('alerta-com');
  if (!r.ok) { alerta.innerHTML = `<div class="alerta alerta-erro">❌ ${j.erro}</div>`; return; }
  alerta.innerHTML = `<div class="alerta alerta-sucesso">✅ Comunicado publicado.</div>`;
  form.reset();
  carregarComunicadosAdmin();
});

async function carregarComunicadosAdmin() {
  const r = await fetch('/api/admin/comunicados');
  const lista = await r.json();
  const wrap = document.getElementById('lista-comunicados-admin');
  if (!lista.length) {
    wrap.innerHTML = `<div class="vazio"><div class="icone-grande">📭</div>Nenhum comunicado cadastrado.</div>`;
    return;
  }
  let html = '<div class="comunicados-lista">';
  lista.forEach(c => {
    const cls = !c.ativo ? 'inativo' : (c.destaque ? 'destaque' : '');
    html += `
      <div class="comunicado-card ${cls}">
        <div class="cab">
          <div class="titulo">${c.destaque ? '⭐ ' : ''}${escapeHtml(c.titulo)}
            ${!c.ativo ? ' <span class="badge badge-cinza">Inativo</span>' : ''}
          </div>
          <div class="data">${new Date(c.criado_em).toLocaleString('pt-BR')}</div>
        </div>
        <div class="conteudo">${escapeHtml(c.conteudo)}</div>
        <div class="acoes">
          <button class="btn btn-outline btn-sm" onclick="toggleAtivoComunicado(${c.id}, ${c.ativo ? 0 : 1})">
            ${c.ativo ? '🚫 Desativar' : '✅ Ativar'}
          </button>
          <button class="btn btn-outline btn-sm" onclick="toggleDestaqueComunicado(${c.id}, ${c.destaque ? 0 : 1})">
            ${c.destaque ? 'Remover destaque' : '⭐ Destacar'}
          </button>
          <button class="btn btn-vermelho btn-sm" onclick="removerComunicado(${c.id})">🗑️ Remover</button>
        </div>
      </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;
}

async function toggleAtivoComunicado(id, novo) {
  await fetch(`/api/admin/comunicados/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ativo: novo })
  });
  carregarComunicadosAdmin();
}
async function toggleDestaqueComunicado(id, novo) {
  await fetch(`/api/admin/comunicados/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destaque: novo })
  });
  carregarComunicadosAdmin();
}
async function removerComunicado(id) {
  if (!confirm('Remover este comunicado permanentemente?')) return;
  await fetch(`/api/admin/comunicados/${id}`, { method: 'DELETE' });
  carregarComunicadosAdmin();
}

// ====== Aparência ======
document.getElementById('up-logo').addEventListener('change', (e) => uploadAparencia('logo', e.target.files[0]));
document.getElementById('up-banner').addEventListener('change', (e) => uploadAparencia('banner', e.target.files[0]));
document.getElementById('btn-remover-logo').addEventListener('click', () => removerAparencia('logo'));
document.getElementById('btn-remover-banner').addEventListener('click', () => removerAparencia('banner'));

async function uploadAparencia(tipo, file) {
  if (!file) return;
  const fd = new FormData();
  fd.append('imagem', file);
  const r = await fetch(`/api/admin/aparencia/${tipo}`, { method: 'POST', body: fd });
  const j = await r.json();
  if (!r.ok) { alert('❌ ' + (j.erro || 'Erro')); return; }
  carregarAparencia();
}

async function removerAparencia(tipo) {
  if (!confirm(`Restaurar ${tipo} para o padrão?`)) return;
  await fetch(`/api/admin/aparencia/${tipo}`, { method: 'DELETE' });
  carregarAparencia();
}

document.getElementById('btn-sair').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
});

init();
