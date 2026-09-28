/* ═══════════════════════════════════════════════════════════════
   AutoStilo CRM — Frontend Application Logic
═══════════════════════════════════════════════════════════════ */

const API = '/api';
let token = localStorage.getItem('crm_token');
let currentUser = null;
let currentLeadData = null;
let leadsState = { pagina: 1, busca: '', ia_ativa: '', etiqueta: 'todos', periodo: '' };
let veiculosState = { busca: '', destaque: '', ativo: '' };
let usuarios = [];
let refreshInterval = null;
let pendingPhotos = []; // para o modal de cadastro/edição de veículos
let activeGalleryVehicleId = null;
let currentLeadsList = [];
let somNotificacaoAtivo = true;
let ultimoTotalLeads = null;
let leadsConhecidosEscalados = new Set();

function cleanPhone(tel) {
    let clean = String(tel || '').replace(/\D/g, '');
    if (!clean) return '';
    if (!clean.startsWith('55')) clean = '55' + clean;
    return clean;
}

function tocarAlertaLeadNovo() {
    if (!somNotificacaoAtivo) return;
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
        
        // Tom 1 (880Hz - A5)
        const osc1 = ctx.createOscillator();
        const gain1 = ctx.createGain();
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, ctx.currentTime);
        gain1.gain.setValueAtTime(0.12, ctx.currentTime);
        gain1.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc1.connect(gain1);
        gain1.connect(ctx.destination);
        osc1.start(ctx.currentTime);
        osc1.stop(ctx.currentTime + 0.3);

        // Tom 2 (1320Hz - E6)
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1320, ctx.currentTime + 0.15);
        gain2.gain.setValueAtTime(0.15, ctx.currentTime + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(ctx.currentTime + 0.15);
        osc2.stop(ctx.currentTime + 0.5);
    } catch (e) {
        console.log('Audio notification error:', e);
    }
}

// ─── Helpers ──────────────────────────────────────────────────
function api(endpoint, options = {}) {
    const isFormData = options.body instanceof FormData;
    const body = (options.body && typeof options.body === 'object' && !isFormData)
        ? JSON.stringify(options.body)
        : options.body;

    return fetch(`${API}${endpoint}`, {
        ...options,
        body,
        headers: {
            ...(!isFormData ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...options.headers,
        },
    }).then(async r => {
        if (!r.ok) {
            const err = await r.json().catch(() => ({ error: r.statusText }));
            throw new Error(err.error || 'Erro desconhecido');
        }
        return r.json();
    });
}

function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = (type === 'success' ? '✅ ' : '❌ ') + msg;
    el.className = `toast toast-${type}`;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}

function formatTel(tel) {
    if (!tel) return '';
    const n = tel.replace(/\D/g, '');
    if (n.length >= 12) return `+${n.slice(0,2)} (${n.slice(2,4)}) ${n.slice(4,9)}-${n.slice(9)}`;
    return tel;
}

function formatMoeda(val) {
    if (val === null || val === undefined || val === '') return 'R$ 0,00';
    return Number(val).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Agora';
    if (mins < 60) return `${mins}m atrás`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h atrás`;
    return `${Math.floor(hrs / 24)}d atrás`;
}

function initials(nome) {
    if (!nome) return '?';
    return nome.split(' ').slice(0, 2).map(s => s[0].toUpperCase()).join('');
}

const ETIQUETAS = {
    novo: { emoji: '🆕', label: 'Novo', cls: 'badge-novo' },
    quente: { emoji: '🔥', label: 'Quente', cls: 'badge-quente' },
    aprovado: { emoji: '✅', label: 'Aprovado', cls: 'badge-fechou' },
    a_vista: { emoji: '💵', label: 'À Vista', cls: 'badge-quente' },
    agendado: { emoji: '📅', label: 'Agendado', cls: 'badge-agendado' },
    fechou: { emoji: '🤝', label: 'Fechou', cls: 'badge-fechou' },
    perdeu: { emoji: '❌', label: 'Perdeu', cls: 'badge-perdeu' },
    aguardando: { emoji: '🕐', label: 'Aguardando', cls: 'badge-aguardando' },
    com_vendedor: { emoji: '👤', label: 'Com Vendedor', cls: 'badge-perdeu' },
    em_atendimento: { emoji: '💬', label: 'Em Atendimento', cls: 'badge-quente' },
    reprovado_pedir_nome: { emoji: '🤝', label: 'Pedir Avalista', cls: 'badge-perdeu' },
};

function badgeEtiqueta(e) {
    const t = ETIQUETAS[e] || { emoji: '🏷️', label: e || 'novo', cls: 'badge-novo' };
    return `<span class="badge ${t.cls}">${t.emoji} ${t.label}</span>`;
}

// ─── Clock ─────────────────────────────────────────────────────
function startClock() {
    const el = document.getElementById('headerTime');
    const tick = () => {
        const now = new Date();
        el.textContent = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    };
    tick(); setInterval(tick, 1000);
}

// ─── Auth ──────────────────────────────────────────────────────
async function checkAuth() {
    if (!token) { showLogin(); return; }
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp * 1000 < Date.now()) { logout(); return; }
        currentUser = payload;
        showApp();
    } catch { logout(); }
}

function showLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');
}

function showApp() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');

    document.getElementById('userName').textContent = currentUser.nome;
    document.getElementById('userRole').textContent = currentUser.role;
    document.getElementById('userAvatar').textContent = initials(currentUser.nome);

    startClock();
    loadDashboard();
    loadLeads();
    loadVeiculos();
    loadUsuarios();
    startAutoRefresh();
}

function logout() {
    localStorage.removeItem('crm_token');
    token = null; currentUser = null;
    if (refreshInterval) clearInterval(refreshInterval);
    showLogin();
}

// ─── Login form ────────────────────────────────────────────────
document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    const errEl = document.getElementById('loginError');
    btn.querySelector('.btn-text').classList.add('hidden');
    btn.querySelector('.btn-loader').classList.remove('hidden');
    errEl.classList.add('hidden');
    try {
        const email = document.getElementById('loginEmail').value.trim();
        const senha = document.getElementById('loginSenha').value.trim();
        const data = await api('/auth/login', { method: 'POST', body: { email, senha } });
        token = data.token;
        currentUser = data.user;
        localStorage.setItem('crm_token', token);
        showApp();
    } catch (err) {
        errEl.textContent = err.message || 'E-mail ou senha incorretos';
        errEl.classList.remove('hidden');
    } finally {
        btn.querySelector('.btn-text').classList.remove('hidden');
        btn.querySelector('.btn-loader').classList.add('hidden');
    }
});

document.getElementById('toggleSenha').addEventListener('click', () => {
    const input = document.getElementById('loginSenha');
    input.type = input.type === 'password' ? 'text' : 'password';
});
document.getElementById('btnLogout').addEventListener('click', logout);

// ─── Navigation ────────────────────────────────────────────────
const pages = {
    dashboard: { page: 'pageDashboard', title: 'Dashboard Geral', nav: 'navDashboard' },
    leads: { page: 'pageLeads', title: 'WhatsApp', nav: 'navLeads' },
    veiculos: { page: 'pageVeiculos', title: 'Anúncio / Estoque', nav: 'navVeiculos' },
    iaEditor: { page: 'pageIaEditor', title: 'Editor do Robô', nav: 'navIaEditor' },
    remarketing: { page: 'pageRemarketing', title: '🎯 Motor de Remarketing (3h, 6h, 12h)', nav: 'navRemarketing' },
    aprovados: { page: 'pageAprovados', title: '✅ Fichas Aprovadas & Compras', nav: 'navAprovados' },
    avalista: { page: 'pageAvalista', title: '🤝 Motor de Avalista (Recuperação de Fichas)', nav: 'navAvalista' },
    equipe: { page: 'pageEquipe', title: 'Vendedores', nav: 'navEquipe' },
};

function navigate(rawKey) {
    const key = rawKey === 'ia-editor' ? 'iaEditor' : rawKey;
    Object.entries(pages).forEach(([k, cfg]) => {
        const navBtn = document.getElementById(cfg.nav);
        const pageEl = document.getElementById(cfg.page);
        if (k === key) {
            navBtn?.classList.add('active');
            pageEl?.classList.add('active');
            document.getElementById('headerTitle').textContent = cfg.title;
        } else {
            navBtn?.classList.remove('active');
            pageEl?.classList.remove('active');
        }
    });
    document.getElementById('sidebar').classList.remove('open');

    if (key === 'veiculos') loadVeiculos();
    if (key === 'leads') loadLeads();
    if (key === 'dashboard') loadDashboard();
    if (key === 'iaEditor') loadIaPrompt();
    if (key === 'remarketing') loadRemarketing();
    if (key === 'aprovados') loadAprovados();
    if (key === 'avalista') loadAvalista();
    if (key === 'equipe') loadUsuarios();
}

function closeMobileSidebar() {
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebarBackdrop')?.classList.remove('active');
}

function toggleMobileSidebar() {
    const sidebar = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebarBackdrop');
    if (sidebar) {
        const isOpen = sidebar.classList.toggle('open');
        backdrop?.classList.toggle('active', isOpen);
    }
}

document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        navigate(btn.dataset.page);
        closeMobileSidebar();
    });
});

document.getElementById('btnMenuToggle')?.addEventListener('click', toggleMobileSidebar);
document.getElementById('sidebarBackdrop')?.addEventListener('click', closeMobileSidebar);

// ─── Dashboard ─────────────────────────────────────────────────
async function loadDashboard() {
    try {
        const data = await api('/dashboard');

        document.getElementById('dashDate').textContent =
            new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

        document.getElementById('statTotalLeads').textContent = data.total_leads ?? 0;
        document.getElementById('statIaAtiva').textContent = data.ia_ativa ?? 0;
        document.getElementById('statIaOff').textContent = data.ia_off ?? 0;
        document.getElementById('statEscaladosHoje').textContent = data.escalados_hoje ?? 0;
        document.getElementById('badgeLeads').textContent = data.total_leads ?? 0;

        loadEscaladosRecentes();
        loadLiveActivity();
    } catch {}
}

async function loadEscaladosRecentes() {
    try {
        const data = await api('/leads?ia_ativa=false&limite=6');
        const el = document.getElementById('escaladosList');
        const badgeCount = document.getElementById('badgeEscaladosCount');

        const totalEscalados = data.total || data.leads.length;
        if (badgeCount) {
            badgeCount.textContent = totalEscalados === 1 ? '1 cliente aguardando' : `${totalEscalados} clientes aguardando`;
        }

        if (!data.leads.length) {
            el.innerHTML = '<div class="empty-state">Sem clientes aguardando atendimento humano no momento 🎉</div>';
            return;
        }

        el.innerHTML = data.leads.map(l => {
            const rawMsg = l.ultima_mensagem || 'Cliente solicitou atendimento com consultor';
            const cleanMsg = rawMsg.replace(/\[\{.*?\}\]/g, '').trim();

            return `
                <div class="escalado-card-rich" onclick="openLead('${encodeURIComponent(l.telefone)}')">
                    <div class="escalado-main-info">
                        <div class="escalado-avatar">${initials(l.nome || l.telefone)}</div>
                        <div class="escalado-details">
                            <div class="escalado-title-row">
                                <span class="escalado-nome">${escapeHtml(l.nome || formatTel(l.telefone))}</span>
                                ${badgeEtiqueta(l.etiqueta)}
                            </div>
                            <div class="escalado-tel">📱 ${formatTel(l.telefone)}</div>
                            <div class="escalado-last-msg">💬 "${escapeHtml(cleanMsg)}"</div>
                        </div>
                    </div>
                    <div class="escalado-actions-side">
                        <span class="escalado-wait-badge">⏱️ ${timeAgo(l.ultima_interacao)}</span>
                        <button class="btn-assumir-escalado" onclick="event.stopPropagation(); openLead('${encodeURIComponent(l.telefone)}')">
                            💬 Atender Agora
                        </button>
                    </div>
                </div>
            `;
        }).join('');
    } catch {}
}

async function loadLiveActivity() {
    try {
        const data = await api('/leads?limite=5');
        const el = document.getElementById('liveActivityList');
        if (!data.leads.length) {
            el.innerHTML = '<div class="empty-state">Sem mensagens recentes</div>';
            return;
        }

        el.innerHTML = data.leads.map(l => {
            const rawMsg = l.ultima_mensagem || 'Iniciou conversa';
            const cleanMsg = rawMsg.replace(/\[\{.*?\}\]/g, '').trim();
            const isBot = l.ia_ativa;

            return `
                <div class="live-activity-item" onclick="openLead('${encodeURIComponent(l.telefone)}')">
                    <div class="live-act-left">
                        <div class="live-act-avatar">${isBot ? '🤖' : '👤'}</div>
                        <div class="live-act-content">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span class="live-act-name">${escapeHtml(l.nome || formatTel(l.telefone))}</span>
                                <span style="font-size: 0.7rem; color: ${isBot ? '#34d399' : '#fbbf24'}; font-weight: 700;">
                                    ${isBot ? '• Iago Ativo' : '• Com Consultor'}
                                </span>
                            </div>
                            <div class="live-act-msg">"${escapeHtml(cleanMsg)}"</div>
                        </div>
                    </div>
                    <span class="live-act-time">${timeAgo(l.ultima_interacao)}</span>
                </div>
            `;
        }).join('');
    } catch {}
}

// ─── Leads ─────────────────────────────────────────────────────
async function loadLeads() {
    const tbody = document.getElementById('leadsTableBody');
    tbody.innerHTML = `<tr><td colspan="7" class="table-loading"><div class="spinner"></div> Carregando...</td></tr>`;
    try {
        const params = new URLSearchParams({
            pagina: leadsState.pagina,
            limite: 15,
        });
        if (leadsState.busca) params.set('busca', leadsState.busca);
        if (leadsState.ia_ativa !== '') params.set('ia_ativa', leadsState.ia_ativa);
        if (leadsState.etiqueta !== 'todos') params.set('etiqueta', leadsState.etiqueta);

        const data = await api(`/leads?${params}`);
        let leads = data.leads || [];

        // Filtro local por período
        if (leadsState.periodo) {
            const now = new Date();
            leads = leads.filter(l => {
                if (!l.ultima_interacao) return false;
                const d = new Date(l.ultima_interacao);
                if (leadsState.periodo === 'hoje') {
                    return d.toDateString() === now.toDateString();
                } else if (leadsState.periodo === 'ontem') {
                    const ontem = new Date(); ontem.setDate(ontem.getDate() - 1);
                    return d.toDateString() === ontem.toDateString();
                } else if (leadsState.periodo === '7dias') {
                    const limite = new Date(); limite.setDate(limite.getDate() - 7);
                    return d >= limite;
                }
                return true;
            });
        }

        // Alerta sonoro / visual se entrar lead novo
        if (ultimoTotalLeads !== null && data.total > ultimoTotalLeads) {
            tocarAlertaLeadNovo();
            toast('🔔 Novo lead recebido no WhatsApp!');
        }
        ultimoTotalLeads = data.total;

        // Alerta sonoro / visual se houver lead escalado para vendedor humano
        const novoEscalado = leads.find(l => (l.etiqueta === 'escalado' || l.etapa_funil === 'com_vendedor') && !leadsConhecidosEscalados.has(l.telefone));
        if (novoEscalado) {
            leadsConhecidosEscalados.add(novoEscalado.telefone);
            tocarAlertaLeadNovo();
            toast(`🚨 ATENÇÃO: Lead ${novoEscalado.nome || novoEscalado.telefone} aguardando atendimento humano!`, 'error');
        }

        currentLeadsList = leads;
        renderLeadsTable(leads);
        renderPagination(data.total_paginas, data.pagina);
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="7" class="table-loading" style="color:var(--red)">❌ Erro: ${e.message}</td></tr>`;
    }
}

