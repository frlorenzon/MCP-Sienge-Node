/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Orquestração de compras — o que os handlers de `modules/purchase.js`
 * chamam. Combina as funções cruas de `api/purchase-orders-v1.js` pra montar
 * o que uma tool de negócio precisa, numa chamada só.
 */

import {
  buscarPedidos,
  buscarItens,
  autorizarPedido,
  reprovarPedido,
} from "../api/purchase-orders-v1.js";
import {
  buscarItensDeSolicitacoes,
  buscarSolicitacao,
  criarSolicitacao,
  criarItens,
  autorizarSolicitacao,
  autorizarItens,
  reprovarSolicitacao,
  reprovarItem,
} from "../api/purchase-requests-v1.js";
import {
  buscarItensDaPlanilha,
  buscarInsumosDoOrcamento,
} from "../api/building-cost-estimations-v1.js";
import { buscarCredor, buscarCredores } from "../api/creditor-v1.js";
import { buscarCentroDeCusto, buscarCentrosDeCusto } from "../api/cost-center-v1.js";

/** Reduz um item do pedido aos campos que importam pra decidir uma aprovação. */
function resumirItem(item) {
  return {
    itemNumber: item.itemNumber,
    resource: item.resourceDescription,
    detail: item.detailDescription,
    unit: item.unitOfMeasure,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    netPrice: item.netPrice,
  };
}

/** Reduz um credor aos campos que importam pra identificar o fornecedor de um pedido. */
function resumirFornecedor(credor) {
  return { id: credor.id, name: credor.name, cnpj: credor.cnpj };
}

/**
 * Fábrica de resolvedor de fornecedor, com cache próprio por chamada.
 *
 * Cache por chamada, não em nível de módulo: dados de fornecedor podem mudar
 * entre uma chamada e outra, e um cache que sobrevive além de uma única
 * orquestração arriscaria devolver nome desatualizado sem nenhum ganho real
 * — o reaproveitamento que importa é dentro do mesmo pedido de pedidos.
 */
function criarResolverFornecedor() {
  const cache = new Map();
  return async function resolverFornecedor(supplierId) {
    if (cache.has(supplierId)) return cache.get(supplierId);

    const credorResposta = await buscarCredor(supplierId);
    const fornecedor = credorResposta.success
      ? resumirFornecedor(credorResposta.creditor)
      : { id: supplierId, name: null, cnpj: null };

    cache.set(supplierId, fornecedor);
    return fornecedor;
  };
}

/** Fábrica de resolvedor de obra, mesmo raciocínio de `criarResolverFornecedor`. */
function criarResolverObra() {
  const cache = new Map();
  return async function resolverObra(buildingId) {
    if (cache.has(buildingId)) return cache.get(buildingId);

    const centroResposta = await buscarCentroDeCusto(buildingId);
    const obra = centroResposta.success
      ? { id: buildingId, name: centroResposta.costCenter?.name ?? null }
      : { id: buildingId, name: null };

    cache.set(buildingId, obra);
    return obra;
  };
}

/**
 * Resolve um nome de fornecedor pra um supplierId único, usando a busca
 * textual que a própria API já tem (`creditor`).
 *
 * Zero ou mais de um resultado vira erro — melhor pedir precisão de quem
 * chamou do que escolher um fornecedor errado sozinho.
 */
