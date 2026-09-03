/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * purchase-requests-v1 — Solicitações de Compra.
 *
 * Tradução de `sienge_mcp/api/purchase_requests.py` (projeto Python irmão
 * deste) para Node, escrita a partir da especificação OpenAPI publicada em
 * https://api.sienge.com.br/docs/#/purchase-requests-v1
 *
 * É a ETAPA 1 do processo de compras — ver `knowledge/purchaseProcess.js`.
 * Solicitação registra O QUE se precisa e QUANTO, nunca preço: não existe
 * campo de valor negociado aqui.
 *
 * Nomes de parâmetro e de campo seguem a nomenclatura da própria API, em
 * camelCase. Onde o spec tem grafia irregular ela é PRESERVADA, porque é o que
 * o servidor espera — ver CAMPO_APROPRIACOES e o corpo de `criarSolicitacao`.
 *
 * Cada função chama `makeRequest` (importado, não injetado — diferente do
 * Python, que recebe `make_request` por parâmetro) e devolve o formato padrão
 * do servidor (`success`, mais os dados ou o erro).
 *
 * NÃO TRADUZIDO AINDA: `baixarAnexo` e `inserirAnexo`. As duas dependem de
 * recursos que `makeRequest` ainda não tem — resposta binária e corpo
 * multipart. Mesma pendência de `purchase-orders-v1.js`. Ver
 * `client/siengeClient.js`.
 */

import { makeRequest } from "../client/siengeClient.js";

const LIMIT_PADRAO = 100;
const LIMIT_MAXIMO = 200;

// Enums declarados em GET /purchase-requests/all/items. Note que a situação
// de solicitação usa ATTENDED (atendida por um pedido), enquanto a de pedido,
// em purchase-orders-v1, usa DELIVERED (entregue). Não são intercambiáveis.
const SITUACOES = ["PENDING", "PARTIALLY_ATTENDED", "FULLY_ATTENDED", "CANCELED"];
const SITUACOES_CONSISTENCIA = ["IN_INCLUSION", "CONSISTENT", "INCONSISTENT"];

const RECURSO = "/purchase-requests";

// O spec grafa este campo com um "p" só (BuildingApropriation /
// buildingsApropriations), embora a ROTA de consulta use a grafia correta
// (buildings-appropriations). O payload precisa da grafia do spec.
const CAMPO_APROPRIACOES = "buildingsApropriations";

// Limite declarado para notes em PurchaseRequest (spec: 4000 caracteres).
const NOTES_MAX = 4000;

// =========================================================
// HELPERS
// =========================================================
// Mesmos helpers de `purchase-orders-v1.js`, duplicados de propósito: cada
// arquivo de api/ é uma tradução autocontida do seu par em Python, e as
// pequenas divergências entre os specs (ver `confirmacao`) moram aqui.

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

/**
 * Normaliza as respostas de operação de escrita.
 *
 * Diferente do helper homônimo de `purchase-orders-v1.js`, este devolve
 * também `data`: o POST de criação responde com o id da solicitação recém
 * criada, e é por ele que `criarItens` sabe onde pendurar os insumos.
 */
function confirmacao(resposta, mensagem, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return {
    success: true,
    message: mensagem,
    data: resposta.data,
    status_code: resposta.status_code,
  };
}

/** Ausente para efeito de validação de item: null, undefined, "", 0 ou lista vazia. */
function vazio(valor) {
  if (Array.isArray(valor)) return valor.length === 0;
  return valor === null || valor === undefined || valor === "" || valor === 0;
}

// =========================================================
// CONSULTA
// =========================================================

