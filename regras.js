// Regras de negócio do sistema de reservas Aquárius.
const db = require('./db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
        taxa_limpeza: esp.taxa_limpeza, foto_url: esp.foto_url,
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
        modo: 'hora', taxa_limpeza: esp.taxa_limpeza, foto_url: esp.foto_url,
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

// Aplica infração manual (admin). Se nivel não informado, calcula automaticamente.
function aplicarInfracaoManual({ socioId, motivo, nivel, adminId, ip = null }) {
  const socio = getSocio(socioId);
  if (!socio) return { ok: false, erro: 'Sócio não encontrado.' };
  motivo = (motivo || '').trim();
  if (!motivo) return { ok: false, erro: 'Motivo da infração é obrigatório.' };

  let calc;
  if (nivel === 1 || nivel === 2 || nivel === 3) {
    const pct = nivel === 1 ? 30 : nivel === 2 ? 60 : 100;
    calc = { nivel, percentual: pct, valor: +(VALOR_BASE_INFRACAO * pct / 100).toFixed(2) };
  } else {
    calc = calcularNivelInfracao(socioId);
  }

  const dataBloq = new Date();
  dataBloq.setDate(dataBloq.getDate() + 30);
  const bloqIso = dataBloq.toISOString().slice(0, 10);

  const info = db.prepare(`
    INSERT INTO infracoes (socio_id, reserva_id, nivel, percentual, valor, motivo, aplicada_por, bloqueado_ate)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(socioId, calc.nivel, calc.percentual, calc.valor, motivo, adminId, bloqIso);

  // Aplica/estende bloqueio se for posterior ao atual
  const atualBloq = socio.bloqueado_ate;
  if (!atualBloq || bloqIso > atualBloq) {
    db.prepare('UPDATE socios SET bloqueado_ate = ? WHERE id = ?').run(bloqIso, socioId);
  }

  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'aplicar_infracao_manual', 'infracao', ?, ?, ?)`)
    .run(adminId, info.lastInsertRowid, JSON.stringify({ socio_id: socioId, nivel: calc.nivel, motivo, bloqueado_ate: bloqIso }), ip);

  return {
    ok: true,
    infracao_id: info.lastInsertRowid,
    nivel: calc.nivel, percentual: calc.percentual, valor: calc.valor,
    bloqueado_ate: bloqIso,
  };
}

function listarInfracoesDoSocio(socioId) {
  return db.prepare(`
    SELECT i.*,
           r.data as reserva_data, e.nome as espaco_nome,
           adm.nome as aplicada_por_nome
    FROM infracoes i
    LEFT JOIN reservas r ON r.id = i.reserva_id
    LEFT JOIN espacos e ON e.id = r.espaco_id
    LEFT JOIN socios adm ON adm.id = i.aplicada_por
    WHERE i.socio_id = ?
    ORDER BY i.criada_em DESC
  `).all(socioId);
}

function contarInfracoesNaoVistas(socioId) {
  return db.prepare(`SELECT COUNT(*) as n FROM infracoes WHERE socio_id = ? AND visualizada_em IS NULL`)
    .get(socioId).n;
}

function marcarInfracoesVisualizadas(socioId) {
  db.prepare(`UPDATE infracoes SET visualizada_em = CURRENT_TIMESTAMP WHERE socio_id = ? AND visualizada_em IS NULL`)
    .run(socioId);
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
      INSERT INTO infracoes (socio_id, reserva_id, nivel, percentual, valor, motivo, bloqueado_ate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(reserva.socio_id, reserva.id, calc.nivel, calc.percentual, calc.valor, 'Cancelamento fora do prazo', bloqIso);

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

function getSocioCompleto(id) {
  return db.prepare(`
    SELECT id, matricula, nome, cpf, email, telefone, papel, adimplente, bloqueado_ate, criado_em
    FROM socios WHERE id = ?
  `).get(id);
}

function atualizarSocio({ id, dados, adminId, ip = null }) {
  const socio = db.prepare('SELECT * FROM socios WHERE id = ?').get(id);
  if (!socio) return { ok: false, erro: 'Sócio não encontrado.' };

  const nome = (dados.nome ?? socio.nome).trim();
  if (!nome) return { ok: false, erro: 'Nome é obrigatório.' };

  const email = dados.email !== undefined ? (String(dados.email).trim() || null) : socio.email;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, erro: 'E-mail inválido.' };
  }

  const cpf = dados.cpf !== undefined ? (String(dados.cpf).trim() || null) : socio.cpf;
  const telefone = dados.telefone !== undefined ? (String(dados.telefone).trim() || null) : socio.telefone;
  const papel = dados.papel === 'admin' || dados.papel === 'socio' ? dados.papel : socio.papel;

  // Adimplência e bloqueio só se vierem explicitamente
  let adimplente = socio.adimplente;
  if (dados.adimplente !== undefined) adimplente = Number(dados.adimplente) ? 1 : 0;

  db.prepare(`
    UPDATE socios SET nome = ?, cpf = ?, email = ?, telefone = ?, papel = ?, adimplente = ?
    WHERE id = ?
  `).run(nome, cpf, email, telefone, papel, adimplente, id);

  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'editar_socio', 'socio', ?, ?, ?)`)
    .run(adminId, id, JSON.stringify({
      antes: { nome: socio.nome, email: socio.email, telefone: socio.telefone, papel: socio.papel, adimplente: socio.adimplente },
      depois: { nome, email, telefone, papel, adimplente }
    }), ip);

  return { ok: true };
}

function resetarSenhaSocio({ id, novaSenha, adminId, ip = null }) {
  const socio = db.prepare('SELECT * FROM socios WHERE id = ?').get(id);
  if (!socio) return { ok: false, erro: 'Sócio não encontrado.' };

  let senha = (novaSenha && String(novaSenha).trim()) ? String(novaSenha).trim() : null;
  if (!senha) {
    // Gera senha aleatória: matricula + 4 dígitos aleatórios
    const r = crypto.randomBytes(2).toString('hex');
    senha = `aqua${r}`;
  }
  if (senha.length < 6) return { ok: false, erro: 'Senha deve ter pelo menos 6 caracteres.' };

  const hash = bcrypt.hashSync(senha, 10);
  db.prepare('UPDATE socios SET senha_hash = ? WHERE id = ?').run(hash, id);
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, ip) VALUES (?, 'reset_senha_admin', 'socio', ?, ?)`)
    .run(adminId, id, ip);

  return { ok: true, senha_temporaria: senha };
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

