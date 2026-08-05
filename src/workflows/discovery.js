/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Descoberta — teste de conexão, catálogo de entidades, busca e paginação.
 *
 * Este módulo não traduz uma API: ele orquestra as tools de entidade. O desenho
 * gira em torno de uma limitação que precisa ficar visível em vez de escondida.
 *
 * **A API do Sienge não oferece busca textual uniforme.** Clientes e credores
 * aceitam um parâmetro `search` e são filtrados pelo servidor. Empreendimentos
 * e pedidos de compra não aceitam — o filtro só pode ser feito no cliente,
 * sobre a página que foi lida, o que significa que um registro fora dessa
 * amostra não será encontrado. Títulos a pagar não têm busca textual nenhuma:
 * só recorte por período.
 *
 * Tratar os três casos como iguais produz algo pior do que não buscar: filtrar
 * os poucos registros lidos e responder "nenhum resultado encontrado" com a
 * mesma cara de uma busca exaustiva. Aqui cada resultado declara COMO foi obtido
 * (`alcance`) e sobre quantos registros (`amostra`), para que "não encontrei"
 * possa ser lido como "não encontrei nos N primeiros" — que é o que de fato
 * aconteceu.
 */

// Como cada entidade responde à busca textual.
export const SERVIDOR = "servidor"; // a API filtra; ausência de resultado é conclusiva
export const AMOSTRA = "amostra"; // filtro no cliente, sobre a página lida
export const SEM_FILTRO = "sem_filtro_textual"; // a API não oferece busca por texto

const ALCANCE = {
  // A API de clientes não aceita busca por nome — só documento e datas. O
  // filtro textual é feito no cliente, sobre a página lida.
  customers: AMOSTRA,
  // Credores aceitam o parâmetro `creditor`, que o servidor filtra.
  creditors: SERVIDOR,
  projects: AMOSTRA,
  enterprises: AMOSTRA,
  purchase_orders: AMOSTRA,
  bills: SEM_FILTRO,
};

// Janela padrão para títulos, relativa a hoje. Data fixa envelhece em silêncio
// e faz a busca responder sobre um período que já passou.
const JANELA_PADRAO_DIAS = 365;

