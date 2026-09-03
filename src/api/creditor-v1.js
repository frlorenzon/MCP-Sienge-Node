/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * creditor-v1 — Credores (fornecedores).
 *
 * Tradução de `sienge_mcp/api/creditors.py`.
 *
 * Diferente de clientes, esta API **tem** busca textual — pelo parâmetro
 * `creditor`, que procura em nome, nome fantasia ou código do credor. Como o
 * servidor faz a filtragem, "não encontrei" é conclusivo.
 *
 * `cnpj` aceita um único valor ou uma lista — uma lista resolve vários
 * credores numa chamada em vez de uma por CNPJ.
 *
 * NÃO TRADUZIDO: suporte a cache (`cache_get`/`cache_set`/`TTL_CACHE`) e
 * varredura completa paginada (`fetch_all`/`fetch_all_paginated`) do Python.
 * Nenhum dos dois existe no projeto Node ainda — `buscarCredores` funciona
 * sem eles, como no Python quando não são passados.
 */

import { makeRequest } from "../client/siengeClient.js";

const RECURSO = "/creditors";
const LIMIT_MAXIMO = 200;

/** Descarta chaves cujo valor é null/undefined/""/[] — filtro vazio não deve ir na query. */
function semNulos(campos) {
  const saida = {};
  for (const [chave, valor] of Object.entries(campos)) {
    const vazio = valor === null || valor === undefined || valor === "" || (Array.isArray(valor) && valor.length === 0);
    if (!vazio) saida[chave] = valor;
  }
  return saida;
}

/** Mensagem já vem pronta (com ❌ incluso) de quem chama — mesmo padrão de cost-center-v1.js. */
function falha(resposta, mensagem) {
  return {
    success: false,
    message: mensagem,
    error: resposta.error,
    details: resposta.message,
    status_code: resposta.status_code,
  };
}

/**
 * GET /creditors — lista credores.
 *
 * @param {object} [opcoes]
 * @param {number} [opcoes.limit]
 * @param {number} [opcoes.offset]
 * @param {string} [opcoes.creditor] busca por nome, nome fantasia ou código — filtrada no servidor
 * @param {string} [opcoes.cpf] CPF sem máscara, só números
 * @param {string|string[]} [opcoes.cnpj] um CNPJ ou uma lista deles, sem máscara
 */
export async function buscarCredores({ limit = 50, offset = 0, creditor, cpf, cnpj } = {}) {
  const params = {
    limit: Math.min(Number(limit || 50), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({ creditor, cpf, cnpj }),
  };

  const resposta = await makeRequest("GET", RECURSO, { params });
  if (!resposta.success) {
    return falha(resposta, "❌ Erro ao buscar credores");
  }

  const dados = resposta.data ?? {};
  const itens = dados.results ?? [];
  const meta = dados.resultSetMetadata ?? {};
  const total = meta.count ?? itens.length;

  return {
    success: true,
    message: `✅ ${itens.length} credor(es) (total: ${total})`,
    creditors: itens,
    count: itens.length,
    total,
    offset: meta.offset ?? 0,
    limit: meta.limit,
    filters_applied: params,
  };
}

/** GET /creditors/{creditorId} — dados completos de um credor. */
export async function buscarCredor(creditorId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${creditorId}`);
  if (!resposta.success) {
    return falha(resposta, `❌ Erro ao buscar o credor ${creditorId}`);
  }
  return { success: true, creditor: resposta.data };
}

/** GET /creditors/{creditorId}/bank-informations — contas bancárias do credor. */
export async function buscarDadosBancarios(creditorId, { limit = 100, offset = 0 } = {}) {
  const params = {
    limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/${creditorId}/bank-informations`, { params });
  if (!resposta.success) {
    return falha(resposta, `❌ Erro ao buscar dados bancários do credor ${creditorId}`);
  }

  const dados = resposta.data ?? {};
  const itens = dados.results ?? [];
  const meta = dados.resultSetMetadata ?? {};

  return {
    success: true,
    message: `✅ ${itens.length} conta(s) bancária(s)`,
    bankInformations: itens,
    count: itens.length,
    total: meta.count ?? itens.length,
    offset: meta.offset ?? 0,
    limit: meta.limit,
  };
}

/**
 * GET /creditors/{creditorId}/pix-informations — chaves Pix cadastradas do credor.
 *
 * Útil antes de definir Pix como forma de pagamento: confere se a chave
 * informada é a que está no cadastro do credor.
 */
export async function buscarChavesPix(creditorId, { limit = 100, offset = 0 } = {}) {
  const params = {
    limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/${creditorId}/pix-informations`, { params });
  if (!resposta.success) {
    return falha(resposta, `❌ Erro ao buscar chaves Pix do credor ${creditorId}`);
  }

  const dados = resposta.data ?? {};
  const itens = dados.results ?? [];
  const meta = dados.resultSetMetadata ?? {};

  return {
    success: true,
    message: `✅ ${itens.length} chave(s) Pix`,
    pixInformations: itens,
    count: itens.length,
    total: meta.count ?? itens.length,
    offset: meta.offset ?? 0,
    limit: meta.limit,
  };
}
