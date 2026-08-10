/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `/bills` — títulos a pagar (API bill-debt).
 */

import { semNulos } from "./_helpers.js";

export const RECURSO = "/bills";

export const NOTA =
  "Sem busca textual: títulos só se recortam por período, credor ou documento.";

export const ENDPOINTS = [
  "GET /bills",
  "GET /bills/by-change-date",
  "GET /bills/{id}",
  "GET /bills/{id}/installments",
  "GET /bills/{id}/installments/{installmentId}/taxes",
  "GET /bills/{id}/budget-categories",
  "GET /bills/{id}/departments-cost",
  "GET /bills/{id}/buildings-cost",
  "GET /bills/{id}/units",
  "GET /bills/{id}/attachments",
  "GET /bills/{id}/attachments/{attachmentId}",
  "GET /bills/{id}/payment-information",
  "GET /bills/payment-forms",
  "POST /bills",
  "PATCH /bills/{id}",
  "PATCH /bills/{id}/installments",
  "PATCH /bills/{id}/departments-cost",
  "PATCH /bills/{id}/buildings-cost",
  "PATCH /bills/{id}/units",
  "POST /bills/{id}/attachments",
];

/**
 * GET /bills — títulos por data de emissão.
 *
 * A chave de retorno é `bills`, não a genérica `results`: é o que os
 * consumidores procuram, e divergir aqui não daria erro — daria lista vazia
 * com `success: true`, indistinguível de "não há títulos no período".
 */
export async function buscarTitulos(makeRequest, opts = {}) {
  const {
    start_date,
    end_date,
    debtor_id = null,
    creditor_id = null,
    cost_center_id = null,
    documents_identification_id = null,
    document_number = null,
    status = null,
    origin_id = null,
    limit = 100,
    offset = 0,
  } = opts;

  const params = {
    startDate: start_date,
    endDate: end_date,
    limit,
    offset,
    ...semNulos({
      debtorId: debtor_id,
      creditorId: creditor_id,
      costCenterId: cost_center_id,
      documentsIdentificationId: documents_identification_id,
      documentNumber: document_number,
      status,
      originId: origin_id,
    }),
  };

  const res = await makeRequest("GET", RECURSO, { params });
  if (!res.success) {
    return {
      success: false,
      message: "❌ Erro ao consultar títulos",
      error: res.error,
      details: res.message,
    };
  }

  const dados = res.data || {};
  const ehObjeto = dados && typeof dados === "object" && !Array.isArray(dados);
  const itens = ehObjeto ? dados.results ?? [] : dados || [];
  const meta = ehObjeto ? dados.resultSetMetadata ?? {} : {};

  return { success: true, bills: itens, count: itens.length, metadata: meta };
}