function renderLeadsTable(leads) {
    const tbody = document.getElementById('leadsTableBody');
    if (!tbody) return;
    if (!leads || !leads.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="table-loading">Nenhum lead encontrado</td></tr>`;
        return;
    }
    tbody.innerHTML = leads.map(l => {
        const rawMsg = l.ultima_mensagem || '—';
        const cleanMsg = rawMsg.replace(/\[\{.*?\}\]/g, '').trim();
        const telLimpo = cleanPhone(l.telefone);

        return `
            <tr onclick="openLead('${encodeURIComponent(l.telefone)}')">
                <td>
                    <div class="lead-cell">
                        <div class="lead-avatar">${initials(l.nome || l.telefone)}</div>
                        <div>
                            <div class="lead-name">${escapeHtml(l.nome || '(sem nome)')}</div>
                            <div class="lead-phone">${formatTel(l.telefone)}</div>
                        </div>
                    </div>
                </td>
                <td>
                    <button class="ia-toggle-btn ${l.ia_ativa ? 'ia-on' : 'ia-off'}" 
                            onclick="event.stopPropagation(); toggleIaStatus('${encodeURIComponent(l.telefone)}', ${l.ia_ativa})" 
                            title="Clique para alternar entre IA Ativa e Atendimento Humano">
                        <span class="ia-toggle-icon">${l.ia_ativa ? '🤖' : '👤'}</span>
                        <span class="ia-toggle-text">${l.ia_ativa ? 'IA Ativa' : 'Humano'}</span>
                        <span class="ia-toggle-switch"></span>
                    </button>
                </td>
                <td>${badgeEtiqueta(l.etiqueta)}</td>
                <td style="max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:0.8rem">
                    ${escapeHtml(cleanMsg)}
                </td>
                <td style="color:var(--text-secondary);font-size:0.78rem;white-space:nowrap;">${timeAgo(l.ultima_interacao)}</td>
                <td style="white-space:nowrap;">
                    <div style="display:flex;align-items:center;gap:6px;">
                        <a href="https://wa.me/${telLimpo}" target="_blank" rel="noopener noreferrer" 
                           class="btn btn-sm" 
                           onclick="event.stopPropagation()" 
                           title="Abrir WhatsApp direto com o cliente"
                           style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);text-decoration:none;display:inline-flex;align-items:center;gap:4px;padding:4px 8px;font-size:0.75rem;font-weight:600;border-radius:6px;transition:all 0.2s;">
                            <span>🟢</span> <span>WhatsApp</span>
                        </a>
                        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation(); openLead('${encodeURIComponent(l.telefone)}')">
                            Ver →
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

// ─── TOGGLE IA RÁPIDO ON/OFF ───────────────────────────────────
window.toggleIaStatus = async (telEncoded, currentStatus) => {
    const tel = decodeURIComponent(telEncoded);
    try {
        const data = await api(`/leads/${telEncoded}/toggle-ia`, { method: 'POST' });
        if (data.ia_ativa) {
            toast(`🤖 IA ATIVADA para ${formatTel(tel)}! O robô voltará a responder.`);
        } else {
            toast(`👤 IA DESATIVADA para ${formatTel(tel)} (Atendimento Humano assumiu).`);
        }
        loadLeads();
        loadDashboard();
    } catch (e) {
        toast('Erro ao alterar status da IA: ' + e.message, 'error');
    }
};

function renderPagination(total, atual) {
    const el = document.getElementById('pagination');
    if (!el || total <= 1) { if (el) el.innerHTML = ''; return; }
    let html = `<button class="page-btn" onclick="goPage(${atual-1})" ${atual<=1?'disabled':''}>‹</button>`;
    for (let i = 1; i <= total; i++) {
        if (i === 1 || i === total || Math.abs(i - atual) <= 2) {
            html += `<button class="page-btn ${i===atual?'active':''}" onclick="goPage(${i})">${i}</button>`;
        } else if (Math.abs(i - atual) === 3) {
            html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
        }
    }
    html += `<button class="page-btn" onclick="goPage(${atual+1})" ${atual>=total?'disabled':''}>›</button>`;
    el.innerHTML = html;
}

window.goPage = (p) => { leadsState.pagina = p; loadLeads(); };

// Search Leads
let searchTimeout;
document.getElementById('searchInput')?.addEventListener('input', e => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        leadsState.busca = e.target.value;
        leadsState.pagina = 1;
        loadLeads();
    }, 350);
});

// Filters Leads por Etiqueta
document.querySelectorAll('#etiquetasFilter .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#etiquetasFilter .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        leadsState.etiqueta = chip.dataset.etiqueta || '';
        leadsState.pagina = 1;
        loadLeads();
    });
});

// Filters Leads por Período
document.querySelectorAll('#periodoFilter .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        document.querySelectorAll('#periodoFilter .filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        leadsState.periodo = chip.dataset.periodo || '';
        leadsState.pagina = 1;
        loadLeads();
    });
});

// Botão Exportar CSV
window.exportarLeadsCsv = () => {
    if (!currentLeadsList || !currentLeadsList.length) {
        toast('Nenhum lead encontrado para exportar.', 'error');
        return;
    }
    const headers = ['Nome', 'Telefone', 'Etiqueta', 'Status IA', 'Ultima Interacao', 'Ultima Mensagem'];
    const rows = currentLeadsList.map(l => [
        `"${(l.nome || '').replace(/"/g, '""')}"`,
        `"${(l.telefone || '').replace(/"/g, '""')}"`,
        `"${(l.etiqueta || '').replace(/"/g, '""')}"`,
        l.ia_ativa ? 'IA Ativa' : 'Humano',
        l.ultima_interacao ? new Date(l.ultima_interacao).toLocaleString('pt-BR') : '',
        `"${(l.ultima_mensagem || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `leads_iago_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    toast('📥 Planilha CSV exportada com sucesso!');
};

document.getElementById('btnExportarCsv')?.addEventListener('click', () => {
    window.exportarLeadsCsv();
});

// Botão Exportar VCF para iPhone
window.exportarLeadsVcf = async () => {
    let allLeads = currentLeadsList;
    try {
        toast('⏳ Preparando contatos para iPhone (.VCF)...');
        const res = await api('/leads?limite=5000');
        if (res && res.leads && res.leads.length > 0) {
            allLeads = res.leads;
        }
    } catch(e) {}

    if (!allLeads || !allLeads.length) {
        toast('Nenhum lead encontrado para exportar.', 'error');
        return;
    }

    let vcf = '';
    let exportados = 0;
    allLeads.forEach(l => {
        const rawTel = String(l.telefone || '').replace(/\D/g, '');
        if (!rawTel || rawTel.length < 8) return;
        const telFormatted = rawTel.startsWith('55') ? `+${rawTel}` : `+55${rawTel}`;
        const nomeClean = (l.nome && l.nome !== '(sem nome)' && l.nome !== l.telefone) ? l.nome.trim() : `Lead ${rawTel.slice(-4)}`;
        const nomeFinal = `${nomeClean} (Iago Lead)`;

        vcf += 'BEGIN:VCARD\r\n';
        vcf += 'VERSION:3.0\r\n';
        vcf += `FN:${nomeFinal}\r\n`;
        vcf += `N:;${nomeFinal};;;\r\n`;
        vcf += `TEL;TYPE=CELL,VOICE:${telFormatted}\r\n`;
        vcf += `NOTE:Lead CRM Iago - Etiqueta: ${l.etiqueta || 'Geral'}\r\n`;
        vcf += 'END:VCARD\r\n';
        exportados++;
    });

    const blob = new Blob([vcf], { type: 'text/vcard;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `contatos_iphone_iago_${new Date().toISOString().slice(0, 10)}.vcf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    toast(`📱 ${exportados} contatos prontos! Toque no arquivo no iPhone para adicionar todos na agenda!`);
};

document.getElementById('btnExportarVcf')?.addEventListener('click', () => {
    window.exportarLeadsVcf();
});

// Botão Alternar Som Notificação
document.getElementById('btnToggleSomNotificacao')?.addEventListener('click', () => {
    somNotificacaoAtivo = !somNotificacaoAtivo;
    const icon = document.getElementById('iconSomNotificacao');
    const txt = document.getElementById('textSomNotificacao');
    if (icon) icon.textContent = somNotificacaoAtivo ? '🔔' : '🔕';
    if (txt) txt.textContent = somNotificacaoAtivo ? 'Som Ativo' : 'Som Mudo';
    toast(somNotificacaoAtivo ? '🔔 Alerta sonoro ativado!' : '🔕 Alerta sonoro silenciado.');
    if (somNotificacaoAtivo) tocarAlertaLeadNovo();
});

// ─── Lead Modal & Live WhatsApp Chat ───────────────────────────
let activeChatInterval = null;
let selectedImageBase64 = null;
let selectedImageMime = 'image/jpeg';
let mediaRecorder = null;
let audioChunks = [];
let recordTimerInterval = null;
let recordSeconds = 0;
let lastKnownVeiculosFotos = [];

window.openLead = async (telEncoded) => {
    const tel = decodeURIComponent(telEncoded);
    const modal = document.getElementById('modalLead');
    modal.classList.remove('hidden');

    document.getElementById('chatView').innerHTML = '<div class="chat-loading">Carregando conversa ao vivo...</div>';
    document.getElementById('modalLeadNome').textContent = '...';
    document.getElementById('modalLeadTelefone').textContent = tel;
    document.getElementById('modalAvatar').textContent = '?';

    // Limpar estados de envio anteriores
    clearImagePreview();
    cancelAudioRecording();
    document.getElementById('msgManualInput').value = '';

    await fetchAndRenderLead(telEncoded, true);
    startLiveChatPolling(telEncoded);
};

async function fetchAndRenderLead(telEncoded, isFirstLoad = false) {
    try {
        const data = await api(`/leads/${telEncoded}`);
        currentLeadData = data.lead;
        lastKnownVeiculosFotos = data.veiculosFotos || [];
        renderLeadModal(data.lead, data.historico || [], data.audios || [], data.veiculosFotos || [], isFirstLoad);
    } catch (e) {
        if (isFirstLoad) toast('Erro ao carregar lead: ' + e.message, 'error');
    }
}

function startLiveChatPolling(telEncoded) {
    stopLiveChatPolling();
    activeChatInterval = setInterval(() => {
        const modal = document.getElementById('modalLead');
        if (modal && !modal.classList.contains('hidden')) {
            fetchAndRenderLead(telEncoded, false);
        } else {
            stopLiveChatPolling();
        }
    }, 2500);
}

function stopLiveChatPolling() {
    if (activeChatInterval) {
        clearInterval(activeChatInterval);
        activeChatInterval = null;
    }
}

function renderLeadModal(lead, historico = [], audios = [], veiculosFotos = [], isFirstLoad = false) {
    if (isFirstLoad) {
        document.getElementById('modalLeadNome').textContent = lead.nome || '(sem nome)';
        document.getElementById('modalLeadTelefone').textContent = formatTel(lead.telefone);
        document.getElementById('modalAvatar').textContent = initials(lead.nome || lead.telefone);

        const btnWhatsModal = document.getElementById('modalBtnWhatsAppDirect');
        if (btnWhatsModal) {
            btnWhatsModal.href = `https://wa.me/${cleanPhone(lead.telefone)}`;
        }

        const iaToggle = document.getElementById('iaToggle');
        iaToggle.checked = lead.ia_ativa;
        updateIaLabel(lead.ia_ativa);

        const etiquetaGrid = document.getElementById('etiquetaGrid');
        etiquetaGrid.innerHTML = Object.entries(ETIQUETAS).map(([k, v]) =>
            `<button class="etiqueta-btn ${lead.etiqueta === k ? 'active-etiqueta' : ''}" data-etiqueta="${k}">${v.emoji} ${v.label}</button>`
        ).join('');
        etiquetaGrid.querySelectorAll('.etiqueta-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                etiquetaGrid.querySelectorAll('.etiqueta-btn').forEach(b => b.classList.remove('active-etiqueta'));
                btn.classList.add('active-etiqueta');
            });
        });

        const sel = document.getElementById('vendedorSelect');
        sel.innerHTML = `<option value="">— Sem vendedor —</option>` +
            usuarios.map(u => `<option value="${u.id}" ${lead.vendedor_id === u.id ? 'selected' : ''}>${u.nome}</option>`).join('');

        document.getElementById('anotacoesInput').value = lead.anotacoes || '';

        // ── Preencher Ficha de Triagem do Cliente ──
        const triagem = lead.dados_triagem || {};
        const elCarro = document.getElementById('triagemCarro');
        const elForma = document.getElementById('triagemForma');
        const elEntrada = document.getElementById('triagemEntrada');
        const elParcela = document.getElementById('triagemParcela');
        const elCpf = document.getElementById('triagemCpf');
        const elNasc = document.getElementById('triagemNasc');
        const elCnh = document.getElementById('triagemCnh');
        const elTroca = document.getElementById('triagemTroca');
        const elResumo = document.getElementById('triagemResumo');

        if (elCarro) elCarro.textContent = triagem.carro_interesse || '—';
        if (elForma) elForma.textContent = triagem.forma_compra || (lead.etiqueta === 'a_vista' ? 'À Vista' : 'Financiamento');
        if (elEntrada) elEntrada.textContent = triagem.entrada || '—';
        if (elParcela) elParcela.textContent = triagem.parcela || '—';
        if (elCpf) elCpf.textContent = triagem.cpf || '—';
        if (elNasc) elNasc.textContent = triagem.nascimento || '—';
        if (elCnh) elCnh.textContent = triagem.cnh || '—';
        if (elTroca) elTroca.textContent = triagem.troca || 'Não informada';
        if (elResumo) elResumo.textContent = triagem.resumo || 'Sem observações adicionais gravadas na simulação.';

        // Botões de Ação Rápida no Modal
        const btnAprov = document.getElementById('btnMarcarAprovadoModal');
        const btnVista = document.getElementById('btnMarcarAVistaModal');

        if (btnAprov) {
            btnAprov.onclick = async () => {
                try {
                    await api(`/leads/${encodeURIComponent(lead.telefone)}/status-rapido`, {
                        method: 'PATCH',
                        body: { etiqueta: 'aprovado' }
                    });
                    toast('✅ Lead marcado como APROVADO! Movido para Fichas Aprovadas.');
                    lead.etiqueta = 'aprovado';
                    // Atualiza botão na grid de etiquetas
                    etiquetaGrid.querySelectorAll('.etiqueta-btn').forEach(b => {
                        if (b.dataset.etiqueta === 'aprovado') b.classList.add('active-etiqueta');
                        else b.classList.remove('active-etiqueta');
                    });
                    if (pages.leads.page && document.getElementById(pages.leads.page).classList.contains('active')) loadLeads();
                    if (document.getElementById('badgeAprovados')) {
                        const cur = parseInt(document.getElementById('badgeAprovados').textContent || '0');
                        document.getElementById('badgeAprovados').textContent = cur + 1;
                    }
                } catch(err) {
                    toast('Erro ao aprovar: ' + err.message, 'error');
                }
            };
        }

        if (btnVista) {
            btnVista.onclick = async () => {
                try {
                    await api(`/leads/${encodeURIComponent(lead.telefone)}/status-rapido`, {
                        method: 'PATCH',
                        body: { etiqueta: 'a_vista' }
                    });
                    toast('💵 Lead marcado como COMPRA À VISTA! Movido para Fichas Aprovadas.');
                    lead.etiqueta = 'a_vista';
                    etiquetaGrid.querySelectorAll('.etiqueta-btn').forEach(b => {
                        if (b.dataset.etiqueta === 'a_vista') b.classList.add('active-etiqueta');
                        else b.classList.remove('active-etiqueta');
                    });
                    if (pages.leads.page && document.getElementById(pages.leads.page).classList.contains('active')) loadLeads();
                    if (document.getElementById('badgeAprovados')) {
                        const cur = parseInt(document.getElementById('badgeAprovados').textContent || '0');
                        document.getElementById('badgeAprovados').textContent = cur + 1;
                    }
                } catch(err) {
                    toast('Erro ao marcar à vista: ' + err.message, 'error');
                }
            };
        }
    }

    renderChat(historico, audios, veiculosFotos, isFirstLoad);
}

function updateIaLabel(isOn) {
    const lbl = document.getElementById('iaStatusLabel');
    lbl.textContent = isOn ? '🤖 IA Ativa' : '👤 Atendimento Humano';
    lbl.className = `ia-status-label ${isOn ? 'ia-on' : 'ia-off'}`;
}

document.getElementById('iaToggle').addEventListener('change', e => updateIaLabel(e.target.checked));

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

function renderChat(historico = [], audios = [], veiculosFotos = [], isFirstLoad = false) {
    const view = document.getElementById('chatView');
    if ((!historico || !historico.length) && (!audios || !audios.length)) {
        view.innerHTML = '<div class="chat-loading">Sem histórico registrado</div>';
        return;
    }

    // Mapa de áudios
    const audioMap = new Map();
    (audios || []).forEach(a => {
        if (a.id_mensagem) audioMap.set(a.id_mensagem, a);
    });

    const isScrolledToBottom = view.scrollHeight - view.clientHeight <= view.scrollTop + 60;

    const html = historico.slice().reverse().map(row => {
        let msgObj = row.message;
        if (typeof msgObj === 'string') {
            try { msgObj = JSON.parse(msgObj); } catch { msgObj = { content: msgObj }; }
        }
        msgObj = msgObj || {};

        const msgType = msgObj.type || row.type || row.role || 'ai';
        const sender = msgObj.sender || (msgType === 'human' || msgType === 'user' || msgType === 'incoming' ? 'user' : 'bot');
        const isHuman = sender === 'user';
        const isVendedor = sender === 'vendedor';

        let text = msgObj.content || row.content || (typeof row.message === 'string' ? row.message : '') || '';
        if (typeof text === 'object') {
            text = text.text || text.caption || JSON.stringify(text);
        }

        // Se for envio de fotos pelo robô (tool call de fotos)
        let galleryHtml = '';
        if (msgType === 'tool' && (row.message?.name?.includes('fotos') || text.includes('Fotos enviadas'))) {
            // Renderizar galeria de fotos do veículo enviado
            if (veiculosFotos && veiculosFotos.length > 0) {
                galleryHtml = `
                    <div class="chat-gallery">
                        ${veiculosFotos.slice(0, 6).map(f => `
                            <img src="data:${f.mimetype || 'image/jpeg'};base64,${f.base64}" 
                                 class="chat-gallery-img" 
                                 title="${f.marca || ''} ${f.modelo || ''}" 
                                 onclick="window.openImageLightbox(this.src)">
                        `).join('')}
                    </div>
                `;
            }
            return `<div class="chat-bubble bot">
                <div class="chat-bubble-sender">🤖 Iago (Fotos Enviadas)</div>
                ${galleryHtml}
                <div class="chat-bubble-text" style="font-size:0.78rem; color:#a7f3d0">📸 <em>Fotos do veículo enviadas no WhatsApp</em></div>
                <div class="chat-time">${row.created_at ? new Date(row.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : ''} ✓✓</div>
            </div>`;
        }

        // Ignorar chamadas de ferramentas de controle interno
        if (msgType === 'tool' || text.startsWith('Calling ') || (text.startsWith('[{"resultado"') && text.length > 50)) {
            return '';
        }

        // Imagem anexada avulsa
        let singleImgHtml = '';
        if (msgObj.media_type === 'image' && msgObj.base64) {
            singleImgHtml = `<img src="data:${msgObj.mimetype || 'image/jpeg'};base64,${msgObj.base64}" class="chat-single-img" onclick="window.openImageLightbox(this.src)">`;
        }

        // Áudio anexado
        const audioItem = audioMap.get(row.id_mensagem) || audioMap.get(row.id) || (msgObj.base64 && msgObj.media_type === 'audio' ? { base64: msgObj.base64, mimetype: msgObj.mimetype } : null);
        let audioSrc = '';
        if (audioItem && audioItem.base64) {
            const raw = audioItem.base64;
            if (raw.startsWith('data:audio/')) {
                audioSrc = raw;
            } else {
                const mime = audioItem.mimetype || (raw.startsWith('GkX') ? 'audio/webm' : 'audio/ogg');
                audioSrc = `data:${mime};base64,${raw}`;
            }
        }
        const time = row.created_at ? new Date(row.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';

        let senderLabel = isHuman ? '👤 Cliente' : (isVendedor ? `👨‍💼 Vendedor (${msgObj.vendedor_nome || 'Você'})` : '🤖 Iago (IA)');
        let bubbleClass = isHuman ? 'user' : (isVendedor ? 'vendedor' : 'bot');

        return `<div class="chat-bubble ${bubbleClass}">
            <div class="chat-bubble-sender">${senderLabel}</div>
            ${singleImgHtml}
            ${audioSrc ? `
                <div class="chat-audio-player-wrap">
                    <div class="chat-audio-pill">🎙️ Áudio de Voz</div>
                    <audio controls class="chat-audio-el" src="${audioSrc}"></audio>
                </div>
            ` : ''}
            ${text && (!singleImgHtml || text !== '📷 Imagem enviada') ? `<div class="chat-bubble-text">${escapeHtml(text)}</div>` : ''}
            <div class="chat-time">${time} ${!isHuman ? '✓✓' : ''}</div>
        </div>`;
    }).filter(Boolean).join('');

    view.innerHTML = html || '<div class="chat-loading">Sem mensagens para exibir</div>';

    if (isFirstLoad || isScrolledToBottom) {
        view.scrollTop = view.scrollHeight;
    }
}

// ─── Envio de Mensagem WhatsApp (Texto / Imagem / Áudio) ─────────
async function enviarMensagemChat() {
    if (!currentLeadData) return;
    const input = document.getElementById('msgManualInput');
    const texto = input.value.trim();
    const tel = encodeURIComponent(currentLeadData.telefone);

    if (!texto && !selectedImageBase64) return;

    try {
        const payload = {
            texto: texto || undefined,
            imagemBase64: selectedImageBase64 || undefined,
            mimeType: selectedImageMime || 'image/jpeg'
        };

        input.value = '';
        clearImagePreview();

        await api(`/leads/${tel}/mensagem`, {
            method: 'POST',
            body: JSON.stringify(payload),
        });

        toast('Mensagem enviada no WhatsApp!');
        await fetchAndRenderLead(tel, false);
    } catch (e) {
        toast('Erro ao enviar: ' + e.message, 'error');
    }
}

document.getElementById('btnEnviarMsg').addEventListener('click', enviarMensagemChat);
document.getElementById('msgManualInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarMensagemChat();
    }
});