// ===== Senha: alterar / recuperar =====
const MIN_SENHA = 6;

function alterarSenha({ socioId, senhaAtual, novaSenha, ip = null }) {
  const socio = getSocio(socioId);
  if (!socio) return { ok: false, erro: 'Sócio não encontrado.' };
  if (!bcrypt.compareSync(senhaAtual || '', socio.senha_hash)) {
    return { ok: false, erro: 'Senha atual incorreta.' };
  }
  if (!novaSenha || String(novaSenha).length < MIN_SENHA) {
    return { ok: false, erro: `Nova senha deve ter pelo menos ${MIN_SENHA} caracteres.` };
  }
  if (senhaAtual === novaSenha) {
    return { ok: false, erro: 'A nova senha deve ser diferente da atual.' };
  }
  const hash = bcrypt.hashSync(novaSenha, 10);
  db.prepare('UPDATE socios SET senha_hash = ? WHERE id = ?').run(hash, socioId);
  db.prepare(`INSERT INTO audit_log (socio_id, acao, ip) VALUES (?, 'alterar_senha', ?)`).run(socioId, ip);
  return { ok: true };
}

function gerarTokenReset({ identificador, ip = null }) {
  // identificador pode ser matrícula OU e-mail
  if (!identificador) return { ok: false, erro: 'Informe matrícula ou e-mail.' };
  const ident = String(identificador).trim();
  const socio = db.prepare(`
    SELECT * FROM socios WHERE matricula = ? OR LOWER(email) = LOWER(?)
  `).get(ident, ident);

  // Por segurança, sempre retornar sucesso — sem revelar se o registro existe.
  if (!socio) return { ok: true, socio: null };

  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h
  db.prepare(`
    INSERT INTO senha_reset_tokens (socio_id, token, expira_em) VALUES (?, ?, ?)
  `).run(socio.id, token, expira);
  db.prepare(`INSERT INTO audit_log (socio_id, acao, ip) VALUES (?, 'solicitar_reset_senha', ?)`).run(socio.id, ip);
  return { ok: true, socio, token, expira };
}