async function resolverIdDoFornecedorPorNome(nome) {
  const resposta = await buscarCredores({ creditor: nome, limit: 10 });
  if (!resposta.success) return resposta;

  if (resposta.creditors.length === 0) {
    return {
      success: false,
      error: "FornecedorNaoEncontrado",
      message: `Nenhum fornecedor encontrado com o nome '${nome}'.`,
    };
  }
  if (resposta.creditors.length > 1) {
    return {
      success: false,
      error: "FornecedorAmbiguo",
      message: `'${nome}' encontrou ${resposta.creditors.length} fornecedores — seja mais específico.`,
      candidatos: resposta.creditors.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  return { success: true, id: resposta.creditors[0].id };
}

/**
 * Resolve um nome de obra pra um buildingId único.
 *
 * A API de centro de custo não tem busca textual (só limit/offset) — busca a
 * lista inteira (poucas dezenas nesta conta) e filtra por substring aqui.
 */
async function resolverIdDaObraPorNome(nome) {
  const resposta = await buscarCentrosDeCusto({ limit: 200 });
  if (!resposta.success) return resposta;

  const termo = nome.trim().toLowerCase();
  const encontrados = resposta.cost_centers.filter((c) => {
    const nomeCentro = c.name?.toLowerCase() ?? "";
    // Centros marcados "NÃO USAR" no próprio nome são obra desativada que a
    // conta mantém na lista por histórico — nunca é o que quem pergunta quer.
    if (nomeCentro.includes("não usar") || nomeCentro.includes("nao usar")) return false;
    return nomeCentro.includes(termo);
  });

  if (encontrados.length === 0) {
    return {
      success: false,
      error: "ObraNaoEncontrada",
      message: `Nenhuma obra encontrada com o nome '${nome}'.`,
    };
  }
  if (encontrados.length > 1) {
    return {
      success: false,
      error: "ObraAmbigua",
      message: `'${nome}' encontrou ${encontrados.length} obras — seja mais específico.`,
      candidatos: encontrados.map((c) => ({ id: c.id, name: c.name })),
    };
  }
  // Devolve o nome junto: quem confirma uma escrita precisa ver "IU.06 -
  // Residencial Ipê Uva" na prévia, não só o id 30.
  return { success: true, id: encontrados[0].id, name: encontrados[0].name };
}

/**
 * Pedidos de compra pendentes de aprovação, com os itens, o fornecedor e a
 * obra de cada um já resolvidos — pra não obrigar quem chama a encadear
 * buscarItens, buscarCredor e buscarCentroDeCusto pedido a pedido.
 *
 * "Pendente de aprovação" = `authorized: false` + `status: PENDING` +
 * `consistency: CONSISTENT`. `authorized: false` sozinho não basta — inclui
 * pedido cancelado com `disapproved:false` (em vez de true) e pedido antigo
 * com `consistent: INCONSISTENT`, inclusive um já PARTIALLY_DELIVERED, que
 * claramente já passou da fase de aprovação. Confirmado contra pedidos reais.
 * Os três filtros vão na própria requisição — a API já suporta os três
 * combinados, então não há por que buscar tudo e descartar depois.
 *
 * A obra é resolvida a partir de `buildingId` do pedido, usando a API de
 * centro de custo: nesta conta os dois IDs sempre coincidem (conferido nos
 * pedidos pendentes reais), então `buildingId` funciona como `costCenterId`.
 *
 * Sem paginação por enquanto: busca até 100 pedidos pendentes numa página só.
 * Se algum dia isso não bastar, é hora de paginar.
 */
export async function listarPedidosParaAprovacao() {
  const resposta = await buscarPedidos({
    authorized: false,
    status: "PENDING",
    consistency: "CONSISTENT",
    limit: 100,
  });
  if (!resposta.success) return resposta;

  const resolverFornecedor = criarResolverFornecedor();
  const resolverObra = criarResolverObra();

  const pedidos = [];
  for (const pedido of resposta.purchaseOrders) {
    const itensResposta = await buscarItens(pedido.id);
    const fornecedor = await resolverFornecedor(pedido.supplierId);
    const obra = await resolverObra(pedido.buildingId);

    pedidos.push({
      id: pedido.id,
      date: pedido.date,
      supplier: fornecedor,
      building: obra,
      buyerId: pedido.buyerId,
      totalAmount: pedido.totalAmount,
      paymentCondition: pedido.paymentCondition,
      items: itensResposta.success ? itensResposta.items.map(resumirItem) : [],
    });
  }

  return { success: true, count: pedidos.length, purchaseOrders: pedidos };
}

/**
 * Pedidos de compra pendentes de recebimento — já autorizados, mas ainda não
 * totalmente entregues —, opcionalmente filtrados por obra, fornecedor,
 * item, ou qualquer combinação dos três.
 *
 * "Pendente de recebimento" = `authorized: true` + `status` em PENDING ou
 * PARTIALLY_DELIVERED. A API só filtra um valor de status por chamada — não
 * uma lista —, então isso vira duas chamadas (uma por status), cada uma já
 * filtrada por obra/fornecedor quando informados. FULLY_DELIVERED e CANCELED
 * ficam de fora por definição: não há mais nada a receber.
 *
 * Filtro por item não existe na API (`buscarItens` só aceita limit/offset,
 * sem busca textual) — é aplicado aqui, depois de buscar os itens de cada
 * pedido candidato: substring, sem diferenciar maiúscula/minúscula, contra o
 * nome do insumo e o detalhe. "argamassa" bate em "Argamassa de Reboco",
 * "Argamassa Colante" etc. Pedido sem nenhum item batendo é descartado do
 * resultado.
 *
 * `building` ou `supplier` — ao menos um dos dois é obrigatório, por nome
 * (não ID: quem chama não tem como saber o ID numérico). Sem nenhum filtro,
 * a varredura chega a centenas de pedidos e a dezenas de segundos, porque
 * cada pedido exige uma chamada extra pra ler os itens.
 *
 * Nome que bate em mais de um fornecedor/obra, ou em nenhum, vira erro —
 * ver `resolverIdDoFornecedorPorNome`/`resolverIdDaObraPorNome`.
 *
 * @param {object} opcoes
 * @param {string} [opcoes.building] nome (ou parte) da obra
 * @param {string} [opcoes.supplier] nome (ou parte) do fornecedor
 * @param {string} [opcoes.item] busca textual no nome/detalhe do insumo
 */
export async function listarPedidosPendentesRecebimento({ building, supplier, item } = {}) {
  if (!building && !supplier) {
    return {
      success: false,
      error: "FiltroObrigatorio",
      message:
        "Informe ao menos obra (building) ou fornecedor (supplier). Sem um dos dois, " +
        "a busca varreria centenas de pedidos.",
    };
  }

  let buildingId, supplierId;

  if (building) {
    const resolvidoObra = await resolverIdDaObraPorNome(building);
    if (!resolvidoObra.success) return resolvidoObra;
    buildingId = resolvidoObra.id;
  }

  if (supplier) {
    const resolvidoFornecedor = await resolverIdDoFornecedorPorNome(supplier);
    if (!resolvidoFornecedor.success) return resolvidoFornecedor;
    supplierId = resolvidoFornecedor.id;
  }

  const filtrosComuns = {
    authorized: true,
    limit: 100,
    ...(buildingId != null ? { buildingId } : {}),
    ...(supplierId != null ? { supplierId } : {}),
  };

  const [resPendentes, resParciais] = await Promise.all([
    buscarPedidos({ ...filtrosComuns, status: "PENDING" }),
    buscarPedidos({ ...filtrosComuns, status: "PARTIALLY_DELIVERED" }),
  ]);
  if (!resPendentes.success) return resPendentes;
  if (!resParciais.success) return resParciais;

  const candidatos = [...resPendentes.purchaseOrders, ...resParciais.purchaseOrders];
  const termoBusca = item?.trim().toLowerCase();

  const resolverFornecedor = criarResolverFornecedor();
  const resolverObra = criarResolverObra();

  const pedidos = [];
  for (const pedido of candidatos) {
    const itensResposta = await buscarItens(pedido.id);
    let itens = itensResposta.success ? itensResposta.items : [];

    if (termoBusca) {
      itens = itens.filter(
        (i) =>
          i.resourceDescription?.toLowerCase().includes(termoBusca) ||
          i.detailDescription?.toLowerCase().includes(termoBusca)
      );
      if (itens.length === 0) continue;
    }

    const fornecedor = await resolverFornecedor(pedido.supplierId);
    const obra = await resolverObra(pedido.buildingId);

    pedidos.push({
      id: pedido.id,
      date: pedido.date,
      status: pedido.status,
      supplier: fornecedor,
      building: obra,
      buyerId: pedido.buyerId,
      totalAmount: pedido.totalAmount,
      paymentCondition: pedido.paymentCondition,
      items: itens.map(resumirItem),
    });
  }

  return { success: true, count: pedidos.length, purchaseOrders: pedidos };
}


// =========================================================
// SOLICITAÇÕES DE COMPRA (ETAPA 1/2 DO PROCESSO)
// =========================================================

// A API de solicitações não tem listagem de solicitações — só de itens. Por
// isso o cabeçalho de cada solicitação é remontado aqui a partir dos itens, e
// só se busca por id quando o item não trouxe o que era preciso.
//
// Leitura por lista de candidatos, e não por nome fixo: o spec do Sienge
// nomeia o mesmo conceito de formas diferentes conforme o recurso — a unidade
// de medida é `unitOfMeasure` no item de PEDIDO e `unitySymbol` no item de
// SOLICITAÇÃO. Com todos os nomes plausíveis na lista, o que estiver presente
// resolve; o que faltar vira undefined e a solicitação continua aparecendo,
// em vez de a lista inteira sair vazia por um nome errado.

// Nomes de campo conferidos contra o OpenAPI publicado do Sienge (schemas
// PurchaseRequestItem e PurchaseRequest), não inferidos — por isso a leitura
// aqui é direta, sem lista de candidatos.
//
// `productDescription` e `detailDescription` coexistem e são coisas
// diferentes: o insumo e o detalhamento dele. Vão os dois, como `resumirItem`
// já faz com os itens de pedido — escolher um descartaria informação que quem
// aprova usa.
//
// Do DTO ficam de fora, de propósito: `links` e `tenantUrl` (navegação),
// `disapprovalReason` (só tem valor em item reprovado, e a fila filtra
// disapproved:false) e `authorized`/`disapproved` (constantes na fila: são o
// próprio filtro).

// notes do item e da solicitação aceitam 4000 caracteres cada. Numa lista de
// dezenas de itens isso domina o resultado sem acrescentar quase nada à
// decisão — corta com reticências e quem quiser o texto inteiro lê o registro.
const NOTAS_MAX = 300;

function encurtar(texto) {
  if (!texto) return undefined;
  const limpo = String(texto).trim();
  return limpo.length <= NOTAS_MAX ? limpo : `${limpo.slice(0, NOTAS_MAX)}…`;
}

/**
 * Traduz `competenceLevel` do item, que o spec define como a alçada de
 * autorização já vencida: 0 = nenhuma, 1 = primeira, 2 = segunda, vazio =
 * fora do processo de autorização. Sem isso o número sozinho não diz nada a
 * quem lê o resultado.
 */
function descreverAlcada(nivel) {
  if (nivel === null || nivel === undefined) return "fora do processo de autorização";
  if (nivel === 0) return "sem autorização em nenhuma alçada";
  if (nivel === 1) return "autorizado em 1ª alçada";
  if (nivel === 2) return "autorizado em 2ª alçada";
  return `alçada ${nivel}`;
}

/** Reduz um item de solicitação ao que importa pra decidir a aprovação. */
function resumirItemDeSolicitacao(item) {
  const resumo = {
    itemNumber: item.itemNumber,
    productId: item.productId,
    product: item.productDescription,
    detail: item.detailDescription,
    quantity: item.quantity,
    unit: item.unitySymbol,
    competenceLevel: item.competenceLevel ?? null,
    approvalStage: descreverAlcada(item.competenceLevel),
  };

  if (item.trademarkDescription) resumo.trademark = item.trademarkDescription;
  if (item.estimatedDeliveryTime) resumo.estimatedDeliveryTimeDays = item.estimatedDeliveryTime;

  const notas = encurtar(item.notes);
  if (notas) resumo.notes = notas;

  // NÃO há preço nesta etapa. `estimatedPrice` é estimativa do solicitante e
  // vem 0 quando ninguém preencheu — nesse caso é ruído, não informação. Entra
  // só com esse nome, nunca como `unitPrice`, pra não virar valor negociado.
  // Ver `knowledge/purchaseProcess.js`, etapa 1.
  if (Number(item.estimatedPrice) > 0) resumo.estimatedPrice = item.estimatedPrice;

  return resumo;
}

const LIMITE_POR_PAGINA = 200;
// Teto de segurança: 5 páginas de 200 itens. Um item pendente pode estar na
// página seguinte à do resto da sua solicitação, então parar no meio
// mostraria a solicitação com menos itens do que ela tem — daí paginar até o
// fim em vez de ler só a primeira página, e avisar em `truncated` quando o
// teto for atingido.
const MAX_PAGINAS = 5;

/**
 * Solicitações de compra pendentes de aprovação, agrupadas por solicitação.
 *
 * ETAPA 2 do processo de compras — ver `knowledge/purchaseProcess.js`.
 *
 * "Pendente de aprovação" = `authorized: false` + `disapproved: false` +
 * `purchaseRequestStatus: PENDING` + `purchaseRequestConsistency: CONSISTENT`.
 * `authorized: false` sozinho não basta: traz também item já reprovado e
 * solicitação inconsistente ou já atendida por um pedido, que não estão
 * esperando decisão de ninguém. Os quatro filtros vão na própria requisição.
 *
 * ATENÇÃO ao que o agrupamento significa: no Sienge a aprovação é item a
 * item, e `authorized`/`disapproved` filtram ITENS, não solicitações. Logo
 * cada entrada aqui é uma solicitação com AO MENOS UM item pendente, e
 * `items` traz só os itens pendentes dela — não a solicitação inteira. Uma
 * solicitação parcialmente aprovada aparece com os itens que faltam decidir.
 * `itemCount` conta o que está pendente, não o tamanho da solicitação.
 *
 * O item não traz nada do cabeçalho — data, solicitante e obra só existem em
 * GET /purchase-requests/{id}. Por isso os itens são agrupados ANTES de
 * buscar cabeçalho: assim é uma chamada por solicitação, não por item.
 *
 * Ordena da mais antiga para a mais recente: numa fila de aprovação, o que
 * espera há mais tempo é o que precisa ser visto primeiro.
 */
export async function listarSolicitacoesParaAprovacao() {
  const itens = [];
  let total = null;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const resposta = await buscarItensDeSolicitacoes({
      authorized: false,
      disapproved: false,
      purchaseRequestStatus: "PENDING",
      purchaseRequestConsistency: "CONSISTENT",
      limit: LIMITE_POR_PAGINA,
      offset: pagina * LIMITE_POR_PAGINA,
    });
    if (!resposta.success) return resposta;

    itens.push(...resposta.items);
    total = resposta.total ?? itens.length;

    if (resposta.items.length === 0 || itens.length >= total) break;
  }

  const truncado = total !== null && itens.length < total;

  // Agrupa preservando a ordem de chegada; a ordenação por data vem depois.
  const grupos = new Map();
  for (const item of itens) {
    const id = item.purchaseRequestId;
    if (id === undefined || id === null) continue;
    if (!grupos.has(id)) grupos.set(id, []);
    grupos.get(id).push(item);
  }

  const resolverObra = criarResolverObra();
  const solicitacoes = [];

  for (const [id, itensDoGrupo] of grupos) {
    // Uma chamada por solicitação — não por item. O item não carrega nada do
    // cabeçalho, então não há como evitá-la; agrupar antes de buscar é o que
    // mantém o custo no número de solicitações e não no de itens.
    const cabecalho = await buscarSolicitacao(id);
    const dados = cabecalho.success ? (cabecalho.purchaseRequest ?? {}) : {};

    // Rascunho não está esperando decisão de ninguém: quem o criou ainda não
    // o submeteu. O endpoint de itens não filtra por isso, então o descarte é
    // aqui. Com o parâmetro de sistema 1284 desligado o campo é sempre false,
    // e o filtro não tira nada.
    if (dados.draft === true) continue;

    solicitacoes.push({
      id,
      requestDate: dados.requestDate,
      requesterUser: dados.requesterUser,
      building: dados.buildingId === undefined ? null : await resolverObra(dados.buildingId),
      departmentId: dados.departamentId,
      ...(encurtar(dados.notes) ? { notes: encurtar(dados.notes) } : {}),
      itemCount: itensDoGrupo.length,
      items: itensDoGrupo.map(resumirItemDeSolicitacao),
    });
  }

  // Sem data não dá pra ordenar; essas vão pro fim em vez de bagunçar a fila.
  solicitacoes.sort((a, b) => String(a.requestDate ?? "9999").localeCompare(String(b.requestDate ?? "9999")));

  const resultado = {
    success: true,
    count: solicitacoes.length,
    itemCount: solicitacoes.reduce((soma, s) => soma + s.itemCount, 0),
    aviso:
      "Solicitação de compra não tem preço negociado — só quantidade e unidade. " +
      "A aprovação é item a item: `items` traz apenas os itens pendentes de cada " +
      "solicitação, não a solicitação inteira.",
    purchaseRequests: solicitacoes,
  };

  if (truncado) {
    resultado.truncated = true;
    resultado.message =
      `Foram lidos ${itens.length} de ${total} itens pendentes (teto de ` +
      `${MAX_PAGINAS} páginas). Há solicitações fora desta lista.`;
  }

  // Diagnóstico: se nem descrição nem quantidade foram reconhecidas, o DTO
  // mudou de nome. Devolver as chaves reais é mais útil que campos vazios.
  const primeiroItem = itens[0];
  if (primeiroItem && primeiroItem.productDescription === undefined &&
      primeiroItem.quantity === undefined) {
    resultado.camposNaoReconhecidos = Object.keys(primeiroItem);
  }

  return resultado;
}

// =========================================================
// CRIAÇÃO DE SOLICITAÇÃO (ETAPA 1 DO PROCESSO)
// =========================================================
// Quem pede fala em nomes — "obra iu.06", "tubo de esgoto", "instalações
// hidráulicas". O POST quer buildingId, productId, detailId e wbsCode. A
// tradução acontece TODA aqui dentro, numa chamada só: se ela virasse uma
// sequência de tools ("resolve obra", "resolve insumo", "resolve
// apropriação", "cria"), cada passo reenviaria a conversa inteira e a criação
// de uma solicitação custaria mais contexto que a decisão que ela apoia.

const DIAS_ATE_ENTREGA_PADRAO = 7;
const PAGINA = 200;
const MAX_PAGINAS_ORCAMENTO = 25; // 5000 itens de planilha

/** Data de hoje em yyyy-MM-dd, no fuso local — a API não aceita timestamp. */
function hoje() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function somarDias(iso, dias) {
  // Meio-dia, e não meia-noite: evita que o ajuste de fuso jogue a data para
  // o dia anterior.
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + dias);
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/**
 * Normaliza texto para casamento: sem acento, sem caixa, sem espaço dobrado.
 * "Instalações Hidráulicas" e "instalacoes hidraulicas" têm que casar — quem
 * digita o nome de um item de orçamento não repete a acentuação do cadastro.
 */
function normalizar(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Casa um termo contra uma lista de candidatos, devolvendo um só ou o erro
 * com as opções.
 *
 * Igualdade exata vence substring: "canteiro" contra "Canteiro" e "Canteiro
 * de Obras" resolve no primeiro em vez de virar ambiguidade. Sem essa regra,
 * o nome mais curto de um cadastro nunca seria selecionável, e cada tentativa
 * custaria mais um turno do modelo.
 */
function casarUnico(termo, candidatos, descrever, oQue) {
  const alvo = normalizar(termo);
  if (!alvo) {
    return { success: false, error: "TermoVazio", message: `Termo de busca vazio para ${oQue}.` };
  }

  const exatos = candidatos.filter((c) => normalizar(descrever(c).texto) === alvo);
  const escolhidos = exatos.length ? exatos : candidatos.filter((c) => normalizar(descrever(c).texto).includes(alvo));

  if (escolhidos.length === 0) {
    return { success: false, error: "NaoEncontrado", message: `Nada em ${oQue} bate com '${termo}'.` };
  }
  if (escolhidos.length > 1) {
    return {
      success: false,
      error: "Ambiguo",
      message: `'${termo}' bateu em ${escolhidos.length} ${oQue} — seja mais específico.`,
      candidatos: escolhidos.slice(0, 15).map(descrever),
    };
  }
  return { success: true, valor: escolhidos[0] };
}

/**
 * Cache do orçamento da obra, com TTL curto.
 *
 * Diferente do cache por chamada de fornecedor/obra: orçamento é lido duas
 * vezes no fluxo normal — uma na prévia e outra na confirmação —, e uma
 * planilha grande custa dezenas de páginas. Guardar por alguns minutos faz a
 * confirmação não repetir a varredura. TTL curto porque orçamento é editável.
 */
const TTL_ORCAMENTO_MS = 10 * 60 * 1000;
const cacheOrcamento = new Map();

async function comCache(chave, produzir) {
  const agora = Date.now();
  const guardado = cacheOrcamento.get(chave);
  if (guardado && agora - guardado.em < TTL_ORCAMENTO_MS) return guardado.valor;

  const valor = await produzir();
  if (valor.success) cacheOrcamento.set(chave, { em: agora, valor });
  return valor;
}

/**
 * Profundidade de um item na EAP, contada pelos segmentos do wbsCode:
 * "02.032" é nível 2, "01.001.000.001" é nível 4.
 */
function nivelDoWbs(wbsCode) {
  return String(wbsCode ?? "").split(".").filter(Boolean).length;
}

/**
 * Nível da EAP em que a obra apropria, vindo do ambiente.
 *
 * Não é escolha do assistente nem do usuário: é parametrização do Sienge, e
 * varia por instalação. Configurado, ele faz duas coisas — restringe o
 * casamento aos itens daquele nível (apropriar num nível errado é erro de
 * cadastro, não preferência) e encolhe a lista devolvida quando nada bate, a
 * ponto de ela caber na resposta. Sem configurar, todos os níveis valem.
 *
 * Lido a cada chamada, e não uma vez na carga do módulo: um teste precisa
 * poder trocar o valor sem reimportar.
 */
function nivelDeApropriacao() {
  const bruto = Number(process.env.SIENGE_NIVEL_APROPRIACAO);
  return Number.isInteger(bruto) && bruto > 0 ? bruto : null;
}

/** Máximo de itens de orçamento devolvidos numa pendência. */
const MAX_ITENS_SUGERIDOS = 80;

/** Varre todas as páginas de um endpoint paginado do orçamento. */
async function varrer(buscar, chave) {
  const acumulado = [];
  for (let pagina = 0; pagina < MAX_PAGINAS_ORCAMENTO; pagina++) {
    const resposta = await buscar({ limit: PAGINA, offset: pagina * PAGINA });
    if (!resposta.success) return resposta;

    acumulado.push(...resposta[chave]);
    const total = resposta.total ?? acumulado.length;
    if (resposta[chave].length === 0 || acumulado.length >= total) break;
  }
  return { success: true, [chave]: acumulado };
}

/**
 * Resolve o insumo (e o detalhe, quando informado) dentro do orçamento da obra.
 *
 * Insumo e detalhe são coisas distintas no Sienge: "tubo de esgoto" é o
 * insumo, `2"` é um detalhe DELE. Por isso o detalhe é procurado dentro de
 * `details[]` do insumo já escolhido, e não como um segundo insumo — procurar
 * `2"` no cadastro geral acharia meia dúzia de coisas sem relação.
 */
async function resolverInsumo(buildingId, insumo, detalhe) {
  const varredura = await comCache(`resources:${buildingId}`, () =>
    varrer((pag) => buscarInsumosDoOrcamento(buildingId, pag), "resources")
  );
  if (!varredura.success) return varredura;

  const achado = casarUnico(
    insumo,
    varredura.resources,
    (r) => ({ texto: r.description, productId: r.id, unit: r.unitOfMeasure, code: r.resourceCode }),
    "insumos do orçamento da obra"
  );
  if (!achado.success) return achado;

  const recurso = achado.valor;
  const resolvido = {
    success: true,
    productId: recurso.id,
    product: recurso.description,
    unitySymbol: recurso.unitOfMeasure,
  };

  if (!detalhe) {
    // Detalhe é opcional no payload, mas se o insumo TEM detalhes cadastrados
    // e nenhum foi pedido, avisa em vez de escolher um — a escolha muda o que
    // vai ser comprado.
    const ativos = (recurso.details ?? []).filter((d) => d.status !== "INACTIVE");
    if (ativos.length) {
      resolvido.avisoDetalhe =
        `O insumo '${recurso.description}' tem ${ativos.length} detalhe(s) cadastrado(s) ` +
        `e nenhum foi informado: ${ativos.slice(0, 10).map((d) => d.description).join(", ")}.`;
    }
    return resolvido;
  }

  const achadoDetalhe = casarUnico(
    detalhe,
    (recurso.details ?? []).filter((d) => d.status !== "INACTIVE"),
    (d) => ({ texto: d.description, detailId: d.id, code: d.detailCode }),
    `detalhes do insumo '${recurso.description}'`
  );
  if (!achadoDetalhe.success) return achadoDetalhe;

  resolvido.detailId = achadoDetalhe.valor.id;
  resolvido.detail = achadoDetalhe.valor.description;
  return resolvido;
}


/**
 * Resolve os nomes das apropriações para os `wbsCode` da planilha.
 *
 * COLETA TODOS OS PROBLEMAS em vez de parar no primeiro: se duas apropriações
 * estão ambíguas, quem chamou precisa saber das duas numa resposta só. Parar
 * na primeira faria o usuário ser consultado uma vez por erro, e cada consulta
 * é um turno do modelo reenviando a conversa inteira.
 *
 * A planilha é varrida uma vez e reaproveitada por todas as apropriações da
 * mesma chamada.
 */
/**
 * Lê a planilha da unidade construtiva e devolve os itens elegíveis para
 * apropriação, já restritos ao nível configurado.
 */
async function itensApropriaveis(buildingId, buildingUnitId) {
  const varredura = await comCache(`sheet:${buildingId}:${buildingUnitId}`, () =>
    varrer((pag) => buscarItensDaPlanilha(buildingId, buildingUnitId, pag), "items")
  );
  if (!varredura.success) return varredura;

  const nivel = nivelDeApropriacao();
  const itens = nivel ? varredura.items.filter((i) => nivelDoWbs(i.wbsCode) === nivel) : varredura.items;
  return { success: true, items: itens, nivel, totalNaPlanilha: varredura.items.length };
}

/**
 * Catálogo enxuto para o modelo escolher quando o nome não bate literalmente.
 *
 * A tool não tem como saber que "hidrossanitárias" é "Instalações de
 * Incêndio, Água e Esgoto" — casar substring não resolve sinônimo. O modelo
 * sabe, desde que veja o vocabulário. Então em vez de devolver um "não
 * encontrei" que empurra a pergunta para o usuário, a pendência leva a lista.
 */
function catalogo(itens) {
  return itens
    .slice(0, MAX_ITENS_SUGERIDOS)
    .map((i) => ({ wbsCode: i.wbsCode, description: i.description }));
}

function comoEscolher(itens, nivel) {
  const escopo = nivel ? `de nível ${nivel}` : "da planilha";
  const corte =
    itens.length > MAX_ITENS_SUGERIDOS
      ? ` (mostrando ${MAX_ITENS_SUGERIDOS} de ${itens.length})`
      : "";
  return (
    `Itens ${escopo} disponíveis${corte} em 'itens_disponiveis'. Identifique qual ` +
    `corresponde ao que foi pedido — inclusive por sinônimo, como 'hidrossanitária' ` +
    `para 'Água e Esgoto' — CONFIRME com o usuário e repita a chamada usando a ` +
    `description exata (ou o wbsCode). Não peça ao usuário que adivinhe o nome.`
  );
}

async function resolverApropriacoes(buildingId, buildingUnitId, apropriacoes, prefixo = "") {
  const planilha = await itensApropriaveis(buildingId, buildingUnitId);
  if (!planilha.success) {
    return {
      resolvidas: [],
      pendencias: [
        {
          campo: "unidade_construtiva",
          tipo: "ConsultaFalhou",
          message:
            `Não foi possível ler a planilha da unidade construtiva ${buildingUnitId} ` +
            `da obra ${buildingId}: ${planilha.details ?? planilha.message}`,
        },
      ],
    };
  }

  const varredura = { items: planilha.items };

  if (varredura.items.length === 0) {
    return {
      resolvidas: [],
      pendencias: [
        {
          campo: "unidade_construtiva",
          tipo: "SemItensNoNivel",
          message:
            `A planilha da unidade construtiva ${buildingUnitId} tem ` +
            `${planilha.totalNaPlanilha} item(ns), mas nenhum no nível ` +
            `${planilha.nivel} exigido por SIENGE_NIVEL_APROPRIACAO. Confira a ` +
            `unidade construtiva ou o nível configurado.`,
        },
      ],
    };
  }

  const resolvidas = [];
  const pendencias = [];

  for (const [posicao, pedida] of apropriacoes.entries()) {
    // O wbsCode identifica o item sem ambiguidade, e é o que a pendência
    // oferece de volta quando o nome não bate. Tentar por ele primeiro fecha
    // o ciclo: o modelo lê "02.032" no catálogo e devolve "02.032".
    const porCodigo = varredura.items.find(
      (i) => normalizar(i.wbsCode) === normalizar(pedida.item)
    );
    if (porCodigo) {
      resolvidas.push({
        buildingUnitId,
        costEstimationItemReference: porCodigo.wbsCode,
        percentage: Number(pedida.percentual),
        _descricao: porCodigo.description,
      });
      continue;
    }

    const achado = casarUnico(
      pedida.item,
      varredura.items,
      (i) => ({ texto: i.description, wbsCode: i.wbsCode, unit: i.unitOfMeasure }),
      `itens da planilha ${buildingUnitId}`
    );

    if (!achado.success) {
      const naoAchou = achado.error === "NaoEncontrado";
      pendencias.push({
        campo: `${prefixo}apropriacoes[${posicao}].item`,
        termo: pedida.item,
        tipo: achado.error,
        message: naoAchou
          ? `${achado.message} ${comoEscolher(varredura.items, planilha.nivel)}`
          : achado.message,
        ...(achado.candidatos ? { candidatos: achado.candidatos } : {}),
        // Só na ausência de correspondência: quando houve ambiguidade os
        // candidatos já bastam, e repetir a planilha inteira seria ruído.
        ...(naoAchou ? { itens_disponiveis: catalogo(varredura.items) } : {}),
      });
      continue;
    }

    resolvidas.push({
      buildingUnitId,
      costEstimationItemReference: achado.valor.wbsCode,
      percentage: Number(pedida.percentual),
      // Só para a prévia: o nome não vai no payload, mas é o que deixa você
      // conferir que o código certo foi escolhido.
      _descricao: achado.valor.description,
    });
  }

  // Só cobra o fechamento em 100% quando todas resolveram — reclamar da soma
  // de um rateio que ainda tem item não identificado seria ruído.
  if (pendencias.length === 0) {
    const soma = apropriacoes.reduce((t, a) => t + Number(a.percentual ?? 0), 0);
    // Tolerância de 1 centésimo: 1/3 + 1/3 + 1/3 nunca fecha exato.
    if (Math.abs(soma - 100) > 0.01) {
      pendencias.push({
        campo: `${prefixo}apropriacoes`,
        tipo: "PercentuaisNaoFecham",
        message: `Os percentuais somam ${soma}%, e precisam somar 100%.`,
      });
    }
  }

  return { resolvidas, pendencias };
}


/**
 * Resolve um item pedido: insumo, detalhe, quantidade e apropriações.
 *
 * Devolve o item pronto para o payload, o retrato dele para a prévia e as
 * pendências nomeadas com o índice — `itens[2].quantidade` diz de qual item a
 * cobrança é, sem o que uma solicitação de dez insumos vira dez perguntas
 * indistinguíveis.
 */
async function resolverItemPedido(buildingId, unidadeConstrutiva, pedido, indice, padroes) {
  const prefixo = `itens[${indice}].`;
  const pendencias = [];

  if (!pedido?.insumo) {
    pendencias.push({
      campo: `${prefixo}insumo`,
      tipo: "Faltando",
      message: "Informe o insumo. Ele é procurado no orçamento desta obra.",
    });
  }

  const achado = pedido?.insumo
    ? await resolverInsumo(buildingId, pedido.insumo, pedido.detalhe)
    : null;

  let dadosInsumo;
  if (achado?.success) {
    dadosInsumo = achado;
    if (achado.avisoDetalhe) {
      pendencias.push({ campo: `${prefixo}detalhe`, tipo: "Aviso", message: achado.avisoDetalhe });
    }
  } else if (achado) {
    pendencias.push({
      campo: pedido.detalhe && achado.message?.includes("detalhes do insumo")
        ? `${prefixo}detalhe`
        : `${prefixo}insumo`,
      termo: pedido.insumo,
      tipo: achado.error,
      message: achado.message,
      ...(achado.candidatos ? { candidatos: achado.candidatos } : {}),
    });
  }

  // A UNIDADE SÓ É CONHECIDA DEPOIS DE RESOLVER O INSUMO. Cobrar quantidade
  // antes obriga a mensagem a ser genérica, e quem lê inventa a unidade —
  // pede metros de um insumo vendido em peça de 6 m.
  const unidadeDoInsumo = dadosInsumo?.unitySymbol;
  const comoChamar = dadosInsumo
    ? `'${dadosInsumo.product}'` + (dadosInsumo.detail ? ` detalhe '${dadosInsumo.detail}'` : "")
    : "o insumo";

  if (!(Number(pedido?.quantidade) > 0)) {
    pendencias.push({
      campo: `${prefixo}quantidade`,
      tipo: "Faltando",
      ...(unidadeDoInsumo ? { unidade_do_insumo: unidadeDoInsumo } : {}),
      message: unidadeDoInsumo
        ? `${comoChamar} é solicitado em '${unidadeDoInsumo}'. Pergunte a quantidade ao ` +
          `usuário EM '${unidadeDoInsumo}', dizendo a unidade na pergunta — não ofereça ` +
          `outra (metros, quilos, sacos). Se ele responder noutra unidade, pergunte a ` +
          `equivalência em vez de supor.`
        : "Informe a quantidade. A unidade correta só pode ser dita depois que o insumo " +
          "for identificado.",
    });
  }

  let avisoUnidade;
  if (pedido?.unidade && unidadeDoInsumo && normalizar(pedido.unidade) !== normalizar(unidadeDoInsumo)) {
    avisoUnidade =
      `⚠️ Você informou a quantidade em '${pedido.unidade}', mas ${comoChamar} é solicitado ` +
      `em '${unidadeDoInsumo}'. Os ${pedido.quantidade} serão gravados como ` +
      `'${unidadeDoInsumo}'. Confirme a conversão antes de prosseguir.`;
  }

  // Rateio próprio do item, ou o da solicitação. Itens de uma mesma
  // solicitação quase sempre vão para a mesma apropriação: repetir o rateio
  // em cada item seria custo de schema sem informação nova.
  const rateioPedido = pedido?.apropriacoes?.length ? pedido.apropriacoes : padroes.apropriacoes;
  let apropriacoesResolvidas = [];

  if (!rateioPedido?.length) {
    const planilha = await itensApropriaveis(buildingId, unidadeConstrutiva);
    const temItens = planilha.success && planilha.items.length > 0;
    pendencias.push({
      campo: `${prefixo}apropriacoes`,
      tipo: "Faltando",
      message:
        `Informe o rateio por item de orçamento, com percentuais somando 100 — no item ` +
        `ou, se valer para todos, uma vez só no nível da solicitação. ` +
        (temItens
          ? comoEscolher(planilha.items, planilha.nivel)
          : `Os itens são procurados na planilha da unidade construtiva ${unidadeConstrutiva}.`),
      ...(temItens ? { itens_disponiveis: catalogo(planilha.items) } : {}),
    });
  } else {
    const resultado = await resolverApropriacoes(
      buildingId,
      unidadeConstrutiva,
      rateioPedido,
      // Rateio herdado da solicitação: a pendência aponta para o nível dela,
      // senão o usuário corrigiria o mesmo erro uma vez por item.
      pedido?.apropriacoes?.length ? prefixo : ""
    );
    apropriacoesResolvidas = resultado.resolvidas;
    pendencias.push(...resultado.pendencias);
  }

  if (!dadosInsumo || !(Number(pedido?.quantidade) > 0) || !apropriacoesResolvidas.length) {
    return { pendencias };
  }

  const quantidade = Number(pedido.quantidade);
  const item = {
    productId: dadosInsumo.productId,
    quantity: quantidade,
    unitySymbol: dadosInsumo.unitySymbol,
    buildingsApropriations: apropriacoesResolvidas.map(({ _descricao, ...a }) => a),
    deliveryRequirements: [
      { requirementDate: padroes.dataDeEntrega, requirementQuantity: quantidade },
    ],
  };
  if (dadosInsumo.detailId !== undefined) item.detailId = dadosInsumo.detailId;
  if (pedido.observacao) item.notes = pedido.observacao;

  const retrato = {
    resumo: `${quantidade} ${dadosInsumo.unitySymbol} de ${comoChamar}`,
    productId: dadosInsumo.productId,
    product: dadosInsumo.product,
    ...(dadosInsumo.detail ? { detailId: dadosInsumo.detailId, detail: dadosInsumo.detail } : {}),
    quantity: quantidade,
    unit: dadosInsumo.unitySymbol,
    apropriacoes: apropriacoesResolvidas.map((a) => ({
      costEstimationItemReference: a.costEstimationItemReference,
      description: a._descricao,
      percentage: a.percentage,
    })),
    ...(pedido.observacao ? { observacao: pedido.observacao } : {}),
    ...(avisoUnidade ? { avisoUnidade } : {}),
  };

  return { pendencias, item, retrato };
}

/**
 * Cria uma solicitação de compra a partir de nomes, com prévia obrigatória.
 *
 * ETAPA 1 do processo de compras — ver `knowledge/purchaseProcess.js`. Criar
 * NÃO aprova: a solicitação nasce aguardando decisão de outra pessoa.
 *
 * UMA SOLICITAÇÃO CARREGA VÁRIOS ITENS, que é como o Sienge a modela: o POST
 * de itens recebe uma lista. Por isso `itens` é um array mesmo quando há um
 * insumo só — pedir três insumos numa chamada, e não em três, é a diferença
 * entre uma solicitação com três itens e três solicitações soltas.
 *
 * RESOLVE TUDO ANTES DE COBRAR QUALQUER COISA. Só a obra é bloqueante, porque
 * insumo e planilha vivem dentro dela; do resto, devolve TODAS as pendências
 * de uma vez, de todos os itens, cada uma nomeada com o índice do item a que
 * pertence.
 *
 * `apropriacoes` no nível da solicitação vale para todo item que não trouxer o
 * seu — itens de uma mesma solicitação quase sempre rateiam igual.
 *
 * `confirmar: false` (o padrão) monta o payload e devolve a prévia SEM
 * escrever. `confirmar: true` repete a resolução — de cache, se dentro da
 * janela — e executa.
 *
 * NÃO É ATÔMICO: a API cria o cabeçalho num POST e os itens em outro. Se o
 * segundo falhar, sobra uma solicitação sem itens no Sienge, e o retorno diz
 * qual id ficou pendente — não há DELETE de solicitação no spec.
 *
 * @param {object} args
 * @param {string} args.obra nome (ou parte) da obra
 * @param {Array<object>} args.itens insumos pedidos; cada um com `insumo`,
 *   `quantidade` e, opcionalmente, `detalhe`, `unidade`, `apropriacoes` e
 *   `observacao`
 * @param {Array<{item: string, percentual: number}>} [args.apropriacoes] rateio
 *   padrão, usado pelos itens que não trouxerem o seu
 * @param {number} [args.unidade_construtiva=1] código da unidade construtiva
 * @param {number} [args.dias_para_entrega=7] prazo da necessidade de entrega
 * @param {string} [args.observacao] observação da solicitação
 * @param {boolean} [args.confirmar=false] executa de fato
 */
export async function criarSolicitacaoDeCompra({
  obra,
  itens,
  apropriacoes,
  unidade_construtiva = 1,
  dias_para_entrega = DIAS_ATE_ENTREGA_PADRAO,
  observacao,
  confirmar = false,
} = {}) {
  const solicitante = (process.env.SIENGE_SOLICITANTE || "").trim();
  // Quem CADASTRA, que o Sienge exige à parte de quem PEDE. Na operação normal
  // é a mesma pessoa, então o padrão é o solicitante e ninguém configura nada.
  const cadastrante = (process.env.SIENGE_CADASTRANTE || "").trim() || solicitante;

  // Departamento e categoria são opcionais no spec, mas a parametrização do
  // Sienge pode exigi-los. Constantes da instalação, então vêm do ambiente e
  // não custam nada no schema. Vazios, não vão no corpo.
  const departamento = Number(process.env.SIENGE_DEPARTAMENTO) || undefined;
  const categoria = Number(process.env.SIENGE_CATEGORIA) || undefined;

  if (!solicitante) {
    return {
      success: false,
      error: "SolicitanteNaoConfigurado",
      message:
        "SIENGE_SOLICITANTE não está configurado no .env — é o usuário do Sienge que " +
        "assina a solicitação, e a API o exige.",
    };
  }

  // A obra é a única pendência que impede o resto: insumo e planilha são
  // consultados DENTRO dela.
  if (!obra) {
    return {
      success: false,
      error: "ObraNaoInformada",
      message: "Informe a obra — insumo e apropriações são procurados dentro dela.",
    };
  }
  const resolvidaObra = await resolverIdDaObraPorNome(obra);
  if (!resolvidaObra.success) return resolvidaObra;
  const buildingId = resolvidaObra.id;

  if (!itens?.length) {
    return {
      success: false,
      error: "ItensNaoInformados",
      message:
        "Informe ao menos um item em `itens`. Uma solicitação comporta vários insumos — " +
        "junte todos numa chamada só, em vez de criar uma solicitação por insumo.",
      resolvido: { obra: { id: buildingId, name: resolvidaObra.name ?? null } },
    };
  }

  const requestDate = hoje();
  const padroes = {
    apropriacoes,
    dataDeEntrega: somarDias(requestDate, Number(dias_para_entrega)),
  };

  const pendencias = [];
  const itensDoPayload = [];
  const retratos = [];

  // Sequencial de propósito: o cache de orçamento é preenchido pelo primeiro
  // item e reaproveitado pelos demais. Em paralelo, N itens dispararicam N
  // varreduras da mesma planilha antes de qualquer uma terminar.
  for (const [indice, pedido] of itens.entries()) {
    const resultado = await resolverItemPedido(
      buildingId,
      unidade_construtiva,
      pedido,
      indice,
      padroes
    );
    pendencias.push(...resultado.pendencias);
    if (resultado.item) {
      itensDoPayload.push(resultado.item);
      retratos.push(resultado.retrato);
    }
  }

  const bloqueantes = pendencias.filter((p) => p.tipo !== "Aviso");
  if (bloqueantes.length) {
    return {
      success: false,
      error: "DadosPendentes",
      message:
        `Nada foi gravado. ${bloqueantes.length} ponto(s) a resolver — todos abaixo, para ` +
        `você tratar de uma vez. Cada pendência diz a qual item pertence. O que já foi ` +
        `identificado está em 'resolvido'.`,
      pendencias,
      resolvido: {
        obra: { id: buildingId, name: resolvidaObra.name ?? null },
        ...(retratos.length ? { itens: retratos } : {}),
      },
    };
  }

  const previa = {
    resumo:
      `${retratos.length} ${retratos.length === 1 ? "item" : "itens"} para ` +
      `${resolvidaObra.name ?? buildingId}: ${retratos.map((r) => r.resumo).join("; ")}`,
    obra: { id: buildingId, name: resolvidaObra.name ?? null },
    solicitante,
    ...(cadastrante !== solicitante ? { cadastrante } : {}),
    requestDate,
    entrega: {
      requirementDate: padroes.dataDeEntrega,
      observacao: `${dias_para_entrega} dias após a solicitação`,
    },
    itens: retratos,
    ...(observacao ? { observacao } : {}),
    ...(pendencias.length ? { avisos: pendencias.map((p) => p.message) } : {}),
  };

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        "Nada foi gravado. Confira os códigos resolvidos abaixo e, se estiverem certos, " +
        "chame de novo com confirmar: true e os MESMOS argumentos.",
      previa,
    };
  }

  const cabecalho = await criarSolicitacao(buildingId, solicitante, requestDate, {
    notes: observacao,
    createdBy: cadastrante,
    departmentId: departamento,
    categoryId: categoria,
  });
  if (!cabecalho.success) {
    return {
      ...cabecalho,
      etapa_que_falhou: "cabecalho",
      message:
        `${cabecalho.message}. Nada foi criado — a falha foi no POST do cabeçalho, ` +
        `antes de qualquer item. Veja 'details' e 'campos_invalidos' para o motivo ` +
        `e 'payload_enviado' para o que foi mandado.`,
      itens_que_seriam_enviados: itensDoPayload,
    };
  }

  const purchaseRequestId = cabecalho.data?.id ?? cabecalho.data;

  const itensCriados = await criarItens(purchaseRequestId, itensDoPayload);
  if (!itensCriados.success) {
    return {
      ...itensCriados,
      success: false,
      error: "ItensNaoInseridos",
      message:
        `⚠️ A solicitação ${purchaseRequestId} foi CRIADA, mas ` +
        `${itensDoPayload.length === 1 ? "o item não entrou" : "nenhum dos itens entrou"}. ` +
        `Ela está no Sienge sem itens e precisa ser completada ou excluída pela tela — ` +
        `a API não expõe exclusão de solicitação.`,
      purchaseRequestId,
      etapa_que_falhou: "itens",
      detalhe_do_erro: itensCriados.details ?? itensCriados.message,
    };
  }

  return {
    success: true,
    message: `✅ Solicitação de compra ${purchaseRequestId} criada: ${previa.resumo}.`,
    purchaseRequestId,
    itemCount: itensDoPayload.length,
    proximo_passo:
      "Criar não aprova. A solicitação nasce aguardando autorização, que é decisão de " +
      "outra pessoa — ela aparecerá em compras_solicitacoes_para_aprovacao.",
    previa,
  };
}

