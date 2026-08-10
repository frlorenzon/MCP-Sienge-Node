/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/payment-categories` — planos financeiros.
 */

import { failure, listEndpoint } from "./_helpers.js";

export const RECURSO = "/payment-categories";

export const ENDPOINTS = ["GET /payment-categories", "GET /payment-categories/{id}"];

const LIMIT_MAXIMO = 200;

/** GET /payment-categories — lista os planos financeiros. */
export async function buscarPlanosFinanceiros(makeRequest, opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  return listEndpoint(
    makeRequest,
    RECURSO,
    {
      limit: Math.min(Number(limit || 200), LIMIT_MAXIMO),
      offset: Math.max(Number(offset || 0), 0),
    },
    {
      itemsKey: "paymentCategories",
      okMessage: "✅ {count} plano(s) financeiro(s) (total: {total})",
      errorMessage: "❌ Erro ao buscar planos financeiros",
    }
  );
}

/** GET /payment-categories/{id} — um plano financeiro. */
export async function buscarPlanoFinanceiro(makeRequest, id) {
  const resposta = await makeRequest("GET", `${RECURSO}/${encodeURIComponent(id)}`);
  if (!resposta.success) return failure(resposta, `❌ Erro ao buscar o plano financeiro ${id}`);
  return { success: true, paymentCategory: resposta.data };
}