/** GET /purchase-requests/{purchaseRequestId} — consulta uma solicitação. */
export async function buscarSolicitacao(purchaseRequestId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseRequestId}`);
  return unico(
    resposta,
    "purchaseRequest",
    `Erro ao consultar a solicitação ${purchaseRequestId}`
  );
}

/**
 * GET /purchase-requests/all/items — consulta itens de solicitações com filtros.
 *
 * Este é o ÚNICO endpoint de busca ampla da API: não existe listagem de
 * solicitações em si, apenas de itens. Para uma solicitação específica,
 * informe purchaseRequestId — ou use buscarSolicitacao() para o cabeçalho.
 *
 * startDate/endDate filtram pela data da solicitação (yyyy-MM-dd).
 *
 * Os filtros são exatamente estes — conferido contra o OpenAPI publicado. Em
 * especial NÃO existe `withOpenQuantity`, nem qualquer campo de saldo no
 * PurchaseRequestItem: saldo em aberto é conceito do PEDIDO, não da
 * solicitação.
 */
export async function buscarItensDeSolicitacoes({
  purchaseRequestId,
  startDate,
  endDate,
  buildingId,
  requesterUser,
  authorized,
  disapproved,
  purchaseRequestStatus,
  purchaseRequestConsistency,
  limit,
  offset,
} = {}) {
  validarEnum("purchaseRequestStatus", purchaseRequestStatus, SITUACOES);
  validarEnum("purchaseRequestConsistency", purchaseRequestConsistency, SITUACOES_CONSISTENCIA);

  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      purchaseRequestId,
      startDate,
      endDate,
      buildingId,
      requesterUser,
      authorized,
      disapproved,
      purchaseRequestStatus,
      purchaseRequestConsistency,
    }),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/all/items`, { params });
  return lista(resposta, "items", "Erro ao consultar itens de solicitações de compra");
}

/** GET .../items/{n}/buildings-appropriations — apropriações de obra do item. */
export async function buscarApropriacoesDoItem(
  purchaseRequestId,
  purchaseRequestItemNumber,
  { limit, offset } = {}
) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseRequestId}/items/${purchaseRequestItemNumber}/buildings-appropriations`,
    { params: paginacao(limit, offset) }
  );
  return lista(
    resposta,
    "buildingsAppropriations",
    `Erro ao consultar apropriações do item ${purchaseRequestItemNumber}`
  );
}

/**
 * GET .../items/{n}/delivery-requirements — necessidades de entrega do item.
 *
 * O spec não declara limit/offset para este endpoint, então não paginamos.
 * "Necessidade de entrega" é quando o solicitante PRECISA do insumo; não
 * confundir com a previsão de entrega do pedido (delivery-schedules, em
 * purchase-orders-v1), que é quando o fornecedor se compromete a entregar.
 */
export async function buscarEntregasDoItem(purchaseRequestId, purchaseRequestItemNumber) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${purchaseRequestId}/items/${purchaseRequestItemNumber}/delivery-requirements`
  );
  return lista(
    resposta,
    "deliveryRequirements",
    `Erro ao consultar entregas do item ${purchaseRequestItemNumber}`
  );
}

// =========================================================
// CRIAÇÃO
// =========================================================

/**
 * POST /purchase-requests — cria uma solicitação para uma obra existente.
 *
 * Cria apenas o CABEÇALHO; os insumos entram depois, por criarItens(). Uma
 * solicitação sem itens é um registro incompleto, não um erro da API.
 *
 * @param {number} buildingId código da obra
 * @param {string} requesterUser usuário solicitante (usuário do Sienge)
 * @param {string} requestDate data da solicitação, ISO 8601 yyyy-MM-dd
 * @param {object} [opcionais]
 * @param {number} [opcionais.departmentId] código do departamento
 * @param {number} [opcionais.categoryId] código da categoria da solicitação
 * @param {string} [opcionais.notes] observação, limitada a 4000 caracteres
 * @param {string} [opcionais.createdBy] usuário responsável pelo CADASTRO, nas
 *   informações de controle. É campo à parte de requesterUser: um é quem pede,
 *   o outro é quem registra. O Sienge recusa a criação quando ele chega nulo,
 *   e o spec avisa que este usuário precisa ter permissão na obra.
 *
 * `draft` NÃO é enviado: o spec o declara readOnly, então informá-lo é, na
 * melhor das hipóteses, ignorado.
 */