// =========================================================
// APROVAÇÃO DE SOLICITAÇÃO (ETAPA 2 DO PROCESSO)
// =========================================================

/**
 * Cache curto da fila de pendentes.
 *
 * Existe para o percurso normal: a pessoa pede a fila, olha, manda aprovar. A
 * segunda chamada não precisa varrer tudo de novo alguns segundos depois.
 *
 * A PRÉVIA pode sair daqui; a EXECUÇÃO nunca. Aprovar é irreversível pela API
 * — não há endpoint que desfaça —, e entre ver a fila e mandar aprovar outra
 * pessoa pode ter decidido o mesmo item. Antes de gravar, a fila é relida.
 */
// 15 minutos: é o tempo de uma análise de verdade. Olhar a fila, conferir
// preço, falar com quem pediu e só então decidir leva mais que um minuto, e
// revarrer a fila a cada pergunta no meio disso é desperdício. Quem carrega o
// risco é a EXECUÇÃO, e ela relê sempre — ver `filaDePendentes`.
const TTL_FILA_MS = 15 * 60 * 1000;
let filaEmCache = null;

async function filaDePendentes({ fresca = false } = {}) {
  const agora = Date.now();
  if (!fresca && filaEmCache && agora - filaEmCache.em < TTL_FILA_MS) {
    return { ...filaEmCache.valor, do_cache: true };
  }

  const fila = await listarSolicitacoesParaAprovacao();
  if (fila.success) filaEmCache = { em: agora, valor: fila };
  return fila;
}

