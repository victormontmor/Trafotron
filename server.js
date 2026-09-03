require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const os = require('os');
const session = require('express-session');
const { Pool } = require('pg');
const pgSessionFactory = require('connect-pg-simple');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('');
  console.error('=================================================');
  console.error('  ERRO: variável DATABASE_URL não encontrada.');
  console.error('=================================================');
  console.error('  Crie um arquivo .env nesta pasta (copie o .env.example)');
  console.error('  e coloque a connection string do seu banco Postgres');
  console.error('  (ex: da Neon) na variável DATABASE_URL.');
  console.error('  Veja o README.md para o passo a passo.');
  console.error('=================================================');
  console.error('');
  process.exit(1);
}

if (!process.env.ADMIN_PASSWORD) {
  console.warn('');
  console.warn('=================================================');
  console.warn('  AVISO: ADMIN_PASSWORD não definida no .env.');
  console.warn('  Isso só é usado para criar a PRIMEIRA conta de');
  console.warn('  acesso (usuário "admin", senha "admin") — depois');
  console.warn('  disso, contas são geridas na aba "Usuários".');
  console.warn('  Troque a senha dessa conta assim que possível.');
  console.warn('=================================================');
  console.warn('');
}

if (!process.env.SESSION_SECRET) {
  console.warn('');
  console.warn('=================================================');
  console.warn('  AVISO: SESSION_SECRET não definida no .env.');
  console.warn('  Gerando uma chave temporária — todo mundo vai ser');
  console.warn('  desconectado sempre que o servidor reiniciar.');
  console.warn('  Defina uma fixa no .env para evitar isso.');
  console.warn('=================================================');
  console.warn('');
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- senha (hash com salt, sem depender de libs externas) ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuffer = Buffer.from(hash, 'hex');
  const suppliedBuffer = crypto.scryptSync(String(password), salt, 64);
  if (hashBuffer.length !== suppliedBuffer.length) return false;
  return crypto.timingSafeEqual(hashBuffer, suppliedBuffer);
}

const useSsl = !/sslmode=disable/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

const PgSession = pgSessionFactory(session);

app.set('trust proxy', 1);
app.use(express.json());

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: false }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 12 * 60 * 60 * 1000, // 12 horas
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.FORCE_SECURE_COOKIES === 'true'
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// ---------- inicialização do banco (cria tabelas se não existirem) ----------
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS overtime_records (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exit_time TEXT NOT NULL,
      date TEXT NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT false,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // migrações leves para bancos já existentes criados antes destas colunas
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS overtime_hours NUMERIC(6,2);`);
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS rate_per_hour NUMERIC(10,2);`);
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS reason TEXT;`);

  // índice para acelerar a listagem por mês (usa os 7 primeiros chars de 'YYYY-MM-DD')
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_overtime_records_month ON overtime_records (substring(date, 1, 7));`);

  // tabela de sessões de login (usada pelo connect-pg-simple)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      sid TEXT PRIMARY KEY,
      sess JSON NOT NULL,
      expire TIMESTAMPTZ NOT NULL
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions (expire);`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // tabela de funcionários cadastrados — independente dos lançamentos de horas,
  // então excluir/zerar horas nunca apaga o funcionário da lista.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // log de auditoria — quem fez o quê e quando
  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // contas de usuário reais (login individual) — cada pessoa tem seu próprio
  // usuário e senha (com hash, nunca em texto puro)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // migração leve: coluna que marca quem é administrador. Só administradores
  // podem ver/gerenciar a aba "Usuários" e a aba "Atividade" (log de auditoria).
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;`);

  // se ainda não existe nenhum usuário, cria a primeira conta (administrador)
  // usando ADMIN_USERNAME/ADMIN_PASSWORD do .env — só serve pra dar o primeiro
  // acesso; depois disso, contas são geridas pela aba "Usuários" do sistema
  const userCount = await pool.query('SELECT count(*)::int AS c FROM users');
  if (userCount.rows[0].c === 0) {
    const bootstrapUsername = process.env.ADMIN_USERNAME || 'admin';
    const bootstrapPassword = process.env.ADMIN_PASSWORD || 'admin';
    await pool.query(
      `INSERT INTO users (id, username, username_key, password_hash, name, is_admin) VALUES ($1, $2, $3, $4, $5, true)`,
      [generateId(), bootstrapUsername, bootstrapUsername.toLowerCase(), hashPassword(bootstrapPassword), 'Administrador']
    );
    console.log('');
    console.log('=================================================');
    console.log(`  Usuário administrador inicial criado: "${bootstrapUsername}"`);
    console.log('  Entre com ele e crie contas individuais para cada');
    console.log('  pessoa na aba "Usuários" — depois disso, considere');
    console.log('  trocar a senha desse usuário administrador também.');
    console.log('=================================================');
    console.log('');
  } else {
    // banco já existia antes da coluna is_admin: garante que continue
    // existindo pelo menos um administrador, sem promover ninguém à toa.
    const adminCount = await pool.query('SELECT count(*)::int AS c FROM users WHERE is_admin = true');
    if (adminCount.rows[0].c === 0) {
      const promoted = await pool.query(
        `UPDATE users SET is_admin = true WHERE username_key = 'admin' RETURNING username`
      );
      if (promoted.rowCount === 0) {
        // não existe usuário "admin": promove a conta mais antiga, pra
        // garantir que sempre haja alguém com acesso às abas de administração
        await pool.query(`
          UPDATE users SET is_admin = true
          WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
        `);
      }
    }
  }

  // migra automaticamente funcionários que já tinham lançamentos de horas
  // (bancos que já existiam antes desta tabela) para o novo cadastro
  const legacyNames = await pool.query(`SELECT DISTINCT trim(name) AS name FROM overtime_records WHERE trim(name) <> ''`);
  for (const row of legacyNames.rows) {
    await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3) ON CONFLICT (name_key) DO NOTHING`,
      [generateId(), row.name, row.name.toLowerCase()]
    );
  }

  // valores padrão de configuração, só se ainda não existirem
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('baseTime', '17:18')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('ratePerHour', '20')
    ON CONFLICT (key) DO NOTHING;
  `);

  // congela horas/valor de registros antigos que ainda não têm esses campos
  // preenchidos (bancos que existiam antes desta funcionalidade)
  const cfg = await getConfigInternal();
  const legacy = await pool.query(
    `SELECT id, exit_time FROM overtime_records WHERE overtime_hours IS NULL`
  );
  for (const row of legacy.rows) {
    const hours = computeOvertimeHours(row.exit_time, cfg.baseTime);
    await pool.query(
      `UPDATE overtime_records SET overtime_hours = $1, rate_per_hour = $2 WHERE id = $3`,
      [hours, cfg.ratePerHour, row.id]
    );
  }
}