// ─── Anexo de Imagens no Chat ──────────────────────────────────
document.getElementById('btnAttachImage').addEventListener('click', () => {
    document.getElementById('chatFileInput').click();
});

document.getElementById('chatFileInput').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;

    selectedImageMime = file.type || 'image/jpeg';
    const reader = new FileReader();
    reader.onload = evt => {
        selectedImageBase64 = evt.target.result;
        document.getElementById('imagePreviewImg').src = selectedImageBase64;
        document.getElementById('imagePreviewContainer').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
});

document.getElementById('btnRemoveImagePreview').addEventListener('click', clearImagePreview);

function clearImagePreview() {
    selectedImageBase64 = null;
    document.getElementById('imagePreviewImg').src = '';
    document.getElementById('imagePreviewContainer').classList.add('hidden');
    document.getElementById('chatFileInput').value = '';
}

// ─── Gravação de Áudio de Voz (Microfone) ───────────────────────
let currentRecordedMime = 'audio/webm;codecs=opus';

document.getElementById('btnRecordAudio').addEventListener('click', async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        
        let mimeType = 'audio/webm;codecs=opus';
        if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
            mimeType = 'audio/webm;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
            mimeType = 'audio/ogg;codecs=opus';
        } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
            mimeType = 'audio/mp4';
        }
        currentRecordedMime = mimeType;

        mediaRecorder = new MediaRecorder(stream, { mimeType });
        audioChunks = [];

        mediaRecorder.ondataavailable = evt => {
            if (evt.data && evt.data.size > 0) {
                audioChunks.push(evt.data);
            }
        };

        mediaRecorder.onstart = () => {
            recordSeconds = 0;
            document.getElementById('recTimer').textContent = '0:00';
            document.getElementById('chatInputBar').classList.add('hidden');
            document.getElementById('recordingBar').classList.remove('hidden');

            recordTimerInterval = setInterval(() => {
                recordSeconds++;
                const mins = Math.floor(recordSeconds / 60);
                const secs = recordSeconds % 60;
                document.getElementById('recTimer').textContent = `${mins}:${secs < 10 ? '0' : ''}${secs}`;
            }, 1000);
        };

        mediaRecorder.start(200); // grava blocos a cada 200ms
    } catch (e) {
        toast('Não foi possível acessar o microfone: ' + e.message, 'error');
    }
});

document.getElementById('btnCancelRec').addEventListener('click', cancelAudioRecording);

function cancelAudioRecording() {
    if (recordTimerInterval) {
        clearInterval(recordTimerInterval);
        recordTimerInterval = null;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
        mediaRecorder.stream.getTracks().forEach(t => t.stop());
    }
    audioChunks = [];
    document.getElementById('recordingBar').classList.add('hidden');
    document.getElementById('chatInputBar').classList.remove('hidden');
}

document.getElementById('btnSendRec').addEventListener('click', async () => {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

    if (recordTimerInterval) {
        clearInterval(recordTimerInterval);
        recordTimerInterval = null;
    }

    // Solicitar último chunk antes de fechar
    if (mediaRecorder.state === 'recording') {
        mediaRecorder.requestData();
    }

    mediaRecorder.onstop = async () => {
        mediaRecorder.stream.getTracks().forEach(t => t.stop());

        if (!audioChunks.length) {
            toast('Nenhum áudio gravado.', 'error');
            cancelAudioRecording();
            return;
        }

        const audioBlob = new Blob(audioChunks, { type: currentRecordedMime });
        audioChunks = [];

        document.getElementById('recordingBar').classList.add('hidden');
        document.getElementById('chatInputBar').classList.remove('hidden');

        if (audioBlob.size < 500) {
            toast('Áudio muito curto.', 'warning');
            return;
        }

        const reader = new FileReader();
        reader.onload = async evt => {
            const b64 = evt.target.result;
            try {
                const tel = encodeURIComponent(currentLeadData.telefone);
                await api(`/leads/${tel}/mensagem`, {
                    method: 'POST',
                    body: JSON.stringify({ 
                        audioBase64: b64,
                        mimeType: currentRecordedMime
                    }),
                });
                toast('Áudio de voz enviado no WhatsApp!');
                await fetchAndRenderLead(tel, false);
            } catch (err) {
                toast('Erro ao enviar áudio: ' + err.message, 'error');
            }
        };
        reader.readAsDataURL(audioBlob);
    };

    mediaRecorder.stop();
});

// Lightbox de Imagens
window.openImageLightbox = (src) => {
    let box = document.getElementById('chatLightbox');
    if (!box) {
        box = document.createElement('div');
        box.id = 'chatLightbox';
        box.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:1rem;backdrop-filter:blur(6px);';
        box.innerHTML = `<img id="chatLightboxImg" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 0 30px rgba(0,0,0,0.8);object-fit:contain;">`;
        box.onclick = () => box.classList.add('hidden');
        document.body.appendChild(box);
    }
    document.getElementById('chatLightboxImg').src = src;
    box.classList.remove('hidden');
};

// Salvar lead
document.getElementById('btnSalvarLead').addEventListener('click', async () => {
    if (!currentLeadData) return;
    const tel = encodeURIComponent(currentLeadData.telefone);
    const etiqueta = document.querySelector('.etiqueta-btn.active-etiqueta')?.dataset.etiqueta;
    try {
        await api(`/leads/${tel}`, {
            method: 'PATCH',
            body: JSON.stringify({
                ia_ativa: document.getElementById('iaToggle').checked,
                etiqueta,
                vendedor_id: document.getElementById('vendedorSelect').value || null,
                anotacoes: document.getElementById('anotacoesInput').value,
            }),
        });
        toast('Lead atualizado com sucesso!');
        loadLeads(); loadDashboard();
    } catch (e) { toast(e.message, 'error'); }
});

