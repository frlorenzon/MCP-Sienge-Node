/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * cost-center-v1 — Centro de Custos.
 *
 * Tradução de `sienge_mcp/api/cost_centers.py`. Cobre os 4 endpoints da API.
 * Note que GET /cost-centers/immediate-register-settings recebe
 * `costCenterId` como parâmetro de QUERY, não de caminho — é a única rota da
 * API com essa forma.
 */

import { makeRequest } from "../client/siengeClient.js";

const RECURSO = "/cost-centers";
const LIMIT_MAXIMO = 200;

/**
 * Mensagem já vem pronta (com ❌ incluso) de quem chama — diferente de
 * `falha()` em `purchase-orders-v1.js`, que prefixa o ❌ sozinha. As duas
 * seguem o que cada arquivo Python de origem fazia.
 */
function falha(resposta, mensagem) {
  return {
    success: false,
    message: mensagem,
    error: resposta.error,
    details: resposta.message,
    status_code: resposta.status_code,
  };
}

/** GET /cost-centers — lista os centros de custo, em ordem de código. */
export async function buscarCentrosDeCusto({ limit = 100, offset = 0 } = {}) {
  const params = {
    limit: Math.min(Number(limit || 100), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
  };

  const resposta = await makeRequest("GET", RECURSO, { params });
  if (!resposta.success) {
    return falha(resposta, "❌ Erro ao buscar centros de custo");
  }

  const dados = resposta.data ?? {};
  const itens = dados.results ?? [];
  const meta = dados.resultSetMetadata ?? {};
  const total = meta.count ?? itens.length;

  return {
    success: true,
    message: `✅ ${itens.length} centro(s) de custo (total: ${total})`,
    cost_centers: itens,
    count: itens.length,
    total,
    offset: meta.offset ?? 0,
    limit: meta.limit,
    total_count: total,
  };
}

/** GET /cost-centers/{costCenterId} — dados de um centro de custo. */
export async function buscarCentroDeCusto(costCenterId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${costCenterId}`);
  if (!resposta.success) {
    return falha(resposta, `❌ Erro ao buscar o centro de custo ${costCenterId}`);
  }
  return { success: true, costCenter: resposta.data };
}

/** GET /cost-centers/{costCenterId}/available — se o centro de custo está disponível. */
export async function verificarDisponibilidade(costCenterId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${costCenterId}/available`);
  if (!resposta.success) {
    return falha(
      resposta,
      `❌ Erro ao verificar disponibilidade do centro de custo ${costCenterId}`
    );
  }
  return { success: true, costCenterId, available: resposta.data };
}

/**
 * GET /cost-centers/immediate-register-settings — parâmetros de cadastro
 * imediato. `costCenterId` vai na query, não no caminho.
 */
export async function buscarConfigDeCadastroImediato(costCenterId) {
  const resposta = await makeRequest("GET", `${RECURSO}/immediate-register-settings`, {
    params: { costCenterId },
  });
  if (!resposta.success) {
    return falha(
      resposta,
      `❌ Erro ao buscar as configurações do centro de custo ${costCenterId}`
    );
  }
  return { success: true, costCenterId, settings: resposta.data };
}