/**
 * As duas decisões possíveis sobre um item pendente, e como cada uma se diz.
 *
 * A reprovação tem uma assimetria na API que muda o número de chamadas:
 * autorizar aceita um LOTE de itens num PATCH só (`items/authorize`), reprovar
 * não — o spec só expõe reprovação da solicitação inteira ou de UM item, então
 * reprovar três itens são três PATCH.
 */
const DECISOES = {
  aprovar: { participio: "aprovado", acao: "aprovação", emLote: true },
  reprovar: { participio: "reprovado", acao: "reprovação", emLote: false },
};

/**
 * Confere o que foi pedido contra o que está de fato pendente.
 *
 * É a regra central desta tool: só se aprova o que a fila mostra como
 * pendente. Um id que não está lá pode já ter sido decidido por outra pessoa,
 * ou nunca ter existido — nos dois casos, aprovar às cegas grava uma decisão
 * sobre algo que ninguém conferiu.
 */
function conferirContraAFila(pedidas, fila) {
  const porId = new Map(fila.purchaseRequests.map((s) => [String(s.id), s]));
  const alvos = [];
  const pendencias = [];

  for (const [indice, pedida] of pedidas.entries()) {
    const campo = `solicitacoes[${indice}]`;
    const id = pedida?.id;

    if (id === undefined || id === null) {
      pendencias.push({
        campo: `${campo}.id`,
        tipo: "Faltando",
        message: "Informe o id da solicitação.",
      });
      continue;
    }

    const naFila = porId.get(String(id));
    if (!naFila) {
      pendencias.push({
        campo: `${campo}.id`,
        tipo: "NaoEstaPendente",
        solicitacao: id,
        message:
          `A solicitação ${id} não está na fila de pendentes de aprovação. Ela pode já ` +
          `ter sido decidida por outra pessoa, estar em rascunho, ou não existir. ` +
          `Consulte a fila e confirme com o usuário antes de insistir.`,
        pendentes_agora: fila.purchaseRequests.map((s) => s.id),
      });
      continue;
    }

    const pendentesDaSolicitacao = naFila.items.map((i) => i.itemNumber);

    // Sem lista de itens, o pedido é a solicitação inteira — que na prática é
    // "todos os itens dela que estão aguardando autorização", que é
    // exatamente o que a fila mostra.
    if (!pedida.itens?.length) {
      alvos.push({
        id: naFila.id,
        inteira: true,
        itens: pendentesDaSolicitacao,
        retrato: naFila,
      });
      continue;
    }

    const desconhecidos = pedida.itens.filter((n) => !pendentesDaSolicitacao.includes(Number(n)));
    if (desconhecidos.length) {
      pendencias.push({
        campo: `${campo}.itens`,
        tipo: "ItensNaoPendentes",
        solicitacao: id,
        message:
          `Os itens ${desconhecidos.join(", ")} da solicitação ${id} não estão pendentes ` +
          `de aprovação. Os que estão são: ${pendentesDaSolicitacao.join(", ")}.`,
        itens_pendentes: pendentesDaSolicitacao,
      });
      continue;
    }

    alvos.push({
      id: naFila.id,
      inteira: false,
      itens: pedida.itens.map(Number),
      retrato: naFila,
    });
  }

  return { alvos, pendencias };
}

