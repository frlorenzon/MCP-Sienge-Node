/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * building-cost-estimations-v1 — Orçamento da Obra.
 *
 * Escrito a partir de `spec/openapi.yaml`, seção "Orçamento".
 *
 * Não é um recurso de compras, mas é a fonte dos códigos que uma SOLICITAÇÃO
 * de compra exige. Quem pede um insumo fala em nome — "tubo de esgoto",
 * "instalações hidráulicas" —, e o POST de item de solicitação quer números e
 * códigos. A tradução de um para o outro acontece toda aqui:
 *
 *   nome da unidade construtiva  → buildingUnitId              (sheets)
 *   nome do item de orçamento    → costEstimationItemReference (sheets/items → wbsCode)
 *   nome do insumo               → productId                   (resources)
 *   nome do detalhe do insumo    → detailId                    (resources → details[])
 *
 * ATENÇÃO ao nome do campo da apropriação: `costEstimationItemReference` do
 * corpo da solicitação é o `wbsCode` daqui — o código da posição do item na
 * EAP, tipo "01.001.000.001". NÃO é o `id` do item de orçamento, que é uma
 * string opaca ("a1b2c3") e serve a outra coisa.
 *
 * Nenhum destes endpoints tem busca textual: o spec só declara limit/offset
 * (e resourceGroups, em resources). Casar nome com código é trabalho de quem
 * chama, sobre a lista devolvida — ver `client/purchaseClient.js`.
 */

import { makeRequest } from "../client/siengeClient.js";

const LIMIT_PADRAO = 100;
const LIMIT_MAXIMO = 200;

const RECURSO = "/building-cost-estimations";

// =========================================================
// HELPERS
// =========================================================
// Mesmos helpers dos demais arquivos de api/, duplicados de propósito: cada
// um é uma tradução autocontida do seu recurso.

function paginacao(limit, offset) {
  return {
    limit: Math.min(Number(limit ?? LIMIT_PADRAO), LIMIT_MAXIMO),
    offset: Math.max(Number(offset ?? 0), 0),
  };
}

function falha(resposta, contexto) {
  return {
    success: false,
    message: `❌ ${contexto}`,
    error: resposta.error,
    details: resposta.message,
    status_code: resposta.status_code,
    // Vem do ErrorMessage do Sienge e diz QUAL campo foi recusado — sem isso,
    // um 400 chega ao usuário como "Bad Request" e ninguém sabe o que corrigir.
    ...(resposta.campos_invalidos ? { campos_invalidos: resposta.campos_invalidos } : {}),
    ...(resposta.client_message ? { client_message: resposta.client_message } : {}),
  };
}

/** Normaliza as respostas paginadas (resultSetMetadata + results) do spec. */
function lista(resposta, chave, contexto) {
  if (!resposta.success) return falha(resposta, contexto);

  const dados = resposta.data ?? {};
  const ehObjeto = dados && typeof dados === "object" && !Array.isArray(dados);
  const itens = ehObjeto ? (dados.results ?? []) : (dados ?? []);
  const meta = ehObjeto ? (dados.resultSetMetadata ?? {}) : {};

  return {
    success: true,
    [chave]: itens,
    count: itens.length,
    total: meta.count ?? itens.length,
    offset: meta.offset ?? 0,
    limit: meta.limit,
  };
}

// =========================================================
// PLANILHAS (UNIDADES CONSTRUTIVAS)
// =========================================================

/**
 * GET /building-cost-estimations/{buildingId}/sheets — planilhas do orçamento.
 *
 * Uma planilha por unidade construtiva. Cada SheetDTO traz `id` (que é o
 * `buildingUnitId` usado na apropriação), `description` e `status` — este
 * último indicando a situação operacional, com LOCKED entre os valores.
 */
export async function buscarPlanilhas(buildingId, { limit, offset } = {}) {
  const resposta = await makeRequest("GET", `${RECURSO}/${buildingId}/sheets`, {
    params: paginacao(limit, offset),
  });
  return lista(resposta, "sheets", `Erro ao consultar planilhas do orçamento da obra ${buildingId}`);
}

/**
 * GET /building-cost-estimations/{buildingId}/sheets/{buildingUnitId}/items —
 * itens da planilha orçamentária de uma unidade construtiva.
 *
 * É a lista de onde sai a apropriação: o `wbsCode` de cada item é o
 * `costEstimationItemReference` que o item de solicitação pede, e a
 * `description` ("Instalações Hidráulicas", "Canteiro de Obras") é o texto
 * pelo qual uma pessoa se refere a ele.
 *
 * Uma planilha de obra real tem centenas de itens; o teto por página é 200,
 * então quem casa nome com código precisa paginar.
 */
export async function buscarItensDaPlanilha(buildingId, buildingUnitId, { limit, offset } = {}) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${buildingId}/sheets/${buildingUnitId}/items`,
    { params: paginacao(limit, offset) }
  );
  return lista(
    resposta,
    "items",
    `Erro ao consultar itens da planilha ${buildingUnitId} da obra ${buildingId}`
  );
}

// =========================================================
// INSUMOS DO ORÇAMENTO
// =========================================================

/**
 * GET /building-cost-estimations/{buildingId}/resources — insumos do orçamento.
 *
 * Escopo é a obra: devolve o que aquele orçamento prevê, não o cadastro geral
 * de insumos da empresa. É o escopo certo para uma solicitação, porque um
 * insumo fora do orçamento da obra não tem item de orçamento onde ser
 * apropriado.
 *
 * Cada ResourceDTO traz `id` (o `productId` do item de solicitação),
 * `description`, `unitOfMeasure` (o `unitySymbol`), `category`,
 * `resourceCode`, e dois arrays que resolvem os campos opcionais do item:
 * `details[]` → `detailId` e `trademarks[]` → `trademarkId`.
 *
 * @param {object} [opcoes]
 * @param {Array<string>} [opcoes.resourceGroups] códigos de grupo de insumo
 *   para restringir a busca, ex. ["02", "01.001"]
 */
export async function buscarInsumosDoOrcamento(buildingId, { resourceGroups, limit, offset } = {}) {
  const params = paginacao(limit, offset);
  // O spec declara resourceGroups como lista; `makeRequest` já expande array
  // em repetição da chave (grupo=02&grupo=01.001), que é o formato esperado.
  if (resourceGroups?.length) params.resourceGroups = resourceGroups;

  const resposta = await makeRequest("GET", `${RECURSO}/${buildingId}/resources`, { params });
  return lista(resposta, "resources", `Erro ao consultar insumos do orçamento da obra ${buildingId}`);
}
