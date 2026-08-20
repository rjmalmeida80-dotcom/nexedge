'use strict';
const https = require('https');
const { parseStringPromise } = require('xml2js');
const { query } = require('../config/database');

// ── Configuração AT ───────────────────────────────────────────────────────────
const AT_CONFIG = {
  // Credenciais AT (definidas no .env)
  contribuinte: process.env.AT_NIF || '',
  password: process.env.AT_PASSWORD || '',
  // URLs dos webservices AT
  urls: {
    series:     'https://servicos.portaldasfinancas.gov.pt:722/SeriesWSService',
    faturas:    'https://servicos.portaldasfinancas.gov.pt:401/faturas',
    validarNif: 'https://servicos.portaldasfinancas.gov.pt:700/ValidacaoNIFWSService',
    saft:       'https://servicos.portaldasfinancas.gov.pt:443/RecepcionarDocumentos',
  },
  // URLs de teste (sandbox)
  urlsTeste: {
    series:     'https://servicos.portaldasfinancas.gov.pt:722/SeriesWSServiceSandbox',
    faturas:    'https://servicos.portaldasfinancas.gov.pt:401/faturasSandbox',
    validarNif: 'https://servicos.portaldasfinancas.gov.pt:700/ValidacaoNIFWSServiceSandbox',
  },
};

const MODO_TESTE = process.env.AT_MODO_TESTE !== 'false';

function getUrl(tipo) {
  return MODO_TESTE ? AT_CONFIG.urlsTeste[tipo] : AT_CONFIG.urls[tipo];
}