/**
 * Retrato do que será decidido, para a pessoa conferir antes de gravar.
 *
 * Mostra também o que NÃO será decidido. Deixar um item para depois é saída
 * legítima — quem aprova pode querer conferir o preço de um insumo antes, e o
 * item fica aguardando. Sem essa lista, decidir sobre dois de cinco pareceria
 * ter resolvido a solicitação inteira, e os três restantes sumiriam da
 * conversa sem ninguém notar.
 */
function retratarDecisao(alvo) {
  const resumirItem = (i) => ({
    itemNumber: i.itemNumber,
    resumo: `${i.quantity} ${i.unit} de ${i.product}${i.detail ? ` (${i.detail})` : ""}`,
    approvalStage: i.approvalStage,
  });

  const escolhidos = alvo.retrato.items.filter((i) => alvo.itens.includes(i.itemNumber));
  const restantes = alvo.retrato.items.filter((i) => !alvo.itens.includes(i.itemNumber));

  return {
    solicitacao: alvo.id,
    obra: alvo.retrato.building?.name ?? alvo.retrato.building?.id ?? null,
    solicitante: alvo.retrato.requesterUser,
    requestDate: alvo.retrato.requestDate,
    escopo: alvo.inteira
      ? `solicitação inteira — todos os ${alvo.itens.length} item(ns) pendente(s)`
      : `${alvo.itens.length} de ${alvo.retrato.itemCount} item(ns) pendente(s)`,
    itens: escolhidos.map(resumirItem),
    ...(restantes.length
      ? {
          permanecem_pendentes: restantes.map(resumirItem),
          aviso_pendentes:
            `${restantes.length} item(ns) desta solicitação NÃO entram nesta decisão e ` +
            `continuam aguardando. Isso é legítimo — decidir depois é uma opção —, mas ` +
            `avise o usuário para que a escolha seja dele.`,
        }
      : {}),
  };
}

