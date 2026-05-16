require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const XLSX = require('xlsx');
const db = require('./db');
const regras = require('./regras');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
});

const PASTA_ESPACOS = path.join(__dirname, 'public', 'img', 'espacos');
fs.mkdirSync(PASTA_ESPACOS, { recursive: true });

const uploadFoto = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, PASTA_ESPACOS),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname).toLowerCase() || '.jpg')
        .replace(/[^a-z0-9.]/g, '');
      cb(null, `${req.params.codigo}-${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(jpeg|png|webp|jpg)/i.test(file.mimetype);
    cb(ok ? null : new Error('Apenas imagens JPG, PNG ou WEBP.'), ok);
  }
});

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

// Upload de foto por espaço (admin)
app.post('/api/admin/espacos/:codigo/foto', exigeLogin, exigeAdmin, (req, res) => {
  uploadFoto.single('foto')(req, res, (err) => {
    if (err) return res.status(400).json({ erro: err.message });
    if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo no campo "foto".' });
    const esp = db.prepare('SELECT * FROM espacos WHERE codigo = ?').get(req.params.codigo);
    if (!esp) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ erro: 'Espaço não encontrado.' });
    }
    // Remove foto antiga (se houver)
    if (esp.foto_url) {
      const antiga = path.join(__dirname, 'public', esp.foto_url.replace(/^\//, ''));
      if (fs.existsSync(antiga)) { try { fs.unlinkSync(antiga); } catch {} }
    }
    const fotoUrl = '/img/espacos/' + req.file.filename;
    db.prepare('UPDATE espacos SET foto_url = ? WHERE codigo = ?').run(fotoUrl, req.params.codigo);
    db.prepare(`INSERT INTO audit_log (socio_id, acao, entidade, entidade_id, detalhes, ip) VALUES (?, 'upload_foto_espaco', 'espaco', ?, ?, ?)`)
      .run(req.session.userId, esp.id, JSON.stringify({ codigo: esp.codigo, foto_url: fotoUrl }), ip(req));
    res.json({ ok: true, foto_url: fotoUrl });
  });
});

// Remover foto
app.delete('/api/admin/espacos/:codigo/foto', exigeLogin, exigeAdmin, (req, res) => {
  const esp = db.prepare('SELECT * FROM espacos WHERE codigo = ?').get(req.params.codigo);
  if (!esp) return res.status(404).json({ erro: 'Espaço não encontrado.' });
  if (esp.foto_url) {
    const arq = path.join(__dirname, 'public', esp.foto_url.replace(/^\//, ''));
    if (fs.existsSync(arq)) { try { fs.unlinkSync(arq); } catch {} }
  }
  db.prepare('UPDATE espacos SET foto_url = NULL WHERE codigo = ?').run(req.params.codigo);
  res.json({ ok: true });
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
// Cadastro individual
app.post('/api/admin/socios', exigeLogin, exigeAdmin, (req, res) => {
  const r = regras.criarSocio({ ...req.body, adminId: req.session.userId, ip: ip(req) });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

// Template de importação (.xlsx)
app.get('/api/admin/socios/template', exigeLogin, exigeAdmin, (_req, res) => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['matricula', 'nome', 'cpf', 'email', 'telefone', 'senha', 'papel', 'adimplente'],
    ['1010', 'Nome Sócio Exemplo', '111.222.333-44', 'email@exemplo.com', '(54) 99999-0000', '', 'socio', 1],
    ['1011', 'Outro Sócio', '555.666.777-88', '', '', '', 'socio', 1],
  ]);
  ws['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 16 }, { wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 8 }, { wch: 12 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'socios');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' });
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-importacao-socios.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// Importação em massa (.xlsx)
app.post('/api/admin/socios/importar', exigeLogin, exigeAdmin, upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Envie um arquivo .xlsx no campo "arquivo".' });
  let linhas;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    linhas = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  } catch (e) {
    return res.status(400).json({ erro: 'Não foi possível ler o arquivo. Confirme que é um .xlsx válido.' });
  }
  if (!linhas.length) return res.status(400).json({ erro: 'Planilha vazia ou sem cabeçalho.' });

  // Normaliza chaves (lowercase + remove acentos)
  const norm = (s) => String(s || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const ALIAS = {
    matricula: 'matricula', 'matrícula': 'matricula',
    nome: 'nome', 'nome_completo': 'nome', 'nome completo': 'nome',
    cpf: 'cpf',
    email: 'email', 'e-mail': 'email',
    telefone: 'telefone', 'celular': 'telefone', 'fone': 'telefone',
    senha: 'senha',
    papel: 'papel', 'perfil': 'papel', 'tipo': 'papel',
    adimplente: 'adimplente',
  };
  const linhasNorm = linhas.map(obj => {
    const out = {};
    for (const k of Object.keys(obj)) {
      const nk = ALIAS[norm(k)];
      if (nk) out[nk] = obj[k];
    }
    return out;
  });

  const resumo = regras.importarSociosLote(linhasNorm, { adminId: req.session.userId, ip: ip(req) });
  res.json(resumo);
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
