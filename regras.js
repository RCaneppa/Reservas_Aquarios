// Regras de negócio do sistema de reservas Aquárius.
const db = require('./db');
const bcrypt = require('bcryptjs');

const VALOR_BASE_INFRACAO = 92.00; // 100% = R$ 92,00
const PERIODOS = ['diurno', 'noturno'];

// Período diurno: 09:00–17:00; Noturno: 18:00–02:00 (apresentação)
const PERIODO_LIMITE_CANCEL = { diurno: '09:00', noturno: '17:00' };

function hoje() {
  return new Date().toISOString().slice(0, 10);
}

function agoraHoraMin() {
  const d = new Date();
  return d.toTimeString().slice(0, 5);
}

function diaSemana(dataIso) {
  // 0 = domingo, 1 = segunda, ...
  return new Date(dataIso + 'T12:00:00').getDay();
}

function clubeAbertoNoDia(dataIso) {
  // Clube fechado às segundas-feiras (limpeza/manutenção)
  return diaSemana(dataIso) !== 1;
}

function getSocio(socioId) {
  return db.prepare('SELECT * FROM socios WHERE id = ?').get(socioId);
}

function getEspaco(espacoId) {
  return db.prepare('SELECT * FROM espacos WHERE id = ?').get(espacoId);
}

function getEspacoPorCodigo(codigo) {
  return db.prepare('SELECT * FROM espacos WHERE codigo = ?').get(codigo);
}

// Verifica se sócio pode reservar (adimplência + bloqueio por infração).
function validarSocio(socio) {
  if (!socio) return { ok: false, motivo: 'Sócio não encontrado.' };
  if (!socio.adimplente) {
    return { ok: false, motivo: 'Sócio inadimplente (atraso superior a 90 dias). Regularize no setor financeiro.' };
  }
  if (socio.bloqueado_ate) {
    const hojeIso = hoje();
    if (socio.bloqueado_ate > hojeIso) {
      return { ok: false, motivo: `Sócio bloqueado para reservas até ${socio.bloqueado_ate} por infração de cancelamento.` };
    }
  }
  return { ok: true };
}

// Lista disponibilidade para uma data: retorna por espaço o que está livre.
function disponibilidade(dataIso) {
  if (!clubeAbertoNoDia(dataIso)) {
    return { aberto: false, motivo: 'Clube fechado às segundas-feiras (limpeza/manutenção).' };
  }
  const espacos = db.prepare('SELECT * FROM espacos WHERE ativo = 1 ORDER BY id').all();
  const reservas = db.prepare(`
    SELECT r.*, e.codigo as espaco_codigo, e.modo_reserva
    FROM reservas r JOIN espacos e ON e.id = r.espaco_id
    WHERE r.data = ? AND r.status = 'confirmada'
  `).all(dataIso);

  const result = { aberto: true, data: dataIso, espacos: [] };
  for (const esp of espacos) {
    const rs = reservas.filter(r => r.espaco_id === esp.id);
    if (esp.modo_reserva === 'periodo') {
      const ocupado = { diurno: false, noturno: false };
      rs.forEach(r => { if (r.periodo) ocupado[r.periodo] = true; });
      result.espacos.push({
        id: esp.id, codigo: esp.codigo, nome: esp.nome, tipo: esp.tipo,
        modo: 'periodo', conjugado_com: esp.conjugado_com,
        taxa_limpeza: esp.taxa_limpeza,
        slots: PERIODOS.map(p => ({ periodo: p, disponivel: !ocupado[p] }))
      });
    } else {
      // Por hora: gerar slots de 1h (07:00–22:00)
      const horas = [];
      for (let h = 7; h < 22; h++) {
        const ini = String(h).padStart(2, '0') + ':00';
        const fim = String(h + 1).padStart(2, '0') + ':00';
        const reservado = rs.some(r => r.hora_inicio === ini);
        horas.push({ hora_inicio: ini, hora_fim: fim, disponivel: !reservado });
      }
      result.espacos.push({
        id: esp.id, codigo: esp.codigo, nome: esp.nome, tipo: esp.tipo,
        modo: 'hora', taxa_limpeza: esp.taxa_limpeza,
        slots: horas
      });
    }
  }
  return result;
}