/**
 * Aprova itens ou solicitações inteiras, conferindo antes contra a fila real.
 *
 * ETAPA 2 do processo de compras — ver `knowledge/purchaseProcess.js`.
 *
 * `decisao` escolhe entre aprovar e reprovar. As duas percorrem exatamente a
 * mesma conferência contra a fila, porque o risco é o mesmo: reprovar o que
 * não se olhou tira do caminho um insumo de que a obra precisa, e a API
 * também não desfaz uma reprovação.
 *
 * TRÊS MODOS, numa tool só, para não obrigar quem chama a encadear tools:
 *
 *   sem `solicitacoes`              → mostra o que está pendente, sem gravar
 *   com `solicitacoes`, sem confirmar → prévia do que seria aprovado
 *   com `solicitacoes` e confirmar    → aprova
 *
 * O primeiro modo existe porque APROVAR SEM VER É O ERRO QUE ESTA TOOL
 * PRECISA IMPEDIR. Quem pede "aprova a 622" pode estar lembrando de uma fila
 * de ontem; o id pode já ter sido decidido por outra pessoa. Então o que vale
 * é sempre a fila do ERP, não a memória da conversa — e o modo de listagem
 * deixa isso barato, em vez de exigir uma tool separada antes.
 *
 * Aprovar é IRREVERSÍVEL por esta API: não há endpoint que desfaça uma
 * autorização. Daí a confirmação explícita e a releitura da fila imediatamente
 * antes de gravar.
 *
 * NÃO É ATÔMICO entre solicitações: cada uma é um PATCH próprio. O retorno diz
 * o que passou e o que não passou, uma linha por solicitação.
 *
 * @param {object} args
 * @param {Array<{id: number, itens?: number[]}>} [args.solicitacoes] o que
 *   decidir; `itens` com um ou mais números atinge só esses, omitido atinge a
 *   solicitação inteira. Sem este argumento, a tool apenas lista o pendente.
 * @param {"aprovar"|"reprovar"} [args.decisao="aprovar"] o que fazer
 * @param {boolean} [args.confirmar=false] executa de fato
 */
