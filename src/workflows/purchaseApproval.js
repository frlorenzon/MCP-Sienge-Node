/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Camada de intenção de compras — pedidos prontos para decisão.
 *
 * As funções de `api/` espelham a API REST do Sienge: um recurso por endpoint,
 * normalizado como o servidor o entrega. É fiel, e é o alicerce certo. Mas
 * obriga quem consome a refazer o join — e quando quem consome é um modelo de
 * linguagem, cada nível do join vira um turno de inferência que reenvia a
 * conversa inteira. Um lote de 20 pedidos com 6 itens cada custa 121 chamadas
 * encadeadas, cada uma carregando tudo o que veio antes.
 *
 * Este módulo percorre o mesmo caminho dentro do servidor: a varredura é
 * paralela, fornecedor e insumo são resolvidos uma vez por identificador (não
 * uma vez por ocorrência) e o retorno já vem projetado, com os totais somados
 * e as divergências marcadas. O que sobra para o modelo é o julgamento — que é
 * a única parte que ele faz melhor que um `for`.
 *
 * Nada aqui substitui a camada de API: estas funções compõem aquelas. Para o
 * que não estiver previsto — anexos, avaliação de fornecedor, apropriações item
 * a item — o caminho é `chamar_api` com `deep_mode`.
 */

import * as purchaseOrders from "../apis/purchase-orders.js";
import * as creditors from "../apis/creditors.js";
import * as costCenters from "../apis/cost-centers.js";

const num = (v, padrao) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : padrao;
};

export const VALOR_ALERTA = num(process.env.SIENGE_COMPRAS_VALOR_ALERTA, 50000);
export const TOLERANCIA_PRECO = num(process.env.SIENGE_COMPRAS_TOLERANCIA_PRECO, 0.2);
const CONCORRENCIA = Math.max(1, num(process.env.SIENGE_COMPRAS_CONCORRENCIA, 6));

const TTL_CADASTRO = 3600;
const MAX_PEDIDOS_TETO = 200;
const JANELA_TRIAGEM_DIAS = 180;

// A API do Sienge varia o nome do mesmo dado entre DTOs. A leitura por lista de
// candidatos absorve isso; `diagnosticoDeCampos` denuncia quando nenhum bate.
const ID_PEDIDO = ["purchaseOrderId", "id", "orderId", "purchaseOrderNumber"];
const DATA_PEDIDO = ["date", "orderDate", "purchaseOrderDate", "issueDate"];
const ID_INSUMO = ["productId", "resourceId", "detailId"];
const DESCRICAO_INSUMO = [
  "resourceDescription",
  "productDescription",
  "detailDescription",
  "description",
  "name",
];
const NOME_CREDOR = ["name", "tradeName", "corporateName", "fantasyName"];
const NOME_OBRA = ["name", "description", "costCenterName", "buildingName"];
const PRECO_UNITARIO = ["unitPrice", "unitaryPrice", "price"];
const QUANTIDADE = ["quantity", "orderedQuantity", "requestedQuantity"];
const TOTAL_ITEM = ["totalPrice", "total", "amount", "netAmount"];
const UNIDADE = [
  "unitOfMeasure",
  "purchaseUnitSymbol",
  "unitySymbol",
  "unitOfMeasureSymbol",
  "unitSymbol",
  "measurementUnit",
  "symbol",
];

const CAMPOS_ESPERADOS = {
  insumo: ID_INSUMO,
  qtd: QUANTIDADE,
  un: UNIDADE,
  unitario: PRECO_UNITARIO,
};

/** Primeiro campo presente e não vazio, na ordem de preferência declarada. */
function primeiro(registro, campos, padrao = null) {
  if (!registro || typeof registro !== "object") return padrao;
  for (const campo of campos) {
    const valor = registro[campo];
    if (valor !== null && valor !== undefined && valor !== "") return valor;
  }
  return padrao;
}

