/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Helpers de HTTP/paginação compartilhados entre customers, creditors,
 * enterprises, cost_centers, units e payment_categories.
 */

/** Separa a lista de itens e os metadados de uma resposta paginada do Sienge. */
export function splitResults(data, resultsKey = "results") {
  const ehObjeto = data && typeof data === "object" && !Array.isArray(data);
  const items = ehObjeto ? data[resultsKey] ?? [] : data;
  const metadata = ehObjeto ? data.resultSetMetadata ?? {} : {};
  return [items, metadata];
}

export function failure(result, message) {
  return {
    success: false,
    message,
    error: result.error,
    details: result.message,
  };
}

/** Remove chaves nulas/indefinidas — o Sienge trata parâmetro vazio como filtro. */
export function semNulos(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== null && v !== undefined)
  );
}

/** Preenche `{count}` e `{total}` no template de mensagem. */
function formatMessage(template, { count, total }) {
  return template.replace("{count}", String(count)).replace("{total}", String(total));
}

/**
 * Padrão comum de listagem: GET paginado -> extrai results/metadata -> monta
 * resposta. `okMessage` pode usar `{count}` e `{total}`.
 */
export async function listEndpoint(makeRequest, endpoint, params, opts) {
  const { itemsKey, okMessage, errorMessage, extra = null } = opts;

  const result = await makeRequest("GET", endpoint, { params });
  if (!result.success) return failure(result, errorMessage);

  const [items, metadata] = splitResults(result.data);
  const lista = Array.isArray(items) ? items : [];
  const total = metadata.count ?? lista.length;

  const response = {
    success: true,
    message: formatMessage(okMessage, { count: lista.length, total }),
    [itemsKey]: lista,
    count: lista.length,
  };
  return extra ? { ...response, ...extra(lista, metadata) } : response;
}

/** Padrão comum de busca de um recurso único (sem paginação). */
export async function getEndpoint(makeRequest, endpoint, { errorMessage, buildOk }) {
  const result = await makeRequest("GET", endpoint);
  if (!result.success) return failure(result, errorMessage);
  return buildOk(result.data);
}

/** Busca no cache; se ausente (ou o cache falhar), chama `loader` e grava o resultado. */
export async function cached(cacheGet, cacheSet, cacheKey, ttl, loader) {
  try {
    const value = cacheGet(cacheKey);
    if (value) return value;
  } catch {
    // cache indisponível não impede a chamada
  }

  const response = await loader();

  if (response?.success) {
    try {
      cacheSet(cacheKey, response, ttl);
    } catch {
      // gravar no cache é best-effort
    }
  }
  return response;
}

/**
 * Chave de cache estável a partir dos parâmetros. A ordenação é explícita
 * porque a ordem de inserção de um objeto não é confiável entre chamadas — sem
 * ela, os mesmos filtros em ordem diferente viram entradas distintas no cache.
 */
export function cacheKey(prefixo, params) {
  const ordenados = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  return `${prefixo}:${JSON.stringify(ordenados)}`;
}