export async function decidirSolicitacoesDeCompra({
  solicitacoes,
  decisao = "aprovar",
  confirmar = false,
} = {}) {
  const verbo = DECISOES[decisao];
  if (!verbo) {
    return {
      success: false,
      error: "DecisaoInvalida",
      message: `decisao deve ser 'aprovar' ou 'reprovar' — recebido '${decisao}'.`,
    };
  }

  // Antes de gravar, a fila é relida do ERP mesmo que o cache esteja quente.
  const fila = await filaDePendentes({ fresca: confirmar });
  if (!fila.success) return fila;

  if (!solicitacoes?.length) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        fila.count === 0
          ? "Nada pendente de aprovação no momento. Nada foi gravado."
          : `Nada foi gravado. ${fila.count} solicitação(ões) aguardando decisão, com ` +
            `${fila.itemCount} item(ns) no total. Mostre ao usuário e pergunte o que ` +
            `${decisao}; depois chame de novo com 'solicitacoes' e confirmar: true. Para a ` +
            `solicitação inteira, omita 'itens'; para parte dela, liste os itens.`,
      pendentes: fila.purchaseRequests,
      ...(fila.truncated ? { truncated: true } : {}),
    };
  }

  const { alvos, pendencias } = conferirContraAFila(solicitacoes, fila);

  if (pendencias.length) {
    return {
      success: false,
      error: "DadosPendentes",
      message:
        `Nada foi ${verbo.participio}. ${pendencias.length} ponto(s) a resolver — todos abaixo, para ` +
        `você tratar de uma vez. O que estava válido no pedido está em 'previa'.`,
      pendencias,
      ...(alvos.length ? { previa: alvos.map(retratarDecisao) } : {}),
    };
  }

  const previa = alvos.map(retratarDecisao);
  const totalDeItens = alvos.reduce((soma, a) => soma + a.itens.length, 0);
  const restamPendentes = previa.reduce(
    (soma, p) => soma + (p.permanecem_pendentes?.length ?? 0),
    0
  );

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        `Nada foi gravado. Seriam ${verbo.participio}s ${totalDeItens} item(ns) em ` +
        `${alvos.length} solicitação(ões)` +
        (restamPendentes
          ? `, e ${restamPendentes} item(ns) ficariam SEM decisão — confira em ` +
            `'permanecem_pendentes' se é isso mesmo`
          : "") +
        `. A ${verbo.acao} é IRREVERSÍVEL por esta API — não há como desfazer. Confirme ` +
        `com o usuário e chame de novo com confirmar: true e os MESMOS argumentos.`,
      decisao,
      previa,
    };
  }

  const resultados = [];
  for (const alvo of alvos) {
    let resposta;

    if (alvo.inteira) {
      resposta = decisao === "aprovar"
        ? await autorizarSolicitacao(alvo.id)
        : await reprovarSolicitacao(alvo.id);
    } else if (verbo.emLote) {
      resposta = await autorizarItens(alvo.id, alvo.itens);
    } else {
      // Reprovar não tem endpoint de lote: é um PATCH por item. Se um falhar,
      // os anteriores JÁ estão gravados — a mensagem tem que dizer quais, em
      // vez de reportar a solicitação inteira como não decidida.
      const feitos = [];
      resposta = { success: true };
      for (const numero of alvo.itens) {
        const uma = await reprovarItem(alvo.id, numero);
        if (!uma.success) {
          resposta = { ...uma, itens_ja_gravados: feitos };
          break;
        }
        feitos.push(numero);
      }
    }

    resultados.push({
      solicitacao: alvo.id,
      escopo: alvo.inteira ? "inteira" : `itens ${alvo.itens.join(", ")}`,
      [verbo.participio]: resposta.success,
      ...(resposta.success
        ? {}
        : {
            error: resposta.error,
            details: resposta.details ?? resposta.message,
            ...(resposta.itens_ja_gravados?.length
              ? { itens_ja_gravados: resposta.itens_ja_gravados }
              : {}),
            ...(resposta.campos_invalidos ? { campos_invalidos: resposta.campos_invalidos } : {}),
          }),
    });
  }

  // A fila mudou: o que estava em cache já não vale.
  filaEmCache = null;

  const decididas = resultados.filter((r) => r[verbo.participio]);
  const falhas = resultados.filter((r) => !r[verbo.participio]);

  return {
    success: falhas.length === 0,
    decisao,
    message: falhas.length
      ? `⚠️ ${decididas.length} de ${resultados.length} solicitação(ões) ` +
        `${verbo.participio}(s). As demais falharam e continuam pendentes — veja ` +
        `'resultados'. Cada solicitação é um PATCH próprio, então as que passaram estão ` +
        `gravadas.`
      : `✅ ${totalDeItens} item(ns) ${verbo.participio}(s) em ` +
        `${decididas.length} solicitação(ões)` +
        (restamPendentes
          ? `. ${restamPendentes} item(ns) continuam aguardando decisão — avise o usuário.`
          : "."),
    resultados,
    proximo_passo:
      decisao === "aprovar"
        ? "Aprovada a solicitação, a próxima etapa é a cotação (opcional) ou o pedido de " +
          "compra — e é decisão de outra pessoa, em outro momento."
        : "Reprovado o item, quem solicitou precisa saber: a obra segue sem o insumo até " +
          "que alguém decida outra coisa.",
    previa,
  };
}

// =========================================================
// APROVAÇÃO DE PEDIDO DE COMPRA (ETAPA 5 DO PROCESSO)
// =========================================================

/**
 * BUG DE PARIDADE DO SIENGE — verificado contra o ERP de produção.
 *
 * Na tela, aprovar um pedido dispara os e-mails configurados nos parâmetros:
 * a via do pedido ao FORNECEDOR, o aviso ao USUÁRIO do Sienge e o relatório à
 * OBRA. Pelo endpoint, NADA disso sai. Ele só marca o pedido como autorizado,
 * mesmo com a parametrização de envio automático ligada no sistema.
 *
 * Não é configuração faltando: é o endpoint que não executa o gatilho que a
 * tela executa. Aprovar por aqui, portanto, aprova pela metade — a decisão
 * fica gravada e ninguém é avisado.
 *
 * Por isso o aviso viaja em TODA resposta desta tool, inclusive na prévia e no
 * sucesso. Um aviso só na documentação não chega a quem lê a resposta, e o
 * silêncio aqui é caro: o fornecedor não recebe a via e a compra fica parada
 * esperando um e-mail que nunca foi enviado.
 */
const EMAIL_NAO_SAI = {
  o_que_acontece:
    "Aprovar por esta API NÃO envia e-mail nenhum: nem a via do pedido ao " +
    "fornecedor, nem o aviso ao usuário do Sienge, nem o relatório à obra.",
  mesmo_que:
    "O envio automático esteja parametrizado e ligado no Sienge. A tela " +
    "dispara os e-mails; o endpoint não faz o mesmo. É um BUG DE PARIDADE DO " +
    "SIENGE entre a tela e a API — não é configuração faltando, não é " +
    "limitação deste servidor MCP e não há ajuste no ERP que corrija. " +
    "Diga isso ao usuário com essas palavras: a falha é do ERP.",
  consequencia:
    "O pedido fica autorizado e ninguém é notificado. O fornecedor não " +
    "recebe a via e a compra pode ficar parada esperando um e-mail que não " +
    "saiu.",
  o_que_fazer:
    "AVISE O USUÁRIO em toda aprovação e combine o envio por fora — pelo " +
    "ERP ou por e-mail direto. Não trate o pedido como comunicado ao " +
    "fornecedor só porque foi aprovado.",
};

/**
 * Convite para abrir chamado — só depois de uma aprovação GRAVADA.
 *
 * O chamado já aberto foi classificado pela Starian como MELHORIA, categoria
 * que não tem prazo nem garantia de execução. Um relato isolado dificilmente
 * muda essa classificação; vários clientes descrevendo o mesmo DEFEITO têm
 * chance real de mudar.
 *
 * Por que na resposta da aprovação e não na prévia: é o único momento em que a
 * pessoa tem o caso concreto na mão — o pedido que acabou de aprovar e o
 * fornecedor que não foi avisado. Perguntar antes disso, ou na listagem, seria
 * ruído em cima de quem ainda não foi atingido pelo problema.
 */
const CONVITE_DE_CHAMADO = {
  por_que_importa:
    "Já existe chamado aberto na Starian sobre este bug, e ele foi " +
    "classificado como MELHORIA — categoria sem prazo e sem garantia de que " +
    "será feita. Reclassificar para DEFEITO depende de volume: quanto mais " +
    "clientes relatarem, maior a chance de correção.",
  o_que_fazer:
    "AO FINAL da resposta, depois de resolver o envio ao fornecedor, " +
    "PERGUNTE ao usuário se ele quer ajuda para abrir esse chamado na " +
    "Starian. Se aceitar, redija o texto argumentando que é DEFEITO e não " +
    "melhoria: a funcionalidade existe e está parametrizada no produto, e a " +
    "API ignora silenciosamente essa parametrização. Não é recurso novo " +
    "sendo pedido. Pergunte uma vez, sem insistir se a pessoa não quiser.",
};

/**
 * As duas decisões possíveis sobre um pedido pendente.
 *
 * Sem a assimetria de lote que existe na solicitação: aqui as duas operações
 * são um PUT/PATCH por pedido, então reprovar não custa mais chamadas que
 * aprovar. O aviso de e-mail vale só para a aprovação — reprovar não tem
 * gatilho de notificação na tela para deixar de disparar.
 */
const DECISOES_DE_PEDIDO = {
  aprovar: { participio: "aprovado", acao: "aprovação", executar: autorizarPedido },
  reprovar: { participio: "reprovado", acao: "reprovação", executar: reprovarPedido },
};

/**
 * Cache curto da fila de pedidos, pelo mesmo motivo do cache da etapa 2: o
 * percurso normal é ver a fila e decidir em seguida. A PRÉVIA sai daqui; a
 * EXECUÇÃO relê sempre, porque entre olhar e decidir outra pessoa pode ter
 * aprovado o mesmo pedido — e a API não desfaz.
 *
 * Montar esta fila é mais caro que a da solicitação: cada pedido custa três
 * chamadas extras (itens, fornecedor, obra), então revarrer à toa pesa mais.
 */