function numero(valor) {
  const n = Number.parseFloat(valor);
  return Number.isFinite(n) ? n : 0;
}

function arred(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

/**
 * Formata em real. O texto do alerta é lido por uma pessoa, então segue a
 * convenção daqui: ponto no milhar, vírgula no centavo.
 */
function brl(valor) {
  return `R$ ${valor.toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Total da linha, preferindo o que o Sienge já calculou.
 *
 * Só multiplica quando o campo não veio: recalcular por conta própria
 * esconderia desconto, acréscimo ou arredondamento que o ERP aplicou.
 */
function totalDoItem(item) {
  const declarado = primeiro(item, TOTAL_ITEM);
  if (declarado !== null) return numero(declarado);
  return numero(primeiro(item, QUANTIDADE)) * numero(primeiro(item, PRECO_UNITARIO));
}

function isoDate(d) {
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Completa a janela quando o chamador informou uma ponta só, ou nenhuma. */
function janela(startDate, endDate, dias) {
  const fim = endDate || isoDate(new Date());
  if (startDate) return [startDate, fim];
  const base = Number.isNaN(Date.parse(fim)) ? new Date() : new Date(`${fim}T00:00:00`);
  const inicio = new Date(base);
  inicio.setDate(inicio.getDate() - dias);
  return [isoDate(inicio), fim];
}

/**
 * Executa `tarefa` sobre `itens` com no máximo `limite` em voo.
 *
 * O freio existe porque a cota do Sienge é diária e baixa: disparar 200
 * requisições de uma vez não é mais rápido, só aumenta a chance de tomar 429 no
 * meio e perder a varredura inteira.
 */
async function comFreio(itens, limite, tarefa) {
  const resultados = new Array(itens.length);
  let proximo = 0;
  const trabalhador = async () => {
    while (proximo < itens.length) {
      const i = proximo;
      proximo += 1;
      resultados[i] = await tarefa(itens[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador())
  );
  return resultados;
}

/** Itens de vários pedidos, em paralelo. Devolve { itensPorPedido, falhas }. */
async function buscarItensEmLote(makeRequest, ids, concorrencia) {
  const falhas = [];

  const pares = await comFreio(ids, concorrencia, async (pedidoId) => {
    let resposta;
    try {
      resposta = await purchaseOrders.buscarItens(makeRequest, pedidoId);
    } catch (erro) {
      // A varredura não pode morrer por causa de um pedido.
      falhas.push({ pedido: pedidoId, erro: String(erro?.message ?? erro) });
      return [pedidoId, []];
    }
    if (!resposta.success) {
      falhas.push({
        pedido: pedidoId,
        erro: resposta.details || resposta.error || "falha desconhecida",
      });
      return [pedidoId, []];
    }
    return [pedidoId, resposta.items ?? []];
  });

  return { itensPorPedido: new Map(pares), falhas };
}

/**
 * Resolve id → nome para um cadastro qualquer, uma chamada por id distinto.
 *
 * Serve fornecedor e obra pela mesma porta: os dois são cadastros estáveis
 * citados repetidas vezes num lote, e o que se quer deles é só o nome. O cache
 * é por id, não por consulta — assim o segundo pedido do mesmo fornecedor não
 * custa nada, nem hoje nem na execução de amanhã.
 */
async function resolverNomes(makeRequest, deps, ids, concorrencia, opts) {
  const { cacheGet, cacheSet } = deps;
  const { prefixo, buscar, chaveResposta, campos } = opts;

  const distintos = [...new Set([...ids].filter((i) => i !== null && i !== undefined && i !== ""))];
  let chamadas = 0;

  const pares = await comFreio(distintos, concorrencia, async (identificador) => {
    const chave = `compras:${prefixo}:${identificador}`;
    if (cacheGet) {
      const guardado = cacheGet(chave);
      if (guardado !== null && guardado !== undefined) return [String(identificador), guardado];
    }

    let resposta;
    try {
      resposta = await buscar(makeRequest, identificador);
      chamadas += 1;
    } catch {
      return [String(identificador), `(${prefixo} ${identificador})`];
    }

    if (!resposta.success) return [String(identificador), `(${prefixo} ${identificador})`];

    const nome = primeiro(
      resposta[chaveResposta] ?? {},
      campos,
      `(${prefixo} ${identificador})`
    );
    if (cacheSet) cacheSet(chave, nome, TTL_CADASTRO);
    return [String(identificador), nome];
  });

  return { nomes: Object.fromEntries(pares), chamadas };
}

const resolverFornecedores = (makeRequest, deps, ids, c) =>
  resolverNomes(makeRequest, deps, ids, c, {
    prefixo: "credor",
    buscar: creditors.buscarCredor,
    chaveResposta: "creditor",
    campos: NOME_CREDOR,
  });

/** `buildingId` do pedido é o centro de custo — é dele que sai o nome da obra. */
const resolverObras = (makeRequest, deps, ids, c) =>
  resolverNomes(makeRequest, deps, ids, c, {
    prefixo: "obra",
    buscar: costCenters.buscarCentroDeCusto,
    chaveResposta: "costCenter",
    campos: NOME_OBRA,
  });

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// ALERTAS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// Todos os sinais aqui saem de dados já em mãos — nenhum custa chamada extra.

/**
 * Denuncia campo que a leitura defensiva não conseguiu resolver em item nenhum.
 *
 * A leitura por candidatos protege contra variação de nome, mas fracassa em
 * silêncio: o campo vira null e some do retorno, e quem lê acha que o Sienge
 * não tem o dado. Quando nenhum candidato bate em nenhum item, é nome errado,
 * não dado ausente — e aí vale devolver as chaves reais do DTO, que é a única
 * informação que resolve o problema de vez.
 *
 * Custa nada quando está tudo certo: devolve null.
 */
function diagnosticoDeCampos(itensPorPedido) {
  const todos = [...itensPorPedido.values()].flat();
  const amostra = todos[0];
  if (!amostra) return null;

  const nomeErrado = {};
  const valorVazio = {};

  for (const [nome, candidatos] of Object.entries(CAMPOS_ESPERADOS)) {
    if (todos.some((item) => primeiro(item, candidatos) !== null)) continue;

    // A chave existe no DTO? Então o nome está certo e o vazio é do dado.
    const presentes = {};
    for (const c of candidatos) {
      const vistos = todos.filter((item) => c in item).map((item) => item[c]);
      if (vistos.length) presentes[c] = vistos.slice(0, 3);
    }
    if (Object.keys(presentes).length) valorVazio[nome] = presentes;
    else nomeErrado[nome] = candidatos;
  }

  if (!Object.keys(nomeErrado).length && !Object.keys(valorVazio).length) return null;

  const diag = { campos_reais_do_item: Object.keys(amostra).sort() };
  if (Object.keys(nomeErrado).length) {
    diag.nome_nao_existe_no_dto = nomeErrado;
    diag.acao_nome =
      "Nenhum dos nomes candidatos existe neste DTO. Acrescente o nome correto, " +
      "visto em campos_reais_do_item, à lista correspondente no topo de " +
      "src/workflows/purchaseApproval.js.";
  }
  if (Object.keys(valorVazio).length) {
    diag.campo_existe_mas_veio_vazio = valorVazio;
    diag.acao_valor =
      "O nome está certo — a API devolveu o campo vazio. É dado faltando no " +
      "cadastro do Sienge, não erro de leitura: confira o insumo no ERP.";
  }
  return diag;
}

/**
 * Menor preço unitário praticado para cada insumo dentro deste lote.
 *
 * É a comparação mais barata que existe e pega o caso que mais dói: o mesmo
 * insumo comprado a preços diferentes na mesma leva de aprovação.
 */
function menorPrecoDoLote(itensPorPedido) {
  const menor = {};
  for (const itens of itensPorPedido.values()) {
    for (const item of itens) {
      const insumo = primeiro(item, ID_INSUMO);
      const preco = numero(primeiro(item, PRECO_UNITARIO));
      if (insumo === null || preco <= 0) continue;
      const chave = String(insumo);
      if (!(chave in menor) || preco < menor[chave]) menor[chave] = preco;
    }
  }
  return menor;
}

function alertasDoPedido(pedido, itens, valor, menorPreco, fornecedorResolvido) {
  const alertas = [];

  if (!itens.length) alertas.push("pedido sem itens — nada a aprovar, verificar no ERP");

  if (valor >= VALOR_ALERTA) {
    alertas.push(`valor de ${brl(valor)} acima do limiar de ${brl(VALOR_ALERTA)}`);
  }

  const consistencia = pedido.consistency;
  if (consistencia && consistencia !== "CONSISTENT") {
    alertas.push(`consistência ${consistencia} no Sienge`);
  }

  if (!fornecedorResolvido) alertas.push("fornecedor não encontrado no cadastro de credores");

  for (const item of itens) {
    const insumo = primeiro(item, ID_INSUMO);
    const preco = numero(primeiro(item, PRECO_UNITARIO));
    if (insumo === null || preco <= 0) continue;
    const piso = menorPreco[String(insumo)];
    if (piso && preco > piso * (1 + TOLERANCIA_PRECO)) {
      const excesso = (preco / piso - 1) * 100;
      alertas.push(
        `item ${primeiro(item, ["itemNumber", "number"], "?")}: insumo ${insumo} a ` +
          `${brl(preco)}, ${excesso.toFixed(0)}% acima do menor preço do lote (${brl(piso)})`
      );
    }
  }

  return alertas;
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// TRIAGEM PARA APROVAÇÃO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * Pedidos pendentes de aprovação: itens, insumos, fornecedores e obras
 * resolvidos numa travessia só.
 *
 * `start_date`/`end_date` não são expostos pela tool MCP — quem chama de fora
 * usa a janela padrão. Ficam aqui para teste e para reuso por outro workflow,
 * onde não custam contexto.
 *
 * Não autoriza nada. Aprovação é ato separado e deliberado.
 */
export async function analisarPedidosParaAprovacao(makeRequest, deps = {}, opts = {}) {
  const {
    start_date = null,
    end_date = null,
    building_id = null,
    supplier_id = null,
    max_pedidos = 50,
    concorrencia = CONCORRENCIA,
  } = opts;

  const teto = Math.max(1, Math.min(Number(max_pedidos || 50), MAX_PEDIDOS_TETO));
  const [inicio, fim] = janela(start_date, end_date, JANELA_TRIAGEM_DIAS);

  const lista = await purchaseOrders.buscarPedidos(makeRequest, {
    start_date: inicio,
    end_date: fim,
    authorized: false,
    building_id,
    supplier_id,
    limit: teto,
  });
  if (!lista.success) return lista;

  const pedidos = lista.purchaseOrders ?? [];
  if (!pedidos.length) {
    return {
      success: true,
      message: "✅ Nenhum pedido pendente de aprovação nos filtros informados.",
      criterio: `não autorizados, ${inicio} a ${fim}`,
      totais: { pedidos: 0, itens: 0, valor: 0 },
      pedidos: [],
      chamadas_api: 1,
    };
  }

  const ids = pedidos.map((p) => primeiro(p, ID_PEDIDO));
  const { itensPorPedido, falhas } = await buscarItensEmLote(makeRequest, ids, concorrencia);

  // Fornecedor e obra resolvidos em paralelo entre si: são cadastros
  // independentes e esperar um pelo outro não traz nada.
  const [fornecedores, obrasResolvidas] = await Promise.all([
    resolverFornecedores(makeRequest, deps, pedidos.map((p) => p.supplierId), concorrencia),
    resolverObras(makeRequest, deps, pedidos.map((p) => p.buildingId), concorrencia),
  ]);
  const nomes = fornecedores.nomes;
  const obras = obrasResolvidas.nomes;

  const menorPreco = menorPrecoDoLote(itensPorPedido);

  // Catálogo lateral: cada insumo aparece uma vez, por mais pedidos que o
  // citem. É o que impede a descrição de repetir dezenas de vezes no contexto.
  const insumos = {};
  for (const itens of itensPorPedido.values()) {
    for (const item of itens) {
      const insumo = primeiro(item, ID_INSUMO);
      if (insumo === null) continue;
      const chave = String(insumo);
      if (!(chave in insumos)) {
        insumos[chave] = primeiro(item, DESCRICAO_INSUMO, `insumo ${chave}`);
      }
    }
  }

  const linhas = [];
  let totalGeral = 0;
  let totalItens = 0;

  for (const pedido of pedidos) {
    const pedidoId = primeiro(pedido, ID_PEDIDO);
    const itens = itensPorPedido.get(pedidoId) ?? [];
    const valor = itens.reduce((s, i) => s + totalDoItem(i), 0);
    totalGeral += valor;
    totalItens += itens.length;

    const fornecedorId = pedido.supplierId;
    const nome = nomes[String(fornecedorId)];
    const resolvido = Boolean(nome) && !String(nome).startsWith("(credor");

    linhas.push({
      pedido: pedidoId,
      data: primeiro(pedido, DATA_PEDIDO),
      fornecedor: fornecedorId,
      obra: pedido.buildingId,
      valor: arred(valor),
      itens: itens.map((item) => ({
        insumo: primeiro(item, ID_INSUMO),
        qtd: numero(primeiro(item, QUANTIDADE)),
        un: primeiro(item, UNIDADE),
        unitario: arred(numero(primeiro(item, PRECO_UNITARIO))),
      })),
      alertas: alertasDoPedido(pedido, itens, valor, menorPreco, resolvido),
    });
  }

  // Quem tem alerta primeiro, e dentro disso o mais caro: é a ordem em que um
  // comprador olharia a fila.
  linhas.sort((a, b) => b.alertas.length - a.alertas.length || b.valor - a.valor);
  const comAlerta = linhas.filter((l) => l.alertas.length);

  const resultado = {
    success: true,
    criterio: `não autorizados, ${inicio} a ${fim}`,
    totais: {
      pedidos: linhas.length,
      itens: totalItens,
      valor: arred(totalGeral),
      com_alerta: comAlerta.length,
    },
    pedidos: linhas,
    // Os três catálogos laterais: cada fornecedor, obra e insumo escrito uma
    // vez, por mais linhas que os citem. O modelo faz o join sozinho.
    fornecedores: nomes,
    obras,
    insumos,
    chamadas_api: 1 + ids.length + fornecedores.chamadas + obrasResolvidas.chamadas,
  };

  const diagnostico = diagnosticoDeCampos(itensPorPedido);
  if (diagnostico) resultado._diagnostico = diagnostico;

  if (falhas.length) {
    resultado.pedidos_nao_lidos = falhas;
    resultado.cobertura =
      `⚠️ ${falhas.length} de ${ids.length} pedidos não tiveram os itens lidos — os ` +
      "totais acima excluem esses pedidos.";
  }

  if ((lista.total ?? 0) > pedidos.length) {
    resultado.truncado =
      `Existem ${lista.total} pedidos no filtro e ${pedidos.length} foram analisados. ` +
      "Estreite o período ou aumente max_pedidos.";
  }

  return resultado;
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// APROVAÇÃO EM LOTE
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * Teto por chamada. Não é limitação técnica: é o ponto em que a prévia deixa
 * de ser conferível por uma pessoa. Aprovar 200 pedidos de uma vez não é uma
 * decisão, é um acidente esperando acontecer.
 */
export const MAX_POR_LOTE = 50;

/**
 * Levanta o que será aprovado, para que a confirmação não seja cega.
 *
 * Custa uma chamada por pedido mais os cadastros — e vale: confirmar uma
 * aprovação sem ver valor e fornecedor é o mesmo que não confirmar. Os nomes
 * saem do cache quando já foram resolvidos numa consulta anterior da fila.
 */
export async function previaDeAprovacao(makeRequest, deps = {}, ids = []) {
  const { itensPorPedido, falhas } = await buscarItensEmLote(makeRequest, ids, CONCORRENCIA);

  const cabecalhos = await comFreio(ids, CONCORRENCIA, async (id) => {
    const r = await purchaseOrders.buscarPedido(makeRequest, id);
    return [id, r.success ? r.purchaseOrder : null];
  });
  const porId = new Map(cabecalhos);

  const [fornecedores, obras] = await Promise.all([
    resolverFornecedores(
      makeRequest,
      deps,
      [...porId.values()].map((p) => p?.supplierId),
      CONCORRENCIA
    ),
    resolverObras(
      makeRequest,
      deps,
      [...porId.values()].map((p) => p?.buildingId),
      CONCORRENCIA
    ),
  ]);

  const linhas = [];
  const naoEncontrados = [];
  let total = 0;

  for (const id of ids) {
    const pedido = porId.get(id);
    if (!pedido) {
      naoEncontrados.push(id);
      continue;
    }
    const itens = itensPorPedido.get(id) ?? [];
    const valor = arred(itens.reduce((s, i) => s + totalDoItem(i), 0));
    total += valor;

    linhas.push({
      pedido: id,
      data: primeiro(pedido, DATA_PEDIDO),
      fornecedor: fornecedores.nomes[String(pedido.supplierId)] ?? pedido.supplierId,
      obra: obras.nomes[String(pedido.buildingId)] ?? pedido.buildingId,
      valor,
      itens: itens.length,
      // Um pedido já autorizado não deveria entrar num lote de aprovação: ou
      // é engano de quem montou a lista, ou o estado mudou desde a consulta.
      ja_autorizado: pedido.authorized === true || undefined,
      consistencia: pedido.consistency !== "CONSISTENT" ? pedido.consistency : undefined,
    });
  }

  return {
    linhas,
    total: arred(total),
    naoEncontrados,
    itensNaoLidos: falhas.map((f) => f.pedido),
  };
}

/**
 * Autoriza vários pedidos, um a um, e relata cada resultado.
 *
 * **Sequencial de propósito.** Paralelizar economizaria segundos e custaria
 * clareza: numa falha no meio do lote, o que importa é saber exatamente o que
 * foi aprovado e o que não foi. Com escrita, essa resposta vale mais que a
 * latência — e o volume aqui é de dezenas, não de milhares.
 *
 * Nunca aborta no primeiro erro: um pedido que falha não deve impedir os
 * seguintes, e interromper deixaria o lote num estado que ninguém pediu.
 */
export async function aprovarPedidosEmLote(makeRequest, ids = [], observacao = null) {
  const aprovados = [];
  const falharam = [];

  for (const id of ids) {
    const r = await purchaseOrders.autorizarPedido(makeRequest, id, observacao);
    if (r.success) aprovados.push(id);
    else falharam.push({ pedido: id, erro: r.details || r.error, estado_incerto: r.estado_incerto });
  }

  const incertos = falharam.filter((f) => f.estado_incerto).map((f) => f.pedido);

  return {
    success: falharam.length === 0,
    aprovados,
    falharam,
    resumo:
      `${aprovados.length} de ${ids.length} pedido(s) autorizado(s)` +
      (falharam.length ? `; ${falharam.length} falhou(aram)` : ""),
    ...(incertos.length
      ? {
          atencao_estado_incerto:
            `Os pedidos ${incertos.join(", ")} falharam sem resposta do Sienge — a ` +
            "autorização PODE ter sido aplicada. Consulte o estado deles no ERP antes " +
            "de tentar de novo.",
        }
      : {}),
  };
}
