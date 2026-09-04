/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Orquestração de compras — o que os handlers de `modules/purchase.js`
 * chamam. Combina as funções cruas de `api/purchase-orders-v1.js` pra montar
 * o que uma tool de negócio precisa, numa chamada só.
 */

import { buscarPedidos, buscarItens } from "../api/purchase-orders-v1.js";
import {
  buscarItensDeSolicitacoes,
  buscarSolicitacao,
  criarSolicitacao,
  criarItens,
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
