/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/purchase-orders` — pedidos de compra.
 *
 * Um arquivo por recurso da API do Sienge, com o nome do recurso: quem tem um
 * path na mão sabe qual arquivo abrir. Nada aqui é tool — é tradução de
 * endpoint, não custa contexto, e existe para as tools de negócio comporem
 * sem repetir código.
 */

import { normalizarLista, semNulos, validarEnum } from "./_helpers.js";

export const RECURSO = "/purchase-orders";

/**
 * Endpoints deste recurso, na notação `MÉTODO /path`.
 *
 * Declarados à mão porque são o contrato com a API, não um detalhe derivável:
 * `scripts/build-endpoints.js` monta o inventário a partir daqui, e um teste
 * garante que todo path chamado neste arquivo está nesta lista. É o que
 * permite `sienge_api_endpoints` responder sem inventar.
 */
export const ENDPOINTS = [
  "GET /purchase-orders",
  "GET /purchase-orders/{id}",
  "GET /purchase-orders/{id}/items",
  "GET /purchase-orders/{id}/items/{itemNumber}",
  "GET /purchase-orders/{id}/items/{itemNumber}/buildings-appropriations",
  "GET /purchase-orders/{id}/items/{itemNumber}/delivery-schedules",
  "GET /purchase-orders/{id}/items/{itemNumber}/purchase-requests",
  "GET /purchase-orders/{id}/totalization",
  "GET /purchase-orders/{id}/direct-billing",
  "GET /purchase-orders/{id}/attachments",
  "GET /purchase-orders/{id}/attachments/{attachmentId}",
  "GET /purchase-orders/{id}/analysis/pdf",
  "GET /purchase-orders/{id}/supplier-evaluation-criteria",
  "PATCH /purchase-orders/{id}/authorize",
  "PATCH /purchase-orders/{id}/disapprove",
];

const LIMIT_MAXIMO = 200;
const LIMIT_PADRAO = 100;

export const SITUACOES = ["PENDING", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELED"];
export const SITUACOES_APROVACAO = ["DISAPPROVED", "APPROVED"];
export const SITUACOES_CONSISTENCIA = ["IN_INCLUSION", "CONSISTENT", "INCONSISTENT"];

function paginacao(limit, offset) {
  return {
    limit: Math.min(Number(limit || LIMIT_PADRAO), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
  };
}

/**
 * GET /purchase-orders — consulta pedidos de compra com filtros combináveis.
 *
 * start_date/end_date filtram pela data do pedido, no formato yyyy-MM-dd.
 */
export async function buscarPedidos(makeRequest, opts = {}) {
  const {
    start_date = null,
    end_date = null,
    status = null,
    authorized = null,
    supplier_id = null,
    building_id = null,
    buyer_id = null,
    status_approval = null,
    consistency = null,
    limit = null,
    offset = null,
  } = opts;

  validarEnum("status", status, SITUACOES);
  validarEnum("status_approval", status_approval, SITUACOES_APROVACAO);
  validarEnum("consistency", consistency, SITUACOES_CONSISTENCIA);

  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      startDate: start_date,
      endDate: end_date,
      status,
      authorized,
      supplierId: supplier_id,
      buildingId: building_id,
      buyerId: buyer_id,
      statusApproval: status_approval,
      consistency,
    }),
  };

  const resposta = await makeRequest("GET", RECURSO, { params });
  return normalizarLista(resposta, "purchaseOrders", "Erro ao consultar pedidos de compra");
}

/** GET /purchase-orders/{id}/items — itens de um pedido. */
export async function buscarItens(makeRequest, purchaseOrderId, opts = {}) {
  const { limit = null, offset = null } = opts;
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${encodeURIComponent(purchaseOrderId)}/items`,
    { params: paginacao(limit, offset) }
  );
  return normalizarLista(
    resposta,
    "items",
    `Erro ao consultar itens do pedido ${purchaseOrderId}`
  );
}

/** GET /purchase-orders/{id} — um pedido específico. */
export async function buscarPedido(makeRequest, purchaseOrderId) {
  const resposta = await makeRequest(
    "GET",
    `${RECURSO}/${encodeURIComponent(purchaseOrderId)}`
  );
  if (!resposta.success) {
    return {
      success: false,
      message: `❌ Erro ao buscar o pedido de compra ${purchaseOrderId}`,
      error: resposta.error,
      details: resposta.message,
    };
  }
  return { success: true, purchaseOrder: resposta.data };
}
