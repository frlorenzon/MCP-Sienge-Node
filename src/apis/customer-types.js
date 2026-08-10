/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/customer-types` — tipos de cliente.
 *
 * É o endpoint mais barato da API, e por isso `test_sienge_connection` o usa
 * como sonda: confirma credencial sem trazer volume.
 */

import { listEndpoint } from "./_helpers.js";

export const RECURSO = "/customer-types";

export const ENDPOINTS = ["GET /customer-types"];

const LIMIT_MAXIMO = 200;

/** GET /customer-types — lista os tipos de cliente. */
export async function buscarTiposDeCliente(makeRequest, opts = {}) {
  const { limit = 100, offset = 0 } = opts;
  return listEndpoint(
    makeRequest,
    RECURSO,
    {
      limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
      offset: Math.max(Number(offset || 0), 0),
    },
    {
      itemsKey: "customerTypes",
      okMessage: "✅ {count} tipo(s) de cliente (total: {total})",
      errorMessage: "❌ Erro ao buscar tipos de cliente",
    }
  );
}
