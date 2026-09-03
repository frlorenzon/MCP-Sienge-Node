/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * purchase-orders-v1 — Pedidos de Compra.
 *
 * Tradução de `sienge_mcp/api/purchase_orders.py` (projeto Python irmão deste)
 * para Node. Nomes de parâmetro e de campo seguem a nomenclatura da própria
 * API do Sienge, em camelCase.
 *
 * Cada função chama `makeRequest` (importado, não injetado — diferente do
 * Python, que recebe `make_request` por parâmetro) e devolve o formato padrão
 * do servidor (`success`, mais os dados ou o erro).
 *
 * NÃO TRADUZIDO AINDA: `baixar_anexo`, `inserir_anexo` e `gerar_analise_pdf`.
 * As três dependem de recursos que `makeRequest` ainda não tem — resposta
 * binária (raw response) e corpo multipart. Ver `client/siengeClient.js`.
 */

import { makeRequest } from "../client/siengeClient.js";

const LIMIT_PADRAO = 100;
const LIMIT_MAXIMO = 200;

const SITUACOES = ["PENDING", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELED"];
const SITUACOES_APROVACAO = ["DISAPPROVED", "APPROVED"];
const SITUACOES_CONSISTENCIA = ["IN_INCLUSION", "CONSISTENT", "INCONSISTENT"];

const RECURSO = "/purchase-orders";

// Limite de 300 caracteres declarado em ObservationDTO.
const OBSERVACAO_MAX = 300;

// =========================================================
// HELPERS
// =========================================================

/** Monta limit/offset respeitando o teto de 200 declarado no spec. */
function paginacao(limit, offset) {
  return {
    limit: Math.min(Number(limit ?? LIMIT_PADRAO), LIMIT_MAXIMO),
    offset: Math.max(Number(offset ?? 0), 0),
  };
}

/** Descarta chaves cujo valor é null/undefined, para não enviar filtro vazio na query. */
function semNulos(campos) {
  const saida = {};
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor !== null && valor !== undefined) saida[chave] = valor;
  }
  return saida;
}

/** Confere um valor contra o enum do spec antes de chamar a API. */
function validarEnum(nome, valor, aceitos) {
  if (valor === null || valor === undefined) return undefined;
  if (!aceitos.includes(valor)) {
    throw new Error(`${nome} deve ser um de ${aceitos.join(", ")} — recebido '${valor}'`);
  }
  return valor;
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

/** Normaliza as respostas de recurso único (sem paginação). */
function unico(resposta, chave, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return { success: true, [chave]: resposta.data };
}

/** Normaliza as respostas de operação sem corpo de retorno (204/200 vazio). */
function confirmacao(resposta, mensagem, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return { success: true, message: mensagem, status_code: resposta.status_code };
}

// =========================================================
// CONSULTA DE PEDIDOS
// =========================================================

/**
 * GET /purchase-orders — consulta pedidos de compra com filtros combináveis.
 * startDate/endDate filtram pela data do pedido, no formato yyyy-MM-dd.
 */
export async function buscarPedidos({
  startDate,
  endDate,
  status,
  authorized,
  supplierId,
  buildingId,
  buyerId,
  statusApproval,
  consistency,
  limit,
  offset,
} = {}) {
  validarEnum("status", status, SITUACOES);
  validarEnum("statusApproval", statusApproval, SITUACOES_APROVACAO);
  validarEnum("consistency", consistency, SITUACOES_CONSISTENCIA);

  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      startDate,
      endDate,
      status,
      authorized,
      supplierId,
      buildingId,
      buyerId,
      statusApproval,
      consistency,
    }),
  };

  const resposta = await makeRequest("GET", RECURSO, { params });
  return lista(resposta, "purchaseOrders", "Erro ao consultar pedidos de compra");
}

/**
 * GET /purchase-orders/{purchaseOrderId} — consulta um pedido específico.
 * purchaseOrderId segue o parâmetro 415 do Sienge: sequencial contínuo (ex:
 * 123) ou sequencial anual de 8 dígitos, com o ano nos 2 primeiros (ex:
 * 19000123 para "123/19").
 */
export async function buscarPedido(purchaseOrderId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}`);
  return unico(resposta, "purchaseOrder", `Erro ao consultar o pedido ${purchaseOrderId}`);
}

/** GET /purchase-orders/{purchaseOrderId}/totalization — totalização do pedido. */
export async function buscarTotalizacao(purchaseOrderId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}/totalization`);
  return unico(
    resposta,
    "totalization",
    `Erro ao consultar a totalização do pedido ${purchaseOrderId}`
  );
}

