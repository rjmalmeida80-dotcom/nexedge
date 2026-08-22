'use strict';
// Rotas públicas do portal ITSM (sem autenticação)
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// Submeter ticket via portal público
router.post('/ticket', async (req, res) => {
  try {
    const { titulo, descricao, tipo, prioridade, urgencia, impacto, nome_contacto, email_contacto, empresa_slug, campos_extra, tags } = req.body;
    
    if (!titulo || !email_contacto) return res.status(400).json({ error: 'Título e email obrigatórios' });

    // Encontrar empresa pelo slug ou usar empresa default
    let empresa;
    if (empresa_slug) {
      const r = await query(`SELECT id, nome FROM empresa WHERE id=$1 OR slug=$1 LIMIT 1`, [empresa_slug]);
      empresa = r.rows[0];
    }
    if (!empresa) {
      const r = await query(`SELECT id, nome FROM empresa WHERE ativo=true ORDER BY criado_em LIMIT 1`);
      empresa = r.rows[0];
    }
    if (!empresa) return res.status(400).json({ error: 'Empresa não encontrada' });

    // Gerar número do ticket
    const ano = new Date().getFullYear();
    const countR = await query(`SELECT COUNT(*) FROM itsm_ticket WHERE empresa_id=$1 AND EXTRACT(YEAR FROM criado_em)=$2`, [empresa.id, ano]);
    const seq = (parseInt(countR.rows[0].count) + 1).toString().padStart(5, '0');
    const numero = `TK${ano}-${seq}`;

    // Calcular SLA
    const slaH = { critica:4, alta:8, media:24, baixa:72 };
    const resolucaoH = slaH[prioridade||'media'];
    const agora = new Date();
    const limiteResolucao = new Date(agora.getTime() + resolucaoH*3600000);
    const limiteResposta = new Date(agora.getTime() + (resolucaoH/4)*3600000);

    const r = await query(`
      INSERT INTO itsm_ticket (
        empresa_id, numero, tipo, titulo, descricao, prioridade, impacto, urgencia,
        estado, sla_resolucao_h, data_limite_resolucao, data_limite_resposta,
        tags, campos_extra
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'aberto',$9,$10,$11,$12,$13)
      RETURNING id, numero
    `, [
      empresa.id, numero, tipo||'request', titulo, descricao||'',
      prioridade||'media', impacto||'individual', urgencia||'normal',
      resolucaoH, limiteResolucao, limiteResposta,
      JSON.stringify(tags||[]),
      JSON.stringify({ ...campos_extra, nome_contacto, email_contacto, via_portal: true })
    ]);

    const ticket = r.rows[0];

    // Comentário automático
    await query(`INSERT INTO itsm_comentario (ticket_id, tipo, conteudo, "visivelParaCliente") VALUES ($1,'sistema',$2,true)`,
      [ticket.id, `Ticket submetido via Portal de Suporte por ${nome_contacto} (${email_contacto})`]);

    // Notificar equipa
    await query(`INSERT INTO notificacao (utilizador_id, titulo, mensagem, tipo, url_accao)
      SELECT id, $1, $2, 'info', '/itsm' FROM utilizador WHERE empresa_id=$3 AND perfil IN ('admin_empresa','rh') LIMIT 5`,
      [`🎫 Novo ticket portal: ${numero}`, `${nome_contacto}: ${titulo}`, empresa.id]).catch(()=>{});

    res.status(201).json({ id: ticket.id, numero: ticket.numero });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ver estado do ticket (público)
router.get('/estado', async (req, res) => {
  try {
    const { numero, email } = req.query;
    if (!numero) return res.status(400).json({ error: 'Número obrigatório' });

    const r = await query(`
      SELECT t.*, 
        (SELECT json_agg(json_build_object('conteudo',c.conteudo,'autor_nome',u.nome_completo,'criado_em',c.criado_em,'tipo',c.tipo)
          ORDER BY c.criado_em) 
         FROM itsm_comentario c LEFT JOIN utilizador u ON u.id=c.autor_id
         WHERE c.ticket_id=t.id AND c."visivelParaCliente"=true) as comentarios
      FROM itsm_ticket t
      WHERE t.numero=$1
    `, [numero.toUpperCase()]);

    if (!r.rows.length) return res.status(404).json({ error: 'Ticket não encontrado' });

    const ticket = r.rows[0];
    
    // Verificar email se fornecido (segurança básica)
    if (email) {
      const emailPortal = ticket.campos_extra?.email_contacto;
      if (emailPortal && emailPortal.toLowerCase() !== email.toLowerCase()) {
        return res.status(403).json({ error: 'Email não corresponde ao ticket' });
      }
    }

    // Retornar versão pública (sem dados sensíveis)
    res.json({
      id: ticket.id,
      numero: ticket.numero,
      titulo: ticket.titulo,
      estado: ticket.estado,
      tipo: ticket.tipo,
      prioridade: ticket.prioridade,
      data_limite_resolucao: ticket.data_limite_resolucao,
      resolucao: ticket.resolucao,
      satisfacao: ticket.satisfacao,
      criado_em: ticket.criado_em,
      resolvido_em: ticket.resolvido_em,
      comentarios: (ticket.comentarios||[]).filter(c => c.tipo !== 'nota_interna' && c.tipo !== 'sistema'),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