export async function criarSolicitacao(
  buildingId,
  requesterUser,
  requestDate,
  { departmentId, categoryId, notes, createdBy } = {}
) {
  const corpo = semNulos({
    buildingId,
    requesterUser,
    requestDate,
    // O spec grafa "departamentId"; enviar "departmentId" é silenciosamente
    // ignorado pelo servidor. A grafia certa fica só na API deste arquivo.
    departamentId: departmentId,
    categoryId,
    notes: notes === undefined || notes === null ? undefined : String(notes).slice(0, NOTES_MAX),
    createdBy,
  });

  const resposta = await makeRequest("POST", RECURSO, { body: corpo });
  const resultado = confirmacao(
    resposta,
    `✅ Solicitação de compra criada para a obra ${buildingId}`,
    "Erro ao criar a solicitação de compra"
  );
  // Numa recusa, o que FOI ENVIADO vale tanto quanto o motivo: é comparando
  // os dois que se descobre o campo errado. Só no erro — no sucesso seria
  // repetir dados que já voltam na resposta.
  if (!resultado.success) resultado.payload_enviado = corpo;
  return resultado;
}

/**
 * POST /purchase-requests/{purchaseRequestId}/items — adiciona itens à solicitação.
 *
 * @param {Array<object>} items lista de PurchaseRequestItemInsert. Campos
 *   obrigatórios de cada item, conforme o spec: productId, quantity,
 *   unitySymbol, buildingsApropriations e deliveryRequirements.
 *
 *   buildingsApropriations: [{ buildingUnitId: number,
 *     costEstimationItemReference: string, percentage: number }]
 *   deliveryRequirements: [{ requirementDate: "yyyy-MM-dd",
 *     requirementQuantity: number }]
 *
 * A conferência dos obrigatórios é feita aqui, antes da chamada, porque o
 * erro do servidor para um item incompleto não diz qual item nem qual campo.
 */
export async function criarItens(purchaseRequestId, items) {
  if (!items?.length) {
    return { success: false, message: "❌ Informe ao menos um item.", error: "MISSING_ITEMS" };
  }

  const obrigatorios = [
    "productId",
    "quantity",
    "unitySymbol",
    CAMPO_APROPRIACOES,
    "deliveryRequirements",
  ];

  for (const [posicao, item] of items.entries()) {
    const ausentes = obrigatorios.filter((campo) => vazio(item?.[campo]));
    if (ausentes.length) {
      return {
        success: false,
        message:
          `❌ Item na posição ${posicao} está sem os campos obrigatórios: ` +
          `${ausentes.join(", ")}.`,
        error: "INCOMPLETE_ITEM",
      };
    }
  }

  const resposta = await makeRequest("POST", `${RECURSO}/${purchaseRequestId}/items`, {
    body: items,
  });
  const resultado = confirmacao(
    resposta,
    `✅ ${items.length} item(ns) adicionado(s) à solicitação ${purchaseRequestId}`,
    `Erro ao adicionar itens à solicitação ${purchaseRequestId}`
  );
  if (!resultado.success) resultado.payload_enviado = items;
  return resultado;
}

// =========================================================
// AUTORIZAÇÃO E REPROVAÇÃO
// =========================================================
// A API separa três granularidades: a solicitação inteira, um subconjunto de
// itens, ou um item isolado. Reprovação existe para a solicitação inteira e
// para um item — NÃO há variante em lote.
//
// Diferente de purchase-orders-v1, aqui é sempre PATCH e sem corpo de
// observação: o spec não declara ObservationDTO para solicitações.