/**
 * GET /purchase-orders/{purchaseOrderId}/direct-billing — faturamento direto
 * simples. Não retorna faturamento direto com desconto em medição.
 */
export async function buscarFaturamentoDireto(purchaseOrderId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}/direct-billing`);
  return unico(
    resposta,
    "directBilling",
    `Erro ao consultar o faturamento direto do pedido ${purchaseOrderId}`
  );
}

/**
 * Confere a empresa de um pedido antes de usá-lo numa nota fiscal.
 *
 * Lançar uma nota cujo `companyId` diverge do pedido faz o Sienge recusar com
 * HTTP 422 e a mensagem sobre centro de custo não vinculado à empresa do
 * título. Esta consulta antecipa isso: devolve a empresa e a obra do pedido e,
 * quando `companyId` é informado, diz se os dois combinam.
 *
 * Não corresponde a um endpoint da API — é uma leitura de
 * GET /purchase-orders/{purchaseOrderId} com a comparação já feita.
 */
export async function validarEmpresaDoPedido(purchaseOrderId, companyId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}`);
  if (!resposta.success) return falha(resposta, `Erro ao consultar o pedido ${purchaseOrderId}`);

  const pedido = resposta.data ?? {};
  const empresaDoPedido = pedido.companyId;
  const resultado = {
    success: true,
    purchaseOrderId,
    companyId: empresaDoPedido,
    buildingId: pedido.buildingId,
    supplierId: pedido.supplierId,
  };

  if (companyId === undefined || companyId === null) {
    resultado.message = `Pedido ${purchaseOrderId} pertence à empresa ${empresaDoPedido}.`;
    return resultado;
  }

  const combina = empresaDoPedido === companyId;
  resultado.compatible = combina;
  resultado.message = combina
    ? `✅ Pedido ${purchaseOrderId} é compatível com a empresa ${companyId}.`
    : `⚠️ Divergência: o pedido ${purchaseOrderId} pertence à empresa ${empresaDoPedido}, ` +
      `mas a nota seria lançada na empresa ${companyId}. Lançar assim resulta em HTTP 422.`;
  return resultado;
}

// =========================================================
// ITENS DO PEDIDO
// =========================================================

/** GET /purchase-orders/{purchaseOrderId}/items — itens do pedido. */
export async function buscarItens(purchaseOrderId, { limit, offset } = {}) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}/items`, {
    params: paginacao(limit, offset),
  });
  return lista(resposta, "items", `Erro ao consultar itens do pedido ${purchaseOrderId}`);
}

/** GET /purchase-orders/{purchaseOrderId}/items/{itemNumber} — item específico. */
export async function buscarItem(purchaseOrderId, itemNumber) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}/items/${itemNumber}`);
  return unico(
    resposta,
    "item",
    `Erro ao consultar o item ${itemNumber} do pedido ${purchaseOrderId}`
  );
}

/**
 * GET .../items/{itemNumber}/purchase-requests — solicitações atendidas pelo
 * item. Neste endpoint o spec declara limit com valor default 10.
 */
export async function buscarSolicitacoesDoItem(purchaseOrderId, itemNumber, { limit, offset } = {}) {
  const params = {
    limit: Math.min(Number(limit ?? 10), LIMIT_MAXIMO),
    offset: Math.max(Number(offset ?? 0), 0),
  };
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseOrderId}/items/${itemNumber}/purchase-requests`,
    { params }
  );
  return lista(resposta, "purchaseRequests", `Erro ao consultar solicitações do item ${itemNumber}`);
}

/** GET .../items/{itemNumber}/delivery-schedules — previsões de entrega do item. */
export async function buscarPrevisoesDeEntrega(purchaseOrderId, itemNumber, { limit, offset } = {}) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseOrderId}/items/${itemNumber}/delivery-schedules`,
    { params: paginacao(limit, offset) }
  );
  return lista(
    resposta,
    "deliverySchedules",
    `Erro ao consultar previsões de entrega do item ${itemNumber}`
  );
}

