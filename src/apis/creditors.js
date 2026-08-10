/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/creditors` — credores e fornecedores.
 */

import { cached, cacheKey, failure, listEndpoint, semNulos } from "./_helpers.js";

export const RECURSO = "/creditors";

export const ENDPOINTS = [
  "GET /creditors",
  "GET /creditors/{id}",
  "GET /creditors/{id}/bank-informations",
  "GET /creditors/{id}/pix-keys",
];

const LIMIT_MAXIMO = 200;
const TTL_CACHE = 300;

/**
 * GET /creditors — lista credores.
 *
 * `creditor` busca por nome, nome fantasia ou código — e é filtrada no
 * servidor, o que torna a ausência de resultado conclusiva. É a única entidade
 * do Sienge com busca textual de verdade.
 */
export async function buscarCredores(makeRequest, deps = {}, opts = {}) {
  const { cacheGet, cacheSet, fetchAllPaginated } = deps;
  const {
    limit = 50,
    offset = 0,
    creditor = null,
    cpf = null,
    cnpj = null,
    fetch_all = false,
    max_records = null,
  } = opts;

  const params = {
    limit: Math.min(Number(limit || 50), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({ creditor, cpf, cnpj }),
  };

  if (fetch_all && fetchAllPaginated) {
    const itens = await fetchAllPaginated({
      endpoint: RECURSO,
      params,
      pageSize: LIMIT_MAXIMO,
      maxRecords: max_records,
    });
    if (!Array.isArray(itens)) return failure(itens, "❌ Erro ao varrer credores");
    return {
      success: true,
      message: `✅ ${itens.length} credor(es) (varredura completa)`,
      creditors: itens,
      count: itens.length,
    };
  }

  const carregar = () =>
    listEndpoint(makeRequest, RECURSO, params, {
      itemsKey: "creditors",
      okMessage: "✅ {count} credor(es) (total: {total})",
      errorMessage: "❌ Erro ao buscar credores",
      extra: () => ({ filters_applied: params }),
    });

  if (cacheGet && cacheSet) {
    return cached(cacheGet, cacheSet, cacheKey("creditors", params), TTL_CACHE, carregar);
  }
  return carregar();
}

/** GET /creditors/{id} — dados completos de um credor. */
export async function buscarCredor(makeRequest, creditorId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${encodeURIComponent(creditorId)}`);
  if (!resposta.success) return failure(resposta, `❌ Erro ao buscar o credor ${creditorId}`);
  return { success: true, creditor: resposta.data };
}
