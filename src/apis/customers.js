/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/customers` — clientes.
 */

import { cached, cacheKey, failure, listEndpoint, semNulos } from "./_helpers.js";

export const RECURSO = "/customers";

export const NOTA =
  "Não há busca por nome: a API filtra apenas por cpf, cnpj e datas. Para achar " +
  "um cliente pelo nome, pagine ou use o documento.";

export const ENDPOINTS = [
  "GET /customers",
  "GET /customers/{id}",
  "GET /customers/{id}/attachments",
  "GET /customers/{id}/attachments/{attachmentId}",
];

const LIMIT_MAXIMO = 200;
const TTL_CACHE = 300;

/**
 * GET /customers — lista clientes.
 *
 * ⚠️ Sem busca por nome: a API aceita apenas documento e datas. Filtro textual
 * precisa ser feito no cliente, sobre a página lida — ver `filtrarPorNome`.
 * `modified_after`/`modified_before` servem a sincronizações incrementais, que
 * leem bem menos que uma varredura completa.
 */
export async function buscarClientes(makeRequest, deps = {}, opts = {}) {
  const { cacheGet, cacheSet, fetchAllPaginated } = deps;
  const {
    limit = 50,
    offset = 0,
    cpf = null,
    cnpj = null,
    international_id = null,
    only_active = null,
    enterprise_id = null,
    created_after = null,
    created_before = null,
    modified_after = null,
    modified_before = null,
    fetch_all = false,
    max_records = null,
  } = opts;

  const params = {
    limit: Math.min(Number(limit || 50), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({
      cpf,
      cnpj,
      internationalId: international_id,
      onlyActive: only_active,
      enterpriseId: enterprise_id,
      createdAfter: created_after,
      createdBefore: created_before,
      modifiedAfter: modified_after,
      modifiedBefore: modified_before,
    }),
  };

  if (fetch_all && fetchAllPaginated) {
    const itens = await fetchAllPaginated({
      endpoint: RECURSO,
      params,
      pageSize: LIMIT_MAXIMO,
      maxRecords: max_records,
    });
    if (!Array.isArray(itens)) return failure(itens, "❌ Erro ao varrer clientes");
    return {
      success: true,
      message: `✅ ${itens.length} cliente(s) (varredura completa)`,
      customers: itens,
      count: itens.length,
    };
  }

  const carregar = () =>
    listEndpoint(makeRequest, RECURSO, params, {
      itemsKey: "customers",
      okMessage: "✅ {count} cliente(s) (total: {total})",
      errorMessage: "❌ Erro ao buscar clientes",
      extra: () => ({ filters_applied: params }),
    });

  if (cacheGet && cacheSet) {
    return cached(cacheGet, cacheSet, cacheKey("customers", params), TTL_CACHE, carregar);
  }
  return carregar();
}

/** Filtro por nome aplicado no cliente — a API não oferece busca textual. */
export function filtrarPorNome(clientes, termo) {
  const alvo = (termo || "").toLowerCase();
  if (!alvo) return clientes;
  return clientes.filter((c) =>
    [c.name, c.tradeName, c.corporateName, c.id].some((campo) =>
      String(campo ?? "").toLowerCase().includes(alvo)
    )
  );
}
