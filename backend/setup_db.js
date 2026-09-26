const pg = require('../../autostilo-crm/backend/node_modules/pg');

const pool = new pg.Pool({
    host: '187.127.0.79',
    port: 5432,
    database: 'n8n',
    user: 'dC0TbfWTJ4BGVU7W',
    password: 'OuRGx2n8aOXUw7xGYiyXBCpp2N9APq58',
    ssl: false,
});

async function main() {
    console.log('🚀 Inicializando tabelas dedicadas do crmiago_*...');

    await pool.query(`
        -- 1. Lojas
        CREATE TABLE IF NOT EXISTS crmiago_lojas (
            id SERIAL PRIMARY KEY,
            nome VARCHAR(100) NOT NULL,
            slug VARCHAR(50) UNIQUE NOT NULL,
            criado_em TIMESTAMP DEFAULT NOW()
        );

        -- 2. Usuários
        CREATE TABLE IF NOT EXISTS crmiago_usuarios (
            id SERIAL PRIMARY KEY,
            loja_id INTEGER REFERENCES crmiago_lojas(id),
            nome VARCHAR(100) NOT NULL,
            email VARCHAR(150) UNIQUE NOT NULL,
            senha_hash VARCHAR(200) NOT NULL,
            role VARCHAR(20) DEFAULT 'admin',
            ativo BOOLEAN DEFAULT true,
            criado_em TIMESTAMP DEFAULT NOW()
        );

        -- 3. Leads
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

        -- 4. Histórico Leads
        CREATE TABLE IF NOT EXISTS crmiago_historico_leads (
            id SERIAL PRIMARY KEY,
            lead_id INTEGER REFERENCES crmiago_leads(id),
            campo VARCHAR(50),
            valor_anterior TEXT,
            valor_novo TEXT,
            usuario_id INTEGER REFERENCES crmiago_usuarios(id),
            criado_em TIMESTAMP DEFAULT NOW()
        );

        -- 5. Veículos (Estoque Próprio)
        CREATE TABLE IF NOT EXISTS crmiago_veiculos (
            id SERIAL PRIMARY KEY,
            loja_id INTEGER REFERENCES crmiago_lojas(id) DEFAULT 1,
            modelo VARCHAR(100) NOT NULL,
            marca VARCHAR(100),
            ano VARCHAR(20),
            preco NUMERIC(12, 2),
            cor VARCHAR(50),
            cambio VARCHAR(50),
            km INTEGER,
            combustivel VARCHAR(50),
            opcionais TEXT,
            diferenciais TEXT,
            descricao TEXT,
            destaque BOOLEAN DEFAULT false,
            ativo BOOLEAN DEFAULT true,
            criado_em TIMESTAMPTZ DEFAULT NOW(),
            atualizado_em TIMESTAMPTZ DEFAULT NOW()
        );

        -- 6. Fotos de Veículos
        CREATE TABLE IF NOT EXISTS crmiago_veiculos_fotos (
            id SERIAL PRIMARY KEY,
            veiculo_id INTEGER REFERENCES crmiago_veiculos(id) ON DELETE CASCADE,
            nome_arquivo VARCHAR(255),
            mimetype VARCHAR(100) DEFAULT 'image/jpeg',
            base64 TEXT NOT NULL,
            ordem INTEGER DEFAULT 0,
            criado_em TIMESTAMPTZ DEFAULT NOW()
        );

        -- 7. Config Avalista
        CREATE TABLE IF NOT EXISTS crmiago_avalista_config (
            id SERIAL PRIMARY KEY,
            loja_id INTEGER REFERENCES crmiago_lojas(id) DEFAULT 1,
            formato_envio VARCHAR(20) DEFAULT 'texto',
            mensagem TEXT,
            audio_url TEXT,
            atualizado_em TIMESTAMP DEFAULT NOW()
        );

        -- 8. Envios Avalista
        CREATE TABLE IF NOT EXISTS crmiago_avalista_envios (
            id SERIAL PRIMARY KEY,
            telefone VARCHAR(30) NOT NULL,
            nome_cliente VARCHAR(150),
            tipo_envio VARCHAR(20),
            mensagem TEXT,
            status VARCHAR(30) DEFAULT 'enviado',
            enviado_em TIMESTAMP DEFAULT NOW()
        );

        -- 9. Prompts IA e Treinamento
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

        -- 10. Status Atendimento, Fila e Alertas
        CREATE TABLE IF NOT EXISTS crmiago_status_atendimento (
            id SERIAL PRIMARY KEY,
            session_id VARCHAR(50) UNIQUE NOT NULL,
            lock_conversa BOOLEAN DEFAULT false,
            numero_followup INTEGER DEFAULT 0,
            aguardando_followup BOOLEAN DEFAULT false,
            updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS crmiago_escalacao_alerta (
            id SERIAL PRIMARY KEY,
            id_conversa VARCHAR(50) UNIQUE NOT NULL,
            telefone VARCHAR(50),
            criado_em TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS crmiago_fila_mensagens (
            id SERIAL PRIMARY KEY,
            telefone VARCHAR(50) NOT NULL,
            id_mensagem VARCHAR(100),
            conteudo TEXT,
            tipo VARCHAR(20),
            criado_em TIMESTAMP DEFAULT NOW()
        );

        -- Índices para performance
        CREATE INDEX IF NOT EXISTS idx_crmiago_leads_tel ON crmiago_leads(telefone);
        CREATE INDEX IF NOT EXISTS idx_crmiago_veiculos_mod ON crmiago_veiculos(LOWER(modelo));
        CREATE INDEX IF NOT EXISTS idx_crmiago_veiculos_ativo ON crmiago_veiculos(ativo);
        CREATE INDEX IF NOT EXISTS idx_crmiago_fotos_veic ON crmiago_veiculos_fotos(veiculo_id);
    `);

    console.log('✅ Estrutura de tabelas crmiago_* criada com sucesso!');

    // Inserir Loja e Usuários Padrão se não existirem
    const lojaCheck = await pool.query("SELECT id FROM crmiago_lojas WHERE slug = 'iago-consultor'");
    let lojaId = lojaCheck.rows[0]?.id;

    if (!lojaId) {
        const lojaRes = await pool.query(
            "INSERT INTO crmiago_lojas (nome, slug) VALUES ('Iago Consultor', 'iago-consultor') RETURNING id"
        );
        lojaId = lojaRes.rows[0].id;
        console.log(`✅ Loja padrão criada (ID: ${lojaId})`);
    }

    // Senha hash para 'admin123'
    const bcrypt = require('../../autostilo-crm/backend/node_modules/bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);

    const users = [
        { nome: 'Luan', email: 'luan@omelhorvendedoronline.com.br' },
        { nome: 'Administrador', email: 'admin@omelhorvendedoronline.com.br' },
        { nome: 'Iago Consultor', email: 'iago@omelhorvendedoronline.com.br' },
    ];

    for (const u of users) {
        await pool.query(`
            INSERT INTO crmiago_usuarios (loja_id, nome, email, senha_hash, role, ativo)
            VALUES ($1, $2, $3, $4, 'admin', true)
            ON CONFLICT (email) DO NOTHING
        `, [lojaId, u.nome, u.email, hash]);
    }
    console.log('✅ Usuários de acesso criados (senha padrão: admin123)');

    // Inserir Config Avalista padrão
    const confCheck = await pool.query("SELECT id FROM crmiago_avalista_config WHERE loja_id = $1", [lojaId]);
    if (!confCheck.rows.length) {
        await pool.query(`
            INSERT INTO crmiago_avalista_config (loja_id, formato_envio, mensagem)
            VALUES ($1, 'texto', 'Oi {nome}! Tudo bem?\n\nDei uma olhada aqui com a nossa equipe e pelo primeiro nome que você passou o sistema bancário não liberou a aprovação de primeira. 🚗\n\nVocê teria algum outro nome de confiança (como esposo(a), pai, mãe ou parente) para a gente rodar a ficha e liberar o carro para você?')
        `, [lojaId]);
        console.log('✅ Configuração de avalista padrão criada');
    }

    console.log('🎉 Setup do banco crmiago concluído!');
    await pool.end();
}

main().catch(err => {
    console.error('❌ Erro no setup:', err);
    process.exit(1);
});
