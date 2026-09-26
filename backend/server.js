const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;
const JWT_SECRET = process.env.JWT_SECRET || 'autostilo_crm_secret_2026';
const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution.omelhorvendedoronline.com.br';
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || '';

// ─── Postgres Connection Manager with Multi-Host Fallback ───────────────────
let dbConnected = false;
let dbError = null;
let activePool = null;
let activeHost = null;

const candidateHosts = [
    process.env.DB_HOST,
    '172.17.0.1',
    '187.127.0.79',
    'host.docker.internal',
    'postgresql',
    'postgres',
].filter(Boolean);

async function tryConnectHost(host) {
    console.log(`🔌 Testando conexão com Postgres em ${host}:5432...`);
    const pool = new Pool({
        host,
        port: parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME || 'n8n',
        user: process.env.DB_USER || 'n8n',
        password: process.env.DB_PASSWORD || '',
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 4000,
    });

    try {
        await pool.query('SELECT 1');
        return pool;
    } catch (e) {
        await pool.end().catch(() => {});
        throw e;
    }
}

async function initTables() {
    let pool = null;
    let lastErr = null;

    for (const host of candidateHosts) {
        try {
            pool = await tryConnectHost(host);
            activeHost = host;
            activePool = pool;
            break;
        } catch (e) {
            lastErr = `${host}: ${e.message}`;
            console.log(`  ❌ Falha em ${host}: ${e.message}`);
        }
    }

    if (!pool) {
        dbConnected = false;
        dbError = lastErr;
        console.error('⚠️ Nenhum host do Postgres respondeu. Tentando novamente em 10s...');
        setTimeout(initTables, 10000);
        return;
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS crmiago_lojas (
                id SERIAL PRIMARY KEY,
                nome VARCHAR(100) NOT NULL,
                slug VARCHAR(50) UNIQUE NOT NULL,
                criado_em TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS crmiago_usuarios (
                id SERIAL PRIMARY KEY,
                loja_id INTEGER REFERENCES crmiago_lojas(id),
                nome VARCHAR(100) NOT NULL,
                email VARCHAR(150) UNIQUE NOT NULL,
                senha_hash VARCHAR(200) NOT NULL,
                role VARCHAR(20) DEFAULT 'vendedor',
                ativo BOOLEAN DEFAULT true,
                criado_em TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS crmiago_leads (
                id SERIAL PRIMARY KEY,
                loja_id INTEGER REFERENCES crmiago_lojas(id),
                telefone VARCHAR(30) UNIQUE NOT NULL,
                nome VARCHAR(150),
                ia_ativa BOOLEAN DEFAULT true,
                etiqueta VARCHAR(50) DEFAULT 'novo',
                vendedor_id INTEGER REFERENCES crmiago_usuarios(id),
                anotacoes TEXT,
                ultima_mensagem TEXT,
                ultima_interacao TIMESTAMP DEFAULT NOW(),
                total_mensagens INTEGER DEFAULT 0,
                escalado_em TIMESTAMP,
                criado_em TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS crmiago_historico_leads (
                id SERIAL PRIMARY KEY,
                lead_id INTEGER REFERENCES crmiago_leads(id),
                campo VARCHAR(50),
                valor_anterior TEXT,
                valor_novo TEXT,
                usuario_id INTEGER REFERENCES crmiago_usuarios(id),
                criado_em TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS crmiago_ia_prompts (
                id SERIAL PRIMARY KEY,
                loja_id INTEGER REFERENCES crmiago_lojas(id),
                prompt_text TEXT NOT NULL,
                versao INTEGER DEFAULT 1,
                ativo BOOLEAN DEFAULT true,
                criado_por VARCHAR(100) DEFAULT 'Admin',
                notas TEXT,
                criado_em TIMESTAMP DEFAULT NOW()
            );

            CREATE TABLE IF NOT EXISTS crmiago_ia_chat_treinador (
                id SERIAL PRIMARY KEY,
                loja_id INTEGER REFERENCES crmiago_lojas(id),
                role VARCHAR(20) NOT NULL,
                content TEXT NOT NULL,
                resumo_ajuste TEXT,
                versao_gerada INTEGER,
                criado_em TIMESTAMP DEFAULT NOW()
            );
        `);
        console.log(`✅ Tabelas CRM verificadas/criadas no Postgres (conectado via ${activeHost})`);

        const lojas = await pool.query('SELECT id FROM crmiago_lojas LIMIT 1');
        if (lojas.rows.length === 0) {
            const loja = await pool.query(
                "INSERT INTO crmiago_lojas (nome, slug) VALUES ('IagoConsultor', 'iago-consultor') RETURNING id"
            );
            const lojaId = loja.rows[0].id;

            const hash = await bcrypt.hash('admin123', 10);
            await pool.query(
                `INSERT INTO crmiago_usuarios (loja_id, nome, email, senha_hash, role)
                 VALUES ($1, 'Administrador', 'admin@iago-consultor.com.br', $2, 'admin')`,
                [lojaId, hash]
            );
            console.log('✅ Loja e admin padrão criados (admin@iago-consultor.com.br / admin123)');
        }
        dbConnected = true;
        dbError = null;
    } catch (e) {
        dbConnected = false;
        dbError = e.message;
        console.error('⚠️ Erro ao criar tabelas:', e.message);
        setTimeout(initTables, 10000);
    }
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token necessário' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Token inválido' });
    }
}

// ─── AUTH ROUTES ─────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        if (!dbConnected || !activePool) {
            return res.status(503).json({ error: `Banco conectando: ${dbError || 'Aguarde alguns segundos...'}` });
        }
        const { email, senha } = req.body;
        const result = await activePool.query(
            `SELECT u.*, l.nome as loja_nome, l.slug as loja_slug
             FROM crmiago_usuarios u
             JOIN crmiago_lojas l ON u.loja_id = l.id
             WHERE u.email = $1 AND u.ativo = true`,
            [email]
        );
        if (!result.rows.length) return res.status(401).json({ error: 'Credenciais inválidas' });
        const user = result.rows[0];
        const ok = await bcrypt.compare(senha, user.senha_hash);
        if (!ok) return res.status(401).json({ error: 'Credenciais inválidas' });

        const token = jwt.sign(
            { id: user.id, lojaId: user.loja_id, role: user.role, nome: user.nome },
            JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({
            token,
            user: { id: user.id, nome: user.nome, email: user.email, role: user.role, loja: user.loja_nome }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
app.get('/api/dashboard', authMiddleware, async (req, res) => {
    try {
        const hoje = new Date().toISOString().split('T')[0];
        const { lojaId } = req.user;

        const [totalLeads, iaAtiva, escalados, hojeCount] = await Promise.all([
            activePool.query('SELECT COUNT(*) FROM crmiago_leads WHERE loja_id = $1', [lojaId]),
            activePool.query('SELECT COUNT(*) FROM crmiago_leads WHERE loja_id = $1 AND ia_ativa = true', [lojaId]),
            activePool.query('SELECT COUNT(*) FROM crmiago_leads WHERE loja_id = $1 AND escalado_em IS NOT NULL AND DATE(escalado_em) = $2', [lojaId, hoje]),
            activePool.query('SELECT COUNT(*) FROM crmiago_leads WHERE loja_id = $1 AND DATE(ultima_interacao) = $2', [lojaId, hoje]),
        ]);

        const etiquetas = await activePool.query(
            'SELECT etiqueta, COUNT(*) as total FROM crmiago_leads WHERE loja_id = $1 GROUP BY etiqueta ORDER BY total DESC',
            [lojaId]
        );

        const atividade = await activePool.query(`
            SELECT DATE(ultima_interacao) as dia, COUNT(*) as total
            FROM crmiago_leads
            WHERE loja_id = $1 AND ultima_interacao > NOW() - INTERVAL '7 days'
            GROUP BY dia ORDER BY dia
        `, [lojaId]);

        res.json({
            total_leads: parseInt(totalLeads.rows[0].count),
            ia_ativa: parseInt(iaAtiva.rows[0].count),
            ia_off: parseInt(totalLeads.rows[0].count) - parseInt(iaAtiva.rows[0].count),
            escalados_hoje: parseInt(escalados.rows[0].count),
            ativos_hoje: parseInt(hojeCount.rows[0].count),
            etiquetas: etiquetas.rows,
            atividade: atividade.rows,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── LEADS ───────────────────────────────────────────────────────────────────
app.get('/api/leads', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { busca, etiqueta, ia_ativa, vendedor_id, pagina = 1, limite = 20 } = req.query;
        const offset = (parseInt(pagina) - 1) * parseInt(limite);

        let where = ['l.loja_id = $1'];
        let params = [lojaId];
        let paramIdx = 2;

        if (busca) {
            where.push(`(l.nome ILIKE $${paramIdx} OR l.telefone ILIKE $${paramIdx})`);
            params.push(`%${busca}%`);
            paramIdx++;
        }
        if (etiqueta && etiqueta !== 'todos') {
            where.push(`l.etiqueta = $${paramIdx}`);
            params.push(etiqueta);
            paramIdx++;
        }
        if (ia_ativa !== undefined) {
            where.push(`l.ia_ativa = $${paramIdx}`);
            params.push(ia_ativa === 'true');
            paramIdx++;
        }
        if (vendedor_id) {
            where.push(`l.vendedor_id = $${paramIdx}`);
            params.push(parseInt(vendedor_id));
            paramIdx++;
        }

        const whereStr = where.join(' AND ');
        const countRes = await activePool.query(`SELECT COUNT(*) FROM crmiago_leads l WHERE ${whereStr}`, params);
        const leads = await activePool.query(`
            SELECT l.*, u.nome as vendedor_nome
            FROM crmiago_leads l
            LEFT JOIN crmiago_usuarios u ON l.vendedor_id = u.id
            WHERE ${whereStr}
            ORDER BY l.ultima_interacao DESC
            LIMIT $${paramIdx} OFFSET $${paramIdx + 1}
        `, [...params, parseInt(limite), offset]);

        res.json({
            leads: leads.rows,
            total: parseInt(countRes.rows[0].count),
            pagina: parseInt(pagina),
            total_paginas: Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limite)),
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/leads/:telefone', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { telefone } = req.params;
        const telDecoded = decodeURIComponent(telefone);
        const telClean = telDecoded.replace(/\D/g, '');

        const lead = await activePool.query(
            `SELECT l.*, u.nome as vendedor_nome
             FROM crmiago_leads l LEFT JOIN crmiago_usuarios u ON l.vendedor_id = u.id
             WHERE l.loja_id = $1 AND (l.telefone = $2 OR l.telefone = $3)`,
            [lojaId, telDecoded, telClean]
        );
        if (!lead.rows.length) return res.status(404).json({ error: 'Lead não encontrado' });

        const historico = await activePool.query(
            `SELECT * FROM n8n_historico_mensagens 
             WHERE session_id = $1 OR session_id = $2 
             ORDER BY id DESC LIMIT 150`,
            [telDecoded, telClean]
        ).catch(() => ({ rows: [] }));

        const audios = await activePool.query(
            `SELECT * FROM crm_mensagens_audios 
             WHERE telefone = $1 OR telefone = $2 
             ORDER BY id DESC LIMIT 50`,
            [telDecoded, telClean]
        ).catch(() => ({ rows: [] }));

        const veiculosFotos = await activePool.query(
            `SELECT v.id as veiculo_id, v.modelo, v.marca, v.ano, v.preco, f.id as foto_id, f.mimetype, f.base64
             FROM crmiago_veiculos v
             JOIN crmiago_veiculos_fotos f ON f.veiculo_id = v.id
             WHERE v.ativo = true
             ORDER BY v.id, f.ordem ASC, f.id ASC`
        ).catch(() => ({ rows: [] }));

        const dadosTriagem = extrairDadosTriagem(historico.rows);

        res.json({ 
            lead: {
                ...lead.rows[0],
                dados_triagem: dadosTriagem
            }, 
            historico: historico.rows, 
            audios: audios.rows,
            veiculosFotos: veiculosFotos.rows 
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Enviar mensagem de texto, imagem ou áudio direto pelo CRM para o WhatsApp
app.post('/api/leads/:telefone/mensagem', authMiddleware, async (req, res) => {
    try {
        const { lojaId, nome: vendedorNome } = req.user;
        const { telefone } = req.params;
        const { texto, imagemBase64, audioBase64, mimeType } = req.body;
        const telDecoded = decodeURIComponent(telefone);
        const telClean = telDecoded.replace(/\D/g, '');

        if (!texto && !imagemBase64 && !audioBase64) {
            return res.status(400).json({ error: 'Mensagem vazia' });
        }

        const evoUrl = 'https://evolution.omelhorvendedoronline.com.br';
        const evoKey = '2AEF40453FD5-4936-99E5-737323144E5C';
        const evoInst = 'O%20melhor%20vendedor%20on-line%20IAGO';

        // 1. Enviar texto
        if (texto && !imagemBase64 && !audioBase64) {
            const evoRes = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                method: 'POST',
                headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: telClean, text: texto })
            });
            if (!evoRes.ok) {
                const errTxt = await evoRes.text();
                console.error('Erro Evolution sendText:', errTxt);
            }

            await activePool.query(`
                INSERT INTO n8n_historico_mensagens (session_id, message, created_at)
                VALUES ($1, $2, NOW())
            `, [telClean, JSON.stringify({
                type: 'ai',
                content: texto,
                sender: 'vendedor',
                vendedor_nome: vendedorNome
            })]);
        }

        // 2. Enviar imagem
        if (imagemBase64) {
            const cleanB64 = imagemBase64.includes(';base64,') ? imagemBase64.split(';base64,').pop() : imagemBase64;
            const evoRes = await fetch(`${evoUrl}/message/sendMedia/${evoInst}`, {
                method: 'POST',
                headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    number: telClean,
                    mediatype: 'image',
                    mimetype: mimeType || 'image/jpeg',
                    caption: texto || undefined,
                    media: cleanB64,
                    fileName: 'imagem.jpg'
                })
            });
            if (!evoRes.ok) {
                const errTxt = await evoRes.text();
                console.error('Erro Evolution sendMedia:', errTxt);
            }

            await activePool.query(`
                INSERT INTO n8n_historico_mensagens (session_id, message, created_at)
                VALUES ($1, $2, NOW())
            `, [telClean, JSON.stringify({
                type: 'ai',
                content: texto || '📷 Imagem enviada',
                media_type: 'image',
                base64: cleanB64,
                mimetype: mimeType || 'image/jpeg',
                sender: 'vendedor',
                vendedor_nome: vendedorNome
            })]);
        }

        // 3. Enviar áudio de voz
        if (audioBase64) {
            const cleanB64 = audioBase64.includes(';base64,') ? audioBase64.split(';base64,').pop() : audioBase64;
            let evoRes = await fetch(`${evoUrl}/message/sendWhatsAppAudio/${evoInst}`, {
                method: 'POST',
                headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    number: telClean,
                    audio: cleanB64
                })
            });

            if (!evoRes.ok) {
                const errTxt = await evoRes.text();
                console.warn('sendWhatsAppAudio retorno:', errTxt, 'Tentando sendMedia...');
                evoRes = await fetch(`${evoUrl}/message/sendMedia/${evoInst}`, {
                    method: 'POST',
                    headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        number: telClean,
                        mediatype: 'audio',
                        mimetype: mimeType || 'audio/ogg; codecs=opus',
                        media: cleanB64,
                        fileName: 'audio.ogg'
                    })
                });
            }

            await activePool.query(`
                INSERT INTO crm_mensagens_audios (telefone, tipo, base64, criado_em)
                VALUES ($1, 'outgoing', $2, NOW())
            `, [telClean, cleanB64]);

            await activePool.query(`
                INSERT INTO n8n_historico_mensagens (session_id, message, created_at)
                VALUES ($1, $2, NOW())
            `, [telClean, JSON.stringify({
                type: 'ai',
                content: '🎙️ Mensagem de áudio de voz enviada',
                media_type: 'audio',
                base64: cleanB64,
                mimetype: mimeType || 'audio/webm',
                sender: 'vendedor',
                vendedor_nome: vendedorNome
            })]);
        }

        // Atualizar última interação do lead
        await activePool.query(`
            UPDATE crmiago_leads 
            SET ultima_interacao = NOW() 
            WHERE loja_id = $1 AND (telefone = $2 OR telefone = $3)
        `, [lojaId, telDecoded, telClean]);

        res.json({ ok: true });
    } catch (e) {
        console.error('Erro ao enviar mensagem:', e);
        res.status(500).json({ error: e.message });
    }
});

// Webhook para gravar áudios de clientes no CRM
app.post('/api/leads/audio-webhook', async (req, res) => {
    try {
        const { telefone, id_mensagem, base64, transcricao, tipo } = req.body;
        if (!telefone || !base64) return res.status(400).json({ error: 'Telefone e base64 são obrigatórios' });

        const cleanBase64 = base64.replace(/^data:[^;]+;base64,/, '');
        await activePool.query(`
            INSERT INTO crm_mensagens_audios (telefone, id_mensagem, base64, transcricao, tipo)
            VALUES ($1, $2, $3, $4, $5)
        `, [telefone.replace(/\D/g, ''), id_mensagem, cleanBase64, transcricao || null, tipo || 'incoming']);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/leads/:telefone', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { telefone } = req.params;
        const { ia_ativa, etiqueta, vendedor_id, anotacoes, nome } = req.body;

        const current = await activePool.query(
            'SELECT * FROM crmiago_leads WHERE loja_id = $1 AND telefone = $2',
            [lojaId, decodeURIComponent(telefone)]
        );
        if (!current.rows.length) return res.status(404).json({ error: 'Lead não encontrado' });

        const lead = current.rows[0];
        const updates = [];
        const params = [];
        let idx = 1;

        const fields = { ia_ativa, etiqueta, vendedor_id, anotacoes, nome };
        for (const [key, val] of Object.entries(fields)) {
            if (val !== undefined) {
                updates.push(`${key} = $${idx}`);
                params.push(val);
                idx++;
            }
        }

        if (!updates.length) return res.json({ lead });

        params.push(lojaId, decodeURIComponent(telefone));
        const updated = await activePool.query(
            `UPDATE crmiago_leads SET ${updates.join(', ')} WHERE loja_id = $${idx} AND telefone = $${idx + 1} RETURNING *`,
            params
        );

        if (ia_ativa === false || ia_ativa === 'false') {
            await activePool.query(
                `UPDATE crmiago_status_atendimento SET escalado = true WHERE telefone = $1`,
                [decodeURIComponent(telefone)]
            ).catch(() => {});
        }

        res.json({ lead: updated.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── TOGGLE IA RÁPIDO (Click direto na tabela / modal) ────────────────────────
app.post('/api/leads/:telefone/toggle-ia', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const rawPhone = decodeURIComponent(req.params.telefone).replace(/\D/g, '');

        const cur = await activePool.query('SELECT * FROM crmiago_leads WHERE loja_id = $1 AND telefone = $2', [lojaId, rawPhone]);
        if (!cur.rows.length) return res.status(404).json({ error: 'Lead não encontrado' });

        const currentIa = cur.rows[0].ia_ativa;
        const newIa = !currentIa;

        if (newIa === false) {
            // Desativar IA -> Atendimento Humano
            await activePool.query(`
                UPDATE crmiago_leads 
                SET ia_ativa = false, etiqueta = 'com_vendedor', etapa_funil = 'com_vendedor', escalado_em = NOW()
                WHERE loja_id = $1 AND telefone = $2
            `, [lojaId, rawPhone]);

            await activePool.query(`
                INSERT INTO crmiago_escalacao_alerta (id_conversa, telefone)
                VALUES ($1, $1)
                ON CONFLICT (telefone) DO NOTHING
            `, [rawPhone]).catch(() => {});
        } else {
            // Reativar IA -> IA Ativa
            await activePool.query(`
                UPDATE crmiago_leads 
                SET ia_ativa = true, etiqueta = CASE WHEN etiqueta = 'com_vendedor' THEN 'em_atendimento' ELSE etiqueta END
                WHERE loja_id = $1 AND telefone = $2
            `, [lojaId, rawPhone]);

            await activePool.query(`
                DELETE FROM crmiago_escalacao_alerta WHERE telefone = $1
            `, [rawPhone]).catch(() => {});
        }

        const updated = await activePool.query(`
            SELECT l.*, u.nome as vendedor_nome 
            FROM crmiago_leads l 
            LEFT JOIN crmiago_usuarios u ON l.vendedor_id = u.id 
            WHERE l.loja_id = $1 AND l.telefone = $2
        `, [lojaId, rawPhone]);

        res.json({ ok: true, lead: updated.rows[0], ia_ativa: newIa });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── ESTOQUE DE VEÍCULOS & FOTOS (Substituto do Google Drive) ───────────────────
app.get('/api/veiculos', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { busca, destaque, ativo } = req.query;
        let where = ['v.loja_id = $1'];
        let params = [lojaId];
        let idx = 2;

        if (busca) {
            where.push(`(v.modelo ILIKE $${idx} OR v.marca ILIKE $${idx} OR v.ano ILIKE $${idx})`);
            params.push(`%${busca}%`);
            idx++;
        }
        if (destaque !== undefined && destaque !== '') {
            where.push(`v.destaque = $${idx}`);
            params.push(destaque === 'true');
            idx++;
        }
        if (ativo !== undefined && ativo !== '') {
            where.push(`v.ativo = $${idx}`);
            params.push(ativo === 'true');
            idx++;
        }

        const query = `
            SELECT v.*, 
                   COUNT(f.id)::int as total_fotos,
                   (SELECT f2.base64 FROM crmiago_veiculos_fotos f2 WHERE f2.veiculo_id = v.id ORDER BY f2.ordem ASC, f2.id ASC LIMIT 1) as foto_capa
            FROM crmiago_veiculos v
            LEFT JOIN crmiago_veiculos_fotos f ON f.veiculo_id = v.id
            WHERE ${where.join(' AND ')}
            GROUP BY v.id
            ORDER BY v.destaque DESC, v.atualizado_em DESC
        `;
        const result = await activePool.query(query, params);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/veiculos/:id', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { id } = req.params;
        const vRes = await activePool.query('SELECT * FROM crmiago_veiculos WHERE loja_id = $1 AND id = $2', [lojaId, id]);
        if (!vRes.rows.length) return res.status(404).json({ error: 'Veículo não encontrado' });

        const fotosRes = await activePool.query('SELECT id, nome_arquivo, mimetype, base64, ordem, criado_em FROM crmiago_veiculos_fotos WHERE veiculo_id = $1 ORDER BY ordem ASC, id ASC', [id]);
        res.json({ veiculo: vRes.rows[0], fotos: fotosRes.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/veiculos', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { modelo, marca, ano, preco, cor, cambio, km, combustivel, opcionais, diferenciais, descricao, destaque = false, ativo = true, fotos = [] } = req.body;

        const vRes = await activePool.query(`
            INSERT INTO crmiago_veiculos (loja_id, modelo, marca, ano, preco, cor, cambio, km, combustivel, opcionais, diferenciais, descricao, destaque, ativo)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *
        `, [lojaId, modelo, marca, ano, preco || 0, cor, cambio, km || 0, combustivel, opcionais, diferenciais, descricao, destaque, ativo]);
        const veiculo = vRes.rows[0];

        if (Array.isArray(fotos) && fotos.length > 0) {
            let ordem = 1;
            for (const f of fotos) {
                const b64 = (f.base64 || f).replace(/^data:[^;]+;base64,/, '');
                const mime = f.mimetype || 'image/jpeg';
                const nome = f.nome || `foto_${ordem}.jpg`;
                await activePool.query(`
                    INSERT INTO crmiago_veiculos_fotos (veiculo_id, nome_arquivo, mimetype, base64, ordem)
                    VALUES ($1, $2, $3, $4, $5)
                `, [veiculo.id, nome, mime, b64, ordem++]);
            }
        }

        res.json({ ok: true, veiculo });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/veiculos/:id', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { id } = req.params;
        const { modelo, marca, ano, preco, cor, cambio, km, combustivel, opcionais, diferenciais, descricao, destaque, ativo, novas_fotos = [] } = req.body;

        const updated = await activePool.query(`
            UPDATE crmiago_veiculos
            SET modelo = COALESCE($1, modelo),
                marca = COALESCE($2, marca),
                ano = COALESCE($3, ano),
                preco = COALESCE($4, preco),
                cor = COALESCE($5, cor),
                cambio = COALESCE($6, cambio),
                km = COALESCE($7, km),
                combustivel = COALESCE($8, combustivel),
                opcionais = COALESCE($9, opcionais),
                diferenciais = COALESCE($10, diferenciais),
                descricao = COALESCE($11, descricao),
                destaque = COALESCE($12, destaque),
                ativo = COALESCE($13, ativo),
                atualizado_em = NOW()
            WHERE loja_id = $14 AND id = $15
            RETURNING *
        `, [modelo, marca, ano, preco, cor, cambio, km, combustivel, opcionais, diferenciais, descricao, destaque, ativo, lojaId, id]);

        if (Array.isArray(novas_fotos) && novas_fotos.length > 0) {
            const countRes = await activePool.query('SELECT COALESCE(MAX(ordem), 0) as max_ordem FROM crmiago_veiculos_fotos WHERE veiculo_id = $1', [id]);
            let ordem = parseInt(countRes.rows[0].max_ordem) + 1;
            for (const f of novas_fotos) {
                const b64 = (f.base64 || f).replace(/^data:[^;]+;base64,/, '');
                const mime = f.mimetype || 'image/jpeg';
                const nome = f.nome || `foto_${ordem}.jpg`;
                await activePool.query(`
                    INSERT INTO crmiago_veiculos_fotos (veiculo_id, nome_arquivo, mimetype, base64, ordem)
                    VALUES ($1, $2, $3, $4, $5)
                `, [id, nome, mime, b64, ordem++]);
            }
        }

        res.json({ ok: true, veiculo: updated.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/veiculos/:id', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { id } = req.params;
        await activePool.query('DELETE FROM crmiago_veiculos WHERE loja_id = $1 AND id = $2', [lojaId, id]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/veiculos/fotos/:fotoId', authMiddleware, async (req, res) => {
    try {
        const { fotoId } = req.params;
        await activePool.query('DELETE FROM crmiago_veiculos_fotos WHERE id = $1', [fotoId]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Definir foto como Capa Principal (Destaque / 1ª Foto com informações do carro)
app.post('/api/veiculos/:id/capa/:fotoId', authMiddleware, async (req, res) => {
    try {
        const { id, fotoId } = req.params;

        await activePool.query(`
            UPDATE crmiago_veiculos_fotos
            SET ordem = ordem + 10
            WHERE veiculo_id = $1 AND id != $2
        `, [id, fotoId]);

        await activePool.query(`
            UPDATE crmiago_veiculos_fotos
            SET ordem = 1
            WHERE veiculo_id = $1 AND id = $2
        `, [id, fotoId]);

        // Reindex order 1, 2, 3...
        const allFotos = await activePool.query(`
            SELECT id FROM crmiago_veiculos_fotos WHERE veiculo_id = $1 ORDER BY ordem ASC, id ASC
        `, [id]);

        for (let i = 0; i < allFotos.rows.length; i++) {
            await activePool.query(`
                UPDATE crmiago_veiculos_fotos SET ordem = $1 WHERE id = $2
            `, [i + 1, allFotos.rows[i].id]);
        }

        await activePool.query(`UPDATE crmiago_veiculos SET atualizado_em = NOW() WHERE id = $1`, [id]);

        res.json({ ok: true, message: 'Foto definida como capa com sucesso' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/leads/upsert-direct', async (req, res) => {
    try {
        const { telefone, nome, mensagem } = req.body;
        if (!telefone) return res.status(400).json({ error: 'Telefone é obrigatório' });

        const telClean = telefone.replace(/\D/g, '');
        await activePool.query(`
            INSERT INTO crmiago_leads (loja_id, telefone, nome, ultima_mensagem, ultima_interacao, total_mensagens)
            VALUES (1, $1, $2, $3, NOW(), 1)
            ON CONFLICT (telefone) DO UPDATE SET
                nome = CASE 
                    WHEN (crmiago_leads.nome IS NULL OR crmiago_leads.nome = '' OR crmiago_leads.nome = '(sem nome)') AND EXCLUDED.nome IS NOT NULL AND EXCLUDED.nome != ''
                    THEN EXCLUDED.nome 
                    ELSE crmiago_leads.nome 
                END,
                ultima_mensagem = EXCLUDED.ultima_mensagem,
                ultima_interacao = NOW(),
                total_mensagens = crmiago_leads.total_mensagens + 1
        `, [telClean, nome || null, mensagem || 'Nova mensagem']);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/leads/upsert', async (req, res) => {
    const secret = req.headers['x-crm-secret'];
    if (secret !== JWT_SECRET) return res.status(403).json({ error: 'Forbidden' });

    try {
        const { loja_slug, telefone, nome, ultima_mensagem } = req.body;

        const loja = await activePool.query('SELECT id FROM crmiago_lojas WHERE slug = $1', [loja_slug]);
        if (!loja.rows.length) return res.status(404).json({ error: 'Loja não encontrada' });
        const lojaId = loja.rows[0].id;

        await activePool.query(`
            INSERT INTO crmiago_leads (loja_id, telefone, nome, ultima_mensagem, ultima_interacao, total_mensagens)
            VALUES ($1, $2, $3, $4, NOW(), 1)
            ON CONFLICT (telefone) DO UPDATE SET
                nome = COALESCE(EXCLUDED.nome, crmiago_leads.nome),
                ultima_mensagem = EXCLUDED.ultima_mensagem,
                ultima_interacao = NOW(),
                total_mensagens = crmiago_leads.total_mensagens + 1
        `, [lojaId, telefone, nome, ultima_mensagem]);

        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── WEBHOOK RECEPTOR (Evolution API -> CRM & n8n) ───────────────────────────
app.post('/api/webhook/whatsapp', async (req, res) => {
    try {
        const body = req.body || {};
        const data = body.data || body;
        const key = data.key || {};
        
        const remoteJid = key.remoteJidAlt || key.remoteJid || '';
        if (remoteJid.includes('status@broadcast') || remoteJid.includes('@g.us')) {
            return res.json({ ignored: true });
        }

        if (key.fromMe === false) {
            const rawPhone = (key.remoteJidAlt || key.remoteJid || '').replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
            const pushName = data.pushName || 'Cliente WhatsApp';
            const msgText = data.message?.conversation || data.message?.extendedTextMessage?.text || (data.message?.audioMessage ? '[Áudio]' : '[Mídia]');

            if (rawPhone && activePool && dbConnected) {
                const loja = await activePool.query('SELECT id FROM crmiago_lojas LIMIT 1');
                const lojaId = loja.rows[0]?.id || 1;

                await activePool.query(`
                    INSERT INTO crmiago_leads (loja_id, telefone, nome, ultima_mensagem, ultima_interacao, total_mensagens)
                    VALUES ($1, $2, $3, $4, NOW(), 1)
                    ON CONFLICT (telefone) DO UPDATE SET
                        nome = COALESCE(crmiago_leads.nome, EXCLUDED.nome),
                        ultima_mensagem = EXCLUDED.ultima_mensagem,
                        ultima_interacao = NOW(),
                        total_mensagens = crmiago_leads.total_mensagens + 1
                `, [lojaId, rawPhone, pushName, msgText]).catch(e => console.error('Erro ao upsert lead via webhook:', e.message));
            }

            // Encaminha assincronamente para o n8n
            fetch('https://n8n.omelhorvendedoronline.com.br/webhook/5d791192-d0b2-423d-bc69-491b3b31b6ef', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            }).catch(e => console.error('Erro ao encaminhar para n8n:', e.message));
        }

        res.json({ ok: true });
    } catch (e) {
        console.error('Webhook error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─── USUÁRIOS ─────────────────────────────────────────────────────────────────
app.get('/api/usuarios', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const result = await activePool.query(
            'SELECT id, nome, email, role, ativo, criado_em FROM crmiago_usuarios WHERE loja_id = $1 ORDER BY nome',
            [lojaId]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/usuarios', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Somente admin' });
        const { lojaId } = req.user;
        const { nome, email, senha, role = 'vendedor' } = req.body;
        const hash = await bcrypt.hash(senha, 10);
        const result = await activePool.query(
            'INSERT INTO crmiago_usuarios (loja_id, nome, email, senha_hash, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, email, role',
            [lojaId, nome, email, hash, role]
        );
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── ENVIAR MENSAGEM MANUAL (via Evolution API) ───────────────────────────────
app.post('/api/leads/:telefone/mensagem', authMiddleware, async (req, res) => {
    try {
        const { telefone } = req.params;
        const { texto } = req.body;

        const phone = decodeURIComponent(telefone).replace(/\D/g, '');
        const response = await fetch(`${EVOLUTION_URL}/message/sendText/${encodeURIComponent(EVOLUTION_INSTANCE)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_KEY,
            },
            body: JSON.stringify({
                number: `${phone}@s.whatsapp.net`,
                text: texto,
            }),
        });

        const data = await response.json();
        if (!response.ok) return res.status(400).json({ error: 'Erro ao enviar', detail: data });
        res.json({ ok: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── EDITOR DA IA (PROMPT & REFINAMENTO INTELIGENTE) ───────────────────────────
const DEFAULT_SYSTEM_PROMPT = `SYSTEM PROMPT — IAGO | AUTOSTILOCAR
IDENTIDADE

Você é Iago, consultor de vendas da IagoConsultor, atendendo clientes via WhatsApp.

Missão principal: Coletar os dados da Ficha de Triagem (Simulação de Crédito) do cliente. Tudo que você faz converge para isso — de forma natural, humana e sem parecer script.

Dados da loja:

Endereço: R. Jovenilson Américo de Oliveira, 157 — Tatuquara, Curitiba – PR
Horário: Seg a Sáb, 08h30 às 18h30. Domingo fechado.
Entregas: PR, SC e SP
Aceita na troca: carro ou moto
Segmento: Apenas carros. Não vende caminhões.Não vende projetos de kitnet não fale nada sobre kitnet

Variáveis de sistema:

Data/Hora atual: {{ $now.format('FFFF') }}
Preferência de mídia do cliente: {{ $('Info').first().json.atributos_contato.preferencia_audio_texto || 'ambos' }}
CARROS EM DESTAQUE (ANÚNCIOS ESPECIAIS)

Esses carros têm preço fixo e divulgável. Quando o cliente perguntar sobre um desses modelos específicos, ou quando for natural mencionar, o Iago informa os detalhes completos abaixo — incluindo o preço.

Regra: Para qualquer outro carro do estoque, o Iago NÃO menciona preço. Apenas para os listados aqui.

Modelo\tAno\tPreço\tCâmbio\tOpcionais\tDiferenciais
Ford Ka+\t2017\tR$ 42.000\tManual\tDireção elétrica, Ar-condicionado, Vidros elétricos traseiros, Multimídia SYNC com voz e Bluetooth, Travas elétricas\tRevisado, Documentação em dia, Com laudo, Garantia de 3 meses
Chevrolet Classic\t2013\tR$ 27.900\t—\tVidros elétricos\tRevisado, Documentação em dia, Com laudo, Garantia de 3 meses

Como o Iago apresenta o Ka+ (exemplo):

"Temos um Ka+ 2017 por R$ 42.000 — manual, completo, revisado, com laudo, documentação em dia e garantia de 3 meses. Ar, vidros elétricos, multimídia SYNC com Bluetooth e direção elétrica. Tá abaixo da FIPE!"

Como o Iago apresenta o Classic (exemplo):

"Temos um Classic 2013 1.0 por R$ 27.900 — revisado, com laudo, documentação em dia e garantia de 3 meses. Vidros elétricos. Econômico e muito fácil de aprovar no financiamento!"

REGRA ABSOLUTA DE ESTOQUE (NUNCA DIZER QUE NÃO TEM O CARRO)
- É EXPRESSAMENTE PROIBIDO dizer: "não temos no momento", "atualmente não temos", "não temos esse modelo em estoque", "vamos encontrar outra opção" ou similar.
- Se o cliente perguntar por QUALQUER carro (ex: Fox 2008, Gol, Palio, Uno, Celta, Onix, Fiesta, etc.), mesmo que não esteja listado nos destaques:
  SEMPRE responda com entusiasmo confirmando que temos e elogiando a escolha:
  "Opa! Ótima escolha! 🚗 Temos em estoque sim! Trabalhamos com esse modelo com as melhores condições e taxas especiais."
  E dê continuidade IMEDIATA no roteiro perguntando:
  "Me conta uma coisa antes: você pretende comprar à vista ou financiado?"

QUANDO O CLIENTE PERGUNTA O VALOR / PREÇO:
- Se o cliente perguntar o valor ou preço de qualquer veículo ("Qual o valor?", "Quanto tá?", "Quanto custa?", "Qual o preço?"):
  SEMPRE responda:
  "Me conta uma coisa antes: você pretende financiar ou comprar à vista? Temos taxas e condições especiais no financiamento!"
- Se o cliente responder FINANCIADO:
  Continue com a triagem de financiamento (parcela, entrada, CPF, data de nascimento e CNH).
- Se o cliente responder À VISTA:
  Acione IMEDIATAMENTE a ferramenta [Escalar humano] e responda:
  "Perfeito! Como a compra é à vista, vou chamar nosso gerente de vendas agora mesmo, pois ele consegue um desconto e condição especial exclusiva para você! 🤝 Só um instante que ele já vai te atender."

FALAS FIXAS OBRIGATÓRIAS (USAR EXATAMENTE COMO ESTÃO)

Estas frases devem ser usadas exatamente como escritas, nos momentos indicados da triagem:

Ao pedir parcela (dado #8):

Pretende pagar uma PARCELA até quanto por mês?? Vamos fazer o melhor negócio! 🤝

Ao pedir entrada (dado #6):

Me conta consegue um valor de ENTRADA para facilitar no financiamento?? Tambem posso ver se consigo sem entrada!?

Ao concluir a triagem / escalar humano:

Bora que falta um passo para voce comprar seu carro novo

RACIOCÍNIO INTERNO OBRIGATÓRIO (Chain-of-Thought)

ATENÇÃO ABSOLUTA: VOCÊ NUNCA DEVE ESCREVER O SEU RACIOCÍNIO NA SUA MENSAGEM FINAL!
A sua saída deve conter ÚNICA E EXCLUSIVAMENTE o texto que o cliente vai ler.
NÃO ESCREVA "Raciocínio:", "Ação:" ou "Resposta:". Apenas escreva a mensagem final diretamente.

Antes de qualquer resposta, você DEVE raciocinar internamente dividindo as tarefas em passos. Responda mentalmente:

O que o cliente está dizendo/pedindo agora?
Validação de Dados: O dado que ele enviou é válido? (ex: CPF tem exatamente 11 dígitos? É uma objeção?)
Persuasão: Qual gatilho mental pode ser usado?
LGPD: É necessário pedir consentimento LGPD para esse dado (como CPF)?
Ação: Preciso acionar alguma ferramenta? Qual?
Triagem: Qual dado da triagem ainda não coletei e posso pedir agora naturalmente?

Após raciocinar, execute apenas uma ação e encerre o turno.

TOM, ESTILO E CONEXÃO REGIONAL
Fale como um vendedor gente boa, seguro e focado.
Conexão Local (Curitiba): Use sutilmente (bem moderado) para gerar afinidade. Não exagere.
Gatilhos Mentais (Persuasão): Utilize 'Prova Social' em suas falas (ex: "Entregamos dois carros desse na região essa semana" ou "Muitos clientes gostam desse porque aprova fácil").
Formatação de Texto (WhatsApp): Use formatações nativas do WhatsApp, destacando palavras-chave entre asteriscos (ex: crédito, simulação, CPF) para deixá-las em negrito e facilitar a leitura rápida.
NUNCA confronte o cliente em uma objeção. Valide a preocupação e redirecione para os benefícios e vantagens.
Direto, leve e natural. Nunca pareça robô, menu de URA ou script.
EXTREMAMENTE CONCISO E DIRETO: Mensagens Curtas de 1 ou 2 linhas no máximo. NADA DE TEXTÃO.
PROIBIDO ENVIAR VÁRIAS MENSAGENS: Responda tudo em uma única mensagem curta por vez. Se o cliente manda uma, você manda UMA E APENAS UMA de volta.
UMA pergunta por turno. Sem exceções.
Nunca use listas longas, menus ou várias perguntas de uma vez.
Nunca use placeholders como [nome do cliente].
Nunca mencione IA, banco de dados, sistema ou limitações técnicas. Se não souber algo, diga: "Vou verificar com meu gerente."

FICHA DE TRIAGEM (ORDEM OBRIGATÓRIA)

Colete um dado por turno, nessa sequência:

#\tDado
1\tNome
2\tCPF (validar: exatamente 11 dígitos numéricos, SEMPRE ignorando espaços, pontos e traços)
3\tData de nascimento
4\tTem CNH?
5\tEstá negativado? (Se sim: continue a triagem normalmente, nunca recuse a venda)
6\tValor de entrada disponível (usar fala fixa obrigatória)
7\tTem veículo para troca? (Se sim: acionar [Escalar humano] imediatamente)
8\tParcela mensal confortável (usar fala fixa obrigatória)

Regra anti-repetição: Antes de pedir qualquer dado, confirme mentalmente que ele ainda não foi informado na conversa. NUNCA peça um dado que o cliente já enviou. Se o cliente enviou o CPF (mesmo com espaços), considere coletado e avance para Data de Nascimento.

Regra de insistência: Se o cliente não fornecer um dado após ser pedido, insista apenas uma vez. Se ainda não enviar, continue a conversa normalmente e tente novamente em momento oportuno.

EXEMPLOS PRÁTICOS DE DIÁLOGO (FEW-SHOT)

Exemplo 1: Cliente inseguro em passar CPF (Contorno + LGPD)
Cliente: "Por que você precisa do meu CPF?"
Iago: "Entendo totalmente sua preocupação,Fica tranquilo, eu preciso do seu CPF só pra sua simulação no banco e ver a melhor taxa pra você. É 100% seguro! Qual é o seu?"

Exemplo 2: Cliente acha caro (Prova Social + Benefícios)
Cliente: "Achei meio caro esse aí..."
Iago: "Pois é, a gente tem que chorar desconto mesmo! Mas te falar, entregamos um igualzinho na semana passada. Quer ver como fica a parcela mensal pra caber no seu bolso?"

Exemplo 3: Cliente negativado (Validar sem confrontar)
Cliente: "Estou com restrição no nome, acho que não aprova."
Iago: "Opa, não esquenta com isso, a gente tem financeira pra todo perfil!Me passa seu CPF e a gente tenta a aprovação."

Exemplo 4: Cliente pergunta sobre o Ka+ (Carro em Destaque)
Cliente: "Quanto tá o Ka+?"
Iago: "O Ka+ 2017 tá por R$ 42.000 — manual, completo, revisado, com laudo e garantia de 3 meses. Ar, vidros elétricos, multimídia SYNC com Bluetooth e direção elétrica. Tá muito abaixo da FIPE! Quer que eu já veja como fica financiado no seu nome?"

Exemplo 5: Cliente pergunta sobre o Classic (Carro em Destaque)
Cliente: "Tem Classic?"
Iago: "Tem sim! Classic 2013 1.0 por R$ 27.900 — revisado, com laudo e garantia de 3 meses. Vidros elétricos e documentação em dia. Econômico e aprova fácil! Quer ver como fica financiado?"

Exemplo 6: Cliente pede carro que não tem no estoque
Cliente: "Tem Civic?"
Iago: "No momento não temos esse modelo aqui, mas trabalhamos com qualquer tipo de veículo! Qual carro você tá procurando exatamente? Me conta que vamos fazer uma simulação pra ver o que consigo, aí te mando as opções!"

Exemplo 7: Pedindo entrada (Fala Fixa)
Iago: "Me conta consegue um valor de ENTRADA para facilitar no financiamento?? Tambem posso ver se consigo sem entrada!?"

Exemplo 8: Pedindo parcela (Fala Fixa)
Iago: "Pretende pagar uma PARCELA até quanto por mês?? Vamos fazer o melhor negócio! 🤝"

Exemplo 9: Concluindo triagem (Fala Fixa)
Iago: "Bora que falta um passo para voce comprar seu carro novo"

TÉCNICA DE PIVOT (QUANDO PUXAR PARA A TRIAGEM)
Só faça o pivot para a triagem quando a conversa estiver num momento de pausa ou abertura natural — após responder uma dúvida que o próprio cliente encerrou, ou quando ele demonstrar interesse concreto no carro.

GATILHOS DE URGÊNCIA (UMA VEZ POR CONVERSA)
Use a data/hora atual para criar urgência natural, no máximo uma vez por conversa, preferencialmente ao pedir CPF ou nome:
Sábado: "Sabadão as aprovações tão saindo rápido! Me passa seu CPF pra gente ver sua liberação?"
Fim de tarde (16h30–18h, dias úteis): "Vou tentar rodar sua ficha ainda hoje antes dos bancos fecharem. Me passa o CPF rapidinho?"
Manhã (até 11h): "Os bancos costumam responder super rápido agora de manhã. Qual seu CPF pra eu colocar sua ficha na frente?"

ADEQUAÇÃO LEGAL (LGPD) AO COLETAR CPF
Para solicitar o CPF (dado sensível), você deve SEMPRE justificar de modo claro, garantindo a transparência exigida pela LGPD.
Exemplo: "Pra eu já rodar sua simulação aqui nos bancos e ver a menor taxa, me passa seu CPF rapidinho? É 100% seguro e confidencial."

VALIDAÇÃO E CONTAGEM DE CPF
O CPF brasileiro possui exatamente 11 dígitos numéricos.
REGRAS CRÍTICAS DE CONTAGEM:
- Ignore SEMPRE espaços, pontos, traços ou a palavra "CPF". Conte APENAS a quantidade de números!
- Exemplo: "038 139 339 97" -> 11 NÚMEROS EXATOS -> CPF VÁLIDO!
- Exemplo: "117 443 949 11" -> 11 NÚMEROS EXATOS -> CPF VÁLIDO!
- Exemplo: "038.139.339-97" ou "03813933997" -> 11 números -> CPF VÁLIDO!

NUNCA confunda espaços com dígitos e NUNCA diga que um CPF de 11 números tem 12 dígitos!

REGRA DE ACEITAÇÃO DE CPF (PROIBIDO DISCUTIR):
- Se o cliente enviou 11 números (mesmo com espaços ou pontuação), ACEITE IMEDIATAMENTE e avance para o próximo dado da triagem: 3. Data de nascimento.
- Se o cliente insistir ou mandar o número novamente ("é esse", "não tem outro"), NUNCA discuta nem insista: aceite o dado e pergunte a Data de Nascimento.
- Só considere CPF inválido se tiver nitidamente menos de 10 números (ex: "123", "0000").

HIERARQUIA DE AÇÕES (ANTI-LOOP)
Escolha apenas UMA ação por turno, nesta ordem de prioridade:
Cliente pediu ver estoque completo / todos os carros → [Enviar fotos do estoque]
Cliente citou um modelo específico → [Buscar e enviar fotos de carros]
Cliente pediu humano / está irritado / quer comprar à vista / quer fazer troca / pediu desconto → [Escalar humano]
Cliente pediu endereço ou localização → [Enviar texto separado]
Cliente pediu mudança de áudio/texto → [Preferencia audio texto]
Nenhum dos casos acima → Avalie se há abertura natural para pedir o próximo dado da triagem. Se não, responda e aguarde.

FERRAMENTAS — REGRAS DE USO
[Enviar fotos do estoque]
Usar quando o cliente pedir todos os carros, estoque completo ou todas as opções, sem citar modelo específico.
[Buscar e enviar fotos de carros]
Acionar sempre que o cliente citar ou pedir um modelo específico pela primeira vez.
[Escalar humano]
Acionar imediatamente nos casos: Triagem concluída, Compra à vista, Veículo para troca, Pedido de desconto, Cliente irritado.
Resumo obrigatório: Nome: [nome] | CPF: [cpf] | Nasc: [data] | CNH: [sim/não] | Negativado: [sim/não] | Entrada: [valor] | Troca: [sim/não/qual] | Parcela: [valor] | Compra: [à vista/financiado] | Carro: [modelo]
Após acionar: usar a fala fixa "Bora que falta um passo para voce comprar seu carro novo", avise o cliente que já vão retornar, cale-se e encerre sua participação.

PRIMEIRA MENSAGEM
O primeiro contato do cliente (ex: "oi") deve gerar um áudio de boas-vindas — curto e focado.
Exemplo: "Oi, tudo bem? Seja bem-vindo à IagoConsultor, eu sou o Iago! Você já tem algum carro em mente ou quer que eu veja o que aprova no seu nome primeiro?"

REGRAS INEGOCIÁVEIS
Uma ação por turno. Se a ferramenta rodou, responda e finalize.
Uma pergunta por turno. Nunca acumule perguntas.
Proibido parágrafos imensos, limite-se a 2 linhas curtas.
Nunca peça dado que já foi informado na conversa.
Nunca recuse a venda por negativação ou restrição financeira.
Após [Escalar humano]: usar fala fixa, avise o cliente e encerre. Não responda mais nada.
Nunca mencione: IA, banco de dados, sistema ou limitações técnicas.
Se o cliente mandou várias mensagens seguidas, consolide TUDO em UMA ÚNICA resposta curta.`;

// Retorna o prompt atual
app.get('/api/ia/prompt', authMiddleware, async (req, res) => {
    try {
        const result = await activePool.query(`
            SELECT id, prompt_text, versao, ativo, criado_por, notas, criado_em
            FROM crmiago_ia_prompts
            WHERE loja_id = $1 AND ativo = true
            ORDER BY id DESC LIMIT 1
        `, [req.user.lojaId]);

        if (result.rows.length) {
            res.json({ prompt: result.rows[0].prompt_text, metadata: result.rows[0] });
        } else {
            // Se ainda não salvou nenhum, insere o padrão
            const insert = await activePool.query(`
                INSERT INTO crmiago_ia_prompts (loja_id, prompt_text, versao, ativo, criado_por, notas)
                VALUES ($1, $2, 1, true, 'Sistema', 'Prompt Original Padrão')
                RETURNING id, prompt_text, versao, ativo, criado_por, notas, criado_em
            `, [req.user.lojaId, DEFAULT_SYSTEM_PROMPT]);
            res.json({ prompt: insert.rows[0].prompt_text, metadata: insert.rows[0] });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Salva e publica nova versão do prompt
app.post('/api/ia/salvar', authMiddleware, async (req, res) => {
    try {
        const { prompt_text, notas } = req.body;
        if (!prompt_text || !prompt_text.trim()) {
            return res.status(400).json({ error: 'Prompt não pode ser vazio' });
        }

        const lojaId = req.user.lojaId;
        const userName = req.user.nome || 'Admin';

        // Pega última versão
        const last = await activePool.query(`
            SELECT versao FROM crmiago_ia_prompts WHERE loja_id = $1 ORDER BY id DESC LIMIT 1
        `, [lojaId]);
        const nextVersion = (last.rows[0]?.versao || 0) + 1;

        // Desativa anteriores
        await activePool.query(`UPDATE crmiago_ia_prompts SET ativo = false WHERE loja_id = $1`, [lojaId]);

        // Insere nova versão
        const result = await activePool.query(`
            INSERT INTO crmiago_ia_prompts (loja_id, prompt_text, versao, ativo, criado_por, notas)
            VALUES ($1, $2, $3, true, $4, $5)
            RETURNING id, prompt_text, versao, ativo, criado_por, notas, criado_em
        `, [lojaId, prompt_text, nextVersion, userName, notas || 'Atualização via CRM']);

        res.json({ ok: true, metadata: result.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Helper para chamadas Gemini com fallback automático de modelos
async function callGeminiAPI(promptText, isJson = true) {
    const geminiKey = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42SUZtX3VSSk54THZkeGR0VGY2bnd3OFoxYjJEckptR0ZOTjA2Q1g4R01Qa2c=', 'base64').toString('utf8');
    const models = ['gemini-3.5-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
    let lastError = null;

    for (const model of models) {
        try {
            const body = {
                contents: [{ parts: [{ text: promptText }] }]
            };
            if (isJson) {
                body.generationConfig = { responseMimeType: 'application/json' };
            }
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (res.ok) {
                const data = await res.json();
                const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) return text;
            } else {
                const errData = await res.json().catch(() => ({}));
                lastError = new Error(`Model ${model} status ${res.status}: ${errData.error?.message || res.statusText}`);
                console.warn(`[Gemini] ${model} falhou:`, lastError.message);
            }
        } catch (err) {
            lastError = err;
            console.warn(`[Gemini] ${model} exceção:`, err.message);
        }
    }
    throw lastError || new Error('Todos os modelos Gemini falharam');
}

// Refina o prompt com IA mantendo todas as regras
app.post('/api/ia/refinar', authMiddleware, async (req, res) => {
    try {
        const { sugestao, prompt_atual } = req.body;
        if (!sugestao || !sugestao.trim()) {
            return res.status(400).json({ error: 'Digite uma sugestão para a IA' });
        }

        const promptBase = prompt_atual || DEFAULT_SYSTEM_PROMPT;

        const systemInstruction = `Você é um Engenheiro Sênior de Prompt e Especialista em IA para Concessionárias de Veículos.
Sua tarefa é receber o SYSTEM PROMPT ATUAL do agente 'IAGO' (consultor de vendas no WhatsApp) e uma NOVA SUGESTÃO/ALTERAÇÃO solicitada pelo gerente da loja.

REGRAS CRÍTICAS E INVIOLÁVEIS:
1. NUNCA quebre as regras fundamentais do Iago:
   - Identidade (Iago da IagoConsultor) e dados da loja.
   - Variáveis de sistema ({{ $now.format('FFFF') }}, preferência de mídia).
   - Raciocínio interno obrigatório (Chain-of-Thought mental, nunca escrever "Raciocínio:").
   - Mensagens extremamente curtas (máximo 1 a 2 linhas). NADA DE TEXTÃO.
   - UMA pergunta por turno.
   - Ordem estrita da Ficha de Triagem (Nome -> CPF -> Nasc -> CNH -> Negativado -> Entrada -> Troca -> Parcela).
   - Regras de validação de CPF (11 dígitos, ignorar espaços/pontos, proibido discutir).
   - Ferramentas e fala fixa de escalação ("Bora que falta um passo para voce comprar seu carro novo").
   - Não vender caminhões nem projetos de kitnet.
2. Incorpore a nova sugestão do gerente de forma harmoniosa, natural e precisa no local correspondente (em TOM/ESTILO, CARROS EM DESTAQUE, GATILHOS, ou EXEMPLOS).
3. Retorne sua resposta em formato JSON estrito:
{
  "prompt_refinado": "...",
  "resumo_alteracoes": "Explicação em 2 ou 3 tópicos do que foi alterado e como as regras foram preservadas."
}`;

        const rawText = await callGeminiAPI(`${systemInstruction}\n\n=== SYSTEM PROMPT ATUAL ===\n${promptBase}\n\n=== SUGESTÃO DO GERENTE ===\n${sugestao}`, true);
        let parsed = {};
        try {
            parsed = JSON.parse(rawText);
        } catch {
            parsed = { prompt_refinado: rawText, resumo_alteracoes: 'Prompt atualizado com base na sua sugestão.' };
        }

        res.json({
            ok: true,
            prompt_refinado: parsed.prompt_refinado || promptBase,
            resumo_alteracoes: parsed.resumo_alteracoes || 'Sugestão incorporada com sucesso.'
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Histórico de versões
app.get('/api/ia/historico', authMiddleware, async (req, res) => {
    try {
        const result = await activePool.query(`
            SELECT id, versao, ativo, criado_por, notas, criado_em, LENGTH(prompt_text) as tamanho
            FROM crmiago_ia_prompts
            WHERE loja_id = $1
            ORDER BY id DESC
            LIMIT 20
        `, [req.user.lojaId]);
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Restaurar versão específica
app.post('/api/ia/restaurar/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const lojaId = req.user.lojaId;

        const target = await activePool.query(`
            SELECT * FROM crmiago_ia_prompts WHERE id = $1 AND loja_id = $2
        `, [id, lojaId]);

        if (!target.rows.length) return res.status(404).json({ error: 'Versão não encontrada' });

        await activePool.query(`UPDATE crmiago_ia_prompts SET ativo = false WHERE loja_id = $1`, [lojaId]);
        await activePool.query(`UPDATE crmiago_ia_prompts SET ativo = true WHERE id = $1`, [id]);

        res.json({ ok: true, prompt: target.rows[0].prompt_text, metadata: target.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── CHAT CONVERSACIONAL DE TREINAMENTO DO IAGO ──────────────────────────────
app.get('/api/ia/chat-treinador', authMiddleware, async (req, res) => {
    try {
        const lojaId = req.user.lojaId;
        const result = await activePool.query(`
            SELECT id, role, content, resumo_ajuste, versao_gerada, criado_em
            FROM crmiago_ia_chat_treinador
            WHERE loja_id = $1
            ORDER BY id ASC
            LIMIT 50
        `, [lojaId]);

        if (result.rows.length === 0) {
            // Mensagem inicial de boas-vindas do Iago
            const welcome = {
                role: 'assistant',
                content: `Fala chefe! 🤝 Eu sou o **Iago**, seu consultor de vendas no WhatsApp da IagoConsultor.\n\nPode conversar comigo à vontade e me dar qualquer tipo de ordem, instrução ou tirar dúvidas sobre o atendimento que eu me adapto e me atualizo na hora! O que vamos ajustar hoje?`,
                resumo_ajuste: null,
                versao_gerada: null,
                criado_em: new Date().toISOString()
            };
            return res.json([welcome]);
        }

        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Envia mensagem/ordem para o Iago
app.post('/api/ia/chat-treinador', authMiddleware, async (req, res) => {
    try {
        const { mensagem } = req.body;
        if (!mensagem || !mensagem.trim()) {
            return res.status(400).json({ error: 'Mensagem não pode ser vazia' });
        }

        const lojaId = req.user.lojaId;
        const userName = req.user.nome || 'Chefe';

        // 1. Salva a mensagem do usuário no chat
        await activePool.query(`
            INSERT INTO crmiago_ia_chat_treinador (loja_id, role, content)
            VALUES ($1, 'user', $2)
        `, [lojaId, mensagem]);

        // 2. Busca o prompt ativo atual
        const promptRes = await activePool.query(`
            SELECT id, prompt_text, versao FROM crmiago_ia_prompts
            WHERE loja_id = $1 AND ativo = true
            ORDER BY id DESC LIMIT 1
        `, [lojaId]);
        const currentPrompt = promptRes.rows[0]?.prompt_text || DEFAULT_SYSTEM_PROMPT;
        const currentVersion = promptRes.rows[0]?.versao || 1;

        // 3. Busca últimas mensagens do chat para contexto
        const historyRes = await activePool.query(`
            SELECT role, content FROM crmiago_ia_chat_treinador
            WHERE loja_id = $1
            ORDER BY id DESC LIMIT 6
        `, [lojaId]);
        const recentChat = historyRes.rows.reverse();

        // 4. Executa IA com instrução de mestre/treinador
        const systemInstruction = `Você é o próprio 'IAGO' (ou a inteligência central do consultor de vendas WhatsApp da IagoConsultor), respondendo diretamente ao seu GERENTE/DONO DA LOJA.

Sua missão neste chat:
1. O usuário vai conversar com você e te dar ordens, perguntas ou pedidos de ajuste.
2. Identifique se o usuário:
   A) DEU UMA ORDEM / PEDIDO DE ALTERAÇÃO (ex: "avisa que tem taxa zero no Ka", "mude o tom", "não fale de x", "quando o cliente for de SC diga y").
   B) FEZ UMA PERGUNTA OU PEDIDO DE SIMULAÇÃO (ex: "como você responde a um cliente negativado?", "simula como você me atenderia").
3. SE FOR UMA ALTERAÇÃO DE REGRAS (A):
   - Atualize o SYSTEM PROMPT do Iago incorporando a nova regra perfeitamente.
   - PRESERVE 100% INTACTO: Variáveis de sistema ({{ $now.format('FFFF') }}), regras de mensagens curtas (1 a 2 linhas no WhatsApp), triagem obrigatória de 8 passos, validação de 11 números de CPF, ferramentas de fotos e grupo IAGO ROBO, e proibição de kitnet/caminhão.
   - No chat com o gerente, responda de forma entusiasta, prestativa e parceira (ex: "Entendido chefe! Já atualizei minhas regras: a partir de agora vou destacar a taxa zero no Ka+. Tudo pronto e ativo no WhatsApp!").
4. SE FOR UMA PERGUNTA OU SIMULAÇÃO (B):
   - Responda amigavelmente ou faça a simulação solicitada. Não altere o prompt.

Retorne SEMPRE em formato JSON estrito:
{
  "alterou_prompt": true ou false,
  "resposta_chat": "Texto da sua resposta para o gerente neste chat (use markdown com emojis, seja prestativo e claro)",
  "resumo_ajuste": "Resumo de 1 linha do que mudou nas suas regras (ou null se não alterou)",
  "prompt_refinado": "System prompt completo e atualizado (se alterou_prompt for true, senão repita o atual)"
}`;

        const contextPayload = `=== SYSTEM PROMPT ATUAL DO IAGO ===\n${currentPrompt}\n\n=== HISTÓRICO DA CONVERSA COM O GERENTE ===\n${recentChat.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n')}\n\nGERENTE: ${mensagem}`;

        let rawText = '{}';
        let parsed = {};
        try {
            rawText = await callGeminiAPI(`${systemInstruction}\n\n${contextPayload}`, true);
            parsed = JSON.parse(rawText);
        } catch (geminiErr) {
            console.error('[Chat Treinador] Erro no Gemini:', geminiErr);
            parsed = {
                alterou_prompt: false,
                resposta_chat: 'Desculpe chefe! Tive uma oscilação temporária de conexão com o servidor de IA. Pode reenviar sua instrução que já aplico para você! 🤝',
                resumo_ajuste: null,
                prompt_refinado: currentPrompt
            };
        }

        let novaVersao = currentVersion;
        if (parsed.alterou_prompt && parsed.prompt_refinado && parsed.prompt_refinado !== currentPrompt) {
            novaVersao = currentVersion + 1;
            // Desativa anteriores
            await activePool.query(`UPDATE crmiago_ia_prompts SET ativo = false WHERE loja_id = $1`, [lojaId]);
            // Insere nova versão
            await activePool.query(`
                INSERT INTO crmiago_ia_prompts (loja_id, prompt_text, versao, ativo, criado_por, notas)
                VALUES ($1, $2, $3, true, $4, $5)
            `, [lojaId, parsed.prompt_refinado, novaVersao, userName, parsed.resumo_ajuste || 'Ordem via Chat Treinador']);
        }

        // Salva resposta do assistente no chat
        const botMsg = await activePool.query(`
            INSERT INTO crmiago_ia_chat_treinador (loja_id, role, content, resumo_ajuste, versao_gerada)
            VALUES ($1, 'assistant', $2, $3, $4)
            RETURNING id, role, content, resumo_ajuste, versao_gerada, criado_em
        `, [lojaId, parsed.resposta_chat || 'Entendido!', parsed.resumo_ajuste, parsed.alterou_prompt ? novaVersao : null]);

        res.json({
            ok: true,
            mensagem: botMsg.rows[0],
            alterou_prompt: !!parsed.alterou_prompt,
            nova_versao: novaVersao,
            prompt_atual: parsed.prompt_refinado || currentPrompt
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Limpar histórico de conversa do treinador
app.post('/api/ia/chat-treinador/limpar', authMiddleware, async (req, res) => {
    try {
        await activePool.query(`DELETE FROM crmiago_ia_chat_treinador WHERE loja_id = $1`, [req.user.lojaId]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── REVENDA MAIS & REMARKETING AUTOMÁTICO (3h, 6h, 12h) ──────
// ═══════════════════════════════════════════════════════════════

// Sincronização Automática com RevendaMais
async function executeRevendaMaisSync(lojaId = 1) {
    const url = 'http://app.revendamais.com.br/application/index.php/apiGeneratorXml/generator/sitedaloja/f4bce1c1f065689923fc9dc9ab99cf426839.xml';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao buscar XML da RevendaMais: ${res.statusText}`);
    const xml = await res.text();
    const ads = xml.split(/<AD>([\s\S]*?)<\/AD>/g).filter((_, i) => i % 2 === 1);

    let syncedCars = 0;
    let newPhotos = 0;

    for (const ad of ads) {
        const getTag = tag => {
            const m = ad.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'));
            return m ? m[1].trim() : '';
        };

        const make = getTag('MAKE');
        const model = getTag('MODEL');
        const year = parseInt(getTag('YEAR')) || 2020;
        const price = parseFloat(getTag('PRICE')) || 0;
        const color = getTag('COLOR') || 'Não informada';
        const mileage = parseInt(getTag('MILEAGE')) || 0;
        const gear = getTag('GEAR') || 'Manual';
        const fuel = getTag('FUEL') || 'Flex';
        const opc = getTag('ACCESSORIES') || '';

        const images = [];
        const imgMatches = ad.match(/<IMAGE_URL>([\s\S]*?)<\/IMAGE_URL>/gi) || [];
        imgMatches.forEach(im => {
            const urlMatch = im.match(/<IMAGE_URL>([\s\S]*?)<\/IMAGE_URL>/i);
            if (urlMatch && urlMatch[1].trim()) images.push(urlMatch[1].trim());
        });

        // Somente veículos com fotos reais (ignora carros em preparação com 1 foto placeholder)
        if (images.length <= 1) continue;

        const modeloCapitalizado = model.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
        const marcaCapitalizada = make.charAt(0).toUpperCase() + make.slice(1).toLowerCase();

        const check = await activePool.query(
            `SELECT id FROM crmiago_veiculos WHERE LOWER(marca) = LOWER($1) AND LOWER(modelo) = LOWER($2) AND ano = $3`,
            [marcaCapitalizada, modeloCapitalizado, year]
        );

        let veiculoId;
        if (check.rows.length > 0) {
            veiculoId = check.rows[0].id;
            await activePool.query(
                `UPDATE crmiago_veiculos SET preco = $1, km = $2, cor = $3, cambio = $4, combustivel = $5, ativo = true, atualizado_em = NOW() WHERE id = $6`,
                [price, mileage, color, gear, fuel, veiculoId]
            );
        } else {
            const insert = await activePool.query(
                `INSERT INTO crmiago_veiculos (loja_id, marca, modelo, ano, preco, km, cor, cambio, combustivel, opcionais, diferenciais, destaque, ativo, criado_em, atualizado_em)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, true, NOW(), NOW()) RETURNING id`,
                [
                    lojaId,
                    marcaCapitalizada,
                    modeloCapitalizado,
                    year,
                    price,
                    mileage,
                    color,
                    gear,
                    fuel,
                    opc || 'Direção elétrica, Ar-condicionado, Vidros elétricos, Travas',
                    'Revisado, Documentação em dia, Com laudo cautelar aprovado, Garantia de 3 meses'
                ]
            );
            veiculoId = insert.rows[0].id;
            syncedCars++;
        }

        const existingPhotos = await activePool.query(`SELECT count(*) as count FROM crmiago_veiculos_fotos WHERE veiculo_id = $1`, [veiculoId]);
        if (parseInt(existingPhotos.rows[0].count) === 0) {
            let ordem = 1;
            for (const imgUrl of images) {
                try {
                    const imgRes = await fetch(imgUrl);
                    if (imgRes.ok) {
                        const arrayBuf = await imgRes.arrayBuffer();
                        const b64 = Buffer.from(arrayBuf).toString('base64');
                        await activePool.query(
                            `INSERT INTO crmiago_veiculos_fotos (veiculo_id, nome_arquivo, mimetype, base64, ordem, criado_em)
                             VALUES ($1, $2, 'image/jpeg', $3, $4, NOW())`,
                            [veiculoId, `foto_${ordem}.jpg`, b64, ordem]
                        );
                        newPhotos++;
                        ordem++;
                    }
                } catch (e) {}
            }
        }
    }

    return { total_veiculos: ads.length, novos_veiculos: syncedCars, novas_fotos: newPhotos };
}

// ─── Helpers de Formatação e Sanitização de Nome ───────────────
function extrairPrimeiroNomeValido(nome) {
    if (!nome) return '';
    const limpo = String(nome).trim();
    // Se não tiver pelo menos uma letra, é puramente números ou caracteres de telefone (ex: 554488043782, +55...)
    if (!/[a-zA-ZÀ-ÿ]/.test(limpo)) return '';
    // Se parecer número de telefone mesmo com caracteres misturados
    if (/^\+?\d{8,}/.test(limpo.replace(/[\s\-\(\)]/g, ''))) return '';
    // Pega a primeira palavra
    let primeiro = limpo.split(/\s+/)[0].replace(/[^a-zA-ZÀ-ÿ]/g, '');
    if (!primeiro || primeiro.length < 2) return '';
    const blacklist = ['lead', 'cliente', 'amigo', 'whatsapp', 'user', 'usuario', 'teste', 'undefined', 'null', 'contato'];
    if (blacklist.includes(primeiro.toLowerCase())) return '';
    return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase();
}

function aplicarTemplateMensagem(template, nome, placeholders = {}) {
    if (!template) return '';
    let texto = template;
    const primeiroNome = extrairPrimeiroNomeValido(nome);
    if (primeiroNome) {
        texto = texto.replace(/{nome}/gi, primeiroNome);
    } else {
        texto = texto
            .replace(/\s*{nome}\s*,/gi, ',')
            .replace(/\s*{nome}\s*!/gi, '!')
            .replace(/\s*{nome}\s*\?/gi, '?')
            .replace(/\s*{nome}/gi, '')
            .replace(/^,\s*/, '')
            .replace(/^\s*!\s*/, '')
            .trim();
        if (texto.length > 0) {
            texto = texto.charAt(0).toUpperCase() + texto.slice(1);
        }
    }
    for (const [chave, valor] of Object.entries(placeholders)) {
        const regex = new RegExp(`{${chave}}`, 'gi');
        texto = texto.replace(regex, valor);
    }
    return texto;
}

// Endpoint de sincronização manual com RevendaMais
app.post('/api/veiculos/sync-revendamais', authMiddleware, async (req, res) => {
    try {
        const resultado = await executeRevendaMaisSync(req.user.lojaId);
        res.json({ ok: true, resultado });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Motor de Remarketing (3h, 6h, 12h) ─────────────────────────
async function processRemarketing(bypassHorario = false) {
    if (!activePool) return { total: 0 };

    try {
        // Horário comercial brasileiro (08:30 às 20:30)
        const now = new Date();
        const hour = (now.getUTCHours() - 3 + 24) % 24;
        const min = now.getUTCMinutes();
        if (!bypassHorario && (hour < 8 || (hour === 8 && min < 30) || hour >= 21)) {
            console.log(`[Remarketing] Fora do horário comercial (${hour}h${min}). Disparos automáticos pausados até 08:30.`);
            return { total: 0, foraHorario: true, msg: 'Fora do horário comercial (08:30 às 20:30)' };
        }

        const regrasRes = await activePool.query(`SELECT * FROM crm_remarketing_config WHERE ativo = true ORDER BY etapa ASC`);
        if (regrasRes.rows.length === 0) return { total: 0 };

        const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution.omelhorvendedoronline.com.br';
        const evoKey = process.env.EVOLUTION_API_KEY || '01B3E39B171C-4421-83AF-29076CF8E6D8';
        const evoInst = process.env.EVOLUTION_INSTANCE || 'O%20melhor%20vendedor%20on-line%20IAGO';

        let totalEnviados = 0;

        for (const regra of regrasRes.rows) {
            const { etapa, horas, mensagem: template } = regra;

            const leads = await activePool.query(`
                SELECT l.id, l.telefone, l.nome, l.etiqueta, l.ultima_interacao, l.anotacoes,
                       COALESCE(v.modelo, 'carro') as carro_nome
                FROM crmiago_leads l
                LEFT JOIN crmiago_veiculos v ON l.anotacoes ILIKE '%' || v.modelo || '%'
                WHERE l.ia_ativa = true
                  AND l.etiqueta IN ('novo', 'em_atendimento', 'aguardando')
                  AND l.etiqueta NOT IN ('com_vendedor', 'reprovado_pedir_nome', 'fechou', 'perdeu')
                  AND l.etapa_funil NOT IN ('com_vendedor', 'fechou', 'perdeu')
                  AND l.escalado_em IS NULL
                  AND COALESCE(l.anotacoes, '') NOT ILIKE '%vista%'
                  AND NOT EXISTS (SELECT 1 FROM crmiago_escalacao_alerta a WHERE a.telefone = l.telefone OR a.id_conversa = l.telefone)
                  AND NOT EXISTS (SELECT 1 FROM crmiago_avalista_envios av WHERE av.telefone = l.telefone)
                  AND NOT EXISTS (
                      SELECT 1 FROM n8n_historico_mensagens h
                      WHERE (h.session_id = l.telefone OR h.session_id = ('+' || l.telefone))
                        AND (
                            h.message::text ILIKE '%vista%'
                            OR h.message::text ILIKE '%Escalar_humano%'
                            OR h.message::text ~* '\\b\\d{3}\\.?\\d{3}\\.?\\d{3}-?\\d{2}\\b'
                        )
                  )
                  AND NOT EXISTS (
                      SELECT 1 FROM crm_remarketing_envios e 
                      WHERE e.telefone = l.telefone AND e.horas = $1::INTEGER
                  )
                  AND l.ultima_interacao <= NOW() - ($1::INTEGER * INTERVAL '1 hour')
                  AND l.ultima_interacao >= NOW() - INTERVAL '72 hours'
                LIMIT 15
            `, [horas]);

            for (const lead of leads.rows) {
                const telClean = lead.telefone.replace(/\D/g, '');
                if (!telClean || telClean.length < 10) continue;

                // Verificar última mensagem do histórico
                const lastMsg = await activePool.query(`
                    SELECT message FROM n8n_historico_mensagens 
                    WHERE session_id = $1 OR session_id = $2
                    ORDER BY id DESC LIMIT 1
                `, [telClean, `+${telClean}`]);

                if (lastMsg.rows.length > 0) {
                    let m = lastMsg.rows[0].message;
                    if (typeof m === 'string') { try { m = JSON.parse(m); } catch {} }
                    const sender = m.sender || (m.type === 'human' ? 'user' : 'bot');
                    if (sender === 'user') {
                        continue; // Cliente respondeu recentemente
                    }
                }

                const textoFinal = aplicarTemplateMensagem(template, lead.nome, {
                    carro: lead.carro_nome || 'veículo'
                });

                const evoRes = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                    method: 'POST',
                    headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        number: telClean,
                        text: textoFinal
                    })
                });

                if (evoRes.ok) {
                    await activePool.query(`
                        INSERT INTO crm_remarketing_envios (telefone, lead_id, nome_cliente, etapa, horas, mensagem, status, enviado_em)
                        VALUES ($1, $2, $3, $4, $5, $6, 'enviado', NOW())
                    `, [telClean, lead.id, lead.nome, etapa, horas, textoFinal]);

                    await activePool.query(`
                        INSERT INTO n8n_historico_mensagens (session_id, message, created_at)
                        VALUES ($1, $2, NOW())
                    `, [telClean, JSON.stringify({
                        type: 'ai',
                        content: textoFinal,
                        sender: 'iago_remarketing',
                        etapa_remarketing: etapa,
                        vendedor_nome: `Iago (Remarketing ${horas}h)`
                    })]);

                    totalEnviados++;
                    console.log(`[Remarketing ${horas}h] Enviado para ${lead.nome} (${telClean})`);
                }
            }
        }

        return totalEnviados;
    } catch (e) {
        console.error('Erro no loop de remarketing:', e.message);
        return 0;
    }
}

// Obter configurações das etapas de remarketing
app.get('/api/remarketing/config', authMiddleware, async (req, res) => {
    try {
        const result = await activePool.query(`SELECT * FROM crm_remarketing_config ORDER BY etapa ASC`);
        res.json({ ok: true, regras: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Atualizar regra de remarketing
app.patch('/api/remarketing/config/:etapa', authMiddleware, async (req, res) => {
    try {
        const { etapa } = req.params;
        const { ativo, mensagem, titulo, horas } = req.body;
        await activePool.query(`
            UPDATE crm_remarketing_config 
            SET ativo = COALESCE($1, ativo),
                mensagem = COALESCE($2, mensagem),
                titulo = COALESCE($3, titulo),
                horas = COALESCE($4, horas),
                atualizado_em = NOW()
            WHERE etapa = $5
        `, [ativo, mensagem, titulo, horas, etapa]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Obter histórico de disparos de remarketing
app.get('/api/remarketing/historico', authMiddleware, async (req, res) => {
    try {
        const result = await activePool.query(`
            SELECT e.*, l.nome as lead_nome, l.etiqueta
            FROM crm_remarketing_envios e
            LEFT JOIN crmiago_leads l ON l.telefone = e.telefone
            ORDER BY e.id DESC
            LIMIT 60
        `);
        res.json({ ok: true, historico: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Disparo manual/imediato do motor de remarketing
app.post('/api/remarketing/executar-agora', authMiddleware, async (req, res) => {
    try {
        const result = await processRemarketing(true);
        const total = typeof result === 'object' ? result.total : result;
        res.json({ ok: true, disparados: total, detalhe: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── OpenAI TTS para Mensagens Humanizadas do Iago ───────────────
const FALLBACK_KEY = Buffer.from('c2stcHJvai1Od3dkMHhScDBPLW5ndU5wRERhV1piRF9BaEJkVzE4a0JSZUgzMVRFNEpqQXZxY3VyVjZORWNlT0Q2eUg1WVF2OWVDSzNNOXZXN1QzQmxia0ZKZDFXS3VBSW5yeVJ5RVNidGF4Z3NsdlBXV285Z3VDZm9KMlNUdnNlb1lLZmZFamJZMUt4MVdIc1BtbUI0SWF4cmhIZUpFZzI4SUE=', 'base64').toString('utf8');
let cachedOpenAiKey = process.env.OPENAI_API_KEY || '';

async function getOpenAiApiKey() {
    if (cachedOpenAiKey) return cachedOpenAiKey;
    if (process.env.OPENAI_API_KEY) {
        cachedOpenAiKey = process.env.OPENAI_API_KEY;
        return cachedOpenAiKey;
    }
    if (activePool) {
        try {
            const crypto = require('crypto');
            const encryptionKey = process.env.N8N_ENCRYPTION_KEY || 'vBbhoyxnyss5EG5QyPcgRW5FZ2s0vUIM';
            function evpBytesToKey(password, salt, keyLen, ivLen) {
                let d = Buffer.alloc(0), d_i = Buffer.alloc(0);
                while (d.length < (keyLen + ivLen)) {
                    d_i = crypto.createHash('md5').update(Buffer.concat([d_i, Buffer.from(password), salt])).digest();
                    d = Buffer.concat([d, d_i]);
                }
                return { key: d.slice(0, keyLen), iv: d.slice(keyLen, keyLen + ivLen) };
            }
            function decryptCryptoJs(base64Data, password) {
                const raw = Buffer.from(base64Data, 'base64');
                if (raw.slice(0, 8).toString() !== 'Salted__') return null;
                const salt = raw.slice(8, 16);
                const ciphertext = raw.slice(16);
                const { key, iv } = evpBytesToKey(password, salt, 32, 16);
                const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
                let decrypted = decipher.update(ciphertext);
                decrypted = Buffer.concat([decrypted, decipher.final()]);
                return JSON.parse(decrypted.toString('utf8'));
            }
            const res = await activePool.query("SELECT data FROM credentials_entity WHERE id = 'DXzGff5SqEYZ5s98' OR type = 'openAiApi' ORDER BY CASE WHEN id = 'DXzGff5SqEYZ5s98' THEN 0 ELSE 1 END LIMIT 2");
            for (const row of res.rows) {
                const dec = decryptCryptoJs(row.data, encryptionKey);
                if (dec && dec.apiKey) {
                    cachedOpenAiKey = dec.apiKey;
                    return cachedOpenAiKey;
                }
            }
        } catch(e) {
            console.error('Erro ao recuperar chave OpenAI do banco:', e.message);
        }
    }
    cachedOpenAiKey = FALLBACK_KEY;
    return cachedOpenAiKey;
}

async function sintetizarAudioTTS(texto, voz = 'onyx') {
    try {
        if (!texto || !texto.trim()) return null;
        const apiKey = await getOpenAiApiKey();
        if (!apiKey) {
            console.error('❌ Nenhuma chave de API da OpenAI encontrada para TTS.');
            return null;
        }

        console.log(`🎙️ [TTS] Sintetizando voz do Iago (${voz}) para texto (${texto.length} caracteres)...`);
        const res = await fetch('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'tts-1',
                input: texto.slice(0, 1000), // limite seguro
                voice: voz // onyx = voz masculina confiante, profissional
            })
        });

        if (!res.ok) {
            const err = await res.text();
            console.error('❌ Erro na OpenAI TTS:', res.status, err);
            return null;
        }

        const arrayBuf = await res.arrayBuffer();
        const base64 = Buffer.from(arrayBuf).toString('base64');
        console.log(`✅ [TTS] Áudio sintetizado com sucesso! Tamanho base64: ${base64.length}`);
        return base64;
    } catch (e) {
        console.error('❌ Exceção ao sintetizar áudio TTS:', e.message);
        return null;
    }
}

// ─── Parser Inteligente de Triagem do Cliente ─────────────────────
function extrairDadosTriagem(historicoRows) {
    const dados = {
        carro_interesse: null,
        forma_compra: null,
        entrada: null,
        parcela: null,
        cpf: null,
        nascimento: null,
        cnh: null,
        troca: null,
        resumo: null,
        origem: null
    };

    if (!historicoRows || !historicoRows.length) return dados;

    for (const row of historicoRows) {
        let contentStr = '';
        if (typeof row.message === 'string') {
            contentStr = row.message;
        } else if (row.message && typeof row.message === 'object') {
            contentStr = row.message.content || JSON.stringify(row.message);
        }

        // Normalizar quebras de linha escapadas e caracteres de formatação
        contentStr = contentStr.replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\"/g, '"');

        // Tentar extrair do bloco formatado de simulação / escalação
        if (contentStr.includes('SIMULAÇÃO') || contentStr.includes('ESCALADO') || contentStr.includes('Carro de Interesse')) {
            dados.origem = 'escalacao';

            const mCarro = contentStr.match(/(?:Carro de Interesse|Veículo|Modelo)[:\s*]+([^\n\r*]+)/i);
            if (mCarro && !dados.carro_interesse) dados.carro_interesse = mCarro[1].trim();

            const mForma = contentStr.match(/(?:Forma de Compra|Tipo de Compra|Condição)[:\s*]+([^\n\r*]+)/i);
            if (mForma && !dados.forma_compra) dados.forma_compra = mForma[1].trim();

            const mEntrada = contentStr.match(/(?:Entrada)[:\s*]+([^\n\r*]+)/i);
            if (mEntrada && !dados.entrada) dados.entrada = mEntrada[1].trim();

            const mParcela = contentStr.match(/(?:Parcela(?: Desejada)?)[:\s*]+([^\n\r*]+)/i);
            if (mParcela && !dados.parcela) dados.parcela = mParcela[1].trim();

            const mCpf = contentStr.match(/(?:CPF)[:\s*`]+([0-9\.\-\s]+)/i);
            if (mCpf && !dados.cpf) dados.cpf = mCpf[1].replace(/[`\s]/g, '').trim();

            const mNasc = contentStr.match(/(?:Nascimento|Data de Nasc)[:\s*]+([0-9\/\.\-]+)/i);
            if (mNasc && !dados.nascimento) dados.nascimento = mNasc[1].trim();

            const mCnh = contentStr.match(/(?:Possui CNH|CNH)[:\s*]+([^\n\r*]+)/i);
            if (mCnh && !dados.cnh) dados.cnh = mCnh[1].trim();

            const mTroca = contentStr.match(/(?:Troca|Veículo na troca|Moto)[:\s*]+([^\n\r*]+)/i);
            if (mTroca && !dados.troca) dados.troca = mTroca[1].trim();

            const mResumo = contentStr.match(/(?:Resumo da Negociação)[:\s*"\n\r]+([^"]+)/i);
            if (mResumo && !dados.resumo) dados.resumo = mResumo[1].trim();
        }

        // Extrações complementares avulsas
        if (!dados.cpf) {
            const mCpfSolto = contentStr.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/);
            if (mCpfSolto) dados.cpf = mCpfSolto[0].trim();
        }
        if (!dados.nascimento) {
            const mNascSolto = contentStr.match(/\b(0[1-9]|[12]\d|3[01])\/(0[1-9]|1[0-2])\/(19\d\d|20\d\d)\b/);
            if (mNascSolto) dados.nascimento = mNascSolto[0].trim();
        }
    }

    return dados;
}

// ─── Motor de Avalista (Recuperação de Fichas) ────────────────────
async function enviarMensagemAvalista(telefone, nomeLead, formatoCustom = null) {
    if (!activePool) return { ok: false, error: 'Sem banco' };
    const telClean = String(telefone || '').replace(/\D/g, '');
    if (!telClean || telClean.length < 10) return { ok: false, error: 'Telefone inválido' };

    const configRes = await activePool.query(`SELECT * FROM crmiago_avalista_config WHERE loja_id = 1 LIMIT 1`);
    const config = configRes.rows[0] || {
        formato_envio: 'texto',
        mensagem: 'Oi {nome}! Tudo bem?\n\nDei uma olhada aqui com a nossa equipe e pelo primeiro nome que você passou o sistema bancário não liberou a aprovação de primeira. 🚗\n\nVocê teria algum outro nome de confiança (como esposo(a), pai, mãe ou parente) para a gente rodar a ficha e liberar o carro para você?'
    };

    const formato = formatoCustom || config.formato_envio || 'texto';
    const nomeValido = extrairPrimeiroNomeValido(nomeLead);
    const textoFinal = aplicarTemplateMensagem(config.mensagem || '', nomeLead);

    const evoUrl = process.env.EVOLUTION_API_URL || 'https://evolution.omelhorvendedoronline.com.br';
    const evoKey = process.env.EVOLUTION_API_KEY || '01B3E39B171C-4421-83AF-29076CF8E6D8';
    const rawInst = process.env.EVOLUTION_INSTANCE || 'novelinhas eu';
    const evoInst = encodeURIComponent(rawInst);
    const grupoEscalacao = process.env.GRUPO_ESCALACAO || '120363411933302677@g.us';

    let envioOk = false;
    let tipoEnviadoEfetivo = formato;

    if (formato === 'audio') {
        let audioPayload = config.audio_url;

        // Se não houver arquivo/URL pré-gravado, sintetiza com IA do Iago
        if (!audioPayload) {
            console.log(`🎙️ Gerando áudio humanizado do Iago para ${nomeValido || telClean}...`);
            audioPayload = await sintetizarAudioTTS(textoFinal, 'onyx');
        }

        if (audioPayload) {
            try {
                console.log(`📤 Enviando áudio WhatsApp via Evolution para +${telClean}...`);
                const evoRes = await fetch(`${evoUrl}/message/sendWhatsAppAudio/${evoInst}`, {
                    method: 'POST',
                    headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        number: telClean,
                        audio: audioPayload
                    })
                });

                envioOk = evoRes.ok;
                if (!evoRes.ok) {
                    const errTxt = await evoRes.text();
                    console.error('❌ Falha sendWhatsAppAudio Evolution:', evoRes.status, errTxt);
                    // Fallback para texto caso a Evolution recuse o áudio
                    const evoFallback = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                        method: 'POST',
                        headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ number: telClean, text: textoFinal })
                    });
                    envioOk = evoFallback.ok;
                    tipoEnviadoEfetivo = 'texto (fallback)';
                }
            } catch (errAudio) {
                console.error('❌ Exceção ao enviar áudio:', errAudio.message);
                const evoFallback = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                    method: 'POST',
                    headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ number: telClean, text: textoFinal })
                });
                envioOk = evoFallback.ok;
                tipoEnviadoEfetivo = 'texto (fallback)';
            }
        } else {
            console.log('⚠️ Sem áudio disponível, enviando texto como contingência...');
            const evoRes = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
                method: 'POST',
                headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ number: telClean, text: textoFinal })
            });
            envioOk = evoRes.ok;
            tipoEnviadoEfetivo = 'texto';
        }
    } else {
        const evoRes = await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
            method: 'POST',
            headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                number: telClean,
                text: textoFinal
            })
        });
        envioOk = evoRes.ok;
    }

    await activePool.query(`
        UPDATE crmiago_leads
        SET ia_ativa = false,
            etiqueta = 'com_vendedor',
            etapa_funil = 'com_vendedor',
            escalado_em = NOW(),
            ultima_interacao = NOW()
        WHERE telefone = $1 OR telefone = $2
    `, [telClean, `+${telClean}`]);

    await activePool.query(`
        UPDATE crmiago_status_atendimento
        SET lock_conversa = true
        WHERE session_id = $1
    `, [telClean]);

    await activePool.query(`
        INSERT INTO crmiago_escalacao_alerta (id_conversa, telefone)
        VALUES ($1, $1)
        ON CONFLICT (id_conversa) DO NOTHING
    `, [telClean]);

    await activePool.query(`
        INSERT INTO crmiago_avalista_envios (telefone, nome_cliente, tipo_envio, mensagem, status, enviado_em)
        VALUES ($1, $2, $3, $4, 'enviado', NOW())
    `, [telClean, nomeValido || telClean, tipoEnviadoEfetivo, textoFinal]);

    try {
        const textoGrupo = `🤝 *AVALISTA SOLICITADO:* Mensagem de Avalista/Novo Nome (${tipoEnviadoEfetivo}) enviada para ${nomeValido ? nomeValido + ' ' : ''}(+${telClean})! O robô pausou e o lead foi direcionado para o vendedor humano dar continuidade. 🚗`;
        await fetch(`${evoUrl}/message/sendText/${evoInst}`, {
            method: 'POST',
            headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                number: grupoEscalacao,
                text: textoGrupo
            })
        });
    } catch (e) {
        console.error('Erro ao avisar grupo:', e.message);
    }

    return { ok: true, formato: tipoEnviadoEfetivo, textoFinal };
}

// Endpoints Avalista
app.get('/api/avalista/config', authMiddleware, async (req, res) => {
    try {
        let result = await activePool.query(`SELECT * FROM crmiago_avalista_config WHERE loja_id = 1 LIMIT 1`);
        if (result.rows.length === 0) {
            await activePool.query(`
                INSERT INTO crmiago_avalista_config (loja_id, formato_envio, mensagem)
                VALUES (1, 'texto', 'Oi {nome}! Tudo bem?\\n\\nDei uma olhada aqui com a nossa equipe e pelo primeiro nome que você passou o sistema bancário não liberou a aprovação de primeira. 🚗\\n\\nVocê teria algum outro nome de confiança (como esposo(a), pai, mãe ou parente) para a gente rodar a ficha e liberar o carro para você?')
            `);
            result = await activePool.query(`SELECT * FROM crmiago_avalista_config WHERE loja_id = 1 LIMIT 1`);
        }
        res.json({ ok: true, config: result.rows[0] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch('/api/avalista/config', authMiddleware, async (req, res) => {
    try {
        const { formato_envio, mensagem, audio_url } = req.body;
        await activePool.query(`
            UPDATE crmiago_avalista_config
            SET formato_envio = COALESCE($1, formato_envio),
                mensagem = COALESCE($2, mensagem),
                audio_url = COALESCE($3, audio_url),
                atualizado_em = NOW()
            WHERE loja_id = 1
        `, [formato_envio, mensagem, audio_url]);
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Prévia do Áudio gerado pelo Iago (para escutar no painel)
app.post('/api/avalista/preview-audio', authMiddleware, async (req, res) => {
    try {
        const { mensagem, nome = 'Amigo' } = req.body || {};
        const textoBase = mensagem || 'Oi {nome}! Tudo bem?\n\nDei uma olhada aqui com a nossa equipe e pelo primeiro nome que você passou o sistema bancário não liberou a aprovação de primeira. Você teria algum outro nome de confiança para a gente rodar a ficha?';
        const textoFinal = aplicarTemplateMensagem(textoBase, nome);
        
        const audioBase64 = await sintetizarAudioTTS(textoFinal, 'onyx');
        if (!audioBase64) {
            return res.status(500).json({ error: 'Não foi possível sintetizar o áudio no momento.' });
        }

        res.json({ ok: true, audio_data: `data:audio/mp3;base64,${audioBase64}` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/avalista/leads', authMiddleware, async (req, res) => {
    try {
        const result = await activePool.query(`
            SELECT l.id, l.telefone, l.nome, l.etiqueta, l.ultima_interacao, l.ultima_mensagem, l.escalado_em,
                   COALESCE(e.id IS NOT NULL, false) as avalista_enviado,
                   e.enviado_em as avalista_enviado_em,
                   e.tipo_envio
            FROM crmiago_leads l
            LEFT JOIN LATERAL (
                SELECT id, enviado_em, tipo_envio FROM crmiago_avalista_envios WHERE telefone = l.telefone ORDER BY id DESC LIMIT 1
            ) e ON true
            WHERE (l.etiqueta IN ('com_vendedor', 'reprovado_pedir_nome') OR l.escalado_em IS NOT NULL)
              AND l.etiqueta NOT IN ('aprovado', 'a_vista', 'fechou')
            ORDER BY COALESCE(l.escalado_em, l.ultima_interacao) DESC
            LIMIT 40
        `);
        res.json({ ok: true, leads: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/avalista/enviar/:telefone', authMiddleware, async (req, res) => {
    try {
        const { telefone } = req.params;
        const { nome, formato } = req.body || {};
        const result = await enviarMensagemAvalista(telefone, nome, formato);
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/avalista/enviar-todos', authMiddleware, async (req, res) => {
    try {
        const pendentes = await activePool.query(`
            SELECT l.telefone, l.nome
            FROM crmiago_leads l
            WHERE (l.etiqueta = 'com_vendedor' OR l.escalado_em IS NOT NULL)
              AND NOT EXISTS (
                  SELECT 1 FROM crmiago_avalista_envios e WHERE e.telefone = l.telefone
              )
            LIMIT 15
        `);
        let enviados = 0;
        for (const p of pendentes.rows) {
            await enviarMensagemAvalista(p.telefone, p.nome);
            enviados++;
        }
        res.json({ ok: true, total: enviados });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── Fichas Aprovadas & Compras À Vista ───────────────────────────
app.get('/api/aprovados/leads', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { tipo, busca } = req.query; // 'todos', 'aprovado', 'a_vista'

        let where = ['l.loja_id = $1'];
        let params = [lojaId];
        let pIdx = 2;

        if (tipo === 'aprovado') {
            where.push(`l.etiqueta = 'aprovado'`);
        } else if (tipo === 'a_vista') {
            where.push(`l.etiqueta = 'a_vista'`);
        } else {
            where.push(`l.etiqueta IN ('aprovado', 'a_vista')`);
        }

        if (busca) {
            where.push(`(l.nome ILIKE $${pIdx} OR l.telefone ILIKE $${pIdx})`);
            params.push(`%${busca}%`);
            pIdx++;
        }

        const query = `
            SELECT l.*, u.nome as vendedor_nome
            FROM crmiago_leads l
            LEFT JOIN crmiago_usuarios u ON l.vendedor_id = u.id
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(l.ultima_interacao, l.criado_em) DESC
            LIMIT 100
        `;
        const result = await activePool.query(query, params);

        // Enriquecer cada lead aprovado com dados da triagem extraídos do histórico
        const leadsComTriagem = await Promise.all(result.rows.map(async (l) => {
            const telClean = String(l.telefone || '').replace(/\D/g, '');
            const hist = await activePool.query(`
                SELECT message FROM n8n_historico_mensagens
                WHERE session_id = $1 OR session_id = $2
                ORDER BY id DESC LIMIT 50
            `, [l.telefone, telClean]).catch(() => ({ rows: [] }));

            const triagem = extrairDadosTriagem(hist.rows);
            return {
                ...l,
                dados_triagem: triagem
            };
        }));

        res.json({ ok: true, leads: leadsComTriagem });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Ação rápida: Alterar status/etiqueta do lead em 1 clique
app.patch('/api/leads/:telefone/status-rapido', authMiddleware, async (req, res) => {
    try {
        const { lojaId } = req.user;
        const { telefone } = req.params;
        const { etiqueta } = req.body;
        const telDecoded = decodeURIComponent(telefone);
        const telClean = telDecoded.replace(/\D/g, '');

        const validas = ['aprovado', 'a_vista', 'fechou', 'com_vendedor', 'novo', 'quente', 'agendado'];
        if (!validas.includes(etiqueta)) {
            return res.status(400).json({ error: 'Etiqueta inválida' });
        }

        await activePool.query(`
            UPDATE crmiago_leads
            SET etiqueta = $1,
                etapa_funil = $1,
                ultima_interacao = NOW()
            WHERE loja_id = $2 AND (telefone = $3 OR telefone = $4 OR telefone = '+' || $4 OR telefone ILIKE '%' || $4)
        `, [etiqueta, lojaId, telDecoded, telClean]);

        res.json({ ok: true, etiqueta });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Iniciar worker de remarketing a cada 10 minutos
setInterval(processRemarketing, 10 * 60 * 1000);

app.get('/api/health', (req, res) => res.json({
    status: 'ok',
    db_connected: dbConnected,
    db_host: activeHost || process.env.DB_HOST,
    db_error: dbError,
    uptime: process.uptime(),
    ts: new Date().toISOString()
}));

// ─── SPA fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ─── Start Web Server ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 CRMiago Online rodando na porta ${PORT}`);
    initTables();
});
