/**
 * NexEdge — Copilot Widget Universal
 * Aparece em todos os módulos como botão flutuante
 * "Pergunta qualquer coisa sobre a tua empresa"
 */
(function() {
  'use strict';

  const MODULO = document.body.dataset.modulo || document.title.split('—')[1]?.trim() || 'geral';
  let historico = [];
  let aberto = false;

  function getToken() {
    try {
      const t = localStorage.getItem('access_token'); if (t) return t;
      const r = localStorage.getItem('rh-auth'); if (r) return JSON.parse(r)?.state?.token;
    } catch(e) {}
    return null;
  }

  function injectStyles() {
    const s = document.createElement('style');
    s.textContent = `
      #nx-copilot-btn {
        position:fixed;bottom:24px;right:24px;width:52px;height:52px;
        background:linear-gradient(135deg,#8b5cf6,#6366f1);
        border-radius:50%;border:none;cursor:pointer;color:#fff;font-size:22px;
        box-shadow:0 4px 20px rgba(139,92,246,.5);z-index:9998;
        transition:all .2s;display:flex;align-items:center;justify-content:center;
      }
      #nx-copilot-btn:hover{transform:scale(1.1);box-shadow:0 6px 28px rgba(139,92,246,.6)}
      #nx-copilot-btn.act{background:linear-gradient(135deg,#6366f1,#4f46e5)}
      #nx-copilot-panel {
        position:fixed;bottom:88px;right:24px;width:380px;height:520px;
        background:#0F172A;border:1px solid rgba(139,92,246,.3);
        border-radius:20px;z-index:9999;display:none;flex-direction:column;
        box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;
        animation:nxSlideUp .2s ease-out;
      }
      @keyframes nxSlideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:none}}
      #nx-copilot-panel.open{display:flex}
      .nx-header{background:linear-gradient(135deg,#1E1B4B,#2D1B69);padding:14px 18px;
        display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
      .nx-header-left{display:flex;align-items:center;gap:10px}
      .nx-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#8b5cf6,#6366f1);
        display:flex;align-items:center;justify-content:center;font-size:15px}
      .nx-title{font-size:13px;font-weight:700;color:#fff}
      .nx-sub{font-size:10px;color:#a78bfa;margin-top:1px}
      .nx-close{background:none;border:none;color:rgba(255,255,255,.4);font-size:18px;cursor:pointer}
      .nx-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}
      .nx-msg{max-width:85%;padding:10px 14px;border-radius:14px;font-size:13px;line-height:1.5;animation:nxFade .2s}
      @keyframes nxFade{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
      .nx-msg.user{background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
      .nx-msg.bot{background:#1E293B;color:#e2e8f0;align-self:flex-start;border-bottom-left-radius:4px}
      .nx-msg.bot a{color:#a78bfa}
      .nx-typing{display:flex;gap:4px;align-items:center;padding:8px 12px;background:#1E293B;border-radius:14px;width:60px;align-self:flex-start}
      .nx-typing span{width:7px;height:7px;border-radius:50%;background:#6366f1;animation:nxBounce 1.2s infinite}
      .nx-typing span:nth-child(2){animation-delay:.2s}
      .nx-typing span:nth-child(3){animation-delay:.4s}
      @keyframes nxBounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
      .nx-sugestoes{padding:0 14px 8px;display:flex;flex-wrap:wrap;gap:6px}
      .nx-sug{background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.25);
        color:#a78bfa;border-radius:20px;padding:5px 12px;font-size:11px;cursor:pointer;
        font-family:inherit;transition:all .15s}
      .nx-sug:hover{background:rgba(99,102,241,.25);color:#c4b5fd}
      .nx-input-row{padding:12px 14px;border-top:1px solid rgba(255,255,255,.06);
        display:flex;gap:8px;flex-shrink:0;background:#0F172A}
      .nx-input{flex:1;background:#1E293B;border:1px solid rgba(255,255,255,.08);
        border-radius:12px;padding:10px 14px;font-size:13px;color:#f8fafc;
        font-family:inherit;outline:none;resize:none;height:40px;
        transition:border-color .15s}
      .nx-input:focus{border-color:#6366f1}
      .nx-send{background:linear-gradient(135deg,#8b5cf6,#6366f1);border:none;
        border-radius:10px;width:40px;height:40px;cursor:pointer;color:#fff;
        font-size:16px;flex-shrink:0;transition:all .15s}
      .nx-send:hover{transform:scale(1.05)}
      .nx-send:disabled{opacity:.4;cursor:not-allowed}
      ::-webkit-scrollbar{width:3px}
      ::-webkit-scrollbar-thumb{background:rgba(139,92,246,.3);border-radius:3px}
      @media(max-width:480px){
        #nx-copilot-panel{width:calc(100vw - 32px);bottom:80px;right:16px;height:60vh}
        #nx-copilot-btn{bottom:20px;right:20px}
      }
    `;
    document.head.appendChild(s);
  }

  function injectHTML() {
    const btn = document.createElement('button');
    btn.id = 'nx-copilot-btn';
    btn.title = 'Copilot IA NexEdge';
    btn.innerHTML = '🤖';
    btn.onclick = togglePanel;

    const panel = document.createElement('div');
    panel.id = 'nx-copilot-panel';
    panel.innerHTML = `
      <div class="nx-header">
        <div class="nx-header-left">
          <div class="nx-avatar">🤖</div>
          <div>
            <div class="nx-title">NexEdge Copilot</div>
            <div class="nx-sub">Powered by Claude AI · ${MODULO}</div>
          </div>
        </div>
        <button class="nx-close" onclick="document.getElementById('nx-copilot-panel').classList.remove('open');document.getElementById('nx-copilot-btn').classList.remove('act')">×</button>
      </div>
      <div class="nx-msgs" id="nx-msgs">
        <div class="nx-msg bot">👋 Olá! Sou o Copilot da NexEdge. Pergunta-me qualquer coisa sobre a tua empresa — entregas, stock, faturas, funcionários, alertas...</div>
      </div>
      <div class="nx-sugestoes" id="nx-sugs"></div>
      <div class="nx-input-row">
        <textarea class="nx-input" id="nx-input" placeholder="Pergunta qualquer coisa..." rows="1"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.nxEnviar()}"></textarea>
        <button class="nx-send" id="nx-send" onclick="window.nxEnviar()">➤</button>
      </div>`;

    document.body.appendChild(btn);
    document.body.appendChild(panel);
    carregarSugestoes();
  }

  async function carregarSugestoes() {
    try {
      const modKey = MODULO.toLowerCase().includes('logist') ? 'logistica' :
        MODULO.toLowerCase().includes('wms')||MODULO.toLowerCase().includes('armazém') ? 'wms' :
        MODULO.toLowerCase().includes('rh')||MODULO.toLowerCase().includes('funcionár') ? 'rh' :
        MODULO.toLowerCase().includes('financ')||MODULO.toLowerCase().includes('fatur') ? 'financeiro' :
        MODULO.toLowerCase().includes('crm') ? 'crm' :
        MODULO.toLowerCase().includes('itsm')||MODULO.toLowerCase().includes('ticket') ? 'itsm' : 'geral';

      const r = await fetch('/api/copilot/sugestoes/'+modKey, {
        headers: { 'Authorization': 'Bearer '+getToken() }
      });
      if (!r.ok) return;
      const sugs = await r.json();
      const el = document.getElementById('nx-sugs');
      if (el) el.innerHTML = sugs.map(s=>`<button class="nx-sug" onclick="window.nxSugestao('${s.replace(/'/g,"\\'")}')">
        ${s.length > 40 ? s.slice(0,38)+'...' : s}
      </button>`).join('');
    } catch(e) {}
  }

  function togglePanel() {
    aberto = !aberto;
    const panel = document.getElementById('nx-copilot-panel');
    const btn = document.getElementById('nx-copilot-btn');
    panel.classList.toggle('open', aberto);
    btn.classList.toggle('act', aberto);
    if (aberto) document.getElementById('nx-input')?.focus();
  }

  window.nxSugestao = function(texto) {
    const input = document.getElementById('nx-input');
    if (input) { input.value = texto; window.nxEnviar(); }
  };

  window.nxEnviar = async function() {
    const input = document.getElementById('nx-input');
    const msg = input?.value?.trim();
    if (!msg) return;
    input.value = '';

    const token = getToken();
    if (!token) {
      adicionarMsg('Por favor faz login para usar o Copilot.', 'bot');
      return;
    }

    adicionarMsg(msg, 'user');
    const typing = mostrarTyping();
    document.getElementById('nx-send').disabled = true;

    try {
      const r = await fetch('/api/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+token },
        body: JSON.stringify({ mensagem: msg, contexto_modulo: MODULO, historico: historico.slice(-6) })
      });
      const d = await r.json();
      typing.remove();
      if (d.resposta) {
        adicionarMsg(d.resposta, 'bot');
        historico.push({ role:'user', content:msg });
        historico.push({ role:'assistant', content:d.resposta });
        if (historico.length > 20) historico = historico.slice(-20);
      } else {
        adicionarMsg('Erro: '+(d.error||'Sem resposta'), 'bot');
      }
    } catch(e) {
      typing.remove();
      adicionarMsg('Erro de ligação: '+e.message, 'bot');
    }
    document.getElementById('nx-send').disabled = false;
    document.getElementById('nx-input')?.focus();
  };

  function adicionarMsg(texto, tipo) {
    const msgs = document.getElementById('nx-msgs');
    if (!msgs) return;
    const el = document.createElement('div');
    el.className = 'nx-msg '+tipo;
    el.innerHTML = texto.replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>');
    msgs.appendChild(el);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function mostrarTyping() {
    const msgs = document.getElementById('nx-msgs');
    const el = document.createElement('div');
    el.className = 'nx-typing';
    el.innerHTML = '<span></span><span></span><span></span>';
    msgs?.appendChild(el);
    msgs && (msgs.scrollTop = msgs.scrollHeight);
    return el;
  }

  // Inicializar
  injectStyles();
  injectHTML();

  // Atalho teclado: Ctrl+Espaço
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); togglePanel(); }
  });
})();