// ---------- helpers ----------

async function getConfigInternal() {
  const result = await pool.query('SELECT key, value FROM app_config');
  const config = { baseTime: '17:18', ratePerHour: 20 };
  result.rows.forEach(row => {
    if (row.key === 'baseTime') config.baseTime = row.value;
    if (row.key === 'ratePerHour') config.ratePerHour = Number(row.value);
  });
  return config;
}

function timeToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

// mesma lógica usada no front-end para calcular a hora extra (múltiplos de 30 min)
function computeOvertimeHours(exitTime, baseTime) {
  const diff = timeToMinutes(exitTime) - timeToMinutes(baseTime);
  if (diff <= 0) return 0;
  const rawHours = diff / 60;
  return Math.round(rawHours * 2) / 2;
}

async function logAudit(actor, action, details) {
  try {
    await pool.query(
      'INSERT INTO audit_log (actor, action, details) VALUES ($1, $2, $3)',
      [actor || 'desconhecido', action, details || null]
    );
  } catch (e) {
    console.error('Falha ao registrar log de auditoria:', e.message);
  }
}

function mapRecord(r) {
  return {
    id: r.id,
    name: r.name,
    exitTime: r.exit_time,
    date: r.date,
    paid: r.paid,
    paidAt: r.paid_at,
    hours: r.overtime_hours !== null && r.overtime_hours !== undefined ? Number(r.overtime_hours) : null,
    ratePerHour: r.rate_per_hour !== null && r.rate_per_hour !== undefined ? Number(r.rate_per_hour) : null,
    reason: r.reason || ''
  };
}

const RECORD_FIELDS = `id, name, exit_time, date, paid, paid_at, overtime_hours, rate_per_hour, reason`;

// ---------- autenticação ----------

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
}

// só deixa passar quem é administrador — usado nas rotas de Usuários e Atividade
function requireAdmin(req, res, next) {
  if (req.session && req.session.authenticated && req.session.isAdmin) return next();
  res.status(403).json({ error: 'Só administradores podem acessar isso.' });
}

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};

    if (!username || !password) {
      return res.status(400).json({ error: 'Informe usuário e senha.' });
    }

    const result = await pool.query(
      'SELECT id, username, name, password_hash, is_admin FROM users WHERE username_key = $1',
      [String(username).trim().toLowerCase()]
    );

    // mensagem genérica de propósito (não revela se o usuário existe ou não)
    if (result.rowCount === 0 || !verifyPassword(password, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
    }

    const user = result.rows[0];
    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.name;
    req.session.isAdmin = !!user.is_admin;

    await logAudit(user.name, 'login', 'Acesso ao sistema');
    res.json({ success: true, username: user.username, displayName: user.name, isAdmin: !!user.is_admin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao entrar.' });
  }
});

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    username: (req.session && req.session.username) || null,
    displayName: (req.session && req.session.displayName) || null,
    isAdmin: !!(req.session && req.session.isAdmin)
  });
});