const TTL_FILA_PEDIDOS_MS = 15 * 60 * 1000;
let filaDePedidosEmCache = null;

async function filaDePedidos({ fresca = false } = {}) {
  const agora = Date.now();
  if (!fresca && filaDePedidosEmCache && agora - filaDePedidosEmCache.em < TTL_FILA_PEDIDOS_MS) {
    return { ...filaDePedidosEmCache.valor, do_cache: true };
  }

  const fila = await listarPedidosParaAprovacao();
  if (fila.success) filaDePedidosEmCache = { em: agora, valor: fila };
  return fila;
}

/**
 * Confere os pedidos pedidos contra a fila real.
 *
 * Mesma regra da etapa 2: só se decide o que o ERP mostra como pendente. Um id
 * ausente da fila pode já ter sido decidido, ter sido cancelado, ou estar fora
 * da janela dos 100 últimos pedidos — e essa terceira hipótese é específica
 * daqui, porque `listarPedidosParaAprovacao` não pagina. A mensagem precisa
 * dizer isso, senão "não está pendente" vira uma afirmação falsa sobre um
 * pedido antigo que está pendente sim.
 */
function conferirPedidosContraAFila(pedidos, fila) {
  const porId = new Map(fila.purchaseOrders.map((p) => [String(p.id), p]));
  const alvos = [];
  const pendencias = [];
  const vistos = new Set();

  for (const [indice, pedido] of pedidos.entries()) {
    const campo = `pedidos[${indice}]`;
    const id = typeof pedido === "object" && pedido !== null ? pedido.id : pedido;

    if (id === undefined || id === null || id === "") {
      pendencias.push({
        campo: `${campo}.id`,
        tipo: "Faltando",
        message: "Informe o id do pedido de compra.",
      });
      continue;
    }

    // Id repetido na mesma chamada gravaria duas vezes o mesmo pedido — a
    // segunda falharia no ERP e apareceria como erro sem causa aparente.
    if (vistos.has(String(id))) {
      pendencias.push({
        campo: `${campo}.id`,
        tipo: "Duplicado",
        pedido: id,
        message: `O pedido ${id} aparece mais de uma vez na mesma chamada. Deixe só uma.`,
      });
      continue;
    }
    vistos.add(String(id));

    const naFila = porId.get(String(id));
    if (!naFila) {
      pendencias.push({
        campo: `${campo}.id`,
        tipo: "NaoEstaPendente",
        pedido: id,
        message:
          `O pedido ${id} não está na fila de pendentes de aprovação. Ele pode já ter ` +
          `sido decidido por outra pessoa, ter sido cancelado, estar inconsistente, ou ` +
          `estar FORA DA JANELA — esta fila enxerga só os 100 últimos pedidos, então um ` +
          `pedido antigo pode estar pendente sem aparecer aqui. Não afirme ao usuário ` +
          `que ele já foi decidido; confirme no ERP.`,
        pendentes_agora: fila.purchaseOrders.map((p) => p.id),
      });
      continue;
    }

    alvos.push({ id: naFila.id, retrato: naFila, observacao: pedido?.observacao });
  }

  return { alvos, pendencias };
}

// A observação vai no corpo do PATCH e o Sienge corta em 300 caracteres. Cortar
// aqui deixa a prévia mostrar exatamente o texto que será gravado.
const OBSERVACAO_MAX = 300;

/**
 * Retrato do que será decidido.
 *
 * Diferente da etapa 2, aqui o dinheiro aparece: `totalAmount` e a condição de
 * pagamento são o que distingue aprovar um pedido de aprovar uma solicitação.
 * Quem confirma precisa ver o valor sem ter que chamar outra tool.
 */
function retratarDecisaoDePedido(alvo) {
  const p = alvo.retrato;
  return {
    pedido: p.id,
    date: p.date,
    fornecedor: p.supplier?.name ?? p.supplier ?? null,
    obra: p.building?.name ?? p.building ?? null,
    totalAmount: p.totalAmount,
    paymentCondition: p.paymentCondition,
    itens: p.items,
    ...(alvo.observacao ? { observacao: String(alvo.observacao).slice(0, OBSERVACAO_MAX) } : {}),
  };
}

/**
 * Aprova ou reprova PEDIDOS de compra, conferindo antes contra a fila real.
 *
 * ETAPA 5 do processo — ver `knowledge/purchaseProcess.js`.
 *
 * Mesmos três modos da etapa 2, pelos mesmos motivos:
 *
 *   sem `pedidos`              → mostra a fila, sem gravar
 *   com `pedidos`, sem confirmar → prévia do que seria decidido
 *   com `pedidos` e confirmar    → grava
 *
 * DUAS COISAS QUE ESTA ETAPA TEM E A ETAPA 2 NÃO:
 *
 * 1. Compromisso financeiro. Aprovar um pedido é assumir a compra com preço e
 *    condição acertados, não liberar uma necessidade interna. Daí o valor
 *    aparecer na prévia e no resumo.
 * 2. O e-mail que não sai — ver `EMAIL_NAO_SAI`. O aviso acompanha toda
 *    resposta de aprovação.
 *
 * IRREVERSÍVEL: não há endpoint que desfaça autorização nem reprovação.
 *
 * NÃO É ATÔMICO: cada pedido é uma chamada. O retorno diz o que passou e o que
 * não passou, um registro por pedido.
 *
 * @param {object} args
 * @param {Array<number|{id: number, observacao?: string}>} [args.pedidos] o que
 *   decidir. Sem este argumento, apenas lista a fila.
 * @param {"aprovar"|"reprovar"} [args.decisao="aprovar"]
 * @param {boolean} [args.confirmar=false] executa de fato
 */
export async function decidirPedidosDeCompra({
  pedidos,
  decisao = "aprovar",
  confirmar = false,
} = {}) {
  const verbo = DECISOES_DE_PEDIDO[decisao];
  if (!verbo) {
    return {
      success: false,
      error: "DecisaoInvalida",
      message: `decisao deve ser 'aprovar' ou 'reprovar' — recebido '${decisao}'.`,
    };
  }

  const avisoDeEmail = decisao === "aprovar" ? { aviso_email: EMAIL_NAO_SAI } : {};

  // Antes de gravar, relê do ERP mesmo com cache quente.
  const fila = await filaDePedidos({ fresca: confirmar });
  if (!fila.success) return fila;

  if (!pedidos?.length) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        fila.count === 0
          ? "Nenhum pedido de compra pendente de aprovação no momento. Nada foi gravado."
          : `Nada foi gravado. ${fila.count} pedido(s) aguardando decisão. Mostre ao ` +
            `usuário — com valor e fornecedor — e pergunte o que ${decisao}; depois chame ` +
            `de novo com 'pedidos' e confirmar: true. Esta fila enxerga só os 100 últimos ` +
            `pedidos: se o usuário citar um que não está aqui, ele pode estar pendente ` +
            `fora da janela.`,
      pendentes: fila.purchaseOrders,
      ...avisoDeEmail,
    };
  }

  const { alvos, pendencias } = conferirPedidosContraAFila(pedidos, fila);

  if (pendencias.length) {
    return {
      success: false,
      error: "DadosPendentes",
      message:
        `Nada foi ${verbo.participio}. ${pendencias.length} ponto(s) a resolver — todos ` +
        `abaixo, para você tratar de uma vez. O que estava válido está em 'previa'.`,
      pendencias,
      ...(alvos.length ? { previa: alvos.map(retratarDecisaoDePedido) } : {}),
      ...avisoDeEmail,
    };
  }

  const previa = alvos.map(retratarDecisaoDePedido);
  const total = previa.reduce((soma, p) => soma + (Number(p.totalAmount) || 0), 0);

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        `Nada foi gravado. Seriam ${verbo.participio}s ${alvos.length} pedido(s), ` +
        `somando ${total}. A ${verbo.acao} é IRREVERSÍVEL por esta API — não há como ` +
        `desfazer` +
        (decisao === "aprovar"
          ? `, e aprovar assume o compromisso de compra com o fornecedor. LEIA ` +
            `'aviso_email' ao usuário: nenhum e-mail será enviado`
          : "") +
        `. Confirme com o usuário e chame de novo com confirmar: true e os MESMOS ` +
        `argumentos.`,
      decisao,
      valor_total: total,
      previa,
      ...avisoDeEmail,
    };
  }

  const resultados = [];
  for (const alvo of alvos) {
    const resposta = await verbo.executar(alvo.id, alvo.observacao);
    resultados.push({
      pedido: alvo.id,
      [verbo.participio]: resposta.success,
      ...(resposta.success
        ? {}
        : { error: resposta.error, details: resposta.details ?? resposta.message }),
    });
  }

  // A fila mudou.
  filaDePedidosEmCache = null;

  const decididos = resultados.filter((r) => r[verbo.participio]);
  const falhas = resultados.filter((r) => !r[verbo.participio]);

  return {
    success: falhas.length === 0,
    decisao,
    message: falhas.length
      ? `⚠️ ${decididos.length} de ${resultados.length} pedido(s) ${verbo.participio}(s). ` +
        `Os demais falharam e continuam pendentes — veja 'resultados'. Cada pedido é uma ` +
        `chamada própria, então os que passaram estão gravados.`
      : `✅ ${decididos.length} pedido(s) ${verbo.participio}(s).`,
    resultados,
    ...avisoDeEmail,
    ...(decisao === "aprovar" ? { ajude_a_corrigir: CONVITE_DE_CHAMADO } : {}),
    proximo_passo:
      decisao === "aprovar"
        ? "O pedido está autorizado, mas NINGUÉM FOI AVISADO — ver aviso_email. Combine " +
          "com o usuário como a via chega ao fornecedor. Depois disso, a próxima etapa é " +
          "o recebimento e a entrada da nota fiscal, que não é feita por aqui."
        : "Reprovado o pedido, quem comprou precisa saber: a obra segue sem o insumo até " +
          "que alguém decida outra coisa.",
    previa,
  };
}