function isoDate(d) {
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function janelaPadrao() {
  const hoje = new Date();
  const inicio = new Date(hoje);
  inicio.setDate(inicio.getDate() - JANELA_PADRAO_DIAS);
  return [isoDate(inicio), isoDate(hoje)];
}

/** Faz uma chamada de baixo custo à API pra confirmar que as credenciais estão válidas. */
export async function testSiengeConnection(makeRequest, config) {
  const timestamp = new Date().toISOString();
  let result;
  try {
    result = await makeRequest("GET", "/customer-types");
  } catch (exc) {
    return {
      success: false,
      message: "❌ Erro ao testar conexão",
      error: String(exc),
      timestamp,
    };
  }

  if (result.success) {
    return {
      success: true,
      message: "✅ Conexão com API do Sienge estabelecida com sucesso!",
      api_status: "Online",
      auth_method: config.SIENGE_API_KEY ? "Bearer Token" : "Basic Auth",
      timestamp,
      latency_ms: result.latency_ms,
      request_id: result.request_id,
    };
  }

  return {
    success: false,
    message: "❌ Falha ao conectar com API do Sienge",
    error: result.error,
    details: result.message,
    timestamp,
    latency_ms: result.latency_ms,
    request_id: result.request_id,
  };
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// CATÁLOGO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

const ENTITY_CATALOG = [
  {
    type: "customers",
    name: "Clientes",
    description: "Clientes cadastrados no sistema",
    busca_textual: AMOSTRA,
    observacao: "Sem busca por nome na API; filtre por cpf/cnpj para resultado conclusivo.",
    tools: ["get_sienge_customers", "search_sienge_data"],
  },
  {
    type: "creditors",
    name: "Credores/Fornecedores",
    description: "Fornecedores e credores cadastrados",
    busca_textual: SERVIDOR,
    tools: ["get_sienge_creditors", "search_sienge_data"],
  },
  {
    type: "projects",
    name: "Empreendimentos/Obras",
    description: "Projetos e obras cadastrados",
    busca_textual: AMOSTRA,
    tools: ["get_sienge_projects", "get_sienge_enterprises"],
  },
  {
    type: "purchase_orders",
    name: "Pedidos de Compra",
    description: "Pedidos de compra — etapa 4 do processo de compras",
    busca_textual: AMOSTRA,
    tools: ["get_sienge_purchase_orders", "describe_purchase_process"],
  },
  {
    type: "bills",
    name: "Títulos a Pagar",
    description: "Contas a pagar; recorte por período, sem busca textual",
    busca_textual: SEM_FILTRO,
    tools: ["get_sienge_bills", "billdebt_get_bills"],
  },
];

/** Retorna o catálogo de entidades consultáveis, com o alcance da busca em cada uma. */
export async function listSiengeEntities() {
  return {
    success: true,
    entities: ENTITY_CATALOG,
    count: ENTITY_CATALOG.length,
    observacao:
      "busca_textual indica como a entidade responde a uma busca por texto: " +
      `'${SERVIDOR}' = a API filtra e a ausência de resultado é conclusiva; ` +
      `'${AMOSTRA}' = o filtro é feito sobre a página lida, então registros fora ` +
      `dela não aparecem; '${SEM_FILTRO}' = não há busca por texto, apenas recorte.`,
  };
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// BUSCA
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

function casa(termo, ...campos) {
  const alvo = termo.toLowerCase();
  return campos.some((c) => String(c ?? "").toLowerCase().includes(alvo));
}

async function buscarCustomers(func, termo, limite) {
  const r = await func({ limit: limite, search: termo });
  return [r, r.success ? r.customers ?? [] : []];
}

async function buscarCreditors(func, termo, limite) {
  const r = await func({ limit: limite, search: termo });
  return [r, r.success ? r.creditors ?? [] : []];
}

async function buscarProjects(func, termo, limite, filtros) {
  const r = await func({ limit: limite, company_id: filtros.company_id });
  if (!r.success) return [r, []];
  let itens = r.enterprises ?? [];
  if (termo) {
    itens = itens.filter((p) => casa(termo, p.description, p.name, p.code, p.id));
  }
  return [r, itens];
}

async function buscarPurchaseOrders(func, termo, limite, filtros) {
  const r = await func({
    limit: limite,
    supplier_id: filtros.supplier_id,
    building_id: filtros.building_id,
  });
  if (!r.success) return [r, []];
  let itens = r.purchaseOrders ?? r.purchase_orders ?? [];
  if (termo) {
    itens = itens.filter((o) => casa(termo, o.notes, o.supplierName, o.id, o.purchaseOrderId));
  }
  return [r, itens];
}

async function buscarBills(func, termo, limite, filtros) {
  const [inicio, fim] = janelaPadrao();
  const r = await func({
    start_date: filtros.start_date || inicio,
    end_date: filtros.end_date || fim,
    creditor_id: filtros.creditor_id,
    limit: limite,
  });
  // Sem busca textual: o termo é ignorado de propósito, e o resultado declara
  // isso em `alcance`/`ressalva` para não passar por filtro que não houve.
  return [r, r.success ? r.bills ?? [] : []];
}

const BUSCADORES = {
  customers: buscarCustomers,
  creditors: buscarCreditors,
  projects: buscarProjects,
  enterprises: buscarProjects,
  purchase_orders: buscarPurchaseOrders,
  bills: buscarBills,
};

// Títulos ficam fora da varredura genérica: sem busca textual, entrariam como
// ruído com aparência de resultado.
export const ENTIDADES_PADRAO = ["customers", "creditors", "projects", "purchase_orders"];

/** Busca em uma entidade e devolve sempre um resultado descritivo, inclusive em falha. */
async function buscarEntidade(funcs, entidade, termo, limite, filtros) {
  const buscador = BUSCADORES[entidade];
  const func = funcs[entidade];
  if (!buscador || !func) {
    return {
      entity_type: entidade,
      success: false,
      error: `Entidade '${entidade}' não suportada`,
      supported: Object.keys(BUSCADORES).sort(),
    };
  }

  let bruto;
  let itens;
  try {
    [bruto, itens] = await buscador(func, termo, limite, filtros);
  } catch (exc) {
    return {
      entity_type: entidade,
      success: false,
      error: `${exc?.name ?? "Error"}: ${exc?.message ?? exc}`,
    };
  }

  if (!bruto.success) {
    return {
      entity_type: entidade,
      success: false,
      error: bruto.error,
      details: bruto.message,
    };
  }

  const alcance = ALCANCE[entidade] ?? AMOSTRA;
  const lidos = bruto.count ?? itens.length;
  const resultado = {
    entity_type: entidade,
    success: true,
    alcance,
    results: itens,
    count: itens.length,
  };
  if (alcance === AMOSTRA) {
    resultado.amostra = lidos;
    resultado.ressalva =
      `A API não filtra esta entidade por texto; o filtro foi aplicado sobre os ` +
      `${lidos} registro(s) lidos. Registros fora dessa amostra não aparecem — ` +
      `aumente \`limit\` ou use a tool específica, com os filtros próprios dela.`;
  } else if (alcance === SEM_FILTRO) {
    resultado.ressalva =
      "Esta entidade não tem busca textual na API: o termo foi ignorado e o " +
      "resultado é o recorte por período. Filtre por data ou por credor.";
  }
  return resultado;
}

/**
 * Busca um termo em uma ou várias entidades do Sienge.
 *
 * Cada resultado declara em `alcance` como a busca foi feita. Um "nenhum
 * resultado" só é conclusivo quando o alcance é 'servidor'; nos demais casos
 * significa "não está na amostra lida".
 *
 * Sem `entityType`, varre clientes, credores, empreendimentos e pedidos de
 * compra — quatro chamadas, disparadas em paralelo. Títulos a pagar ficam de
 * fora porque não têm busca textual: peça-os com entityType="bills" e um
 * recorte de período.
 */
export async function searchSiengeData(funcsBase, query, entityType = null, limit = 20, filters = null) {
  const limite = Math.min(limit || 20, 100);
  const filtros = filters || {};
  const funcs = {
    customers: funcsBase.customers,
    creditors: funcsBase.creditors,
    projects: funcsBase.projects,
    enterprises: funcsBase.projects,
    bills: funcsBase.bills,
    purchase_orders: funcsBase.purchase_orders,
  };

  if (entityType) {
    const resultado = await buscarEntidade(funcs, entityType, query, limite, filtros);
    resultado.query = query;
    resultado.chamadas_api = 1;
    resultado.message = resultado.success
      ? `✅ ${resultado.count} resultado(s) em ${entityType}`
      : `❌ Falha ao buscar em ${entityType}`;
    return resultado;
  }

  const alvos = [...ENTIDADES_PADRAO];
  const achados = await Promise.all(
    alvos.map((e) => buscarEntidade(funcs, e, query, limite, filtros))
  );

  const comDados = achados.filter((a) => a.success && a.count > 0);
  const vazias = achados.filter((a) => a.success && a.count === 0).map((a) => a.entity_type);
  const erros = achados
    .filter((a) => !a.success)
    .map((a) => ({ entity_type: a.entity_type, error: a.error }));

  const total = comDados.reduce((soma, a) => soma + a.count, 0);
  const parcial = achados.some((a) => a.success && a.alcance === AMOSTRA);

  let mensagem;
  if (comDados.length) {
    mensagem = `✅ '${query}' encontrou ${total} registro(s) em ${comDados.length} entidade(s)`;
  } else if (erros.length && !vazias.length) {
    mensagem = `❌ Nenhuma entidade respondeu à busca de '${query}'`;
  } else {
    mensagem = `Nenhum resultado para '${query}' nas entidades consultadas`;
  }

  return {
    // Só é falha quando nada respondeu; "não achei" é resultado válido.
    success: comDados.length > 0 || erros.length === 0,
    message: mensagem,
    query,
    total_records: total,
    results_by_entity: comDados,
    sem_resultado: vazias,
    erros,
    chamadas_api: alvos.length,
    busca_parcial: parcial,
    observacao: parcial
      ? "Parte das entidades foi filtrada no cliente, sobre a página lida — veja " +
        "`alcance` e `ressalva` em cada resultado antes de concluir que algo não existe."
      : null,
    nao_varridas: {
      bills: "sem busca textual na API; use entity_type='bills' com período",
    },
  };
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// PAGINAÇÃO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

async function paginarCustomers(func, tamanho, offset, filtros) {
  const resultado = await func({
    limit: tamanho,
    offset,
    search: filtros.search,
    customer_type_id: filtros.customer_type_id,
  });
  return [resultado, "customers"];
}

async function paginarCreditors(func, tamanho, offset, filtros) {
  return [await func({ limit: tamanho, offset, search: filtros.search }), "creditors"];
}

async function paginarProjects(func, tamanho, offset, filtros) {
  const resultado = await func({
    limit: tamanho,
    offset,
    company_id: filtros.company_id,
    enterprise_type: filtros.enterprise_type,
  });
  return [resultado, "enterprises"];
}

async function paginarBills(func, tamanho, offset, filtros) {
  const [inicio, fim] = janelaPadrao();
  const resultado = await func({
    start_date: filtros.start_date || inicio,
    end_date: filtros.end_date || fim,
    creditor_id: filtros.creditor_id,
    limit: tamanho,
    offset, // obrigatório: sem ele a API devolve sempre a primeira página
  });
  return [resultado, "bills"];
}

const PAGINADORES = {
  customers: paginarCustomers,
  creditors: paginarCreditors,
  projects: paginarProjects,
  bills: paginarBills,
};

/**
 * Devolve uma página de uma entidade do Sienge.
 *
 * A API nem sempre informa o total de registros. Quando não informa, o
 * retorno traz `total_desconhecido: true` e se apoia em `has_next`, deduzido
 * de a página ter vindo cheia — em vez de inventar um número de páginas a
 * partir do tamanho da página atual.
 */
export async function getSiengeDataPaginated(
  funcs,
  entityType,
  page = 1,
  pageSize = 20,
  filters = null,
  sortBy = null
) {
  const tamanho = Math.max(1, Math.min(pageSize, 50));
  const pagina = Math.max(1, page);
  const offset = (pagina - 1) * tamanho;
  const filtros = filters || {};

  const paginador = PAGINADORES[entityType];
  if (!paginador) {
    return {
      success: false,
      message: `❌ Entidade '${entityType}' não suportada para paginação`,
      supported_types: Object.keys(PAGINADORES).sort(),
    };
  }

  const [resultado, chave] = await paginador(funcs[entityType], tamanho, offset, filtros);
  if (!resultado.success) return resultado;

  const itens = resultado[chave] ?? resultado.data ?? [];
  const total = resultado.total ?? resultado.total_count ?? null;
  const veioCheia = itens.length >= tamanho;

  const paginacao = {
    current_page: pagina,
    page_size: tamanho,
    records_in_page: itens.length,
    has_previous: pagina > 1,
    previous_page: pagina > 1 ? pagina - 1 : null,
    has_next: veioCheia,
    next_page: veioCheia ? pagina + 1 : null,
  };
  if (total !== null && total !== undefined) {
    paginacao.total_records = total;
    paginacao.total_pages = Math.max(1, Math.ceil(Number(total) / tamanho));
  } else {
    paginacao.total_desconhecido = true;
  }

  if (sortBy) {
    paginacao.sort_by_ignorado = `'${sortBy}' não foi aplicado: a API não expõe ordenação nesta rota.`;
  }

  return {
    success: true,
    message: `✅ Página ${pagina} de ${entityType} — ${itens.length} registro(s)`,
    entity_type: entityType,
    data: itens,
    pagination: paginacao,
    filters_applied: filtros,
  };
}