app.use('/api', requireAuth);

app.post('/api/logout', (req, res) => {
  const actor = req.session && req.session.displayName;
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
  if (actor) logAudit(actor, 'logout', 'Saiu do sistema');
});

// ---------- usuários do sistema (contas de login individuais) ----------

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, name, is_admin, created_at FROM users ORDER BY name ASC');
    res.json(result.rows.map(r => ({ id: r.id, username: r.username, name: r.name, isAdmin: r.is_admin, createdAt: r.created_at })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar usuários.' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { username, password, name } = req.body || {};
    if (!username || !String(username).trim() || !password || !name || !String(name).trim()) {
      return res.status(400).json({ error: 'Preencha nome, usuário e senha.' });
    }
    if (String(password).length < 4) {
      return res.status(400).json({ error: 'A senha precisa ter pelo menos 4 caracteres.' });
    }

    const trimmedUsername = String(username).trim();
    const usernameKey = trimmedUsername.toLowerCase();
    const trimmedName = String(name).trim();
    const id = generateId();

    const result = await pool.query(
      `INSERT INTO users (id, username, username_key, password_hash, name) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username_key) DO NOTHING
       RETURNING id, username, name, created_at`,
      [id, trimmedUsername, usernameKey, hashPassword(String(password)), trimmedName]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Esse nome de usuário já existe.' });
    }

    await logAudit(req.session.displayName, 'usuario_criado', `${trimmedName} (@${trimmedUsername})`);
    const created = result.rows[0];
    res.status(201).json({ id: created.id, username: created.username, name: created.name, createdAt: created.created_at });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao criar usuário.' });
  }
});

// remove uma conta de login. Não deixa remover a própria conta enquanto
// estiver logado nela, nem remover a última conta que existe no sistema.
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    if (req.params.id === req.session.userId) {
      return res.status(400).json({ error: 'Você não pode remover a própria conta enquanto estiver logado nela.' });
    }

    const countResult = await pool.query('SELECT count(*)::int AS c FROM users');
    if (countResult.rows[0].c <= 1) {
      return res.status(400).json({ error: 'Precisa existir pelo menos um usuário no sistema.' });
    }

    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING username, name', [req.params.id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    await logAudit(req.session.displayName, 'usuario_removido', `${result.rows[0].name} (@${result.rows[0].username})`);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao remover usuário.' });
  }
});

// troca a PRÓPRIA senha (exige confirmar a senha atual)
app.put('/api/users/me/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Preencha a senha atual e a nova senha.' });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 4 caracteres.' });
    }

    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }
    if (!verifyPassword(currentPassword, result.rows[0].password_hash)) {
      return res.status(401).json({ error: 'Senha atual incorreta.' });
    }

    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(String(newPassword)), req.session.userId]);
    await logAudit(req.session.displayName, 'senha_alterada', 'Trocou a própria senha');
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao trocar senha.' });
  }
});

// redefine a senha de OUTRO usuário (uso quando alguém esquece a senha —
// só administradores podem fazer isso agora, junto com o resto da gestão de usuários)
app.put('/api/users/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 4) {
      return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 4 caracteres.' });
    }

    const result = await pool.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING username, name',
      [hashPassword(String(newPassword)), req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    await logAudit(req.session.displayName, 'senha_redefinida', `Redefiniu a senha de ${result.rows[0].name} (@${result.rows[0].username})`);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao redefinir senha.' });
  }
});

// ---------- configuração (horário base da jornada e valor da hora extra) ----------

app.get('/api/config', async (req, res) => {
  try {
    const config = await getConfigInternal();
    res.json(config);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar configuração.' });
  }
});