/** GET .../items/{itemNumber}/buildings-appropriations — apropriações de obra do item. */
export async function buscarApropriacoesDeObra(purchaseOrderId, itemNumber, { limit, offset } = {}) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseOrderId}/items/${itemNumber}/buildings-appropriations`,
    { params: paginacao(limit, offset) }
  );
  return lista(
    resposta,
    "buildingsAppropriations",
    `Erro ao consultar apropriações de obra do item ${itemNumber}`
  );
}

// =========================================================
// AUTORIZAÇÃO E REPROVAÇÃO
// =========================================================
// O spec oferece PUT (sem corpo) e PATCH (com ObservationDTO) para as duas
// operações. Usamos PATCH quando há observação e PUT quando não há, evitando
// enviar um corpo vazio.

async function decidir(purchaseOrderId, operacao, observacao, participio, infinitivo) {
  const endpoint = `${RECURSO}/${purchaseOrderId}/${operacao}`;

  const resposta = observacao
    ? await makeRequest("PATCH", endpoint, { body: { observation: observacao.slice(0, OBSERVACAO_MAX) } })
    : await makeRequest("PUT", endpoint);

  return confirmacao(
    resposta,
    `✅ Pedido de compra ${purchaseOrderId} ${participio}`,
    `Erro ao ${infinitivo} o pedido ${purchaseOrderId}`
  );
}

/**
 * PUT/PATCH /purchase-orders/{purchaseOrderId}/authorize — autoriza o pedido.
 * `observation` é opcional e limitada a 300 caracteres; quando informada, usa
 * a variante PATCH.
 */
export async function autorizarPedido(purchaseOrderId, observation) {
  return decidir(purchaseOrderId, "authorize", observation, "autorizado", "autorizar");
}

/** PUT/PATCH /purchase-orders/{purchaseOrderId}/disapprove — reprova o pedido. */
export async function reprovarPedido(purchaseOrderId, observation) {
  return decidir(purchaseOrderId, "disapprove", observation, "reprovado", "reprovar");
}

// =========================================================
// ANEXOS
// =========================================================

/** GET /purchase-orders/{purchaseOrderId}/attachments — lista de anexos. */
export async function buscarAnexos(purchaseOrderId, { limit, offset } = {}) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseOrderId}/attachments`, {
    params: paginacao(limit, offset),
  });
  return lista(resposta, "attachments", `Erro ao listar anexos do pedido ${purchaseOrderId}`);
}

// baixarAnexo (GET .../attachments/{attachmentNumber}, resposta binária) e
// inserirAnexo (POST .../attachments, corpo multipart) ficam de fora por
// enquanto — ver o aviso no topo do arquivo.

// =========================================================
// AVALIAÇÃO DO FORNECEDOR
// =========================================================

/**
 * GET .../supplier-evaluation-criteria — critérios disponíveis e faixa de
 * notas. Retorna `remainderList`, `defaultList` e o intervalo válido das
 * notas (`rangeMin`/`rangeMax`), que devem ser respeitados ao avaliar.
 */
export async function buscarCriteriosDeAvaliacao(purchaseOrderId) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseOrderId}/supplier-evaluation-criteria`
  );
  return unico(
    resposta,
    "supplierEvaluationCriteria",
    `Erro ao consultar critérios de avaliação do pedido ${purchaseOrderId}`
  );
}

/**
 * POST/PUT /purchase-orders/{purchaseOrderId}/evaluation — avalia o fornecedor.
 *
 * `evaluatedCriteria`: [{criterionId, value}], conforme EvaluatedCriterion do
 * spec. Os ids e a faixa válida de `value` vêm de buscarCriteriosDeAvaliacao().
 * `substituir` com false usa POST (cadastra); com true usa PUT, que cadastra
 * caso não exista ou atualiza a última avaliação.
 */
export async function avaliarFornecedor(purchaseOrderId, evaluatedCriteria, { notes, substituir = false } = {}) {
  if (!evaluatedCriteria?.length) {
    return {
      success: false,
      message: "❌ Informe ao menos um critério em evaluatedCriteria.",
      error: "MISSING_CRITERIA",
    };
  }

  const corpo = { evaluatedCriteria };
  if (notes !== undefined) corpo.notes = notes;

  const metodo = substituir ? "PUT" : "POST";
  const resposta = await makeRequest(metodo, `${RECURSO}/${purchaseOrderId}/evaluation`, { body: corpo });
  return confirmacao(
    resposta,
    `✅ Avaliação do fornecedor registrada no pedido ${purchaseOrderId}`,
    `Erro ao avaliar o fornecedor do pedido ${purchaseOrderId}`
  );
}

// =========================================================
// RELATÓRIO
// =========================================================
// gerarAnalisePdf (GET .../analysis/pdf, resposta binária) fica de fora por
// enquanto — ver o aviso no topo do arquivo.
