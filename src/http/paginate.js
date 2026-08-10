/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Varredura de endpoints paginados por limit/offset.
 */

import { makeSiengeRequest, makeSiengeBulkRequest } from "./client.js";

const MAX_PAGE_SIZE = 200;

/**
 * Percorre um endpoint paginado (limit/offset) até esgotar os resultados.
 *
 * ⚠️ Em caso de falha da API isto NÃO devolve uma lista, e sim o objeto
 * `{success: false, error, message}`. Quem chama precisa checar
 * `Array.isArray()` antes de tratar o retorno como coleção — é o que
 * `apis/` faz. Ver `docs/notas-tecnicas.md`.
 */
export async function fetchAllPaginated({
  endpoint,
  params = null,
  pageSize = 200,
  maxRecords = null,
  resultsKey = "results",
  useBulk = false,
}) {
  const query = { ...(params || {}) };
  const tamanho = Math.min(Number(pageSize), MAX_PAGE_SIZE);
  let offset = Number(query.offset || 0);
  const requester = useBulk ? makeSiengeBulkRequest : makeSiengeRequest;
  const collected = [];

  while (true) {
    query.limit = tamanho;
    query.offset = offset;

    const result = await requester("GET", endpoint, { params: query });
    if (!result.success) {
      return { success: false, error: result.error, message: result.message };
    }

    const payload = result.data;
    const payloadKey = useBulk ? "data" : resultsKey;
    const pageItems =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload[payloadKey] ?? []
        : payload;

    if (!Array.isArray(pageItems)) {
      collected.push(pageItems);
      break;
    }

    collected.push(...pageItems);

    if (maxRecords && collected.length >= Number(maxRecords)) {
      return collected.slice(0, Number(maxRecords));
    }

    if (pageItems.length < tamanho) break;

    offset += pageItems.length || tamanho;
  }

  return collected;
}
