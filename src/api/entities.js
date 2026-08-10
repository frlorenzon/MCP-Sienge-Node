/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * As consultas de entidade de que o módulo `nucleo` depende.
 *
 * Este arquivo é deliberadamente parcial. `search_sienge_data` e
 * `get_sienge_data_paginated` são tools do núcleo, mas leem clientes,
 * credores, empreendimentos, pedidos e títulos — que pertencem a `cadastros`,
 * `compras` e `titulos`. Manter aqui apenas as cinco consultas de que elas
 * dependem é o que permite o núcleo funcionar sozinho, sem arrastar os módulos
 * inteiros junto. Quando `cadastros` for implementado, estas funções migram
 * para `api/customers.js`, `api/creditors.js` etc. e este arquivo desaparece.
 */

import { cached, cacheKey, failure, listEndpoint, semNulos } from "./_restHelpers.js";

const LIMIT_MAXIMO = 200;
const TTL_CACHE = 300;

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// CLIENTES
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * GET /customers — lista clientes.
 *
 * `modifiedAfter`/`modifiedBefore` servem a sincronizações incrementais, que
 * leem bem menos que uma varredura completa.
 */
export async function buscarClientes(makeRequest, deps = {}, opts = {}) {
  const { cacheGet, cacheSet, fetchAllPaginated } = deps;
  const {
    limit = 50,
    offset = 0,
    cpf = null,
    cnpj = null,
    international_id = null,
    only_active = null,
    enterprise_id = null,
    created_after = null,
    created_before = null,
    modified_after = null,
    modified_before = null,
    fetch_all = false,
    max_records = null,
  } = opts;

  const params = {
    limit: Math.min(Number(limit || 50), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({
      cpf,
      cnpj,
      internationalId: international_id,
      onlyActive: only_active,
      enterpriseId: enterprise_id,
      createdAfter: created_after,
      createdBefore: created_before,
      modifiedAfter: modified_after,
      modifiedBefore: modified_before,
    }),
  };

  if (fetch_all && fetchAllPaginated) {
    const itens = await fetchAllPaginated({
      endpoint: "/customers",
      params,
      pageSize: LIMIT_MAXIMO,
      maxRecords: max_records,
    });
    if (!Array.isArray(itens)) return failure(itens, "❌ Erro ao varrer clientes");
    return {
      success: true,
      message: `✅ ${itens.length} cliente(s) (varredura completa)`,
      customers: itens,
      count: itens.length,
    };
  }

  const carregar = () =>
    listEndpoint(makeRequest, "/customers", params, {
      itemsKey: "customers",
      okMessage: "✅ {count} cliente(s) (total: {total})",
      errorMessage: "❌ Erro ao buscar clientes",
      extra: () => ({ filters_applied: params }),
    });

  if (cacheGet && cacheSet) {
    return cached(cacheGet, cacheSet, cacheKey("customers", params), TTL_CACHE, carregar);
  }
  return carregar();
}

/** Filtro por nome aplicado no cliente — a API de clientes não oferece busca textual. */
export function filtrarPorNome(clientes, termo) {
  const alvo = (termo || "").toLowerCase();
  if (!alvo) return clientes;
  return clientes.filter((c) =>
    [c.name, c.tradeName, c.corporateName, c.id].some((campo) =>
      String(campo ?? "").toLowerCase().includes(alvo)
    )
  );
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// CREDORES
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * GET /creditors — lista credores.
 *
 * `creditor` busca por nome, nome fantasia ou código — e é filtrada no
 * servidor, o que torna a ausência de resultado conclusiva.
 */
export async function buscarCredores(makeRequest, deps = {}, opts = {}) {
  const { cacheGet, cacheSet, fetchAllPaginated } = deps;
  const {
    limit = 50,
    offset = 0,
    creditor = null,
    cpf = null,
    cnpj = null,
    fetch_all = false,
    max_records = null,
  } = opts;

  const params = {
    limit: Math.min(Number(limit || 50), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
    ...semNulos({ creditor, cpf, cnpj }),
  };

  if (fetch_all && fetchAllPaginated) {
    const itens = await fetchAllPaginated({
      endpoint: "/creditors",
      params,
      pageSize: LIMIT_MAXIMO,
      maxRecords: max_records,
    });
    if (!Array.isArray(itens)) return failure(itens, "❌ Erro ao varrer credores");
    return {
      success: true,
      message: `✅ ${itens.length} credor(es) (varredura completa)`,
      creditors: itens,
      count: itens.length,
    };
  }

  const carregar = () =>
    listEndpoint(makeRequest, "/creditors", params, {
      itemsKey: "creditors",
      okMessage: "✅ {count} credor(es) (total: {total})",
      errorMessage: "❌ Erro ao buscar credores",
      extra: () => ({ filters_applied: params }),
    });

  if (cacheGet && cacheSet) {
    return cached(cacheGet, cacheSet, cacheKey("creditors", params), TTL_CACHE, carregar);
  }
  return carregar();
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// EMPREENDIMENTOS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

const TIPOS = [1, 2, 3, 4];
const REGISTRO_DE_RECEBIVEIS = ["B3", "CERC"];

/**
 * GET /enterprises — lista empreendimentos e obras.
 *
 * `tipo`: 1=Obra, 2=Centro de custo, 3=Obra e centro de custo, 4=Aglutinador.
 */
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

  return listEndpoint(makeRequest, "/enterprises", params, {
    itemsKey: "enterprises",
    okMessage: "✅ {count} empreendimento(s) (total: {total})",
    errorMessage: "❌ Erro ao buscar empreendimentos",
  });
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// PEDIDOS DE COMPRA
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

const LIMIT_PADRAO_PEDIDOS = 100;
const SITUACOES = ["PENDING", "PARTIALLY_DELIVERED", "FULLY_DELIVERED", "CANCELED"];
const SITUACOES_APROVACAO = ["DISAPPROVED", "APPROVED"];
const SITUACOES_CONSISTENCIA = ["IN_INCLUSION", "CONSISTENT", "INCONSISTENT"];

/** Confere um valor contra o enum do spec antes de chamar a API. */
function validarEnum(nome, valor, aceitos) {
  if (valor === null || valor === undefined) return null;
  if (!aceitos.includes(valor)) {
    throw new Error(`${nome} deve ser um de ${aceitos.join(", ")} — recebido ${JSON.stringify(valor)}`);
  }
  return valor;
}

/** Normaliza as respostas paginadas (resultSetMetadata + results) do spec. */
function normalizarLista(resposta, chave, contexto) {
  if (!resposta.success) {
    return {
      success: false,
      message: `❌ ${contexto}`,
      error: resposta.error,
      details: resposta.message,
    };
  }

  const dados = resposta.data || {};
  const ehObjeto = dados && typeof dados === "object" && !Array.isArray(dados);
  const itens = ehObjeto ? dados.results ?? [] : dados || [];
  const meta = ehObjeto ? dados.resultSetMetadata ?? {} : {};

  return {
    success: true,
    [chave]: itens,
    count: itens.length,
    total: meta.count ?? itens.length,
    offset: meta.offset ?? 0,
    limit: meta.limit,
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
    limit: Math.min(Number(limit || LIMIT_PADRAO_PEDIDOS), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
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

  const resposta = await makeRequest("GET", "/purchase-orders", { params });
  return normalizarLista(resposta, "purchaseOrders", "Erro ao consultar pedidos de compra");
}

/** GET /purchase-orders/{id}/items — itens de um pedido. */
export async function buscarItensDoPedido(makeRequest, purchaseOrderId, opts = {}) {
  const { limit = null, offset = null } = opts;
  const params = {
    limit: Math.min(Number(limit || LIMIT_PADRAO_PEDIDOS), LIMIT_MAXIMO),
    offset: Math.max(Number(offset || 0), 0),
  };
  const resposta = await makeRequest(
    "GET",
    `/purchase-orders/${encodeURIComponent(purchaseOrderId)}/items`,
    { params }
  );
  return normalizarLista(resposta, "items", `Erro ao consultar itens do pedido ${purchaseOrderId}`);
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// CADASTROS CONSULTADOS POR ID
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/** GET /creditors/{id} — dados completos de um credor. */
export async function buscarCredor(makeRequest, creditorId) {
  const resposta = await makeRequest("GET", `/creditors/${encodeURIComponent(creditorId)}`);
  if (!resposta.success) return failure(resposta, `❌ Erro ao buscar o credor ${creditorId}`);
  return { success: true, creditor: resposta.data };
}

/** GET /cost-centers/{id} — dados de um centro de custo. */
export async function buscarCentroDeCusto(makeRequest, costCenterId) {
  const resposta = await makeRequest("GET", `/cost-centers/${encodeURIComponent(costCenterId)}`);
  if (!resposta.success) {
    return failure(resposta, `❌ Erro ao buscar o centro de custo ${costCenterId}`);
  }
  return { success: true, costCenter: resposta.data };
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// TÍTULOS A PAGAR
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * GET /bills — busca os títulos no Sienge por data de emissão.
 *
 * A chave de retorno é `bills`, e não a genérica `results`: é o que
 * `discovery` procura, e uma divergência aqui não daria erro — daria uma lista
 * vazia com `success: true`, indistinguível de "não há títulos no período".
 * Coberto por teste de regressão.
 */
export async function getBills(makeRequest, opts = {}) {
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

  const res = await makeRequest("GET", "/bills", { params });
  if (!res.success) {
    return {
      success: false,
      message: "❌ Erro ao consultar dados",
      error: res.error,
      details: res.message,
    };
  }

  const dados = res.data || {};
  const ehObjeto = dados && typeof dados === "object" && !Array.isArray(dados);
  const itens = ehObjeto ? dados.results ?? [] : dados || [];
  const meta = ehObjeto ? dados.resultSetMetadata ?? {} : {};

  return {
    success: true,
    bills: itens,
    count: itens.length,
    metadata: meta,
  };
}