// ── Helper SOAP ───────────────────────────────────────────────────────────────
async function chamarSOAP(url, soapAction, body) {
  return new Promise((resolve, reject) => {
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:at="http://at.gov.pt/">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(envelope),
      },
      rejectUnauthorized: false, // AT usa certificados próprios
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(envelope);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VALIDAÇÃO DE NIF
// ═══════════════════════════════════════════════════════════════════════════════
async function validarNIF(nif, empresaId) {
  // Validação local primeiro (regras portuguesas)
  const nifLimpo = nif?.replace(/\D/g, '') || '';
  if (nifLimpo.length !== 9) return { valido: false, erro: 'NIF deve ter 9 dígitos' };

  // Verificar dígito de controlo
  const pesos = [9,8,7,6,5,4,3,2];
  const soma = pesos.reduce((acc, p, i) => acc + p * parseInt(nifLimpo[i]), 0);
  const resto = soma % 11;
  const digitoControlo = resto < 2 ? 0 : 11 - resto;
  const valido = digitoControlo === parseInt(nifLimpo[8]);

  // Determinar tipo de contribuinte
  const primeiro = parseInt(nifLimpo[0]);
  const tipo = {
    1: 'Pessoa Singular', 2: 'Pessoa Singular', 3: 'Pessoa Singular',
    5: 'Pessoa Colectiva', 6: 'Administração Pública',
    7: 'Herança Indivisa / Pessoa Colectiva', 8: 'Pessoa Colectiva',
    9: 'Pessoa Colectiva (NIPC)',
  }[primeiro] || 'Desconhecido';

  if (!valido) return { valido: false, erro: 'NIF inválido — dígito de controlo incorrecto', nif: nifLimpo };

  // Se credenciais AT disponíveis, validar também online
  if (AT_CONFIG.contribuinte && AT_CONFIG.password) {
    try {
      const body = `
        <at:ValidarNIF>
          <at:nif>${nifLimpo}</at:nif>
          <at:nifRequint>${AT_CONFIG.contribuinte}</at:nifRequint>
          <at:password>${AT_CONFIG.password}</at:password>
        </at:ValidarNIF>`;
      const xml = await chamarSOAP(getUrl('validarNif'), 'ValidarNIF', body);
      const parsed = await parseStringPromise(xml);
      const resultado = parsed?.['soap:Envelope']?.['soap:Body']?.[0]?.['ValidarNIFResponse']?.[0];
      return {
        valido: true,
        validadoAT: resultado?.resultado?.[0] === 'valid',
        tipo,
        nif: nifLimpo,
      };
    } catch(_) {
      // Se AT falhar, retorna validação local
    }
  }

  return { valido: true, tipo, nif: nifLimpo, validadoAT: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. COMUNICAÇÃO DE SÉRIES À AT
// ═══════════════════════════════════════════════════════════════════════════════
async function comunicarSerie(empresaId, { tipodoc, serie, iniciador }) {
  if (!AT_CONFIG.contribuinte || !AT_CONFIG.password) {
    console.log(`📋 [AT SIMULADO] Comunicar série ${serie} tipo ${tipodoc}`);
    return { simulado: true, atcud: `SIMULADO-${serie}` };
  }

  const body = `
    <at:registarSerieDocumentos>
      <at:serie>${serie}</at:serie>
      <at:tipoSerie>N</at:tipoSerie>
      <at:classeDoc>SI</at:classeDoc>
      <at:tipoDoc>${tipodoc}</at:tipoDoc>
      <at:numInicialSeq>${iniciador || 1}</at:numInicialSeq>
      <at:dataInicioPrev>${new Date().toISOString().split('T')[0]}</at:dataInicioPrev>
      <at:nifComunicante>${AT_CONFIG.contribuinte}</at:nifComunicante>
      <at:nifOperadorEmi>${AT_CONFIG.contribuinte}</at:nifOperadorEmi>
    </at:registarSerieDocumentos>`;

  const xml = await chamarSOAP(getUrl('series'), 'registarSerieDocumentos', body);
  const parsed = await parseStringPromise(xml);
  const resp = parsed?.['soap:Envelope']?.['soap:Body']?.[0];

  if (resp?.['soap:Fault']) {
    throw new Error(resp['soap:Fault'][0]?.faultstring?.[0] || 'Erro AT');
  }

  const codigoValidacao = resp?.['ns2:registarSerieDocumentosResponse']?.[0]?.['ns2:codigoValidacaoSerie']?.[0];

  // Guardar na BD
  await query(`
    UPDATE serie_faturacao SET
      codigo_validacao_at = $1,
      comunicada_at = true,
      comunicada_at_em = NOW()
    WHERE empresa_id=$2 AND tipo_doc=$3 AND serie=$4
  `, [codigoValidacao, empresaId, tipodoc, serie]).catch(()=>{});

  return { sucesso: true, codigoValidacao, atcud: codigoValidacao };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CONSULTAR SÉRIES COMUNICADAS
// ═══════════════════════════════════════════════════════════════════════════════
async function consultarSeries(empresaId, tipodoc) {
  if (!AT_CONFIG.contribuinte || !AT_CONFIG.password) {
    return { simulado: true, series: [] };
  }

  const body = `
    <at:consultarSeriesDocumentos>
      <at:tipoDoc>${tipodoc || 'FT'}</at:tipoDoc>
      <at:nifComunicante>${AT_CONFIG.contribuinte}</at:nifComunicante>
    </at:consultarSeriesDocumentos>`;

  const xml = await chamarSOAP(getUrl('series'), 'consultarSeriesDocumentos', body);
  const parsed = await parseStringPromise(xml);
  return parsed;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SUBMISSÃO SAF-T MENSAL AUTOMÁTICA
// ═══════════════════════════════════════════════════════════════════════════════
async function submeterSAFT(empresaId, tipoSAFT, ano, mes) {
  try {
    // Buscar dados da empresa
    const { rows:[emp] } = await query('SELECT * FROM empresa WHERE id=$1', [empresaId]);
    if (!emp) throw new Error('Empresa não encontrada');

    if (!AT_CONFIG.contribuinte || !AT_CONFIG.password) {
      console.log(`📋 [AT SIMULADO] Submeter SAF-T ${tipoSAFT} ${mes}/${ano} para ${emp.nome}`);
      // Registar tentativa
      await query(`
        INSERT INTO at_submissao (empresa_id, tipo, ano, mes, estado, simulado)
        VALUES ($1,$2,$3,$4,'simulado',true)
        ON CONFLICT (empresa_id, tipo, ano, mes) DO UPDATE SET estado='simulado', tentativas=at_submissao.tentativas+1
      `, [empresaId, tipoSAFT, ano, mes]).catch(()=>{});
      return { simulado: true };
    }

    // Em produção: chamar endpoint de geração SAF-T e submeter
    // Por agora registar como pendente para submissão manual
    await query(`
      INSERT INTO at_submissao (empresa_id, tipo, ano, mes, estado)
      VALUES ($1,$2,$3,$4,'pendente')
      ON CONFLICT (empresa_id, tipo, ano, mes) DO UPDATE SET estado='pendente'
    `, [empresaId, tipoSAFT, ano, mes]).catch(()=>{});

    return { pendente: true, mensagem: `SAF-T ${tipoSAFT} ${mes}/${ano} marcado para submissão` };
  } catch(e) {
    console.error('❌ submeterSAFT:', e.message);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. COMUNICAÇÃO AUTOMÁTICA DE FATURAS (SIGTAS)
// ═══════════════════════════════════════════════════════════════════════════════
async function comunicarFatura(fatura, empresa) {
  if (!AT_CONFIG.contribuinte || !AT_CONFIG.password) {
    console.log(`📋 [AT SIMULADO] Comunicar fatura ${fatura.numero_completo}`);
    return { simulado: true };
  }

  const body = `
    <at:registarDocumentoConferencia>
      <at:nifEmitente>${empresa.nif}</at:nifEmitente>
      <at:nifAdquirente>${fatura.cliente_nif || '999999990'}</at:nifAdquirente>
      <at:tipoDocumento>${fatura.tipo_doc || 'FT'}</at:tipoDocumento>
      <at:numeroDocumento>${fatura.numero_completo}</at:numeroDocumento>
      <at:dataEmissao>${fatura.data_emissao}</at:dataEmissao>
      <at:valorTotal>${fatura.total}</at:valorTotal>
      <at:valorIVA>${fatura.total_iva || 0}</at:valorIVA>
    </at:registarDocumentoConferencia>`;

  const xml = await chamarSOAP(getUrl('faturas'), 'registarDocumentoConferencia', body);
  const parsed = await parseStringPromise(xml);

  // Marcar fatura como comunicada
  await query(
    'UPDATE fatura SET comunicada_at=true, comunicada_at_em=NOW() WHERE id=$1',
    [fatura.id]
  ).catch(()=>{});

  return { sucesso: true, resposta: parsed };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 6. JOB AUTOMÁTICO — Comunicar faturas não comunicadas
// ═══════════════════════════════════════════════════════════════════════════════
async function jobComunicarFaturas() {
  try {
    const { rows } = await query(`
      SELECT f.*, e.nif AS empresa_nif, e.nome AS empresa_nome
      FROM fatura f
      JOIN empresa e ON e.id = f.empresa_id
      WHERE (f.comunicada_at IS NULL OR f.comunicada_at = false)
        AND f.estado != 'rascunho'
        AND f.data_emissao >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY f.data_emissao
      LIMIT 50
    `);

    let comunicadas = 0;
    for (const f of rows) {
      try {
        await comunicarFatura(f, { nif: f.empresa_nif, nome: f.empresa_nome });
        comunicadas++;
      } catch(e) {
        console.error(`❌ Erro ao comunicar fatura ${f.numero_completo}:`, e.message);
      }
    }
    console.log(`✅ jobComunicarFaturas: ${comunicadas}/${rows.length} comunicadas`);
  } catch(e) { console.error('❌ jobComunicarFaturas:', e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 7. JOB AUTOMÁTICO — Submeter SAF-T no dia 20 de cada mês
// ═══════════════════════════════════════════════════════════════════════════════
async function jobSubmeterSAFT() {
  try {
    const agora = new Date();
    const mes = agora.getMonth(); // mês anterior
    const ano = mes === 0 ? agora.getFullYear() - 1 : agora.getFullYear();
    const mesAnterior = mes === 0 ? 12 : mes;

    const { rows: empresas } = await query(
      "SELECT id FROM empresa WHERE ativo=true"
    );

    for (const emp of empresas) {
      await submeterSAFT(emp.id, 'faturacao', ano, mesAnterior);
    }
    console.log(`✅ jobSubmeterSAFT: ${empresas.length} empresas processadas`);
  } catch(e) { console.error('❌ jobSubmeterSAFT:', e.message); }
}

module.exports = {
  validarNIF,
  comunicarSerie,
  consultarSeries,
  submeterSAFT,
  comunicarFatura,
  jobComunicarFaturas,
  jobSubmeterSAFT,
};
