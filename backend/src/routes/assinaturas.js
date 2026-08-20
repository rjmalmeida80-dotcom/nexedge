'use strict';
const router = require('express').Router();
const { autenticar, autorizar } = require('../middleware/auth');
const { query } = require('../config/database');
const crypto = require('crypto');
const email = require('../services/emailService');

const GESTORES = ['admin_empresa','rh','diretor'];

// ── Gerar hash do documento ───────────────────────────────────────────────────
function gerarHash(conteudo) {
  return crypto.createHash('sha256').update(conteudo || '').digest('hex');
}

// ═══════════════════════════════════════════════════════════════════
// DOCUMENTOS
// ═══════════════════════════════════════════════════════════════════
router.get('/', autenticar, async (req, res) => {
  try {
    const { rows } = await query(`
      SELECT d.*,
        COUNT(DISTINCT s.id) AS total_signatarios,
        COUNT(DISTINCT CASE WHEN s.estado='assinado' THEN s.id END) AS total_assinados,
        u.nome_completo AS criado_por_nome
      FROM documento_assinatura d
      LEFT JOIN assinatura_signatario s ON s.documento_id = d.id
      LEFT JOIN utilizador u ON u.id = d.criado_por
      WHERE d.empresa_id=$1
      GROUP BY d.id, u.nome_completo
      ORDER BY d.criado_em DESC
    `, [req.empresaId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', autenticar, async (req, res) => {
  try {
    const { rows:[doc] } = await query(
      'SELECT * FROM documento_assinatura WHERE id=$1 AND empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });

    const { rows: signatarios } = await query(
      'SELECT * FROM assinatura_signatario WHERE documento_id=$1 ORDER BY ordem',
      [req.params.id]
    );
    const { rows: logs } = await query(
      'SELECT * FROM assinatura_log WHERE documento_id=$1 ORDER BY criado_em DESC LIMIT 20',
      [req.params.id]
    );

    res.json({ ...doc, signatarios, logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Criar documento ───────────────────────────────────────────────────────────
router.post('/', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { titulo, descricao, tipo, conteudo_html, data_expiracao } = req.body;
    if (!titulo) return res.status(400).json({ error: 'Título obrigatório' });

    const hash = gerarHash(conteudo_html || titulo);
    const { rows:[doc] } = await query(`
      INSERT INTO documento_assinatura
        (empresa_id, titulo, descricao, tipo, conteudo_html, hash_documento, data_expiracao, criado_por)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.empresaId, titulo, descricao||null, tipo||'contrato', conteudo_html||null, hash, data_expiracao||null, req.utilizador.id]);

    await query(`INSERT INTO assinatura_log (documento_id, accao, detalhe) VALUES ($1,'criado','Documento criado')`, [doc.id]).catch(()=>{});
    res.status(201).json(doc);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Editar documento (só rascunho) ────────────────────────────────────────────
router.patch('/:id', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { titulo, descricao, conteudo_html, data_expiracao } = req.body;
    const { rows:[doc] } = await query(
      "SELECT estado FROM documento_assinatura WHERE id=$1 AND empresa_id=$2",
      [req.params.id, req.empresaId]
    );
    if (!doc) return res.status(404).json({ error: 'Não encontrado' });
    if (doc.estado !== 'rascunho') return res.status(400).json({ error: 'Só documentos em rascunho podem ser editados' });

    const hash = conteudo_html ? gerarHash(conteudo_html) : undefined;
    const { rows:[updated] } = await query(`
      UPDATE documento_assinatura SET
        titulo=COALESCE($1,titulo), descricao=COALESCE($2,descricao),
        conteudo_html=COALESCE($3,conteudo_html),
        hash_documento=COALESCE($4,hash_documento),
        data_expiracao=COALESCE($5,data_expiracao),
        actualizado_em=NOW()
      WHERE id=$6 AND empresa_id=$7 RETURNING *
    `, [titulo, descricao, conteudo_html||null, hash||null, data_expiracao||null, req.params.id, req.empresaId]);
    res.json(updated);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Adicionar signatário ──────────────────────────────────────────────────────
router.post('/:id/signatarios', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { nome, email: emailSig, nif, cargo, ordem } = req.body;
    if (!nome || !emailSig) return res.status(400).json({ error: 'Nome e email obrigatórios' });

    const token = crypto.randomUUID();
    const { rows:[sig] } = await query(`
      INSERT INTO assinatura_signatario
        (documento_id, empresa_id, nome, email, nif, cargo, ordem, token_assinatura)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.id, req.empresaId, nome, emailSig, nif||null, cargo||null, ordem||1, token]);

    res.status(201).json(sig);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Enviar documento para assinatura ─────────────────────────────────────────
router.post('/:id/enviar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    const { rows:[doc] } = await query(
      'SELECT d.*, e.nome AS empresa_nome FROM documento_assinatura d JOIN empresa e ON e.id=d.empresa_id WHERE d.id=$1 AND d.empresa_id=$2',
      [req.params.id, req.empresaId]
    );
    if (!doc) return res.status(404).json({ error: 'Documento não encontrado' });

    const { rows: signatarios } = await query(
      "SELECT * FROM assinatura_signatario WHERE documento_id=$1 AND estado='pendente'",
      [req.params.id]
    );
    if (!signatarios.length) return res.status(400).json({ error: 'Adicione pelo menos um signatário' });

    // Actualizar estado
    await query(
      "UPDATE documento_assinatura SET estado='enviado', actualizado_em=NOW() WHERE id=$1",
      [req.params.id]
    );

    // Enviar email a cada signatário
    let enviados = 0;
    for (const sig of signatarios) {
      try {
        const linkAssinatura = `${process.env.FRONTEND_URL || 'https://app.nexedge.pt'}/assinar/${sig.token_assinatura}`;
        await email.enviar({
          remetente: 'suporte',
          para: sig.email,
          assunto: `✍️ Documento para assinar — ${doc.titulo} | ${doc.empresa_nome}`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
              <div style="background:linear-gradient(135deg,#4F46E5,#8B5CF6);padding:32px;text-align:center;border-radius:12px 12px 0 0">
                <h1 style="color:#fff;margin:0;font-size:24px">⚡ NexEdge</h1>
              </div>
              <div style="background:#fff;padding:32px;border:1px solid #E5E7EB;border-radius:0 0 12px 12px">
                <h2 style="color:#1E1B4B">Documento para assinar</h2>
                <p>Olá <strong>${sig.nome}</strong>,</p>
                <p><strong>${doc.empresa_nome}</strong> enviou-lhe o documento <strong>"${doc.titulo}"</strong> para assinar digitalmente.</p>
                ${doc.data_expiracao ? `<p style="color:#D97706">⚠️ Este documento expira em ${new Date(doc.data_expiracao).toLocaleDateString('pt-PT')}</p>` : ''}
                <div style="text-align:center;margin:32px 0">
                  <a href="${linkAssinatura}" style="background:linear-gradient(135deg,#4F46E5,#7C3AED);color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px">
                    ✍️ Assinar Documento
                  </a>
                </div>
                <p style="color:#6B7280;font-size:13px">Se não conseguir clicar no botão, copie este link:<br>${linkAssinatura}</p>
                <hr style="border:none;border-top:1px solid #E5E7EB;margin:24px 0">
                <p style="color:#9CA3AF;font-size:12px">A sua assinatura tem valor legal nos termos do Regulamento eIDAS (UE) 910/2014.</p>
              </div>
            </div>
          `,
        });
        enviados++;
      } catch(e) { console.error(`❌ Email falhou para ${sig.email}:`, e.message); }
    }

    await query(`INSERT INTO assinatura_log (documento_id, accao, detalhe) VALUES ($1,'enviado',$2)`,
      [req.params.id, `Enviado para ${enviados} signatário(s)`]).catch(()=>{});

    res.json({ message: `Documento enviado para ${enviados} signatário(s)`, enviados });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// ASSINATURA (PÚBLICO — acesso via token)
// ═══════════════════════════════════════════════════════════════════

// Ver documento para assinar
router.get('/assinar/:token', async (req, res) => {
  try {
    const { rows:[sig] } = await query(
      "SELECT s.*, d.titulo, d.descricao, d.conteudo_html, d.hash_documento, d.data_expiracao, e.nome AS empresa_nome FROM assinatura_signatario s JOIN documento_assinatura d ON d.id=s.documento_id JOIN empresa e ON e.id=d.empresa_id WHERE s.token_assinatura=$1",
      [req.params.token]
    );
    if (!sig) return res.status(404).json({ error: 'Link de assinatura inválido' });
    if (sig.estado === 'assinado') return res.status(400).json({ error: 'Este documento já foi assinado', assinado: true });
    if (sig.data_expiracao && new Date(sig.data_expiracao) < new Date()) {
      return res.status(400).json({ error: 'Este link de assinatura expirou' });
    }

    // Marcar como visualizado
    if (sig.estado === 'pendente') {
      await query("UPDATE assinatura_signatario SET estado='visualizado' WHERE token_assinatura=$1", [req.params.token]);
      await query("INSERT INTO assinatura_log (documento_id, signatario_id, accao, ip) VALUES ($1,$2,'visualizado',$3)",
        [sig.documento_id, sig.id, req.ip]).catch(()=>{});
    }

    res.json({
      documento: { titulo:sig.titulo, descricao:sig.descricao, conteudo_html:sig.conteudo_html, hash:sig.hash_documento, empresa_nome:sig.empresa_nome },
      signatario: { nome:sig.nome, email:sig.email, cargo:sig.cargo, estado:sig.estado },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Assinar documento
router.post('/assinar/:token', async (req, res) => {
  try {
    const { assinatura_data, aceite_termos } = req.body;
    if (!aceite_termos) return res.status(400).json({ error: 'Deve aceitar os termos para assinar' });

    const { rows:[sig] } = await query(
      "SELECT s.*, d.empresa_id, d.titulo FROM assinatura_signatario s JOIN documento_assinatura d ON d.id=s.documento_id WHERE s.token_assinatura=$1 AND s.estado IN ('pendente','visualizado')",
      [req.params.token]
    );
    if (!sig) return res.status(404).json({ error: 'Link inválido ou documento já assinado' });

    // Registar assinatura
    await query(`
      UPDATE assinatura_signatario SET
        estado='assinado', assinado_em=NOW(),
        ip_assinatura=$1, user_agent=$2,
        assinatura_data=$3
      WHERE token_assinatura=$4
    `, [req.ip, req.headers['user-agent']?.substring(0,500)||null, assinatura_data||null, req.params.token]);

    // Log
    await query("INSERT INTO assinatura_log (documento_id, signatario_id, accao, ip, detalhe) VALUES ($1,$2,'assinado',$3,$4)",
      [sig.documento_id, sig.id, req.ip, `Assinado por ${sig.nome} (${sig.email})`]).catch(()=>{});

    // Verificar se todos assinaram
    const { rows:[contagem] } = await query(
      "SELECT COUNT(*) AS total, COUNT(CASE WHEN estado='assinado' THEN 1 END) AS assinados FROM assinatura_signatario WHERE documento_id=$1",
      [sig.documento_id]
    );

    if (parseInt(contagem.assinados) === parseInt(contagem.total)) {
      await query("UPDATE documento_assinatura SET estado='assinado', actualizado_em=NOW() WHERE id=$1", [sig.documento_id]);
      await query("INSERT INTO assinatura_log (documento_id, accao, detalhe) VALUES ($1,'concluido','Todos os signatários assinaram')", [sig.documento_id]).catch(()=>{});

      // Notificar criador
      const { rows:[criador] } = await query(
        "SELECT u.email, u.nome_completo, d.titulo FROM documento_assinatura d JOIN utilizador u ON u.id=d.criado_por WHERE d.id=$1",
        [sig.documento_id]
      );
      if (criador?.email) {
        await email.enviar({
          remetente: 'suporte',
          para: criador.email,
          assunto: `✅ Documento "${sig.titulo}" totalmente assinado!`,
          html: `<p>Olá <b>${criador.nome_completo}</b>,<br>O documento <b>${sig.titulo}</b> foi assinado por todos os signatários.</p><p><a href="${process.env.FRONTEND_URL||'https://app.nexedge.pt'}/assinaturas">Ver documento</a></p>`,
        }).catch(()=>{});
      }
    } else {
      await query("UPDATE documento_assinatura SET estado='parcialmente_assinado', actualizado_em=NOW() WHERE id=$1", [sig.documento_id]);
    }

    res.json({ message: 'Documento assinado com sucesso!', assinado_em: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Rejeitar documento
router.post('/rejeitar/:token', async (req, res) => {
  try {
    const { motivo } = req.body;
    const { rows:[sig] } = await query(
      "SELECT * FROM assinatura_signatario WHERE token_assinatura=$1 AND estado IN ('pendente','visualizado')",
      [req.params.token]
    );
    if (!sig) return res.status(404).json({ error: 'Link inválido' });

    await query(
      "UPDATE assinatura_signatario SET estado='rejeitado', rejeitado_em=NOW(), motivo_rejeicao=$1 WHERE token_assinatura=$2",
      [motivo||null, req.params.token]
    );
    await query("UPDATE documento_assinatura SET estado='cancelado', actualizado_em=NOW() WHERE id=$1", [sig.documento_id]);
    await query("INSERT INTO assinatura_log (documento_id, signatario_id, accao, detalhe) VALUES ($1,$2,'rejeitado',$3)",
      [sig.documento_id, sig.id, `Rejeitado por ${sig.nome}: ${motivo||'sem motivo'}`]).catch(()=>{});

    res.json({ message: 'Documento rejeitado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cancelar documento
router.patch('/:id/cancelar', autenticar, autorizar(...GESTORES), async (req, res) => {
  try {
    await query(
      "UPDATE documento_assinatura SET estado='cancelado', actualizado_em=NOW() WHERE id=$1 AND empresa_id=$2",
      [req.params.id, req.empresaId]
    );
    res.json({ message: 'Documento cancelado' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
