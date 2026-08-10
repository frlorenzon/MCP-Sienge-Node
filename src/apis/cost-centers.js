/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/cost-centers` — centros de custo.
 *
 * No Sienge, o `buildingId` de um pedido de compra aponta para um centro de
 * custo: é daqui que sai o nome da obra.
 */

import { failure, listEndpoint } from "./_helpers.js";

export const RECURSO = "/cost-centers";

export const ENDPOINTS = [
  "GET /cost-centers",
  "GET /cost-centers/{id}",
  "GET /cost-centers/{id}/available",
  "GET /cost-centers/immediate-register-settings",
];

const LIMIT_MAXIMO = 200;

/** GET /cost-centers — lista centros de custo. */
export async function buscarCentrosDeCusto(makeRequest, opts = {}) {
  const { limit = 200, offset = 0 } = opts;
  return listEndpoint(
    makeRequest,
    RECURSO,
    {
      limit: Math.min(Number(limit || 200), LIMIT_MAXIMO),
      offset: Math.max(Number(offset || 0), 0),
    },
    {
      itemsKey: "costCenters",
      okMessage: "✅ {count} centro(s) de custo (total: {total})",
      errorMessage: "❌ Erro ao buscar centros de custo",
    }
  );
}

/** GET /cost-centers/{id} — dados de um centro de custo. */
export async function buscarCentroDeCusto(makeRequest, costCenterId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${encodeURIComponent(costCenterId)}`);
  if (!resposta.success) {
    return failure(resposta, `❌ Erro ao buscar o centro de custo ${costCenterId}`);
  }
  return { success: true, costCenter: resposta.data };
}