app.put('/api/config', async (req, res) => {
  try {
    const { baseTime, ratePerHour } = req.body;
    if (baseTime) {
      await pool.query(
        `INSERT INTO app_config (key, value) VALUES ('baseTime', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [baseTime]
      );
    }
    if (typeof ratePerHour === 'number') {
      await pool.query(
        `INSERT INTO app_config (key, value) VALUES ('ratePerHour', $1)
         ON CONFLICT (key) DO UPDATE SET value = $1`,
        [String(ratePerHour)]
      );
    }
    const config = await getConfigInternal();
    await logAudit(req.session.displayName, 'configuracao_alterada', `horário-base: ${config.baseTime} · valor/hora: R$ ${config.ratePerHour}`);
    res.json(config);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar configuração.' });
  }
});

// ---------- funcionários (cadastro independente dos lançamentos de horas) ----------

app.get('/api/employees', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name FROM employees ORDER BY name_key ASC');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar funcionários.' });
  }
});

app.post('/api/employees', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Informe o nome do funcionário.' });
    }
    const trimmedName = String(name).trim();
    const nameKey = trimmedName.toLowerCase();
    const id = generateId();

    const result = await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO NOTHING
       RETURNING id, name`,
      [id, trimmedName, nameKey]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Esse funcionário já está cadastrado.' });
    }

    await logAudit(req.session.displayName, 'funcionario_cadastrado', trimmedName);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao cadastrar funcionário.' });
  }
});

// remover um funcionário do cadastro (uso administrativo, ex: nome duplicado/errado).
// Isso NÃO apaga os lançamentos de horas que já existem em nome dele.
app.delete('/api/employees/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM employees WHERE id = $1 RETURNING id, name',
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
    await logAudit(req.session.displayName, 'funcionario_removido', result.rows[0].name);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao remover funcionário.' });
  }
});

// histórico completo de horas (pagas e pendentes) de um funcionário específico,
// usado na aba Funcionários ao clicar no nome de alguém
app.get('/api/employee-records', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Informe o nome do funcionário.' });
    }
    const result = await pool.query(
      `SELECT ${RECORD_FIELDS}
       FROM overtime_records
       WHERE lower(trim(name)) = lower(trim($1))
       ORDER BY date DESC, created_at DESC`,
      [name]
    );
    res.json(result.rows.map(mapRecord));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar histórico do funcionário.' });
  }
});

// ---------- lançamentos de hora extra ----------

// listar registros de hora extra PENDENTES (ainda não pagos) — usado no dashboard/lançamentos
app.get('/api/records', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${RECORD_FIELDS} FROM overtime_records WHERE paid = false ORDER BY date DESC, created_at DESC`
    );
    res.json(result.rows.map(mapRecord));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar registros.' });
  }
});

// criar um novo registro — o valor da hora extra é calculado e SALVO agora
// (congelado), então não muda mais mesmo que a configuração mude depois
app.post('/api/records', async (req, res) => {
  try {
    const { name, exitTime, date, reason } = req.body;

    if (!name || !exitTime || !date) {
      return res.status(400).json({ error: 'Nome, horário de saída e data são obrigatórios.' });
    }

    const cfg = await getConfigInternal();
    const hours = computeOvertimeHours(exitTime, cfg.baseTime);

    if (hours <= 0) {
      return res.status(400).json({ error: `O horário de saída precisa ser depois das ${cfg.baseTime} para gerar hora extra.` });
    }

    const trimmedName = String(name).trim();
    const trimmedReason = reason ? String(reason).trim().slice(0, 500) : null;
    const id = generateId();

    // garante que o funcionário exista no cadastro, mesmo que o lançamento
    // tenha vindo de um nome ainda não cadastrado (evita perder o vínculo)
    await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO NOTHING`,
      [generateId(), trimmedName, trimmedName.toLowerCase()]
    );

    const result = await pool.query(
      `INSERT INTO overtime_records (id, name, exit_time, date, overtime_hours, rate_per_hour, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${RECORD_FIELDS}`,
      [id, trimmedName, exitTime, date, hours, cfg.ratePerHour, trimmedReason]
    );

    await logAudit(req.session.displayName, 'lancamento_criado', `${trimmedName} · saída ${exitTime} · ${date} · ${hours}h`);
    res.status(201).json(mapRecord(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar registro.' });
  }
});

