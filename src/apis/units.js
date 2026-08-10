/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/units` — unidades imobiliárias.
 */

import { failure, listEndpoint, semNulos } from "./_helpers.js";

export const RECURSO = "/units";

export const ENDPOINTS = [
  "GET /units",
  "GET /units/{id}",
  "GET /units/{id}/groupings",
  "GET /units/{id}/evaluations",
  "GET /units/characteristics",
  "GET /units/situations",
];

const LIMIT_MAXIMO = 200;

/** GET /units — lista unidades. */
export async function buscarUnidades(makeRequest, opts = {}) {
  const {
    limit = 100,
    offset = 0,
    enterprise_id = null,
    contract_id = null,
    additional_data = null,
  } = opts;

  const params = {
    limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({
      enterpriseId: enterprise_id,
      contractId: contract_id,
      additionalData: additional_data,
    }),
  };

  return listEndpoint(makeRequest, RECURSO, params, {
    itemsKey: "units",
    okMessage: "✅ {count} unidade(s) (total: {total})",
    errorMessage: "❌ Erro ao buscar unidades",
  });
}

/** GET /units/{id} — dados de uma unidade. */
export async function buscarUnidade(makeRequest, unitId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${encodeURIComponent(unitId)}`);
  if (!resposta.success) return failure(resposta, `❌ Erro ao buscar a unidade ${unitId}`);
  return { success: true, unit: resposta.data };
}
