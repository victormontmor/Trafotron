require('dotenv').config();

const express = require('express');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');

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

const useSsl = !/sslmode=disable/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

app.use(express.json());
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

  // migração leve para bancos já existentes criados antes destas colunas
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS paid BOOLEAN NOT NULL DEFAULT false;`);
  await pool.query(`ALTER TABLE overtime_records ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;`);

  // índice para acelerar a listagem por mês (usa os 7 primeiros chars de 'YYYY-MM-DD')
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_overtime_records_month ON overtime_records (substring(date, 1, 7));`);

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

  // migra automaticamente funcionários que já tinham lançamentos de horas
  // (bancos que já existiam antes desta tabela) para o novo cadastro
  await pool.query(`
    INSERT INTO employees (id, name, name_key)
    SELECT DISTINCT ON (lower(trim(name)))
      md5(lower(trim(name)) || '-' || clock_timestamp()::text || random()::text),
      trim(name),
      lower(trim(name))
    FROM overtime_records
    WHERE trim(name) <> ''
    ON CONFLICT (name_key) DO NOTHING;
  `);

  // valores padrão de configuração, só se ainda não existirem
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('baseTime', '17:18')
    ON CONFLICT (key) DO NOTHING;
  `);
  await pool.query(`
    INSERT INTO app_config (key, value) VALUES ('ratePerHour', '20')
    ON CONFLICT (key) DO NOTHING;
  `);
}

// ---------- rotas da API ----------

// configuração (horário base da jornada e valor da hora extra)
app.get('/api/config', async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM app_config');
    const config = { baseTime: '17:18', ratePerHour: 20 };
    result.rows.forEach(row => {
      if (row.key === 'baseTime') config.baseTime = row.value;
      if (row.key === 'ratePerHour') config.ratePerHour = Number(row.value);
    });
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
    const result = await pool.query('SELECT key, value FROM app_config');
    const config = {};
    result.rows.forEach(row => { config[row.key] = row.value; });
    res.json({ baseTime: config.baseTime, ratePerHour: Number(config.ratePerHour) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar configuração.' });
  }
});

function mapRecord(r) {
  return {
    id: r.id,
    name: r.name,
    exitTime: r.exit_time,
    date: r.date,
    paid: r.paid,
    paidAt: r.paid_at
  };
}

// ---------- funcionários (cadastro independente dos lançamentos de horas) ----------

// listar todos os funcionários cadastrados
app.get('/api/employees', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name FROM employees ORDER BY name_key ASC'
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar funcionários.' });
  }
});

// cadastrar um novo funcionário
app.post('/api/employees', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Informe o nome do funcionário.' });
    }
    const trimmedName = String(name).trim();
    const nameKey = trimmedName.toLowerCase();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const result = await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO NOTHING
       RETURNING id, name`,
      [id, trimmedName, nameKey]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ error: 'Esse funcionário já está cadastrado.' });
    }

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
      'DELETE FROM employees WHERE id = $1 RETURNING id',
      [req.params.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Funcionário não encontrado.' });
    }
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
      `SELECT id, name, exit_time, date, paid, paid_at
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
      'SELECT id, name, exit_time, date, paid, paid_at FROM overtime_records WHERE paid = false ORDER BY date DESC, created_at DESC'
    );
    res.json(result.rows.map(mapRecord));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao buscar registros.' });
  }
});

// criar um novo registro
app.post('/api/records', async (req, res) => {
  try {
    const { name, exitTime, date } = req.body;

    if (!name || !exitTime || !date) {
      return res.status(400).json({ error: 'Nome, horário de saída e data são obrigatórios.' });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const trimmedName = String(name).trim();

    // garante que o funcionário exista no cadastro, mesmo que o lançamento
    // tenha vindo de um nome ainda não cadastrado (evita perder o vínculo)
    const empId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await pool.query(
      `INSERT INTO employees (id, name, name_key) VALUES ($1, $2, $3)
       ON CONFLICT (name_key) DO NOTHING`,
      [empId, trimmedName, trimmedName.toLowerCase()]
    );

    const result = await pool.query(
      'INSERT INTO overtime_records (id, name, exit_time, date) VALUES ($1, $2, $3, $4) RETURNING id, name, exit_time, date, paid, paid_at',
      [id, trimmedName, exitTime, date]
    );

    res.status(201).json(mapRecord(result.rows[0]));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erro ao salvar registro.' });
  }
});

// remover um registro (uso administrativo, para corrigir lançamentos errados)
app.delete('/api/records/:id', async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM overtime_records WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Registro não encontrado.' });
    }

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
      `SELECT id, name, exit_time, date, paid, paid_at
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