/** PATCH /purchase-requests/{purchaseRequestId}/authorize — autoriza todos os itens. */
export async function autorizarSolicitacao(purchaseRequestId) {
  const resposta = await makeRequest("PATCH", `${RECURSO}/${purchaseRequestId}/authorize`);
  return confirmacao(
    resposta,
    `✅ Solicitação de compra ${purchaseRequestId} autorizada`,
    `Erro ao autorizar a solicitação ${purchaseRequestId}`
  );
}

/** PATCH /purchase-requests/{purchaseRequestId}/disapproval — reprova todos os itens. */
export async function reprovarSolicitacao(purchaseRequestId) {
  const resposta = await makeRequest("PATCH", `${RECURSO}/${purchaseRequestId}/disapproval`);
  return confirmacao(
    resposta,
    `✅ Solicitação de compra ${purchaseRequestId} reprovada`,
    `Erro ao reprovar a solicitação ${purchaseRequestId}`
  );
}

/**
 * PATCH .../items/authorize — autoriza um subconjunto de itens.
 *
 * @param {Array<number>} itemNumbers números dos itens a autorizar; o spec
 *   espera { items: [{ purchaseRequestItemNumber: number }, ...] }.
 */
export async function autorizarItens(purchaseRequestId, itemNumbers) {
  if (!itemNumbers?.length) {
    return {
      success: false,
      message: "❌ Informe ao menos um número de item.",
      error: "MISSING_ITEMS",
    };
  }

  const corpo = {
    items: itemNumbers.map((n) => ({ purchaseRequestItemNumber: Number(n) })),
  };
  const resposta = await makeRequest("PATCH", `${RECURSO}/${purchaseRequestId}/items/authorize`, {
    body: corpo,
  });
  return confirmacao(
    resposta,
    `✅ ${itemNumbers.length} item(ns) autorizado(s) na solicitação ${purchaseRequestId}`,
    `Erro ao autorizar itens da solicitação ${purchaseRequestId}`
  );
}

/** PATCH .../items/{purchaseRequestItemNumber}/authorize — autoriza um item. */
export async function autorizarItem(purchaseRequestId, purchaseRequestItemNumber) {
  const resposta = await makeRequest(
    "PATCH",
    `${RECURSO}/${purchaseRequestId}/items/${purchaseRequestItemNumber}/authorize`
  );
  return confirmacao(
    resposta,
    `✅ Item ${purchaseRequestItemNumber} autorizado na solicitação ${purchaseRequestId}`,
    `Erro ao autorizar o item ${purchaseRequestItemNumber}`
  );
}

/** PATCH .../items/{purchaseRequestItemNumber}/disapproval — reprova um item. */
export async function reprovarItem(purchaseRequestId, purchaseRequestItemNumber) {
  const resposta = await makeRequest(
    "PATCH",
    `${RECURSO}/${purchaseRequestId}/items/${purchaseRequestItemNumber}/disapproval`
  );
  return confirmacao(
    resposta,
    `✅ Item ${purchaseRequestItemNumber} reprovado na solicitação ${purchaseRequestId}`,
    `Erro ao reprovar o item ${purchaseRequestItemNumber}`
  );
}

// =========================================================
// ANEXOS
// =========================================================

/**
 * GET /purchase-requests/{purchaseRequestId}/attachments — lista os anexos.
 * O spec não declara limit/offset aqui.
 */
export async function buscarAnexos(purchaseRequestId) {
  const resposta = await makeRequest("GET", `${RECURSO}/${purchaseRequestId}/attachments`);
  return lista(
    resposta,
    "attachments",
    `Erro ao listar anexos da solicitação ${purchaseRequestId}`
  );
}

// baixarAnexo (GET .../attachments/{attachmentNumber}, resposta binária) e
// inserirAnexo (POST .../attachments, corpo multipart) ficam de fora por
// enquanto — ver o aviso no topo do arquivo. Quando forem traduzidos, atenção:
// o campo de formulário do arquivo aqui chama-se `file`, e não `attachment`
// como em purchase-orders-v1. Limite de 70 MB.
