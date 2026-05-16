require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('./db');
const regras = require('./regras');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'aquarius-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 8, // 8h
  },
}));

// Servir frontend
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Auth helpers ----------
function exigeLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ erro: 'Não autenticado.' });
  next();
}
function exigeAdmin(req, res, next) {
  if (req.session.papel !== 'admin') return res.status(403).json({ erro: 'Acesso restrito.' });
  next();
}
function ip(req) { return req.ip || req.connection?.remoteAddress || null; }

// ---------- Auth ----------
app.post('/api/login', (req, res) => {
  const { matricula, senha } = req.body || {};
  const socio = db.prepare('SELECT * FROM socios WHERE matricula = ?').get(matricula);
  if (!socio || !bcrypt.compareSync(senha || '', socio.senha_hash)) {
    return res.status(401).json({ erro: 'Matrícula ou senha inválidos.' });
  }
  req.session.userId = socio.id;
  req.session.papel = socio.papel;
  req.session.nome = socio.nome;
  req.session.matricula = socio.matricula;
  db.prepare(`INSERT INTO audit_log (socio_id, acao, ip) VALUES (?, 'login', ?)`).run(socio.id, ip(req));
  res.json({
    ok: true,
    socio: { id: socio.id, matricula: socio.matricula, nome: socio.nome, papel: socio.papel,
             adimplente: !!socio.adimplente, bloqueado_ate: socio.bloqueado_ate }
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ erro: 'Não autenticado.' });
  const s = regras.getSocio(req.session.userId);
  res.json({
    id: s.id, matricula: s.matricula, nome: s.nome, papel: s.papel,
    adimplente: !!s.adimplente, bloqueado_ate: s.bloqueado_ate
  });
});

// ---------- Espaços / disponibilidade ----------
app.get('/api/espacos', (_req, res) => {
  res.json(db.prepare('SELECT * FROM espacos WHERE ativo = 1 ORDER BY id').all());
});

app.get('/api/disponibilidade', exigeLogin, (req, res) => {
  const data = req.query.data;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data || '')) return res.status(400).json({ erro: 'Data inválida.' });
  res.json(regras.disponibilidade(data));
});

// ---------- Reservas ----------
app.post('/api/reservas', exigeLogin, (req, res) => {
  const { espaco_id, data, periodo, hora_inicio, hora_fim, termo } = req.body || {};
  const r = regras.criarReserva({
    socioId: req.session.userId,
    espacoId: Number(espaco_id),
    data, periodo, horaInicio: hora_inicio, horaFim: hora_fim,
    termo, ip: ip(req),
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.get('/api/reservas/minhas', exigeLogin, (req, res) => {
  res.json(regras.listarReservasSocio(req.session.userId));
});

app.post('/api/reservas/:id/cancelar', exigeLogin, (req, res) => {
  const r = regras.cancelarReserva({
    reservaId: Number(req.params.id),
    socioId: req.session.userId,
    ip: ip(req),
    porAdmin: req.session.papel === 'admin' && req.body?.forcar === true,
  });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// ---------- Admin ----------
app.get('/api/admin/reservas', exigeLogin, exigeAdmin, (req, res) => {
  res.json(regras.listarTodasReservas({ data: req.query.data, status: req.query.status }));
});
app.get('/api/admin/infracoes', exigeLogin, exigeAdmin, (_req, res) => {
  res.json(regras.listarInfracoes());
});
app.get('/api/admin/audit', exigeLogin, exigeAdmin, (_req, res) => {
  res.json(regras.listarAuditLog());
});
app.get('/api/admin/socios', exigeLogin, exigeAdmin, (_req, res) => {
  res.json(regras.listarSocios());
});
app.post('/api/admin/socios/:id/desbloquear', exigeLogin, exigeAdmin, (req, res) => {
  db.prepare('UPDATE socios SET bloqueado_ate = NULL WHERE id = ?').run(Number(req.params.id));
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, ip) VALUES (?, 'desbloqueio_socio', 'socio', ?, ?)`)
    .run(req.session.userId, Number(req.params.id), ip(req));
  res.json({ ok: true });
});
app.post('/api/admin/socios/:id/adimplencia', exigeLogin, exigeAdmin, (req, res) => {
  const adimplente = req.body?.adimplente ? 1 : 0;
  db.prepare('UPDATE socios SET adimplente = ? WHERE id = ?').run(adimplente, Number(req.params.id));
  db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'mudar_adimplencia', 'socio', ?, ?, ?)`)
    .run(req.session.userId, Number(req.params.id), JSON.stringify({ adimplente }), ip(req));
  res.json({ ok: true });
});

// ---------- Rotas de páginas ----------
app.get('/admin', (req, res) => {
  if (req.session.papel !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/painel', (req, res) => {
  if (!req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'socio.html'));
});

app.listen(PORT, () => {
  console.log(`🌴 Aquárius Reservas rodando em http://localhost:${PORT}`);
});
