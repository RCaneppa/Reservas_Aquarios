const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'aquarius.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS socios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      matricula TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      cpf TEXT,
      email TEXT,
      telefone TEXT,
      senha_hash TEXT NOT NULL,
      papel TEXT NOT NULL DEFAULT 'socio',           -- 'socio' | 'admin'
      adimplente INTEGER NOT NULL DEFAULT 1,         -- 0/1; sócios > 90 dias atraso = 0
      bloqueado_ate TEXT,                            -- data ISO se bloqueado por infração
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS espacos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      tipo TEXT NOT NULL,                            -- 'churrasqueira' | 'salao' | 'campo' | 'quadra'
      modo_reserva TEXT NOT NULL,                    -- 'periodo' | 'hora'
      conjugado_com TEXT,                            -- código de outra churrasqueira (par)
      taxa_limpeza REAL NOT NULL DEFAULT 0,
      foto_url TEXT,                                 -- caminho da foto específica do espaço
      ativo INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS reservas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socio_id INTEGER NOT NULL,
      espaco_id INTEGER NOT NULL,
      data TEXT NOT NULL,                            -- YYYY-MM-DD
      periodo TEXT,                                  -- 'diurno' | 'noturno' (espaços por período)
      hora_inicio TEXT,                              -- HH:MM (espaços por hora)
      hora_fim TEXT,
      status TEXT NOT NULL DEFAULT 'confirmada',     -- 'confirmada' | 'cancelada'
      termo_aceito INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      cancelado_em TEXT,
      cancelado_por INTEGER,
      FOREIGN KEY(socio_id) REFERENCES socios(id),
      FOREIGN KEY(espaco_id) REFERENCES espacos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reservas_data ON reservas(data, status);
    CREATE INDEX IF NOT EXISTS idx_reservas_socio ON reservas(socio_id, status);

    CREATE TABLE IF NOT EXISTS infracoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socio_id INTEGER NOT NULL,
      reserva_id INTEGER,
      nivel INTEGER NOT NULL,                        -- 1, 2 ou 3
      percentual REAL NOT NULL,                      -- 30, 60 ou 100
      valor REAL NOT NULL,                           -- R$ aplicado
      motivo TEXT,
      criada_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(socio_id) REFERENCES socios(id),
      FOREIGN KEY(reserva_id) REFERENCES reservas(id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socio_id INTEGER,
      acao TEXT NOT NULL,
      entidade TEXT,
      entidade_id INTEGER,
      detalhes TEXT,
      ip TEXT,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comunicados (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      conteudo TEXT NOT NULL,
      destaque INTEGER NOT NULL DEFAULT 0,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_por INTEGER,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(criado_por) REFERENCES socios(id)
    );

    CREATE TABLE IF NOT EXISTS config_site (
      chave TEXT PRIMARY KEY,
      valor TEXT,
      atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS senha_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socio_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expira_em TEXT NOT NULL,
      usado INTEGER NOT NULL DEFAULT 0,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(socio_id) REFERENCES socios(id)
    );
    CREATE INDEX IF NOT EXISTS idx_reset_token ON senha_reset_tokens(token);

    CREATE TABLE IF NOT EXISTS termo_aceite (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      socio_id INTEGER NOT NULL,
      reserva_id INTEGER NOT NULL,
      artigo1 INTEGER NOT NULL,
      artigo2 INTEGER NOT NULL,
      artigo3 INTEGER NOT NULL,
      aceito_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      FOREIGN KEY(socio_id) REFERENCES socios(id),
      FOREIGN KEY(reserva_id) REFERENCES reservas(id)
    );
  `);
}

function migrar() {
  // Migrações idempotentes para bases já existentes
  const colsEspacos = db.prepare("PRAGMA table_info(espacos)").all();
  if (!colsEspacos.find(c => c.name === 'foto_url')) {
    db.exec("ALTER TABLE espacos ADD COLUMN foto_url TEXT");
  }
}

function seed() {
  const countSocios = db.prepare('SELECT COUNT(*) as n FROM socios').get().n;
  if (countSocios === 0) {
    const insertSocio = db.prepare(`
      INSERT INTO socios (matricula, nome, cpf, email, telefone, senha_hash, papel, adimplente)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const hash = (s) => bcrypt.hashSync(s, 10);
    insertSocio.run('0001', 'Administração Aquárius', '000.000.000-00', 'admin@aquarius.com.br', '(00) 0000-0000', hash('admin123'), 'admin', 1);
    insertSocio.run('1001', 'Rodrigo Caneppa', '111.111.111-11', 'rodrigo@example.com', '(54) 99999-0001', hash('123456'), 'socio', 1);
    insertSocio.run('1002', 'Maria Silva', '222.222.222-22', 'maria@example.com', '(54) 99999-0002', hash('123456'), 'socio', 1);
    insertSocio.run('1003', 'João Souza', '333.333.333-33', 'joao@example.com', '(54) 99999-0003', hash('123456'), 'socio', 1);
    insertSocio.run('1004', 'Ana Costa (inadimplente)', '444.444.444-44', 'ana@example.com', '(54) 99999-0004', hash('123456'), 'socio', 0);
  }

  const countEspacos = db.prepare('SELECT COUNT(*) as n FROM espacos').get().n;
  if (countEspacos === 0) {
    const insertEspaco = db.prepare(`
      INSERT INTO espacos (codigo, nome, tipo, modo_reserva, conjugado_com, taxa_limpeza)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // 9 churrasqueiras (4+5 e 6+7 conjugadas — flexíveis)
    for (let i = 1; i <= 9; i++) {
      let conj = null;
      if (i === 4) conj = 'CH5';
      if (i === 5) conj = 'CH4';
      if (i === 6) conj = 'CH7';
      if (i === 7) conj = 'CH6';
      insertEspaco.run(`CH${i}`, `Churrasqueira ${i}`, 'churrasqueira', 'periodo', conj, 0);
    }
    insertEspaco.run('SF1', 'Salão de Festas', 'salao', 'periodo', null, 70);
    insertEspaco.run('CF1', 'Campo de Futebol', 'campo', 'hora', null, 0);
    insertEspaco.run('QA1', 'Quadra de Areia', 'quadra', 'hora', null, 0);
  }
}

if (require.main === module && process.argv.includes('--seed')) {
  init();
  migrar();
  seed();
  console.log('✓ Banco inicializado e populado.');
  process.exit(0);
}

init();
migrar();
seed();

module.exports = db;