function consumirTokenReset({ token, novaSenha, ip = null }) {
  if (!token) return { ok: false, erro: 'Token inválido.' };
  const reg = db.prepare('SELECT * FROM senha_reset_tokens WHERE token = ?').get(token);
  if (!reg) return { ok: false, erro: 'Token inválido ou já utilizado.' };
  if (reg.usado) return { ok: false, erro: 'Token já utilizado. Solicite novo link.' };
  if (new Date(reg.expira_em) < new Date()) {
    return { ok: false, erro: 'Token expirado. Solicite novo link.' };
  }
  if (!novaSenha || String(novaSenha).length < MIN_SENHA) {
    return { ok: false, erro: `Nova senha deve ter pelo menos ${MIN_SENHA} caracteres.` };
  }
  const hash = bcrypt.hashSync(novaSenha, 10);
  const tx = db.transaction(() => {
    db.prepare('UPDATE socios SET senha_hash = ? WHERE id = ?').run(hash, reg.socio_id);
    db.prepare('UPDATE senha_reset_tokens SET usado = 1 WHERE id = ?').run(reg.id);
    db.prepare(`INSERT INTO audit_log (socio_id, acao, ip) VALUES (?, 'redefinir_senha', ?)`).run(reg.socio_id, ip);
  });
  tx();
  return { ok: true, socio_id: reg.socio_id };
}

