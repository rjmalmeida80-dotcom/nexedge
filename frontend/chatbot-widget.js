/**
 * NexEdge Chatbot Widget
 * Adicionar a qualquer página: <script src="/chatbot-widget.js"></script>
 */
(function() {
  'use strict';

  const API = '/api/itsm/chatbot';
  let sessaoId = null;
  let aberto = false;
  let estrelasSel = 0;

  // ── CSS ──
  const css = `
    #ne-chat-btn {
      position: fixed; bottom: 24px; right: 24px; z-index: 9999;
      width: 56px; height: 56px; border-radius: 50%;
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      border: none; cursor: pointer; box-shadow: 0 4px 20px rgba(79,70,229,0.5);
      display: flex; align-items: center; justify-content: center;
      transition: all .2s; font-size: 24px; color: white;
    }
    #ne-chat-btn:hover { transform: scale(1.1); box-shadow: 0 6px 28px rgba(79,70,229,0.65); }
    #ne-chat-btn .ne-badge {
      position: absolute; top: -4px; right: -4px;
      background: #ef4444; color: white; border-radius: 50%;
      width: 18px; height: 18px; font-size: 10px; font-weight: 700;
      display: none; align-items: center; justify-content: center;
      border: 2px solid white;
    }
    #ne-chat-box {
      position: fixed; bottom: 92px; right: 24px; z-index: 9999;
      width: 360px; height: 520px; border-radius: 16px;
      background: #fff; box-shadow: 0 20px 60px rgba(0,0,0,0.2);
      display: none; flex-direction: column; overflow: hidden;
      font-family: Inter, -apple-system, sans-serif;
      border: 1px solid rgba(0,0,0,0.08);
      animation: neChatIn .25s ease-out;
    }
    #ne-chat-box.open { display: flex; }
    @keyframes neChatIn { from { opacity:0; transform:translateY(20px) scale(.95); } to { opacity:1; transform:none; } }
    .ne-chat-header {
      background: linear-gradient(135deg, #4f46e5, #7c3aed);
      padding: 16px 18px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;
    }
    .ne-chat-avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: rgba(255,255,255,0.2); display: flex; align-items: center;
      justify-content: center; font-size: 18px; flex-shrink: 0;
    }
    .ne-chat-info { flex: 1; }
    .ne-chat-name { color: #fff; font-size: 14px; font-weight: 600; }
    .ne-chat-status { color: rgba(255,255,255,0.7); font-size: 11px; display: flex; align-items: center; gap: 4px; }
    .ne-chat-status::before { content:''; width:6px;height:6px;border-radius:50%;background:#4ade80;display:inline-block; }
    .ne-chat-close { background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.7);font-size:20px;padding:0;line-height:1; }
    .ne-chat-close:hover { color:#fff; }
    .ne-chat-msgs {
      flex: 1; overflow-y: auto; padding: 16px; display: flex;
      flex-direction: column; gap: 10px; background: #f8fafc;
    }
    .ne-chat-msgs::-webkit-scrollbar { width: 4px; }
    .ne-chat-msgs::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 4px; }
    .ne-msg { max-width: 82%; display: flex; flex-direction: column; gap: 3px; }
    .ne-msg.bot { align-self: flex-start; }
    .ne-msg.user { align-self: flex-end; }
    .ne-msg-bubble {
      padding: 10px 13px; border-radius: 14px; font-size: 13px; line-height: 1.5;
    }
    .ne-msg.bot .ne-msg-bubble { background: #fff; color: #1e293b; border: 1px solid #e2e8f0; border-bottom-left-radius: 4px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .ne-msg.user .ne-msg-bubble { background: linear-gradient(135deg,#4f46e5,#7c3aed); color: #fff; border-bottom-right-radius: 4px; }
    .ne-msg-time { font-size: 10px; color: #94a3b8; padding: 0 4px; }
    .ne-msg.user .ne-msg-time { text-align: right; }
    .ne-opcoes { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .ne-opcao {
      padding: 6px 12px; border: 1.5px solid #6366f1; border-radius: 20px;
      font-size: 12px; color: #4f46e5; cursor: pointer; background: #fff;
      font-family: inherit; transition: all .15s; font-weight: 500;
    }
    .ne-opcao:hover { background: #eef2ff; border-color: #4f46e5; }
    .ne-ticket-card {
      background: #eef2ff; border: 1px solid #c7d2fe; border-radius: 10px;
      padding: 10px 13px; margin-top: 4px;
    }
    .ne-ticket-num { font-family: monospace; font-size: 13px; font-weight: 700; color: #4f46e5; }
    .ne-ticket-txt { font-size: 11px; color: #6366f1; margin-top: 2px; }
    .ne-chat-input-area {
      padding: 12px; background: #fff; border-top: 1px solid #e2e8f0; flex-shrink: 0;
    }
    .ne-chat-input-row { display: flex; gap: 8px; align-items: flex-end; }
    .ne-chat-input {
      flex: 1; padding: 9px 12px; border: 1.5px solid #e2e8f0; border-radius: 10px;
      font-size: 13px; font-family: inherit; outline: none; resize: none;
      max-height: 80px; overflow-y: auto; color: #1e293b; background: #f8fafc;
      transition: border-color .15s;
    }
    .ne-chat-input:focus { border-color: #6366f1; background: #fff; }
    .ne-chat-input::placeholder { color: #94a3b8; }
    .ne-chat-send {
      width: 36px; height: 36px; border-radius: 10px; border: none; cursor: pointer;
      background: linear-gradient(135deg,#4f46e5,#7c3aed); color: white;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      transition: all .15s; font-size: 16px;
    }
    .ne-chat-send:hover { transform: scale(1.05); }
    .ne-chat-send:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .ne-typing { display: flex; gap: 4px; padding: 10px 13px; background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; border-bottom-left-radius: 4px; width: fit-content; }
    .ne-typing span { width: 6px; height: 6px; border-radius: 50%; background: #94a3b8; animation: neDot 1.2s infinite; }
    .ne-typing span:nth-child(2) { animation-delay: .2s; }
    .ne-typing span:nth-child(3) { animation-delay: .4s; }
    @keyframes neDot { 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-6px)} }
    .ne-stars { display: flex; gap: 4px; justify-content: center; margin: 8px 0; }
    .ne-star { font-size: 22px; cursor: pointer; opacity: 0.3; transition: all .1s; }
    .ne-star.sel, .ne-star:hover { opacity: 1; transform: scale(1.2); }
    .ne-powered { text-align: center; font-size: 10px; color: #cbd5e1; padding: 6px 0 0; }
  `;

  function injectCSS() {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function getToken() {
    try {
      const t = localStorage.getItem('access_token'); if(t) return t;
      const r = localStorage.getItem('rh-auth'); if(r) { const p=JSON.parse(r); return p?.state?.token||null; }
    } catch(e){}
    return null;
  }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('rh-auth'))?.state?.utilizador||null; } catch(e){return null;}
  }

  async function apiFetch(path, opts={}) {
    const token = getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = await fetch(API + path, { ...opts, headers: { ...headers, ...(opts.headers||{}) } });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function fmtHora() {
    return new Date().toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });
  }

  function adicionarMensagem(texto, tipo, opcoes=[], ticket=null) {
    const msgs = document.getElementById('ne-msgs');

    // Remover typing
    const typing = msgs.querySelector('.ne-typing-wrapper');
    if (typing) typing.remove();

    const wrapper = document.createElement('div');
    wrapper.className = `ne-msg ${tipo}`;

    const bubble = document.createElement('div');
    bubble.className = 'ne-msg-bubble';
    bubble.innerHTML = texto.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    wrapper.appendChild(bubble);

    if (ticket) {
      const card = document.createElement('div');
      card.className = 'ne-ticket-card';
      card.innerHTML = `<div class="ne-ticket-num">🎫 ${ticket.numero}</div><div class="ne-ticket-txt">Ticket criado — a equipa irá contactar-te em breve</div>`;
      wrapper.appendChild(card);
    }

    if (opcoes.length) {
      const opDiv = document.createElement('div');
      opDiv.className = 'ne-opcoes';
      opcoes.forEach(op => {
        const btn = document.createElement('button');
        btn.className = 'ne-opcao';
        btn.textContent = op;
        btn.onclick = () => { opDiv.remove(); enviarMensagem(op); };
        opDiv.appendChild(btn);
      });
      wrapper.appendChild(opDiv);
    }

    const time = document.createElement('div');
    time.className = 'ne-msg-time';
    time.textContent = fmtHora();
    wrapper.appendChild(time);

    msgs.appendChild(wrapper);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function mostrarTyping() {
    const msgs = document.getElementById('ne-msgs');
    const w = document.createElement('div');
    w.className = 'ne-msg bot ne-typing-wrapper';
    w.innerHTML = '<div class="ne-typing"><span></span><span></span><span></span></div>';
    msgs.appendChild(w);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function iniciarSessao() {
    const user = getUser();
    try {
      const r = await apiFetch('/sessao', {
        method: 'POST',
        body: JSON.stringify({ nome: user?.nome_completo || user?.nome || '', email: user?.email || '' })
      });
      sessaoId = r.sessao_id;
      adicionarMensagem(r.mensagem, 'bot', r.opcoes||[]);
    } catch(e) {
      adicionarMensagem('Olá! 👋 Como posso ajudar?', 'bot', ['Tenho um problema','Fazer um pedido','Verificar ticket']);
    }
  }

  async function enviarMensagem(texto) {
    if (!texto?.trim()) return;

    const input = document.getElementById('ne-input');
    const send = document.getElementById('ne-send');
    if (input) input.value = '';
    if (send) send.disabled = true;

    adicionarMensagem(texto, 'user');
    mostrarTyping();

    try {
      if (!sessaoId) await iniciarSessao();

      const r = await apiFetch('/mensagem', {
        method: 'POST',
        body: JSON.stringify({ sessao_id: sessaoId, mensagem: texto })
      });

      adicionarMensagem(r.mensagem, 'bot', r.opcoes||[], r.ticket_criado||null);

      if (r.resolvido) {
        mostrarAvaliacao();
      }
    } catch(e) {
      adicionarMensagem('Desculpa, ocorreu um erro. Tenta novamente ou cria um ticket.', 'bot', ['Criar ticket', 'Tentar novamente']);
    }

    if (send) send.disabled = false;
  }

  function mostrarAvaliacao() {
    const msgs = document.getElementById('ne-msgs');
    const w = document.createElement('div');
    w.className = 'ne-msg bot';
    w.innerHTML = `
      <div class="ne-msg-bubble">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">Como foi o suporte? ⭐</div>
        <div class="ne-stars" id="ne-stars-widget">
          ${[1,2,3,4,5].map(n=>`<span class="ne-star" data-n="${n}" onclick="window._neAvaliar(${n})">⭐</span>`).join('')}
        </div>
      </div>`;
    msgs.appendChild(w);
    msgs.scrollTop = msgs.scrollHeight;

    window._neAvaliar = async (n) => {
      document.querySelectorAll('.ne-star').forEach((s,i) => {
        s.classList.toggle('sel', i < n);
        s.style.opacity = i < n ? '1' : '0.3';
      });
      if (sessaoId) {
        await apiFetch(`/sessao/${sessaoId}/fechar`, {
          method: 'POST', body: JSON.stringify({ satisfacao: n })
        }).catch(()=>{});
      }
      setTimeout(() => {
        adicionarMensagem('Obrigado pelo feedback! ✅ Boa continuação.', 'bot');
      }, 600);
    };
  }

  function toggleChat() {
    aberto = !aberto;
    const box = document.getElementById('ne-chat-box');
    const btn = document.getElementById('ne-chat-btn');
    if (aberto) {
      box.classList.add('open');
      btn.innerHTML = '<span style="font-size:20px">✕</span>';
      if (!sessaoId) iniciarSessao();
      document.getElementById('ne-input')?.focus();
    } else {
      box.classList.remove('open');
      btn.innerHTML = '💬<div class="ne-badge" id="ne-badge"></div>';
    }
  }

  function criarWidget() {
    injectCSS();

    // Botão
    const btn = document.createElement('button');
    btn.id = 'ne-chat-btn';
    btn.title = 'Suporte NexEdge';
    btn.innerHTML = '💬<div class="ne-badge" id="ne-badge"></div>';
    btn.onclick = toggleChat;
    document.body.appendChild(btn);

    // Caixa de chat
    const box = document.createElement('div');
    box.id = 'ne-chat-box';
    box.innerHTML = `
      <div class="ne-chat-header">
        <div class="ne-chat-avatar">🤖</div>
        <div class="ne-chat-info">
          <div class="ne-chat-name">Assistente NexEdge</div>
          <div class="ne-chat-status">Online • Resposta imediata</div>
        </div>
        <button class="ne-chat-close" onclick="document.getElementById('ne-chat-btn').click()">✕</button>
      </div>
      <div class="ne-chat-msgs" id="ne-msgs"></div>
      <div class="ne-chat-input-area">
        <div class="ne-chat-input-row">
          <textarea class="ne-chat-input" id="ne-input" placeholder="Escreve a tua questão..." rows="1"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window._neSend()}"
            oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,80)+'px'"></textarea>
          <button class="ne-chat-send" id="ne-send" onclick="window._neSend()">➤</button>
        </div>
        <div class="ne-powered">Powered by NexEdge AI</div>
      </div>
    `;
    document.body.appendChild(box);

    window._neSend = () => {
      const input = document.getElementById('ne-input');
      const txt = input?.value?.trim();
      if (txt) enviarMensagem(txt);
    };
  }

  // Inicializar quando o DOM estiver pronto
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', criarWidget);
  } else {
    criarWidget();
  }
})();