// Fechar modal lead e parar polling
document.getElementById('modalLeadClose').addEventListener('click', () => {
    document.getElementById('modalLead').classList.add('hidden');
    stopLiveChatPolling();
    cancelAudioRecording();
});
document.getElementById('modalLead').addEventListener('click', e => {
    if (e.target === document.getElementById('modalLead')) {
        document.getElementById('modalLead').classList.add('hidden');
        stopLiveChatPolling();
        cancelAudioRecording();
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── ESTOQUE DE VEÍCULOS & GESTÃO DE FOTOS ────────────────────
// ═══════════════════════════════════════════════════════════════

async function loadVeiculos() {
    const grid = document.getElementById('veiculosGrid');
    grid.innerHTML = `<div class="loading-placeholder"><div class="spinner"></div> Carregando estoque de veículos...</div>`;
    try {
        const params = new URLSearchParams();
        if (veiculosState.busca) params.set('busca', veiculosState.busca);
        if (veiculosState.destaque !== '') params.set('destaque', veiculosState.destaque);
        if (veiculosState.ativo !== '') params.set('ativo', veiculosState.ativo);

        const veiculos = await api(`/veiculos?${params}`);
        document.getElementById('badgeVeiculos').textContent = veiculos.length;
        renderVeiculosGrid(veiculos);
    } catch (e) {
        grid.innerHTML = `<div class="loading-placeholder" style="color:var(--red)">❌ Erro ao carregar veículos: ${e.message}</div>`;
    }
}

function renderVeiculosGrid(veiculos) {
    const grid = document.getElementById('veiculosGrid');
    if (!veiculos.length) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1 / -1; padding: 3rem; text-align:center;">
                <div style="font-size:3rem; margin-bottom:0.75rem;">🚗</div>
                <div style="font-size:1.1rem; font-weight:700; color:#fff;">Nenhum veículo encontrado</div>
                <p style="color:var(--text-secondary); margin: 0.5rem 0 1.5rem;">Cadastre novos carros com fotos para o Iago consultar e enviar aos clientes.</p>
                <button class="btn btn-primary" onclick="openModalVeiculo()">+ Cadastrar Primeiro Carro</button>
            </div>
        `;
        return;
    }

    grid.innerHTML = veiculos.map(v => {
        const capaSrc = v.foto_capa ? `data:image/jpeg;base64,${v.foto_capa}` : '';
        return `
            <div class="veiculo-card ${v.destaque ? 'is-destaque' : ''}">
                <div class="veiculo-thumb-wrap">
                    ${capaSrc ? `
                        <img src="${capaSrc}" alt="${v.modelo}" class="veiculo-thumb" loading="lazy">
                    ` : `
                        <div class="veiculo-thumb-empty">
                            <span>🚗</span>
                            <span>Sem foto de capa</span>
                        </div>
                    `}
                    <span class="badge-photo-count">📸 ${v.total_fotos || 0} fotos</span>
                    ${v.destaque ? `<span class="badge-card-destaque">📢 ANÚNCIO (DESTAQUE)</span>` : `<span class="badge-card-estoque">🚗 ESTOQUE LOJA</span>`}
                </div>
                <div class="veiculo-info">
                    <div class="veiculo-header">
                        <div>
                            <div class="veiculo-title">${v.modelo}</div>
                            <div class="veiculo-marca-ano">${v.marca || 'AutoStilo'} • ${v.ano || '—'}</div>
                        </div>
                        <div class="veiculo-preco">${formatMoeda(v.preco)}</div>
                    </div>

                    <div class="veiculo-tags">
                        ${v.cambio ? `<span class="v-tag">🕹️ ${v.cambio}</span>` : ''}
                        ${v.km ? `<span class="v-tag">🛣️ ${Number(v.km).toLocaleString('pt-BR')} km</span>` : ''}
                        ${v.combustivel ? `<span class="v-tag">⛽ ${v.combustivel}</span>` : ''}
                        ${v.cor ? `<span class="v-tag">🎨 ${v.cor}</span>` : ''}
                    </div>

                    ${v.diferenciais ? `
                        <div class="veiculo-diferenciais-preview" title="${v.diferenciais}">
                            ✨ ${v.diferenciais}
                        </div>
                    ` : ''}

                    <div class="veiculo-actions">
                        <button class="btn btn-secondary btn-sm" onclick="openGalleryModal(${v.id}, '${encodeURIComponent(v.modelo)}', '${encodeURIComponent(v.ano || '')}')">
                            📸 Fotos (${v.total_fotos || 0})
                        </button>
                        <button class="btn btn-ghost btn-sm" onclick="openModalVeiculo(${v.id})" title="Editar veículo">
                            ✏️
                        </button>
                        <button class="btn btn-ghost btn-sm" style="color:#f87171" onclick="excluirVeiculo(${v.id}, '${encodeURIComponent(v.modelo)}')" title="Excluir veículo">
                            🗑️
                        </button>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Search & Filters Veículos
let searchVeiculosTimeout;
document.getElementById('searchVeiculos').addEventListener('input', e => {
    clearTimeout(searchVeiculosTimeout);
    searchVeiculosTimeout = setTimeout(() => {
        veiculosState.busca = e.target.value;
        loadVeiculos();
    }, 350);
});

document.querySelectorAll('[data-filter-veiculo]').forEach(chip => {
    chip.addEventListener('click', () => {
        const filter = chip.dataset.filterVeiculo;
        document.querySelectorAll('[data-filter-veiculo]').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        if (filter === 'destaque') {
            veiculosState.destaque = chip.dataset.value;
            veiculosState.ativo = '';
        } else if (filter === 'ativo') {
            veiculosState.ativo = chip.dataset.value;
            veiculosState.destaque = '';
        } else {
            veiculosState.destaque = '';
            veiculosState.ativo = '';
        }
        loadVeiculos();
    });
});

// ─── Modal Novo / Editar Veículo ───────────────────────────────
document.getElementById('btnNovoVeiculo').addEventListener('click', () => openModalVeiculo());

window.openModalVeiculo = async (id = null) => {
    const modal = document.getElementById('modalVeiculo');
    const form = document.getElementById('formVeiculo');
    form.reset();
    pendingPhotos = [];
    renderPhotosPreview();

    if (id) {
        document.getElementById('modalVeiculoTitle').textContent = '✏️ Editar Veículo';
        try {
            const data = await api(`/veiculos/${id}`);
            const v = data.veiculo;
            document.getElementById('veiculoId').value = v.id;
            document.getElementById('veiculoModelo').value = v.modelo || '';
            document.getElementById('veiculoMarca').value = v.marca || '';
            document.getElementById('veiculoAno').value = v.ano || '';
            document.getElementById('veiculoPreco').value = v.preco || '';
            document.getElementById('veiculoCor').value = v.cor || '';
            document.getElementById('veiculoCambio').value = v.cambio || 'Manual';
            document.getElementById('veiculoKm').value = v.km || '';
            document.getElementById('veiculoCombustivel').value = v.combustivel || 'Flex';
            document.getElementById('veiculoOpcionais').value = v.opcionais || '';
            document.getElementById('veiculoDiferenciais').value = v.diferenciais || '';
            document.getElementById('veiculoDescricao').value = v.descricao || '';
            document.getElementById('veiculoDestaque').checked = Boolean(v.destaque);
            document.getElementById('veiculoAtivo').checked = Boolean(v.ativo);

            const fotos = data.fotos || [];
            const existingGroup = document.getElementById('existingPhotosGroup');
            const existingGrid = document.getElementById('modalVeiculoExistingPhotos');
            const existingCount = document.getElementById('existingPhotosCount');

            if (fotos.length > 0) {
                existingGroup.style.display = 'block';
                existingCount.textContent = fotos.length;
                existingGrid.innerHTML = fotos.map((f, idx) => {
                    const isCapa = idx === 0;
                    return `
                        <div class="gallery-photo-card ${isCapa ? 'is-capa' : ''}">
                            ${isCapa ? `<span class="badge-capa-destaque">⭐ Capa Principal</span>` : ''}
                            <img src="data:${f.mimetype || 'image/jpeg'};base64,${f.base64}" class="gallery-photo-img" alt="Foto ${idx+1}">
                            <button type="button" class="gallery-photo-delete" onclick="excluirFoto(${f.id}, ${v.id})" title="Excluir esta foto">
                                🗑️ Excluir
                            </button>
                            ${!isCapa ? `
                                <div class="gallery-photo-bottom">
                                    <button type="button" class="btn-definir-capa" onclick="definirCapaFotoModal(${f.id}, ${v.id})">
                                        ⭐ Definir como Capa Principal
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    `;
                }).join('');
            } else {
                existingGroup.style.display = 'none';
            }
        } catch (e) {
            toast('Erro ao carregar dados do carro: ' + e.message, 'error');
            return;
        }
    } else {
        document.getElementById('modalVeiculoTitle').textContent = '🚗 Cadastrar Novo Veículo';
        document.getElementById('veiculoId').value = '';
        document.getElementById('veiculoAtivo').checked = true;
        document.getElementById('existingPhotosGroup').style.display = 'none';
    }

    modal.classList.remove('hidden');
};

window.definirCapaFotoModal = async (fotoId, veiculoId) => {
    try {
        await api(`/veiculos/${veiculoId}/capa/${fotoId}`, { method: 'POST' });
        toast('⭐ Foto definida como capa principal!');
        openModalVeiculo(veiculoId);
        loadVeiculos();
    } catch (e) {
        toast('Erro ao definir capa: ' + e.message, 'error');
    }
};

document.getElementById('modalVeiculoClose').addEventListener('click', () => {
    document.getElementById('modalVeiculo').classList.add('hidden');
});
document.getElementById('btnCancelarVeiculo').addEventListener('click', () => {
    document.getElementById('modalVeiculo').classList.add('hidden');
});

// Photo upload handlers (Drag & Drop + File selector)
const photoDropzone = document.getElementById('photoDropzone');
const photoInput = document.getElementById('photoInput');

photoDropzone.addEventListener('dragover', e => {
    e.preventDefault();
    photoDropzone.classList.add('dragover');
});
photoDropzone.addEventListener('dragleave', () => photoDropzone.classList.remove('dragover'));
photoDropzone.addEventListener('drop', e => {
    e.preventDefault();
    photoDropzone.classList.remove('dragover');
    if (e.dataTransfer.files) handlePhotoFiles(e.dataTransfer.files);
});
photoInput.addEventListener('change', e => {
    if (e.target.files) handlePhotoFiles(e.target.files);
});

function handlePhotoFiles(files) {
    Array.from(files).forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            pendingPhotos.push({
                nome: file.name,
                mimetype: file.type,
                base64: reader.result,
            });
            renderPhotosPreview();
        };
        reader.readAsDataURL(file);
    });
}

function renderPhotosPreview() {
    const grid = document.getElementById('photosPreviewGrid');
    grid.innerHTML = pendingPhotos.map((p, idx) => `
        <div class="preview-thumb-card">
            <img src="${p.base64}" class="preview-thumb-img" alt="Foto ${idx+1}">
            <button type="button" class="preview-thumb-delete" onclick="removePendingPhoto(${idx})" title="Remover">✕</button>
        </div>
    `).join('');
}

window.removePendingPhoto = (idx) => {
    pendingPhotos.splice(idx, 1);
    renderPhotosPreview();
};

// Submeter Formulário de Veículo
document.getElementById('formVeiculo').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = document.getElementById('btnSalvarVeiculo');
    const originalText = btn.textContent;
    btn.textContent = 'Salvando...';
    btn.disabled = true;

    const id = document.getElementById('veiculoId').value;
    const payload = {
        modelo: document.getElementById('veiculoModelo').value.trim(),
        marca: document.getElementById('veiculoMarca').value.trim(),
        ano: document.getElementById('veiculoAno').value.trim(),
        preco: parseFloat(document.getElementById('veiculoPreco').value) || 0,
        cor: document.getElementById('veiculoCor').value.trim(),
        cambio: document.getElementById('veiculoCambio').value,
        km: parseInt(document.getElementById('veiculoKm').value) || 0,
        combustivel: document.getElementById('veiculoCombustivel').value.trim(),
        opcionais: document.getElementById('veiculoOpcionais').value.trim(),
        diferenciais: document.getElementById('veiculoDiferenciais').value.trim(),
        descricao: document.getElementById('veiculoDescricao').value.trim(),
        destaque: document.getElementById('veiculoDestaque').checked,
        ativo: document.getElementById('veiculoAtivo').checked,
    };

    try {
        if (id) {
            payload.novas_fotos = pendingPhotos;
            await api(`/veiculos/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
            toast('Veículo atualizado com sucesso!');
        } else {
            payload.fotos = pendingPhotos;
            await api('/veiculos', { method: 'POST', body: JSON.stringify(payload) });
            toast('Novo veículo cadastrado com sucesso!');
        }
        document.getElementById('modalVeiculo').classList.add('hidden');
        loadVeiculos();
    } catch (err) {
        toast('Erro ao salvar veículo: ' + err.message, 'error');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

// Excluir Veículo
window.excluirVeiculo = async (id, modeloEncoded) => {
    const modelo = decodeURIComponent(modeloEncoded);
    if (!confirm(`Tem certeza que deseja excluir o ${modelo}? Todas as fotos serão removidas.`)) return;
    try {
        await api(`/veiculos/${id}`, { method: 'DELETE' });
        toast(`Veículo ${modelo} excluído.`);
        loadVeiculos();
    } catch (e) {
        toast('Erro ao excluir: ' + e.message, 'error');
    }
};

// ─── Modal Galeria de Fotos ────────────────────────────────────
window.openGalleryModal = async (veiculoId, modeloEncoded, anoEncoded) => {
    activeGalleryVehicleId = veiculoId;
    const modelo = decodeURIComponent(modeloEncoded);
    const ano = decodeURIComponent(anoEncoded);

    document.getElementById('galleryCarTitle').textContent = `Fotos do ${modelo} ${ano}`;
    document.getElementById('galleryCarSub').textContent = `Gerencie as fotos que a IA envia aos clientes`;
    document.getElementById('carGalleryGrid').innerHTML = '<div class="loading-placeholder"><div class="spinner"></div> Carregando fotos...</div>';
    document.getElementById('modalFotosVeiculo').classList.remove('hidden');

    loadGalleryPhotos(veiculoId);
};

async function loadGalleryPhotos(veiculoId) {
    try {
        const data = await api(`/veiculos/${veiculoId}`);
        const fotos = data.fotos || [];
        document.getElementById('galleryCountBadge').textContent = `${fotos.length} fotos cadastradas`;

        const grid = document.getElementById('carGalleryGrid');
        if (!fotos.length) {
            grid.innerHTML = `
                <div class="empty-state" style="grid-column: 1 / -1; padding: 2.5rem; text-align:center;">
                    <span style="font-size:2.5rem; display:block; margin-bottom:0.5rem;">📷</span>
                    <p style="color:var(--text-secondary);">Nenhuma foto cadastrada para este carro ainda.</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = fotos.map((f, idx) => {
            const isCapa = idx === 0;
            return `
                <div class="gallery-photo-card ${isCapa ? 'is-capa' : ''}">
                    ${isCapa ? `<span class="badge-capa-destaque">⭐ Foto Principal (Capa)</span>` : ''}
                    <img src="data:${f.mimetype || 'image/jpeg'};base64,${f.base64}" class="gallery-photo-img" alt="Foto ${idx+1}">
                    <button class="gallery-photo-delete" onclick="excluirFoto(${f.id}, ${veiculoId})" title="Excluir esta foto">
                        🗑️ Excluir
                    </button>
                    ${!isCapa ? `
                        <div class="gallery-photo-bottom">
                            <button class="btn-definir-capa" onclick="definirCapaFoto(${f.id}, ${veiculoId})">
                                ⭐ Definir como Capa Principal
                            </button>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');
    } catch (e) {
        toast('Erro ao carregar fotos: ' + e.message, 'error');
    }
}

window.definirCapaFoto = async (fotoId, veiculoId) => {
    try {
        await api(`/veiculos/${veiculoId}/capa/${fotoId}`, { method: 'POST' });
        toast('⭐ Foto definida como capa principal! O Iago enviará esta foto primeiro com a ficha técnica do carro.');
        loadGalleryPhotos(veiculoId);
        loadVeiculos();
    } catch (e) {
        toast('Erro ao definir foto de capa: ' + e.message, 'error');
    }
};

// Upload adicional de fotos direto na Galeria
document.getElementById('galleryUploadInput').addEventListener('change', async e => {
    if (!e.target.files || !e.target.files.length || !activeGalleryVehicleId) return;
    const files = Array.from(e.target.files);
    const fotosToAdd = [];

    for (const file of files) {
        if (!file.type.startsWith('image/')) continue;
        const b64 = await new Promise(res => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.readAsDataURL(file);
        });
        fotosToAdd.push({
            nome: file.name,
            mimetype: file.type,
            base64: b64,
        });
    }

    try {
        toast(`Enviando ${fotosToAdd.length} foto(s)...`);
        await api(`/veiculos/${activeGalleryVehicleId}`, {
            method: 'PUT',
            body: JSON.stringify({ novas_fotos: fotosToAdd }),
        });
        toast('Fotos adicionadas com sucesso!');
        loadGalleryPhotos(activeGalleryVehicleId);
        loadVeiculos();
    } catch (err) {
        toast('Erro ao enviar fotos: ' + err.message, 'error');
    } finally {
        e.target.value = '';
    }
});

window.excluirFoto = async (fotoId, veiculoId) => {
    if (!confirm('Deseja excluir esta foto?')) return;
    try {
        await api(`/veiculos/fotos/${fotoId}`, { method: 'DELETE' });
        toast('Foto excluída.');
        loadGalleryPhotos(veiculoId);
        loadVeiculos();
    } catch (e) {
        toast('Erro ao excluir foto: ' + e.message, 'error');
    }
};

document.getElementById('modalFotosClose').addEventListener('click', () => {
    document.getElementById('modalFotosVeiculo').classList.add('hidden');
});

// ─── Equipe ────────────────────────────────────────────────────
async function loadUsuarios() {
    try {
        usuarios = await api('/usuarios');
        renderEquipe();
    } catch {}
}

function renderEquipe() {
    const grid = document.getElementById('equipeGrid');
    if (!usuarios.length) { grid.innerHTML = '<div class="loading-placeholder">Nenhum membro cadastrado</div>'; return; }
    grid.innerHTML = usuarios.map(u => `
        <div class="team-card">
            <div class="team-avatar">${initials(u.nome)}</div>
            <div class="team-name">${u.nome}</div>
            <div class="team-email">${u.email}</div>
            <span class="team-badge ${u.role === 'admin' ? 'admin' : ''}">${u.role}</span>
        </div>
    `).join('');
}

// Novo usuário modal
document.getElementById('btnNovoUsuario').addEventListener('click', () => {
    document.getElementById('modalUsuario').classList.remove('hidden');
});
document.getElementById('modalUsuarioClose').addEventListener('click', () => {
    document.getElementById('modalUsuario').classList.add('hidden');
});
document.getElementById('btnCancelarUsuario').addEventListener('click', () => {
    document.getElementById('modalUsuario').classList.add('hidden');
});
document.getElementById('formUsuario').addEventListener('submit', async e => {
    e.preventDefault();
    try {
        await api('/usuarios', {
            method: 'POST',
            body: JSON.stringify({
                nome: document.getElementById('usuarioNome').value,
                email: document.getElementById('usuarioEmail').value,
                senha: document.getElementById('usuarioSenha').value,
                role: document.getElementById('usuarioRole').value,
            }),
        });
        document.getElementById('modalUsuario').classList.add('hidden');
        document.getElementById('formUsuario').reset();
        toast('Membro criado com sucesso!');
        loadUsuarios();
    } catch (e) { toast(e.message, 'error'); }
});

// ─── EDITOR DA IA (PROMPTS & REFINAMENTO) ──────────────────────
let originalPromptBackup = '';

async function loadIaPrompt() {
    try {
        const data = await api('/ia/prompt');
        const textarea = document.getElementById('promptTextarea');
        textarea.value = data.prompt || '';
        originalPromptBackup = data.prompt || '';

        updatePromptStats(data.prompt || '');
        if (data.metadata) {
            document.getElementById('promptVersionBadge').textContent = `Versão ${data.metadata.versao || 1}`;
            const chatVer = document.getElementById('chatTreinadorVersao');
            if (chatVer) chatVer.textContent = `Versão ${data.metadata.versao || 1}`;
        }
        carregarHistoricoPrompts();
        loadChatTreinador();
    } catch (e) {
        toast('Erro ao carregar prompt da IA: ' + e.message, 'error');
    }
}

function updatePromptStats(text) {
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const charEl = document.getElementById('promptCharCount');
    if (charEl) {
        charEl.textContent = `${chars.toLocaleString('pt-BR')} caracteres (${words.toLocaleString('pt-BR')} palavras)`;
    }
}

document.getElementById('promptTextarea')?.addEventListener('input', e => {
    updatePromptStats(e.target.value);
});

async function salvarPrompt(notas = 'Atualização manual') {
    const btn = document.getElementById('btnSalvarPrompt');
    const promptText = document.getElementById('promptTextarea').value;
    if (!promptText.trim()) {
        toast('O prompt não pode ficar vazio!', 'error');
        return;
    }

    try {
        btn.disabled = true;
        btn.textContent = 'Salvando...';
        const res = await api('/ia/salvar', {
            method: 'POST',
            body: { prompt_text: promptText, notas }
        });
        toast('🚀 Prompt salvo e publicado no Iago com sucesso!', 'success');
        document.getElementById('promptVersionBadge').textContent = `Versão ${res.metadata.versao}`;
        originalPromptBackup = promptText;
        carregarHistoricoPrompts();
    } catch (e) {
        toast('Erro ao salvar prompt: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '💾 Salvar & Publicar no WhatsApp';
    }
}

document.getElementById('btnSalvarPrompt')?.addEventListener('click', () => salvarPrompt());

// Refinar com IA
async function refinarPromptComIa() {
    const sugestao = document.getElementById('sugestaoIaInput').value.trim();
    if (!sugestao) {
        toast('Digite uma sugestão para a IA refinar!', 'error');
        return;
    }

    const btnText = document.getElementById('btnRefinarText');
    const spinner = document.getElementById('btnRefinarSpinner');
    const btn = document.getElementById('btnRefinarPrompt');
    const resultBox = document.getElementById('iaRefinarResult');
    const resumoEl = document.getElementById('iaRefinarResumo');

    try {
        btn.disabled = true;
        btnText.textContent = 'Processando com IA...';
        spinner.classList.remove('hidden');

        const promptAtual = document.getElementById('promptTextarea').value;
        const res = await api('/ia/refinar', {
            method: 'POST',
            body: { sugestao, prompt_atual: promptAtual }
        });

        // Aplica o novo prompt no editor
        document.getElementById('promptTextarea').value = res.prompt_refinado;
        updatePromptStats(res.prompt_refinado);

        // Mostra resumo das mudanças
        resumoEl.textContent = res.resumo_alteracoes;
        resultBox.classList.remove('hidden');
        toast('✨ Prompt refinado com sucesso! Revise e clique em Aprovar.');
    } catch (e) {
        toast('Erro ao refinar prompt: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        btnText.textContent = '✨ Refinar Prompt com IA';
        spinner.classList.add('hidden');
    }
}

document.getElementById('btnRefinarPrompt')?.addEventListener('click', refinarPromptComIa);

document.getElementById('btnDesfazerRefinamento')?.addEventListener('click', () => {
    document.getElementById('promptTextarea').value = originalPromptBackup;
    updatePromptStats(originalPromptBackup);
    document.getElementById('iaRefinarResult').classList.add('hidden');
    toast('Alterações desfeitas.');
});

document.getElementById('btnAplicarESalvar')?.addEventListener('click', async () => {
    const sugestao = document.getElementById('sugestaoIaInput').value.trim();
    await salvarPrompt(`Refinamento IA: ${sugestao.slice(0, 50)}...`);
    document.getElementById('iaRefinarResult').classList.add('hidden');
    document.getElementById('sugestaoIaInput').value = '';
});

// ─── TABS MODO CHAT / VISUAL / AVANÇADO ───────────────────────
const tabModoChat = document.getElementById('tabModoChat');
const tabModoVisual = document.getElementById('tabModoVisual');
const tabModoAvancado = document.getElementById('tabModoAvancado');
const viewModoChat = document.getElementById('viewModoChat');
const viewModoVisual = document.getElementById('viewModoVisual');
const viewModoAvancado = document.getElementById('viewModoAvancado');

function switchIaTab(tab) {
    [tabModoChat, tabModoVisual, tabModoAvancado].forEach(t => t?.classList.remove('active'));
    [viewModoChat, viewModoVisual, viewModoAvancado].forEach(v => v?.classList.add('hidden'));

    if (tab === 'chat') {
        tabModoChat?.classList.add('active');
        viewModoChat?.classList.remove('hidden');
        loadChatTreinador();
    } else if (tab === 'visual') {
        tabModoVisual?.classList.add('active');
        viewModoVisual?.classList.remove('hidden');
    } else if (tab === 'avancado') {
        tabModoAvancado?.classList.add('active');
        viewModoAvancado?.classList.remove('hidden');
    }
}

tabModoChat?.addEventListener('click', () => switchIaTab('chat'));
tabModoVisual?.addEventListener('click', () => switchIaTab('visual'));
tabModoAvancado?.addEventListener('click', () => switchIaTab('avancado'));

// ─── CHAT CONVERSACIONAL COM O IAGO (TREINADOR) ───────────────
async function loadChatTreinador() {
    const container = document.getElementById('chatTreinadorMessages');
    if (!container) return;

    try {
        const msgs = await api('/ia/chat-treinador');
        renderChatTreinadorMessages(msgs);
    } catch (e) {
        container.innerHTML = `<div class="empty-state">Erro ao carregar chat: ${escapeHtml(e.message)}</div>`;
    }
}

function renderChatTreinadorMessages(msgs) {
    const container = document.getElementById('chatTreinadorMessages');
    if (!container) return;

    if (!msgs || msgs.length === 0) {
        container.innerHTML = `<div class="empty-state">Nenhuma mensagem ainda. Diga um 'Oi' para o Iago!</div>`;
        return;
    }

    container.innerHTML = msgs.map(m => {
        const isUser = m.role === 'user';
        const hora = m.criado_em ? new Date(m.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
        
        // Formata markdown simples (negrito, itálico, quebras)
        let formattedText = escapeHtml(m.content)
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*?)\*/g, '<em>$1</em>')
            .replace(/\n/g, '<br>');

        let adjustmentBadge = '';
        if (m.resumo_ajuste && m.versao_gerada) {
            adjustmentBadge = `
                <div class="ia-rule-adjusted-badge">
                    <span class="ia-rule-adjusted-icon">🚀</span>
                    <div>
                        <strong>Regra Atualizada & Publicada no WhatsApp (v${m.versao_gerada})!</strong><br>
                        <span style="opacity: 0.9;">${escapeHtml(m.resumo_ajuste)}</span>
                    </div>
                </div>
            `;
        }

        return `
            <div class="ia-chat-msg ${isUser ? 'user' : 'assistant'}">
                <div class="ia-chat-bubble">
                    ${formattedText}
                    ${adjustmentBadge}
                </div>
                <span class="ia-chat-time">${hora}</span>
            </div>
        `;
    }).join('');

    container.scrollTop = container.scrollHeight;
}

async function enviarOrdemTreinador(mensagemTexto = null) {
    const input = document.getElementById('inputOrdemTreinador');
    const msg = (mensagemTexto || input.value).trim();
    if (!msg) return;

    const btn = document.getElementById('btnEnviarOrdemTreinador');
    const container = document.getElementById('chatTreinadorMessages');

    // Limpa input
    if (!mensagemTexto) input.value = '';

    // Adiciona balão do usuário na hora
    const userMsgEl = document.createElement('div');
    userMsgEl.className = 'ia-chat-msg user';
    userMsgEl.innerHTML = `
        <div class="ia-chat-bubble">${escapeHtml(msg).replace(/\n/g, '<br>')}</div>
        <span class="ia-chat-time">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
    `;
    container.appendChild(userMsgEl);

    // Balão de digitando do Iago
    const typingEl = document.createElement('div');
    typingEl.className = 'ia-chat-msg assistant';
    typingEl.id = 'iagoTypingMsg';
    typingEl.innerHTML = `
        <div class="ia-chat-bubble" style="display: flex; align-items: center; gap: 8px;">
            <span>Iago está pensando e ajustando as regras</span>
            <span class="spinner-small"></span>
        </div>
    `;
    container.appendChild(typingEl);
    container.scrollTop = container.scrollHeight;

    try {
        btn.disabled = true;
        const res = await api('/ia/chat-treinador', {
            method: 'POST',
            body: { mensagem: msg }
        });

        typingEl.remove();

        if (res.mensagem) {
            let formattedText = escapeHtml(res.mensagem.content)
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\*(.*?)\*/g, '<em>$1</em>')
                .replace(/\n/g, '<br>');

            let adjustmentBadge = '';
            if (res.mensagem.resumo_ajuste && res.mensagem.versao_gerada) {
                adjustmentBadge = `
                    <div class="ia-rule-adjusted-badge">
                        <span class="ia-rule-adjusted-icon">🚀</span>
                        <div>
                            <strong>Regra Atualizada & Publicada no WhatsApp (v${res.mensagem.versao_gerada})!</strong><br>
                            <span style="opacity: 0.9;">${escapeHtml(res.mensagem.resumo_ajuste)}</span>
                        </div>
                    </div>
                `;
            }

            const botMsgEl = document.createElement('div');
            botMsgEl.className = 'ia-chat-msg assistant';
            botMsgEl.innerHTML = `
                <div class="ia-chat-bubble">
                    ${formattedText}
                    ${adjustmentBadge}
                </div>
                <span class="ia-chat-time">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</span>
            `;
            container.appendChild(botMsgEl);
            container.scrollTop = container.scrollHeight;

            if (res.alterou_prompt) {
                document.getElementById('promptVersionBadge').textContent = `Versão ${res.nova_versao}`;
                document.getElementById('chatTreinadorVersao').textContent = `Versão ${res.nova_versao}`;
                document.getElementById('promptTextarea').value = res.prompt_atual;
                updatePromptStats(res.prompt_atual);
                toast(`🚀 Iago atualizado para a Versão ${res.nova_versao} no WhatsApp!`, 'success');
            }
        }
    } catch (e) {
        typingEl.remove();
        toast('Erro ao conversar com Iago: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        input.focus();
    }
}

document.getElementById('btnEnviarOrdemTreinador')?.addEventListener('click', () => enviarOrdemTreinador());

document.getElementById('inputOrdemTreinador')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        enviarOrdemTreinador();
    }
});

// Chips de ordens rápidas
document.querySelectorAll('.btn-ordem-chip').forEach(btn => {
    btn.addEventListener('click', () => {
        enviarOrdemTreinador(btn.dataset.ordem);
    });
});

// Limpar chat
document.getElementById('btnLimparChatTreinador')?.addEventListener('click', async () => {
    if (!confirm('Deseja limpar o histórico desta conversa com o Iago? (As regras salvas no robô continuam ativas)')) return;
    try {
        await api('/ia/chat-treinador/limpar', { method: 'POST' });
        loadChatTreinador();
        toast('Conversa limpa.');
    } catch (e) {
        toast(e.message, 'error');
    }
});

// Tags de sugestão rápida no Modo Visual
document.querySelectorAll('.btn-quick-tag').forEach(btn => {
    btn.addEventListener('click', () => {
        const input = document.getElementById('promoTextoInput');
        input.value = btn.dataset.tag;
        document.getElementById('promoAtivaCheck').checked = true;
        input.focus();
        toast('Sugestão aplicada no campo de promoção!');
    });
});

// Seletor de Tom de Voz
document.querySelectorAll('.tone-card').forEach(card => {
    card.addEventListener('click', () => {
        document.querySelectorAll('.tone-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        toast(`Tom de voz alterado para: ${card.querySelector('.tone-title').textContent}`);
    });
});

// Assistente Mágico no Modo Visual
document.getElementById('btnAplicarSugestaoVisual')?.addEventListener('click', async () => {
    const sugestao = document.getElementById('sugestaoVisualInput').value.trim();
    if (!sugestao) {
        toast('Digite um ajuste para o Iago!', 'error');
        return;
    }

    const btn = document.getElementById('btnAplicarSugestaoVisual');
    const textEl = document.getElementById('btnVisualRefinarText');
    const spinner = document.getElementById('btnVisualRefinarSpinner');
    const resultBox = document.getElementById('iaVisualResult');
    const resumoEl = document.getElementById('iaVisualResumo');

    try {
        btn.disabled = true;
        textEl.textContent = 'Aplicando com IA...';
        spinner.classList.remove('hidden');

        const promptAtual = document.getElementById('promptTextarea').value;
        const res = await api('/ia/refinar', {
            method: 'POST',
            body: { sugestao, prompt_atual: promptAtual }
        });

        document.getElementById('promptTextarea').value = res.prompt_refinado;
        updatePromptStats(res.prompt_refinado);

        resumoEl.textContent = res.resumo_alteracoes;
        resultBox.classList.remove('hidden');

        // Salva automaticamente
        await salvarPrompt(`Ajuste Mágico Visual: ${sugestao.slice(0, 50)}...`);
        document.getElementById('sugestaoVisualInput').value = '';
        toast('🎉 Iago atualizado e pronto no WhatsApp com a nova regra!');
    } catch (e) {
        toast('Erro ao aplicar ajuste: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        textEl.textContent = '✨ Aplicar Ajuste com IA';
        spinner.classList.add('hidden');
    }
});

// Salvar Geral (funciona em ambos os modos)
async function salvarConfiguracoesGerais() {
    const isVisual = !viewModoVisual.classList.contains('hidden');
    if (isVisual) {
        // Se estiver no modo visual, compõe as instruções
        const promoAtiva = document.getElementById('promoAtivaCheck').checked;
        const promoTexto = document.getElementById('promoTextoInput').value.trim();
        const activeTone = document.querySelector('.tone-card.active')?.dataset.tone || 'consultivo';
        const trocaMoto = document.getElementById('trocaMotoCheck').checked;
        const trocaCarro = document.getElementById('trocaCarroCheck').checked;
        const negativados = document.getElementById('negativadoCheck').checked;
        const semEntrada = document.getElementById('semEntradaCheck').checked;

        let instrucoesVisuais = [];
        if (promoAtiva && promoTexto) {
            instrucoesVisuais.push(`Campanha ativa da semana: "${promoTexto}" (mencione naturalmente aos clientes interessados)`);
        }
        if (activeTone === 'fechador') {
            instrucoesVisuais.push(`Tom de voz: Mais direto, focado em agilidade e fechamento de simulação.`);
        } else if (activeTone === 'calmo') {
            instrucoesVisuais.push(`Tom de voz: Mais calmo, transparente e detalhista nas explicações.`);
        }
        instrucoesVisuais.push(`Trocas aceitas: ${trocaCarro ? 'Carros' : ''} ${trocaMoto ? 'e Motos' : ''}`);
        instrucoesVisuais.push(`Negativados: ${negativados ? 'Atender com otimismo e rodar simulação' : 'Informar restrições com delicadeza'}`);
        instrucoesVisuais.push(`Sem Entrada: ${semEntrada ? 'Destacar que há opções 100% financiadas' : 'Pedir entrada padrão'}`);

        const sugestaoComposta = instrucoesVisuais.join('. ');
        
        try {
            const btn = document.getElementById('btnSalvarPrompt');
            btn.disabled = true;
            btn.textContent = 'Sincronizando Iago...';

            const promptAtual = document.getElementById('promptTextarea').value;
            const res = await api('/ia/refinar', {
                method: 'POST',
                body: { sugestao: sugestaoComposta, prompt_atual: promptAtual }
            });

            document.getElementById('promptTextarea').value = res.prompt_refinado;
            updatePromptStats(res.prompt_refinado);
            await salvarPrompt('Atualização pelo Modo Visual Prático');
            toast('✅ Todas as configurações do Iago foram ativadas no WhatsApp com sucesso!');
        } catch (e) {
            toast('Erro ao sincronizar: ' + e.message, 'error');
        }
    } else {
        await salvarPrompt();
    }
}

document.getElementById('btnSalvarPrompt')?.addEventListener('click', salvarConfiguracoesGerais);

// Chips de sugestões rápidas
document.querySelectorAll('.btn-sugestao-chip').forEach(chip => {
    chip.addEventListener('click', () => {
        const input = document.getElementById('sugestaoIaInput');
        input.value = chip.dataset.sugestao;
        input.focus();
    });
});

async function carregarHistoricoPrompts() {
    try {
        const historico = await api('/ia/historico');
        const sel = document.getElementById('selectHistoricoPrompt');
        if (!sel) return;
        sel.innerHTML = '<option value="">⏮️ Histórico de Versões...</option>' +
            historico.map(h => `<option value="${h.id}">v${h.versao} • ${new Date(h.criado_em).toLocaleDateString('pt-BR')} ${new Date(h.criado_em).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} (${h.criado_por || 'Admin'})</option>`).join('');
    } catch {}
}

document.getElementById('selectHistoricoPrompt')?.addEventListener('change', async e => {
    const id = e.target.value;
    if (!id) return;
    if (!confirm('Deseja restaurar esta versão do prompt?')) return;
    try {
        const res = await api(`/ia/restaurar/${id}`, { method: 'POST' });
        document.getElementById('promptTextarea').value = res.prompt;
        updatePromptStats(res.prompt);
        document.getElementById('promptVersionBadge').textContent = `Versão ${res.metadata.versao}`;
        originalPromptBackup = res.prompt;
        toast(`Versão ${res.metadata.versao} restaurada!`);
    } catch (err) {
        toast('Erro ao restaurar versão: ' + err.message, 'error');
    }
});

document.getElementById('btnRestaurarPadrao')?.addEventListener('click', async () => {
    if (!confirm('Deseja restaurar para o System Prompt Original de Fábrica?')) return;
    try {
        const data = await api('/ia/prompt');
        document.getElementById('promptTextarea').value = data.prompt;
        updatePromptStats(data.prompt);
        toast('Prompt padrão restaurado no editor. Clique em Salvar para publicar.');
    } catch (err) {
        toast('Erro ao carregar padrão: ' + err.message, 'error');
    }
});

// ═══════════════════════════════════════════════════════════════
// ─── REVENDA MAIS & REMARKETING AUTOMÁTICO (3h, 6h, 12h) ──────
// ═══════════════════════════════════════════════════════════════

// Sincronizar com RevendaMais
document.getElementById('btnSyncRevendaMais')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnSyncRevendaMais');
    const txt = document.getElementById('btnSyncText');
    const spin = document.getElementById('btnSyncSpinner');

    txt.textContent = 'Sincronizando...';
    spin?.classList.remove('hidden');
    btn.disabled = true;

    try {
        const res = await api('/veiculos/sync-revendamais', { method: 'POST' });
        toast(`🎉 Sincronização concluída! ${res.resultado?.novas_fotos || 0} novas fotos baixadas.`);
        await loadVeiculos();
    } catch (e) {
        toast('Erro ao sincronizar com RevendaMais: ' + e.message, 'error');
    } finally {
        txt.textContent = '🔄 Sincronizar RevendaMais';
        spin?.classList.add('hidden');
        btn.disabled = false;
    }
});

// Carregar tela de Remarketing
async function loadRemarketing() {
    const configGrid = document.getElementById('remarketingConfigGrid');
    const tableBody = document.getElementById('remarketingTableBody');

    try {
        // 1. Carregar Configurações das 3 Etapas
        const configRes = await api('/remarketing/config');
        const regras = configRes.regras || [];

        configGrid.innerHTML = regras.map(r => `
            <div class="card" style="display:flex; flex-direction:column; justify-content:space-between; background:#091a11; border:1px solid rgba(16,185,129,0.25);">
                <div class="card-header" style="justify-content:space-between; padding:0.9rem 1.1rem;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <h3 style="font-size:0.92rem; font-weight:800; color:#fff;">${r.titulo}</h3>
                    </div>
                    <label class="toggle-switch" title="${r.ativo ? 'Etapa Ativa' : 'Etapa Pausada'}">
                        <input type="checkbox" id="remarketingToggle_${r.etapa}" ${r.ativo ? 'checked' : ''} onchange="toggleRemarketingEtapa(${r.etapa}, this.checked)">
                        <span class="toggle-slider"></span>
                    </label>
                </div>
                <div class="card-body" style="padding:1rem;">
                    <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:0.5rem;">
                        ⏱️ Disparo após <strong>${r.horas} horas</strong> sem resposta do cliente.
                    </div>
                    <div class="form-group" style="margin-bottom:0.6rem;">
                        <textarea id="remarketingMsg_${r.etapa}" class="form-control form-textarea-sm" style="font-size:0.84rem; line-height:1.45; min-height:85px; background:rgba(3,10,6,0.9);">${escapeHtml(r.mensagem)}</textarea>
                    </div>
                    <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:6px;">
                        <div style="font-size:0.7rem; color:var(--brand-accent);">
                            Tags: <code style="background:rgba(16,185,129,0.15); padding:2px 4px; border-radius:4px;">{nome}</code> <code style="background:rgba(16,185,129,0.15); padding:2px 4px; border-radius:4px;">{carro}</code>
                        </div>
                        <button class="btn btn-secondary btn-sm" onclick="salvarRemarketingMensagem(${r.etapa})">💾 Salvar Mensagem</button>
                    </div>
                </div>
            </div>
        `).join('');

        // 2. Carregar Histórico de Disparos
        const histRes = await api('/remarketing/historico');
        const historico = histRes.historico || [];
        document.getElementById('remarketingTotalCount').textContent = `${historico.length} disparos recentes`;

        if (historico.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="table-loading">Nenhum disparo de remarketing registrado recentemente.</td></tr>`;
            return;
        }

        tableBody.innerHTML = historico.map(h => {
            const dataHora = h.enviado_em ? new Date(h.enviado_em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';
            return `
                <tr>
                    <td>
                        <strong style="color:#fff; cursor:pointer;" onclick="openLead('${encodeURIComponent(h.telefone)}')">${escapeHtml(h.nome_cliente || 'Cliente')}</strong>
                        <div style="font-size:0.74rem; color:var(--text-muted);">${formatTel(h.telefone)}</div>
                    </td>
                    <td>
                        <span class="badge-pill-brand" style="font-size:0.7rem;">Etapa ${h.etapa} (${h.horas}h)</span>
                    </td>
                    <td style="max-width:320px; font-size:0.8rem; color:#e2e8f0; line-height:1.35;">
                        ${escapeHtml(h.mensagem)}
                    </td>
                    <td style="font-size:0.75rem; color:var(--text-secondary);">${dataHora}</td>
                    <td>
                        <span class="status-pill" style="font-size:0.68rem; background:rgba(16,185,129,0.15); color:#34d399; border-color:rgba(16,185,129,0.3);">
                            ✓ Enviado
                        </span>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        toast('Erro ao carregar dados de remarketing: ' + e.message, 'error');
    }
}

// Salvar mensagem de uma etapa
window.salvarRemarketingMensagem = async (etapa) => {
    const textarea = document.getElementById(`remarketingMsg_${etapa}`);
    if (!textarea) return;
    const mensagem = textarea.value.trim();
    if (!mensagem) return toast('A mensagem não pode ficar vazia.', 'warning');

    try {
        await api(`/remarketing/config/${etapa}`, {
            method: 'PATCH',
            body: JSON.stringify({ mensagem })
        });
        toast(`Etapa ${etapa} atualizada com sucesso!`);
    } catch (e) {
        toast('Erro ao salvar etapa: ' + e.message, 'error');
    }
};

// Alternar status ativo/inativo de uma etapa
window.toggleRemarketingEtapa = async (etapa, ativo) => {
    try {
        await api(`/remarketing/config/${etapa}`, {
            method: 'PATCH',
            body: JSON.stringify({ ativo })
        });
        toast(`Etapa ${etapa} ${ativo ? 'ativada' : 'pausada'}!`);
    } catch (e) {
        toast('Erro ao alterar status: ' + e.message, 'error');
    }
};

// Executar remarketing manualmente agora
document.getElementById('btnExecutarRemarketingAgora')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnExecutarRemarketingAgora');
    const txt = document.getElementById('btnExecutarRemarketingText');
    const spin = document.getElementById('btnExecutarRemarketingSpinner');

    txt.textContent = 'Processando Fila...';
    spin?.classList.remove('hidden');
    btn.disabled = true;

    try {
        const res = await api('/remarketing/executar-agora', { method: 'POST' });
        toast(`⚡ Remarketing executado com sucesso! ${res.disparados || 0} mensagens enviadas.`);
        await loadRemarketing();
    } catch (e) {
        toast('Erro ao executar remarketing: ' + e.message, 'error');
    } finally {
        txt.textContent = '⚡ Executar Remarketing Agora';
        spin?.classList.add('hidden');
        btn.disabled = false;
    }
});

document.getElementById('btnAtualizarHistoricoRemarketing')?.addEventListener('click', loadRemarketing);

// ─── Auto refresh ──────────────────────────────────────────────
function startAutoRefresh() {
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        const activePage = document.querySelector('.page.active');
        if (activePage?.id === 'pageDashboard') loadDashboard();
        if (activePage?.id === 'pageLeads') loadLeads();
        if (activePage?.id === 'pageRemarketing') loadRemarketing();
        if (activePage?.id === 'pageAvalista') loadAvalista();
    }, 30000);
}

// ─── AVALISTA / RECUPERAÇÃO DE REPROVADOS ────────────────────────
const AVALISTA_PADRAO_MSG = `Oi {nome}! Tudo bem?\n\nDei uma olhada aqui com a nossa equipe e pelo primeiro nome que você passou o sistema bancário não liberou a aprovação de primeira. 🚗\n\nVocê teria algum outro nome de confiança (como esposo(a), pai, mãe ou parente) para a gente rodar a ficha e liberar o carro para você?`;

async function loadAvalista() {
    const tableBody = document.getElementById('avalistaTableBody');
    const totalCountEl = document.getElementById('avalistaTotalCount');
    const inputMsg = document.getElementById('inputAvalistaMensagem');
    const radioTexto = document.getElementById('radioAvalistaTexto');
    const radioAudio = document.getElementById('radioAvalistaAudio');
    const labelTexto = document.getElementById('labelFormatoTexto');
    const labelAudio = document.getElementById('labelFormatoAudio');

    try {
        const configRes = await api('/avalista/config');
        if (configRes && configRes.config) {
            const cfg = configRes.config;
            if (inputMsg) inputMsg.value = cfg.mensagem || AVALISTA_PADRAO_MSG;
            if (cfg.formato_envio === 'audio') {
                if (radioAudio) radioAudio.checked = true;
                labelAudio?.style.setProperty('background', 'rgba(16, 185, 129, 0.12)');
                labelAudio?.style.setProperty('border-color', 'rgba(16, 185, 129, 0.5)');
                labelTexto?.style.setProperty('background', 'rgba(255, 255, 255, 0.03)');
                labelTexto?.style.setProperty('border-color', 'var(--border)');
            } else {
                if (radioTexto) radioTexto.checked = true;
                labelTexto?.style.setProperty('background', 'rgba(16, 185, 129, 0.12)');
                labelTexto?.style.setProperty('border-color', 'rgba(16, 185, 129, 0.5)');
                labelAudio?.style.setProperty('background', 'rgba(255, 255, 255, 0.03)');
                labelAudio?.style.setProperty('border-color', 'var(--border)');
            }
        }

        const leadsRes = await api('/avalista/leads');
        const leads = (leadsRes && leadsRes.leads) || [];
        
        let pendentes = 0;
        leads.forEach(l => { if (!l.avalista_enviado && l.etiqueta !== 'reprovado_pedir_nome') pendentes++; });
        if (totalCountEl) totalCountEl.textContent = `${leads.length} clientes (${pendentes} pendentes)`;
        const badgeAvalista = document.getElementById('badgeAvalista');
        if (badgeAvalista) badgeAvalista.textContent = pendentes;

        if (leads.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="5" class="table-loading">Nenhum cliente reprovado ou escalado no momento.</td></tr>`;
            return;
        }

        tableBody.innerHTML = leads.map(l => {
            const nome = escapeHtml(l.nome || l.telefone);
            const tel = escapeHtml(l.telefone || '');
            const msg = escapeHtml((l.ultima_mensagem || 'Sem mensagem').slice(0, 75)) + (l.ultima_mensagem?.length > 75 ? '...' : '');
            const horario = l.escalado_em || l.ultima_interacao;
            const dataFmt = horario ? new Date(horario).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
            
            const jaEnviado = l.avalista_enviado || l.etiqueta === 'reprovado_pedir_nome';
            const statusBadge = jaEnviado 
                ? `<span class="badge" style="background:rgba(16,185,129,0.15); color:#34d399; border:1px solid rgba(16,185,129,0.3);">✅ Enviado (${l.tipo_envio || 'texto'})</span>`
                : `<span class="badge" style="background:rgba(239,68,68,0.15); color:#f87171; border:1px solid rgba(239,68,68,0.3);">⏳ Pendente Envio</span>`;

            const btnAcao = jaEnviado
                ? `<button class="btn btn-ghost btn-sm" onclick="reenviarAvalista('${tel}', '${escapeHtml(l.nome || '')}')" title="Reenviar pedido de avalista">🔄 Reenviar</button>`
                : `<button class="btn btn-primary btn-sm" onclick="dispararAvalistaIndividual('${tel}', '${escapeHtml(l.nome || '')}')">⚡ Pedir Novo Nome</button>`;

            return `
                <tr>
                    <td>
                        <div style="font-weight:600; color:#fff;">${nome}</div>
                        <div style="font-size:0.75rem; color:var(--text-secondary);">📱 +${tel}</div>
                    </td>
                    <td>${statusBadge}</td>
                    <td style="font-size:0.8rem; color:var(--text-secondary); max-width:280px;">${msg}</td>
                    <td style="font-size:0.8rem; color:var(--text-secondary);">${dataFmt}</td>
                    <td>
                        <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                            ${btnAcao}
                            <button class="btn btn-sm" onclick="marcarAprovadoDireto('${tel}')" style="background:rgba(16,185,129,0.2); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-weight:600; cursor:pointer;" title="Aprovar Ficha deste cliente">
                                ✅ Aprovado
                            </button>
                            <button class="btn btn-sm" onclick="marcarAVistaDireto('${tel}')" style="background:rgba(234,179,8,0.2); color:#facc15; border:1px solid rgba(234,179,8,0.4); font-weight:600; cursor:pointer;" title="Marcar como Compra À Vista">
                                💵 À Vista
                            </button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.error('Erro ao carregar avalista:', e);
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="5" class="table-loading" style="color:#ef4444;">Erro: ${e.message}</td></tr>`;
    }
}

document.getElementById('btnSalvarAvalistaMensagem')?.addEventListener('click', async () => {
    const msg = document.getElementById('inputAvalistaMensagem')?.value;
    const formato = document.querySelector('input[name="formatoEnvioAvalista"]:checked')?.value || 'texto';
    try {
        await api('/avalista/config', {
            method: 'PATCH',
            body: { mensagem: msg, formato_envio: formato }
        });
        toast('✅ Configuração de Avalista salva com sucesso!');
    } catch (e) {
        toast('Erro ao salvar: ' + e.message, 'error');
    }
});

document.getElementById('btnRestaurarPadraoAvalista')?.addEventListener('click', () => {
    const inputMsg = document.getElementById('inputAvalistaMensagem');
    if (inputMsg) inputMsg.value = AVALISTA_PADRAO_MSG;
});

document.querySelectorAll('input[name="formatoEnvioAvalista"]').forEach(radio => {
    radio.addEventListener('change', async (e) => {
        const val = e.target.value;
        const labelTexto = document.getElementById('labelFormatoTexto');
        const labelAudio = document.getElementById('labelFormatoAudio');
        if (val === 'audio') {
            labelAudio?.style.setProperty('background', 'rgba(16, 185, 129, 0.12)');
            labelAudio?.style.setProperty('border-color', 'rgba(16, 185, 129, 0.5)');
            labelTexto?.style.setProperty('background', 'rgba(255, 255, 255, 0.03)');
            labelTexto?.style.setProperty('border-color', 'var(--border)');
        } else {
            labelTexto?.style.setProperty('background', 'rgba(16, 185, 129, 0.12)');
            labelTexto?.style.setProperty('border-color', 'rgba(16, 185, 129, 0.5)');
            labelAudio?.style.setProperty('background', 'rgba(255, 255, 255, 0.03)');
            labelAudio?.style.setProperty('border-color', 'var(--border)');
        }
        await api('/avalista/config', { method: 'PATCH', body: { formato_envio: val } });
        toast(`Formato de envio alterado para: ${val === 'audio' ? '🎙️ Áudio Humanizado' : '💬 Texto WhatsApp'}`);
    });
});

window.dispararAvalistaIndividual = async (telefone, nome) => {
    try {
        toast(`Enviando pedido de avalista para +${telefone}...`);
        const res = await api(`/avalista/enviar/${telefone}`, {
            method: 'POST',
            body: { nome }
        });
        toast(`✅ Mensagem enviada com sucesso para +${telefone}! Lead reativado na IA.`);
        await loadAvalista();
    } catch (e) {
        toast('Erro ao enviar: ' + e.message, 'error');
    }
};

window.reenviarAvalista = async (telefone, nome) => {
    if (!confirm(`Deseja reenviar a mensagem de avalista para +${telefone}?`)) return;
    await window.dispararAvalistaIndividual(telefone, nome);
};

window.marcarAprovadoDireto = async (tel) => {
    try {
        toast(`Aprovando ficha de +${tel}...`);
        await api(`/leads/${encodeURIComponent(tel)}/status-rapido`, {
            method: 'PATCH',
            body: { etiqueta: 'aprovado' }
        });
        toast(`✅ Ficha aprovada com sucesso para +${tel}! Cliente movido para Fichas Aprovadas.`);
        await loadAvalista();
        const badgeAprov = document.getElementById('badgeAprovados');
        if (badgeAprov) badgeAprov.textContent = parseInt(badgeAprov.textContent || '0') + 1;
    } catch(e) {
        toast('Erro ao aprovar: ' + e.message, 'error');
    }
};

window.marcarAVistaDireto = async (tel) => {
    try {
        toast(`Registrando compra à vista para +${tel}...`);
        await api(`/leads/${encodeURIComponent(tel)}/status-rapido`, {
            method: 'PATCH',
            body: { etiqueta: 'a_vista' }
        });
        toast(`💵 Compra À Vista registrada para +${tel}! Cliente movido para Fichas Aprovadas.`);
        await loadAvalista();
        const badgeAprov = document.getElementById('badgeAprovados');
        if (badgeAprov) badgeAprov.textContent = parseInt(badgeAprov.textContent || '0') + 1;
    } catch(e) {
        toast('Erro ao marcar à vista: ' + e.message, 'error');
    }
};

document.getElementById('btnDispararAvalistaTodos')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnDispararAvalistaTodos');
    const txt = document.getElementById('btnDispararAvalistaText');
    const spin = document.getElementById('btnDispararAvalistaSpinner');

    txt.textContent = 'Enviando Fila...';
    spin?.classList.remove('hidden');
    btn.disabled = true;

    try {
        const res = await api('/avalista/enviar-todos', { method: 'POST' });
        toast(`⚡ Sucesso! ${res.total || 0} mensagens de avalista disparadas.`);
        await loadAvalista();
    } catch (e) {
        toast('Erro ao disparar fila: ' + e.message, 'error');
    } finally {
        txt.textContent = '⚡ Pedir Avalista para Pendentes';
        spin?.classList.add('hidden');
        btn.disabled = false;
    }
});

document.getElementById('btnAtualizarFilaAvalista')?.addEventListener('click', loadAvalista);

// ─── Prévia de Áudio do Iago (Avalista) ──────────────────────────
document.getElementById('btnPreviewAudioAvalista')?.addEventListener('click', async () => {
    const btn = document.getElementById('btnPreviewAudioAvalista');
    const spin = document.getElementById('previewAudioSpinner');
    const player = document.getElementById('audioAvalistaPlayer');
    const msg = document.getElementById('inputAvalistaMensagem')?.value;

    btn.disabled = true;
    spin?.classList.remove('hidden');

    try {
        toast('🎙️ Gerando prévia da voz do consultor Iago com IA...');
        const res = await api('/avalista/preview-audio', {
            method: 'POST',
            body: { mensagem: msg, nome: 'João' }
        });

        if (res.audio_data && player) {
            player.src = res.audio_data;
            player.classList.remove('hidden');
            player.play().catch(() => {});
            toast('✅ Áudio sintetizado! Tocando prévia.');
        }
    } catch (e) {
        toast('Erro ao gerar prévia de áudio: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        spin?.classList.add('hidden');
    }
});

// ─── FICHAS APROVADAS & COMPRAS À VISTA ───────────────────────────
let aprovadosState = { tipo: 'todos', busca: '' };

async function loadAprovados() {
    const tableBody = document.getElementById('aprovadosTableBody');
    const statTotal = document.getElementById('statTotalAprovados');
    const statAprov = document.getElementById('statFinanciamentoAprovado');
    const statVista = document.getElementById('statAVistaCount');
    const chipTodos = document.getElementById('countChipTodos');
    const chipAprov = document.getElementById('countChipAprovados');
    const chipVista = document.getElementById('countChipAVista');
    const badgeNav = document.getElementById('badgeAprovados');

    try {
        const queryParams = new URLSearchParams();
        if (aprovadosState.tipo && aprovadosState.tipo !== 'todos') queryParams.set('tipo', aprovadosState.tipo);
        if (aprovadosState.busca) queryParams.set('busca', aprovadosState.busca);

        const res = await api(`/aprovados/leads?${queryParams.toString()}`);
        const leads = (res && res.leads) || [];

        // Contagens gerais
        let totalFinanc = 0;
        let totalVista = 0;
        leads.forEach(l => {
            if (l.etiqueta === 'a_vista') totalVista++;
            else totalFinanc++;
        });

        const totalGeral = leads.length;
        if (statTotal) statTotal.textContent = totalGeral;
        if (statAprov) statAprov.textContent = totalFinanc;
        if (statVista) statVista.textContent = totalVista;
        if (chipTodos) chipTodos.textContent = totalGeral;
        if (chipAprov) chipAprov.textContent = totalFinanc;
        if (chipVista) chipVista.textContent = totalVista;
        if (badgeNav) badgeNav.textContent = totalGeral;

        if (leads.length === 0) {
            tableBody.innerHTML = `
                <tr>
                    <td colspan="7" class="table-loading" style="color:var(--text-secondary); padding: 2rem;">
                        Nenhuma ficha aprovada ou compra à vista encontrada no momento.
                    </td>
                </tr>
            `;
            return;
        }

        tableBody.innerHTML = leads.map(l => {
            const nome = escapeHtml(l.nome || l.telefone);
            const tel = escapeHtml(l.telefone || '');
            const telLimpo = tel.replace(/\D/g, '');
            const vendedor = escapeHtml(l.vendedor_nome || 'Consultor Iago');
            const triagem = l.dados_triagem || {};

            const isVista = l.etiqueta === 'a_vista';
            const badgeTipo = isVista
                ? `<span class="badge" style="background:rgba(234,179,8,0.18); color:#facc15; border:1px solid rgba(234,179,8,0.4); font-weight:600;">💵 Compra À Vista</span>`
                : `<span class="badge" style="background:rgba(16,185,129,0.18); color:#34d399; border:1px solid rgba(16,185,129,0.4); font-weight:600;">✅ Financiamento Aprovado</span>`;

            const carro = escapeHtml(triagem.carro_interesse || 'Carro em negociação');
            const entrada = escapeHtml(triagem.entrada || (isVista ? 'Pagamento Integral' : '—'));
            const parcela = escapeHtml(triagem.parcela || (isVista ? '—' : '—'));
            const condicao = `
                <div style="font-weight:600; color:#fff;">Entrada: <span style="color:#34d399;">${entrada}</span></div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">${isVista ? '💵 À Vista' : 'Parcela: ' + parcela}</div>
            `;

            const cpf = escapeHtml(triagem.cpf || 'Não coletado');
            const nasc = escapeHtml(triagem.nascimento || '—');
            const cnh = escapeHtml(triagem.cnh ? (triagem.cnh.toLowerCase().includes('sim') ? 'CNH: Sim' : 'CNH: Não') : '—');
            const docs = `
                <div style="font-family:monospace; font-size:0.8rem; color:#cbd5e1;">CPF: ${cpf}</div>
                <div style="font-size:0.75rem; color:var(--text-secondary);">Nasc: ${nasc} • ${cnh}</div>
            `;

            return `
                <tr>
                    <td>
                        <div style="font-weight:600; color:#fff;">${nome}</div>
                        <div style="font-size:0.75rem; color:var(--text-secondary);">📱 +${tel}</div>
                    </td>
                    <td>${badgeTipo}</td>
                    <td>
                        <div style="font-weight:600; color:#e2e8f0;">🚗 ${carro}</div>
                        ${triagem.troca ? `<div style="font-size:0.75rem; color:#94a3b8;">🔄 Troca: ${escapeHtml(triagem.troca)}</div>` : ''}
                    </td>
                    <td>${condicao}</td>
                    <td>${docs}</td>
                    <td style="font-size:0.8rem; color:var(--text-secondary);">${vendedor}</td>
                    <td>
                        <div style="display:flex; gap:6px;">
                            <button class="btn btn-ghost btn-sm" onclick="openLeadModal('${tel}')" title="Ver ficha e conversa completa">📋 Ficha</button>
                            <a href="https://wa.me/${telLimpo}" target="_blank" class="btn btn-primary btn-sm" style="background:#25D366; border-color:#25D366; color:#000; text-decoration:none; display:inline-flex; align-items:center;" title="Chamar no WhatsApp">💬 WhatsApp</a>
                            <button class="btn btn-ghost btn-sm" onclick="concluirVendaLead('${tel}')" title="Marcar venda concluída" style="border:1px solid rgba(16,185,129,0.3); color:#34d399;">🤝 Fechar</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');

    } catch (e) {
        console.error('Erro ao carregar aprovados:', e);
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="7" class="table-loading" style="color:#ef4444;">Erro ao carregar fichas: ${e.message}</td></tr>`;
    }
}

window.concluirVendaLead = async (telefone) => {
    if (!confirm(`Deseja marcar a negociação do cliente +${telefone} como VENDA CONCLUÍDA (Fechou)? 🚗🎉`)) return;
    try {
        await api(`/leads/${encodeURIComponent(telefone)}/status-rapido`, {
            method: 'PATCH',
            body: { etiqueta: 'fechou' }
        });
        toast('🎉 Parabéns pela venda! Status atualizado para FECHOU.');
        await loadAprovados();
    } catch(e) {
        toast('Erro ao concluir venda: ' + e.message, 'error');
    }
};

// Filtros da página de Aprovados
document.querySelectorAll('#aprovadosTipoFilter .filter-chip').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('#aprovadosTipoFilter .filter-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        aprovadosState.tipo = btn.dataset.tipo;
        loadAprovados();
    });
});

let searchAprovadosTimeout = null;
document.getElementById('buscaAprovadosInput')?.addEventListener('input', (e) => {
    clearTimeout(searchAprovadosTimeout);
    searchAprovadosTimeout = setTimeout(() => {
        aprovadosState.busca = e.target.value.trim();
        loadAprovados();
    }, 400);
});

document.getElementById('btnAtualizarAprovados')?.addEventListener('click', loadAprovados);

// ═══════════════════════════════════════════════════════════════
// 🤖 EDITOR DO ROBÔ (IA) — IMPLEMENTAÇÃO COMPLETA
// ═══════════════════════════════════════════════════════════════

let iaEditorState = {
    promptAtual: '',
    metadata: null,
    chatHistorico: [],
    refinadoTemporario: null,
    carregado: false
};

function updateCharCount() {
    const textarea = document.getElementById('promptTextarea');
    const pill = document.getElementById('promptCharCount');
    if (textarea && pill) {
        pill.textContent = `${textarea.value.length} caracteres`;
    }
}

function formatChatMessage(text) {
    if (!text) return '';
    return escapeHtml(text)
        .replace(/\n/g, '<br>')
        .replace(/\*(.*?)\*/g, '<strong>$1</strong>')
        .replace(/_(.*?)_/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;">$1</code>');
}

async function loadIaPrompt() {
    try {
        const res = await api('/ia/prompt');
        iaEditorState.promptAtual = res.prompt || '';
        iaEditorState.metadata = res.metadata || {};

        const promptTextarea = document.getElementById('promptTextarea');
        if (promptTextarea) {
            promptTextarea.value = iaEditorState.promptAtual;
            updateCharCount();
        }

        const versao = res.metadata?.versao || 1;
        const badge = document.getElementById('promptVersionBadge');
        if (badge) badge.textContent = `Versão ${versao}`;

        const chatVersao = document.getElementById('chatTreinadorVersao');
        if (chatVersao) chatVersao.textContent = `Versão ${versao}`;

        await Promise.all([
            loadChatTreinadorHistorico(),
            loadPromptHistorico()
        ]);

        iaEditorState.carregado = true;
    } catch (e) {
        console.error('Erro ao carregar prompt da IA:', e);
        toast('Erro ao carregar configurações da IA: ' + e.message, 'error');
    }
}

async function loadChatTreinadorHistorico() {
    const bodyEl = document.getElementById('chatTreinadorMessages');
    if (!bodyEl) return;

    try {
        const res = await api('/ia/chat-treinador/historico');
        const msgs = res.historico || [];
        iaEditorState.chatHistorico = msgs;

        if (msgs.length === 0) {
            bodyEl.innerHTML = `
                <div class="ia-bubble assistant">
                    Olá! Eu sou o <strong>Iago</strong>, consultor virtual da loja. 🤖<br><br>
                    Você pode conversar comigo para testar minhas respostas ou me dar <strong>ordens diretas</strong> sobre o que mudar no atendimento (ex: <em>"A partir de agora informe que aceitamos motos na troca"</em>).
                    <div class="ia-bubble-meta">Sistema</div>
                </div>
            `;
            return;
        }

        bodyEl.innerHTML = msgs.map(m => `
            <div class="ia-bubble ${m.role}">
                ${formatChatMessage(m.content)}
                ${m.alterou_prompt ? '<div class="ia-bubble-alert-update">✨ Instruções do robô atualizadas no WhatsApp!</div>' : ''}
                <div class="ia-bubble-meta">${m.role === 'user' ? 'Você' : 'Iago'} • ${m.horario || ''}</div>
            </div>
        `).join('');

        bodyEl.scrollTop = bodyEl.scrollHeight;
    } catch(e) {
        bodyEl.innerHTML = `<div class="text-muted p-sm">Não foi possível carregar o histórico: ${e.message}</div>`;
    }
}

async function enviarOrdemTreinador() {
    const input = document.getElementById('inputOrdemTreinador');
    const msg = input?.value.trim();
    if (!msg) return;

    const bodyEl = document.getElementById('chatTreinadorMessages');
    input.value = '';

    // Adiciona bolha do usuário
    const userBubble = document.createElement('div');
    userBubble.className = 'ia-bubble user';
    userBubble.innerHTML = `${formatChatMessage(msg)}<div class="ia-bubble-meta">Você • Agora</div>`;
    bodyEl.appendChild(userBubble);

    // Bolha de digitação
    const loadingBubble = document.createElement('div');
    loadingBubble.className = 'ia-bubble assistant';
    loadingBubble.id = 'treinadorTyping';
    loadingBubble.innerHTML = `<em>Iago está pensando e ajustando as regras... ⏳</em>`;
    bodyEl.appendChild(loadingBubble);
    bodyEl.scrollTop = bodyEl.scrollHeight;

    try {
        const res = await api('/ia/chat-treinador', {
            method: 'POST',
            body: { mensagem: msg }
        });

        loadingBubble.remove();

        const assistantBubble = document.createElement('div');
        assistantBubble.className = 'ia-bubble assistant';
        assistantBubble.innerHTML = `
            ${formatChatMessage(res.resposta || 'Ordem processada com sucesso!')}
            ${res.alterou_prompt ? '<div class="ia-bubble-alert-update">✨ Instruções do robô atualizadas no WhatsApp!</div>' : ''}
            <div class="ia-bubble-meta">Iago • Agora</div>
        `;
        bodyEl.appendChild(assistantBubble);
        bodyEl.scrollTop = bodyEl.scrollHeight;

        if (res.alterou_prompt && res.prompt_refinado) {
            iaEditorState.promptAtual = res.prompt_refinado;
            const promptTextarea = document.getElementById('promptTextarea');
            if (promptTextarea) {
                promptTextarea.value = res.prompt_refinado;
                updateCharCount();
            }
            toast('✅ Regra incorporada ao robô no WhatsApp com sucesso!');
            await loadIaPrompt();
        }
    } catch(e) {
        loadingBubble.remove();
        toast('Erro ao processar ordem com o Iago: ' + e.message, 'error');
    }
}

async function salvarPromptManual() {
    const promptTextarea = document.getElementById('promptTextarea');
    const text = promptTextarea?.value.trim();
    if (!text) {
        toast('O prompt não pode estar vazio', 'warning');
        return;
    }

    try {
        const res = await api('/ia/prompt', {
            method: 'POST',
            body: {
                prompt_text: text,
                notas: 'Edição direta via painel CRM'
            }
        });

        toast('💾 Prompt publicado com sucesso no WhatsApp!');
        iaEditorState.promptAtual = text;
        const versao = res.metadata?.versao || 1;
        const badge = document.getElementById('promptVersionBadge');
        if (badge) badge.textContent = `Versão ${versao}`;
        const chatVersao = document.getElementById('chatTreinadorVersao');
        if (chatVersao) chatVersao.textContent = `Versão ${versao}`;
        await loadPromptHistorico();
    } catch(e) {
        toast('Erro ao salvar prompt: ' + e.message, 'error');
    }
}

async function loadPromptHistorico() {
    const select = document.getElementById('selectHistoricoPrompt');
    if (!select) return;

    try {
        const res = await api('/ia/prompt/historico');
        const list = res.historico || [];
        select.innerHTML = '<option value="">⏮️ Histórico de Versões...</option>';
        list.forEach(v => {
            const opt = document.createElement('option');
            opt.value = v.id;
            opt.textContent = `V${v.versao} (${new Date(v.criado_em).toLocaleDateString('pt-BR')}) - ${v.notas || 'Atualização'}`;
            select.appendChild(opt);
        });
    } catch(e) {}
}

async function reverterPrompt(id) {
    if (!id) return;
    if (!confirm('Deseja reverter para esta versão anterior do prompt?')) return;

    try {
        await api('/ia/prompt/reverter', {
            method: 'POST',
            body: { id }
        });
        toast('Versão restaurada com sucesso!');
        await loadIaPrompt();
    } catch(e) {
        toast('Erro ao reverter prompt: ' + e.message, 'error');
    }
}

async function refinarPromptComIa() {
    const input = document.getElementById('sugestaoIaInput');
    const sugestao = input?.value.trim();
    if (!sugestao) {
        toast('Digite uma sugestão para a IA', 'warning');
        return;
    }

    const btn = document.getElementById('btnRefinarPrompt');
    const btnText = document.getElementById('btnRefinarText');
    const spinner = document.getElementById('btnRefinarSpinner');
    btn.disabled = true;
    if (btnText) btnText.textContent = 'Processando com IA...';
    spinner?.classList.remove('hidden');

    try {
        const res = await api('/ia/prompt/refinar', {
            method: 'POST',
            body: {
                sugestao,
                prompt_atual: document.getElementById('promptTextarea')?.value || ''
            }
        });

        iaEditorState.refinadoTemporario = res.prompt_refinado;
        const resumoEl = document.getElementById('iaRefinarResumo');
        if (resumoEl) resumoEl.textContent = res.resumo_alteracoes || 'Alterações preparadas pela IA com base na sua solicitação.';
        document.getElementById('iaRefinarResult')?.classList.remove('hidden');
    } catch(e) {
        toast('Erro ao refinar prompt: ' + e.message, 'error');
    } finally {
        btn.disabled = false;
        if (btnText) btnText.textContent = '✨ Refinar Prompt com IA';
        spinner?.classList.add('hidden');
    }
}

// Inicialização dos eventos do IA Editor
function initIaEditorEvents() {
    // 1. Navegação de Abas
    const tabs = [
        { btn: 'tabModoChat', view: 'viewModoChat' },
        { btn: 'tabModoVisual', view: 'viewModoVisual' },
        { btn: 'tabModoAvancado', view: 'viewModoAvancado' }
    ];

    tabs.forEach(({ btn, view }) => {
        document.getElementById(btn)?.addEventListener('click', () => {
            tabs.forEach(t => {
                document.getElementById(t.btn)?.classList.remove('active');
                document.getElementById(t.view)?.classList.add('hidden');
            });
            document.getElementById(btn)?.classList.add('active');
            document.getElementById(view)?.classList.remove('hidden');
        });
    });

    // 2. Chat Treinador
    document.getElementById('btnEnviarOrdemTreinador')?.addEventListener('click', enviarOrdemTreinador);
    document.getElementById('inputOrdemTreinador')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            enviarOrdemTreinador();
        }
    });

    document.getElementById('btnLimparChatTreinador')?.addEventListener('click', async () => {
        if (!confirm('Deseja limpar todo o histórico de conversas com o Iago?')) return;
        try {
            await api('/ia/chat-treinador/limpar', { method: 'POST' });
            toast('Histórico de conversas limpo.');
            await loadChatTreinadorHistorico();
        } catch(e) {
            toast('Erro ao limpar histórico: ' + e.message, 'error');
        }
    });

    // 3. Salvar Prompt Manual
    document.getElementById('btnSalvarPrompt')?.addEventListener('click', salvarPromptManual);

    // 4. Contador de caracteres no textarea
    document.getElementById('promptTextarea')?.addEventListener('input', updateCharCount);

    // 5. Histórico e Reversão
    document.getElementById('selectHistoricoPrompt')?.addEventListener('change', (e) => {
        if (e.target.value) {
            reverterPrompt(e.target.value);
        }
    });

    // 6. Restaurar padrão de fábrica
    document.getElementById('btnRestaurarPadrao')?.addEventListener('click', async () => {
        if (!confirm('Atenção: deseja resetar o prompt para a versão padrão de fábrica do Iago?')) return;
        try {
            await api('/ia/prompt', {
                method: 'POST',
                body: { prompt_text: 'RESTAURAR_PADRAO', notas: 'Restauração de padrão de fábrica' }
            });
            toast('Prompt padrão restaurado!');
            await loadIaPrompt();
        } catch(e) {
            toast('Erro ao restaurar padrão: ' + e.message, 'error');
        }
    });

    // 7. Assistente de Sugestões com IA
    document.getElementById('btnRefinarPrompt')?.addEventListener('click', refinarPromptComIa);
    document.getElementById('btnDesfazerRefinamento')?.addEventListener('click', () => {
        iaEditorState.refinadoTemporario = null;
        document.getElementById('iaRefinarResult')?.classList.add('hidden');
    });

    document.getElementById('btnAplicarESalvar')?.addEventListener('click', async () => {
        if (!iaEditorState.refinadoTemporario) return;
        const promptTextarea = document.getElementById('promptTextarea');
        if (promptTextarea) {
            promptTextarea.value = iaEditorState.refinadoTemporario;
            updateCharCount();
        }
        document.getElementById('iaRefinarResult')?.classList.add('hidden');
        await salvarPromptManual();
    });

    // 8. Controles do Painel Visual
    document.querySelectorAll('.tone-card').forEach(card => {
        card.addEventListener('click', () => {
            document.querySelectorAll('.tone-card').forEach(c => c.classList.remove('active'));
            card.classList.add('active');
            toast(`Tom de voz ajustado para: ${card.querySelector('.tone-title')?.textContent}`);
        });
    });

    document.querySelectorAll('.btn-quick-tag').forEach(btn => {
        btn.addEventListener('click', () => {
            const input = document.getElementById('promoTextoInput');
            if (input) {
                input.value = btn.dataset.tag;
                toast('Promoção aplicada na sugestão!');
            }
        });
    });
}

// Inicializa os ouvintes do IA Editor
initIaEditorEvents();

// ─── Boot ──────────────────────────────────────────────────────
checkAuth();