// Limite: máximo 2 churrasqueiras simultâneas no mesmo período/data.
function validarLimiteChurrasqueiras(socioId, dataIso, periodo, novoEspacoId) {
  const count = db.prepare(`
    SELECT COUNT(*) as n
    FROM reservas r JOIN espacos e ON e.id = r.espaco_id
    WHERE r.socio_id = ? AND r.data = ? AND r.periodo = ?
      AND r.status = 'confirmada' AND e.tipo = 'churrasqueira'
      AND r.espaco_id != ?
  `).get(socioId, dataIso, periodo, novoEspacoId || 0).n;
  if (count >= 2) {
    return { ok: false, motivo: 'Limite de 2 churrasqueiras simultâneas atingido para este período.' };
  }
  return { ok: true };
}

function criarReserva({ socioId, espacoId, data, periodo, horaInicio, horaFim, termo, ip }) {
  const socio = getSocio(socioId);
  const v = validarSocio(socio);
  if (!v.ok) return { ok: false, erro: v.motivo };

  const espaco = getEspaco(espacoId);
  if (!espaco) return { ok: false, erro: 'Espaço inválido.' };

  if (data < hoje()) return { ok: false, erro: 'Data no passado.' };
  if (!clubeAbertoNoDia(data)) {
    return { ok: false, erro: 'Clube fechado às segundas-feiras.' };
  }

  if (!termo || !termo.artigo1 || !termo.artigo2 || !termo.artigo3) {
    return { ok: false, erro: 'É necessário aceitar os 3 artigos do termo de uso.' };
  }

  if (espaco.modo_reserva === 'periodo') {
    if (!PERIODOS.includes(periodo)) return { ok: false, erro: 'Período inválido.' };
    // Slot ocupado?
    const ja = db.prepare(`
      SELECT 1 FROM reservas WHERE espaco_id = ? AND data = ? AND periodo = ? AND status = 'confirmada'
    `).get(espacoId, data, periodo);
    if (ja) return { ok: false, erro: 'Espaço já reservado neste período.' };

    if (espaco.tipo === 'churrasqueira') {
      const lim = validarLimiteChurrasqueiras(socioId, data, periodo, espacoId);
      if (!lim.ok) return { ok: false, erro: lim.motivo };
    }
  } else {
    if (!horaInicio || !horaFim) return { ok: false, erro: 'Informe hora de início e fim.' };
    const ja = db.prepare(`
      SELECT 1 FROM reservas WHERE espaco_id = ? AND data = ? AND hora_inicio = ? AND status = 'confirmada'
    `).get(espacoId, data, horaInicio);
    if (ja) return { ok: false, erro: 'Horário já reservado.' };
  }

  const info = db.prepare(`
    INSERT INTO reservas (socio_id, espaco_id, data, periodo, hora_inicio, hora_fim, termo_aceito)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(socioId, espacoId, data, periodo || null, horaInicio || null, horaFim || null);

  const reservaId = info.lastInsertRowid;

  db.prepare(`
    INSERT INTO termo_aceite (socio_id, reserva_id, artigo1, artigo2, artigo3, ip)
    VALUES (?, ?, 1, 1, 1, ?)
  `).run(socioId, reservaId, ip || null);

  db.prepare(`
    INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip)
    VALUES (?, 'criar_reserva', 'reserva', ?, ?, ?)
  `).run(socioId, reservaId, JSON.stringify({ espaco: espaco.codigo, data, periodo, horaInicio }), ip || null);

  return { ok: true, reserva_id: reservaId, taxa_limpeza: espaco.taxa_limpeza };
}

// Cancelamento dentro do prazo?  diurno: até 09:00; noturno: até 17:00 do dia anterior.
function dentroDoPrazo(reserva) {
  const hojeIso = hoje();
  const agora = agoraHoraMin();
  if (reserva.data > hojeIso) return true;          // futuro: sempre no prazo
  if (reserva.data < hojeIso) return false;         // passado
  // Mesmo dia:
  if (reserva.periodo) {
    const limite = PERIODO_LIMITE_CANCEL[reserva.periodo];
    return agora <= limite;
  }
  // Por hora: deve cancelar pelo menos 2h antes
  return agora + ':00' < reserva.hora_inicio;
}

function calcularNivelInfracao(socioId) {
  // Conta infrações nos últimos 365 dias.
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM infracoes
    WHERE socio_id = ? AND date(criada_em) >= date('now', '-365 days')
  `).get(socioId);
  const proximaInfracao = row.n + 1;
  if (proximaInfracao === 1) return { nivel: 1, percentual: 30, valor: +(VALOR_BASE_INFRACAO * 0.30).toFixed(2) };
  if (proximaInfracao === 2) return { nivel: 2, percentual: 60, valor: +(VALOR_BASE_INFRACAO * 0.60).toFixed(2) };
  return { nivel: 3, percentual: 100, valor: VALOR_BASE_INFRACAO };
}