// ===== Comunicados =====
function listarComunicadosAtivos() {
  return db.prepare(`
    SELECT id, titulo, conteudo, destaque, criado_em
    FROM comunicados WHERE ativo = 1
    ORDER BY destaque DESC, criado_em DESC LIMIT 50
  `).all();
}
function listarTodosComunicados() {
  return db.prepare(`
    SELECT c.*, s.nome as criado_por_nome
    FROM comunicados c LEFT JOIN socios s ON s.id = c.criado_por
    ORDER BY c.criado_em DESC LIMIT 100
  `).all();
}
function criarComunicado({ titulo, conteudo, destaque, criadoPor, ip = null }) {
  titulo = (titulo || '').trim();
  conteudo = (conteudo || '').trim();
  if (!titulo) return { ok: false, erro: 'Título é obrigatório.' };
  if (!conteudo) return { ok: false, erro: 'Conteúdo é obrigatório.' };
  const info = db.prepare(`
    INSERT INTO comunicados (titulo, conteudo, destaque, criado_por)
    VALUES (?, ?, ?, ?)
  `).run(titulo, conteudo, destaque ? 1 : 0, criadoPor);
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'criar_comunicado', 'comunicado', ?, ?, ?)`)
    .run(criadoPor, info.lastInsertRowid, JSON.stringify({ titulo }), ip);
  return { ok: true, id: info.lastInsertRowid };
}
function alterarComunicado({ id, titulo, conteudo, destaque, ativo, adminId, ip = null }) {
  const c = db.prepare('SELECT * FROM comunicados WHERE id = ?').get(id);
  if (!c) return { ok: false, erro: 'Comunicado não encontrado.' };
  db.prepare(`
    UPDATE comunicados SET titulo = ?, conteudo = ?, destaque = ?, ativo = ? WHERE id = ?
  `).run(
    titulo ?? c.titulo, conteudo ?? c.conteudo,
    destaque === undefined ? c.destaque : (destaque ? 1 : 0),
    ativo === undefined ? c.ativo : (ativo ? 1 : 0),
    id
  );
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, ip) VALUES (?, 'alterar_comunicado', 'comunicado', ?, ?)`).run(adminId, id, ip);
  return { ok: true };
}
function removerComunicado({ id, adminId, ip = null }) {
  const r = db.prepare('DELETE FROM comunicados WHERE id = ?').run(id);
  if (!r.changes) return { ok: false, erro: 'Comunicado não encontrado.' };
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, ip) VALUES (?, 'remover_comunicado', 'comunicado', ?, ?)`).run(adminId, id, ip);
  return { ok: true };
}

// ===== Configurações de aparência =====
function getConfig(chave) {
  const row = db.prepare('SELECT valor FROM config_site WHERE chave = ?').get(chave);
  return row ? row.valor : null;
}
function setConfig(chave, valor) {
  db.prepare(`
    INSERT INTO config_site (chave, valor) VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor, atualizado_em = CURRENT_TIMESTAMP
  `).run(chave, valor);
}
function getAparencia() {
  return {
    logo_url: getConfig('logo_url'),
    banner_url: getConfig('banner_url') || '/img/banner-padrao.jpg',
  };
}

// ===== Carga delta de adimplência =====
function importarAdimplenciaLote(linhas, { adminId = null, ip = null } = {}) {
  const resumo = {
    total: linhas.length,
    atualizados: 0,
    inalterados: 0,
    nao_encontrados: 0,
    erros: [],
    detalhes: [],
  };
  const tx = db.transaction((items) => {
    for (let i = 0; i < items.length; i++) {
      const raw = items[i];
      const matricula = normalizarMatricula(raw.matricula);
      const linhaNum = i + 2;
      if (!matricula) {
        resumo.erros.push({ linha: linhaNum, erro: 'matricula ausente' });
        continue;
      }
      const val = String(raw.adimplente ?? raw.status ?? '').trim().toLowerCase();
      let novo;
      if (['1', 'sim', 's', 'true', 'em dia', 'adimplente', 'ok'].includes(val)) novo = 1;
      else if (['0', 'nao', 'não', 'n', 'false', 'inadimplente', 'pendente'].includes(val)) novo = 0;
      else {
        resumo.erros.push({ linha: linhaNum, matricula, erro: `valor de adimplência inválido: "${raw.adimplente ?? raw.status}"` });
        continue;
      }
      const socio = db.prepare('SELECT id, adimplente, nome FROM socios WHERE matricula = ?').get(matricula);
      if (!socio) {
        resumo.nao_encontrados++;
        resumo.detalhes.push({ linha: linhaNum, matricula, status: 'não encontrado' });
        continue;
      }
      if (socio.adimplente === novo) {
        resumo.inalterados++;
        resumo.detalhes.push({ linha: linhaNum, matricula, nome: socio.nome, status: 'inalterado', adimplente: novo });
        continue;
      }
      db.prepare('UPDATE socios SET adimplente = ? WHERE id = ?').run(novo, socio.id);
      db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'importar_adimplencia', 'socio', ?, ?, ?)`)
        .run(adminId, socio.id, JSON.stringify({ matricula, de: socio.adimplente, para: novo }), ip);
      resumo.atualizados++;
      resumo.detalhes.push({ linha: linhaNum, matricula, nome: socio.nome, status: 'atualizado', de: socio.adimplente, para: novo });
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
  aplicarInfracaoManual,
  listarInfracoesDoSocio,
  contarInfracoesNaoVistas,
  marcarInfracoesVisualizadas,
  listarAuditLog,
  listarSocios,
  getEspacoPorCodigo,
  validarSocio,
  getSocio,
  criarSocio,
  getSocioCompleto,
  atualizarSocio,
  resetarSenhaSocio,
  importarSociosLote,
  alterarSenha,
  gerarTokenReset,
  consumirTokenReset,
  importarAdimplenciaLote,
  listarComunicadosAtivos,
  listarTodosComunicados,
  criarComunicado,
  alterarComunicado,
  removerComunicado,
  getAparencia,
  setConfig,
};