// editar um lançamento pendente (correção). Registros já pagos não podem ser
// editados — zere/pague de novo se precisar corrigir algo já quitado.
app.put('/api/records/:id', async (req, res) => {
  try {
    const { name, exitTime, date, reason } = req.body;

    if (!name || !exitTime || !date) {
      return res.status(400).json({ error: 'Nome, horário de saída e data são obrigatórios.' });
    }

    const existing = await pool.query('SELECT paid FROM overtime_records WHERE id = $1', [req.params.id]);
    if (existing.rowCount === 0) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }
    if (existing.rows[0].paid) {
      return res.status(409).json({ error: 'Esse registro já foi pago e não pode mais ser editado.' });
    }

    const cfg = await getConfigInternal();
    const hours = computeOvertimeHours(exitTime, cfg.baseTime);
    if (hours <= 0) {
      return res.status(400).json({ error: `O horário de saída precisa ser depois das ${cfg.baseTime} para gerar hora extra.` });
    }

    const trimmedName = String(name).trim();
    const trimmedReason = reason ? String(reason).trim().slice(0, 500) : null;

    await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO NOTHING`,
      [generateId(), trimmedName, trimmedName.toLowerCase()]
    );

    const result = await pool.query(
      `UPDATE overtime_records
       SET name = $1, exit_time = $2, date = $3, overtime_hours = $4, rate_per_hour = $5, reason = $6
       WHERE id = $7 AND paid = false
       RETURNING ${RECORD_FIELDS}`,
      [trimmedName, exitTime, date, hours, cfg.ratePerHour, trimmedReason, req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Esse registro já foi pago e não pode mais ser editado.' });
    }

    await logAudit(req.session.displayName, 'lancamento_editado', `${trimmedName} · saída ${exitTime} · ${date} · ${hours}h`);
    res.json(mapRecord(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao editar registro.' });
  }
});

// remover um registro (uso administrativo, para corrigir lançamentos errados)
app.delete('/api/records/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM overtime_records WHERE id = $1 RETURNING name, date, exit_time',
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }

    const removed = result.rows[0];
    await logAudit(req.session.displayName, 'lancamento_removido', `${removed.name} · saída ${removed.exit_time} · ${removed.date}`);
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao remover registro.' });
  }
});

// "zerar as horas" — marca registros pendentes como pagos.
// Isso NÃO apaga nada: os registros continuam salvos (e aparecem no histórico
// por mês), mas saem da lista/estatísticas de horas pendentes a pagar.
// Body opcional: { name } -> zera só as horas desse funcionário.
//                 {} (sem name) -> zera todas as horas pendentes.
app.post('/api/records/zerar-horas', async (req, res) => {
  try {
    const { name } = req.body || {};

    let result;
    if (name && String(name).trim()) {
      result = await pool.query(
        `UPDATE overtime_records
         SET paid = true, paid_at = now()
         WHERE paid = false AND lower(trim(name)) = lower(trim($1))
         RETURNING id`,
        [name]
      );
    } else {
      result = await pool.query(
        `UPDATE overtime_records
         SET paid = true, paid_at = now()
         WHERE paid = false
         RETURNING id`
      );
    }

    await logAudit(
      req.session.displayName,
      'horas_zeradas',
      name ? `funcionário: ${name} (${result.rowCount} registro(s))` : `todos os pendentes (${result.rowCount} registro(s))`
    );

    res.json({ success: true, zeroedCount: result.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao zerar horas.' });
  }
});

// lista os meses que possuem registros salvos (para a aba "Meses")
app.get('/api/meses', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        substring(date, 1, 7) AS month,
        count(*)::int AS total,
        count(*) FILTER (WHERE paid = false)::int AS pending
      FROM overtime_records
      GROUP BY month
      ORDER BY month DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar meses.' });
  }
});

// todos os registros (pagos e pendentes) de um mês específico ('YYYY-MM')
app.get('/api/meses/:month', async (req, res) => {
  try {
    const { month } = req.params;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'Formato de mês inválido. Use YYYY-MM.' });
    }
    const result = await pool.query(
      `SELECT ${RECORD_FIELDS}
       FROM overtime_records
       WHERE substring(date, 1, 7) = $1
       ORDER BY date DESC, created_at DESC`,
      [month]
    );
    res.json(result.rows.map(mapRecord));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar registros do mês.' });
  }
});

// ---------- log de auditoria ----------

app.get('/api/audit-log', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const result = await pool.query(
      'SELECT id, actor, action, details, created_at FROM audit_log ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json(result.rows.map(r => ({
      id: r.id,
      actor: r.actor,
      action: r.action,
      details: r.details,
      createdAt: r.created_at
    })));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar histórico de atividade.' });
  }
});

// ---------- inicialização do servidor ----------
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('=================================================');
      console.log('  TRAFOTRON — servidor rodando (banco Postgres)');
      console.log('=================================================');
      console.log(`  Neste computador:  http://localhost:${PORT}`);
      getLocalIPs().forEach(ip => {
        console.log(`  Em outros computadores da mesma rede: http://${ip}:${PORT}`);
      });
      console.log('=================================================');
      console.log('');
    });
  })
  .catch(err => {
    console.error('Erro ao conectar/preparar o banco de dados:', err.message);
    process.exit(1);
  });
