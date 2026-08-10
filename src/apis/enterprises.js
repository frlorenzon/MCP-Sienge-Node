/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/enterprises` — empreendimentos e obras.
 */

import { listEndpoint, semNulos } from "./_helpers.js";

export const RECURSO = "/enterprises";

export const ENDPOINTS = [
  "GET /enterprises",
  "GET /enterprises/{id}",
  "GET /enterprises/{id}/groupings",
];

const LIMIT_MAXIMO = 200;

/** 1=Obra, 2=Centro de custo, 3=Obra e centro de custo, 4=Aglutinador. */
export const TIPOS = [1, 2, 3, 4];
export const REGISTRO_DE_RECEBIVEIS = ["B3", "CERC"];

/** GET /enterprises — lista empreendimentos e obras. */
export async function buscarEmpreendimentos(makeRequest, opts = {}) {
  const {
    limit = 100,
    offset = 0,
    company_id = null,
    tipo = null,
    receivable_register = null,
    only_buildings_enabled_for_integration = null,
  } = opts;

  if (tipo !== null && tipo !== undefined && !TIPOS.includes(tipo)) {
    throw new Error(`tipo deve ser um de ${TIPOS.join(", ")} — recebido ${JSON.stringify(tipo)}`);
  }
  if (
    receivable_register !== null &&
    receivable_register !== undefined &&
    !REGISTRO_DE_RECEBIVEIS.includes(receivable_register)
  ) {
    throw new Error(
      `receivable_register deve ser ${REGISTRO_DE_RECEBIVEIS.join(" ou ")} — ` +
        `recebido ${JSON.stringify(receivable_register)}`
    );
  }

  const params = {
    limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({
      companyId: company_id,
      type: tipo,
      receivableRegister: receivable_register,
      onlyBuildingsEnabledForIntegration: only_buildings_enabled_for_integration,
    }),
  };

  return listEndpoint(makeRequest, RECURSO, params, {
    itemsKey: "enterprises",
    okMessage: "✅ {count} empreendimento(s) (total: {total})",
    errorMessage: "❌ Erro ao buscar empreendimentos",
  });
}