function cancelarReserva({ reservaId, socioId, ip, porAdmin = false }) {
  const reserva = db.prepare('SELECT * FROM reservas WHERE id = ?').get(reservaId);
  if (!reserva) return { ok: false, erro: 'Reserva não encontrada.' };
  if (reserva.status !== 'confirmada') return { ok: false, erro: 'Reserva já cancelada.' };
  if (!porAdmin && reserva.socio_id !== socioId) return { ok: false, erro: 'Você só pode cancelar suas próprias reservas.' };

  const dentro = dentroDoPrazo(reserva);
  let infracao = null;

  if (!dentro && !porAdmin) {
    const calc = calcularNivelInfracao(reserva.socio_id);
    const dataBloq = new Date();
    dataBloq.setDate(dataBloq.getDate() + 30);
    const bloqIso = dataBloq.toISOString().slice(0, 10);

    db.prepare(`
      INSERT INTO infracoes (socio_id, reserva_id, nivel, percentual, valor, motivo)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(reserva.socio_id, reserva.id, calc.nivel, calc.percentual, calc.valor, 'Cancelamento fora do prazo');

    db.prepare('UPDATE socios SET bloqueado_ate = ? WHERE id = ?').run(bloqIso, reserva.socio_id);
    infracao = { ...calc, bloqueado_ate: bloqIso };
  }

  db.prepare(`
    UPDATE reservas SET status = 'cancelada', cancelado_em = CURRENT_TIMESTAMP, cancelado_por = ?
    WHERE id = ?
  `).run(socioId || null, reservaId);

  db.prepare(`
    INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip)
    VALUES (?, ?, 'reserva', ?, ?, ?)
  `).run(
    socioId || reserva.socio_id,
    porAdmin ? 'cancelar_reserva_admin' : 'cancelar_reserva',
    reservaId,
    JSON.stringify({ dentro_prazo: dentro, infracao }),
    ip || null
  );

  return { ok: true, dentro_prazo: dentro, infracao };
}

function listarReservasSocio(socioId) {
  return db.prepare(`
    SELECT r.*, e.codigo as espaco_codigo, e.nome as espaco_nome, e.tipo as espaco_tipo, e.taxa_limpeza
    FROM reservas r JOIN espacos e ON e.id = r.espaco_id
    WHERE r.socio_id = ?
    ORDER BY r.data DESC, r.criado_em DESC
  `).all(socioId);
}

function listarTodasReservas(filtro = {}) {
  let sql = `
    SELECT r.*, e.codigo as espaco_codigo, e.nome as espaco_nome, e.tipo as espaco_tipo,
           s.matricula, s.nome as socio_nome
    FROM reservas r
    JOIN espacos e ON e.id = r.espaco_id
    JOIN socios s ON s.id = r.socio_id
    WHERE 1=1
  `;
  const params = [];
  if (filtro.data) { sql += ' AND r.data = ?'; params.push(filtro.data); }
  if (filtro.status) { sql += ' AND r.status = ?'; params.push(filtro.status); }
  sql += ' ORDER BY r.data DESC, r.criado_em DESC LIMIT 500';
  return db.prepare(sql).all(...params);
}

function listarInfracoes() {
  return db.prepare(`
    SELECT i.*, s.matricula, s.nome as socio_nome
    FROM infracoes i JOIN socios s ON s.id = i.socio_id
    ORDER BY i.criada_em DESC LIMIT 200
  `).all();
}

function listarAuditLog() {
  return db.prepare(`
    SELECT a.*, s.matricula, s.nome as socio_nome
    FROM audit_log a LEFT JOIN socios s ON s.id = a.socio_id
    ORDER BY a.criado_em DESC LIMIT 200
  `).all();
}

function listarSocios() {
  return db.prepare(`
    SELECT id, matricula, nome, email, telefone, papel, adimplente, bloqueado_ate
    FROM socios ORDER BY matricula
  `).all();
}

// ===== Cadastro de sócios =====
function normalizarMatricula(m) {
  if (m === null || m === undefined) return '';
  return String(m).trim().replace(/\s+/g, '');
}

function senhaPadrao(matricula) {
  // Default usa os últimos dígitos da matrícula + "aqua" → fácil de comunicar e única o suficiente.
  const m = normalizarMatricula(matricula);
  return (m || 'novo') + '@aqua';
}

function criarSocio({ matricula, nome, cpf, email, telefone, senha, papel = 'socio', adimplente = 1, adminId = null, ip = null }) {
  matricula = normalizarMatricula(matricula);
  nome = (nome || '').trim();
  if (!matricula) return { ok: false, erro: 'Matrícula é obrigatória.' };
  if (!nome) return { ok: false, erro: 'Nome é obrigatório.' };

  const existe = db.prepare('SELECT id FROM socios WHERE matricula = ?').get(matricula);
  if (existe) return { ok: false, erro: `Matrícula ${matricula} já cadastrada.` };

  const senhaFinal = (senha && String(senha).trim()) ? String(senha).trim() : senhaPadrao(matricula);
  const hash = bcrypt.hashSync(senhaFinal, 10);

  const info = db.prepare(`
    INSERT INTO socios (matricula, nome, cpf, email, telefone, senha_hash, papel, adimplente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(matricula, nome, (cpf || '').trim() || null, (email || '').trim() || null,
         (telefone || '').trim() || null, hash, papel === 'admin' ? 'admin' : 'socio',
         adimplente ? 1 : 0);

  db.prepare(`
    INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip)
    VALUES (?, 'criar_socio', 'socio', ?, ?, ?)
  `).run(adminId, info.lastInsertRowid, JSON.stringify({ matricula, nome }), ip);

  return {
    ok: true,
    socio_id: info.lastInsertRowid,
    matricula,
    senha_inicial: senha ? null : senhaFinal,  // só retorna se foi gerada
  };
}

function importarSociosLote(linhas, { adminId = null, ip = null } = {}) {
  // linhas: array de objetos com chaves { matricula, nome, cpf, email, telefone, senha, papel, adimplente }
  const resumo = {
    total: linhas.length,
    criados: 0,
    ignorados: 0,
    erros: [],
    criados_detalhes: [],
  };
  const tx = db.transaction((items) => {
    for (let i = 0; i < items.length; i++) {
      const linha = items[i];
      const r = criarSocio({
        matricula: linha.matricula,
        nome: linha.nome,
        cpf: linha.cpf,
        email: linha.email,
        telefone: linha.telefone,
        senha: linha.senha,
        papel: linha.papel || 'socio',
        adimplente: linha.adimplente === undefined ? 1 : (Number(linha.adimplente) ? 1 : 0),
        adminId, ip,
      });
      if (r.ok) {
        resumo.criados++;
        resumo.criados_detalhes.push({
          linha: i + 2, // +2 pois excel tem header na linha 1
          matricula: r.matricula,
          senha_inicial: r.senha_inicial,
        });
      } else {
        resumo.ignorados++;
        resumo.erros.push({ linha: i + 2, matricula: linha.matricula, erro: r.erro });
      }
    }
  });
  tx(linhas);
  return resumo;
}

module.exports = {
  VALOR_BASE_INFRACAO,
  hoje,
  disponibilidade,
  criarReserva,
  cancelarReserva,
  listarReservasSocio,
  listarTodasReservas,
  listarInfracoes,
  listarAuditLog,
  listarSocios,
  getEspacoPorCodigo,
  validarSocio,
  getSocio,
  criarSocio,
  importarSociosLote,
};
