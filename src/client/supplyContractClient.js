/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Orquestração de contratos de suprimentos e suas medições. Combina as
 * funções cruas de `api/supply-contracts-v1.js` e
 * `api/supply-contracts-measurements-v1.js` no que uma pergunta de negócio
 * precisa, numa chamada só.
 *
 * O PROBLEMA CENTRAL DESTE MÓDULO É A IDENTIDADE. Quem pergunta diz "o
 * contrato de alvenaria da obra IU.06" ou "contrato 1234"; a API quer o par
 * (`documentId`, `contractNumber`) — e as medições querem, além disso, a obra
 * e um número de medição que é sequencial POR OBRA. Ninguém sabe de cabeça
 * que o documento é "CT". Então tudo aqui aceita nome e número soltos e
 * resolve por dentro; ver `resolverContratoPorReferencia`.
 *
 * A resolução tem um custo que não existe em compras: a API NÃO lista
 * contratos sem um período de datas. Não há "todos". Então toda busca por
 * referência varre uma JANELA (padrão: 4 anos até hoje) e diz, na resposta,
 * qual janela varreu — um contrato mais antigo que a janela não é "não
 * existe", é "não olhei lá".
 *
 * Três helpers (`normalizar`, `casarUnico`, resolução de obra por nome) são
 * cópias de `purchaseClient.js`. Duplicados de propósito por ora: extrair um
 * módulo comum mexeria no fluxo de compras, que está em produção e coberto
 * por testes. Quando aparecer o terceiro consumidor, eles devem sair daqui e
 * de lá para um módulo só.
 */

import {
  buscarContrato,
  buscarContratos,
  buscarObrasDoContrato,
  buscarItensDoContrato,
  buscarAditivos,
  autorizarContrato,
  reprovarContrato,
} from "../api/supply-contracts-v1.js";
import {
  buscarMedicoes,
  buscarItensDaMedicao,
  buscarLiberacao,
  criarMedicao,
  autorizarMedicao,
  reprovarMedicao,
} from "../api/supply-contracts-measurements-v1.js";
import { buscarCentroDeCusto, buscarCentrosDeCusto } from "../api/cost-center-v1.js";
import { buscarCredor } from "../api/creditor-v1.js";

// =========================================================
// VOCABULÁRIO
// =========================================================
// A API filtra por LETRAS (`N`, `A`, `S`, `T`) e a mesma letra muda de
// sentido entre parâmetros — ver o cabeçalho de `api/supply-contracts-v1.js`.
// Ninguém deve digitar isso, nem o modelo: aqui em cima se fala em palavras,
// e a tradução para letra acontece num lugar só.

const AUTORIZACAO = {
  aguardando: "N",
  aprovados: "A",
  reprovados: "S",
  todos: "T",
};

const CONSISTENCIA = {
  consistente: "S",
  inconsistente: "N",
  inclusao: "I",
  todos: "T",
};

function letra(mapa, palavra, oQue) {
  if (palavra === null || palavra === undefined || palavra === "") return undefined;
  const chave = normalizar(palavra).replace(/\s+/g, "");
  const achado = Object.keys(mapa).find((k) => normalizar(k).replace(/\s+/g, "") === chave);
  if (!achado) {
    return {
      erro: {
        success: false,
        error: "SituacaoInvalida",
        message: `'${palavra}' não é uma situação de ${oQue}.`,
        opcoes: Object.keys(mapa),
      },
    };
  }
  return mapa[achado];
}

// Janela padrão da varredura de contratos. Quatro anos: contrato de
// suprimentos é de vida longa — um assinado há três anos ainda recebe medição
// —, e a janela é o que separa "não existe" de "não olhei lá".
const JANELA_PADRAO_ANOS = 4;

const PAGINA = 200;
const MAX_PAGINAS = 25; // 5000 contratos/medições numa varredura

/** Máximo de candidatos devolvidos numa pendência — lista maior não ajuda ninguém. */
const MAX_CANDIDATOS = 15;

// Raiz mínima para duas palavras serem consideradas parentes na ORDENAÇÃO.
// Seis letras: "instalac" (8) aproxima instalação de instalações; "hidr" (4)
// não aproxima hidráulica de hidrossanitária, que é exatamente o que não pode
// virar casamento.
const RAIZ_MINIMA = 6;

/** Máximo de contratos devolvidos quando a busca por nome não acha nada. */
const MAX_NA_JANELA = 40;

/** Máximo de itens de contrato listados numa pendência de item não encontrado. */
const MAX_ITENS_SUGERIDOS = 60;

// =========================================================
// DATAS E TEXTO
// =========================================================

/** Data de hoje em yyyy-MM-dd, no fuso local — a API não aceita timestamp. */
function hoje() {
  const d = new Date();
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

function anosAtras(anos) {
  const d = new Date();
  d.setFullYear(d.getFullYear() - anos);
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const dia = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/** Janela de datas de uma varredura, com o padrão explícito na resposta. */
function janela(desde, ate) {
  return {
    contractStartDate: desde || anosAtras(JANELA_PADRAO_ANOS),
    contractEndDate: ate || hoje(),
  };
}

/**
 * Normaliza texto para casamento: sem acento, sem caixa, sem espaço dobrado.
 * "Alvenaria de Vedação" e "alvenaria de vedacao" têm que casar — quem digita
 * o nome de um item de contrato não repete a acentuação do cadastro.
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
 * Casa um termo contra candidatos, devolvendo um só ou o erro com as opções.
 *
 * Igualdade exata vence substring, pelo mesmo motivo de `purchaseClient`: sem
 * essa regra, o nome mais curto de um cadastro ("Torre A" contra "Torre A" e
 * "Torre A - Cobertura") nunca seria selecionável.
 */
function casarUnico(termo, candidatos, descrever, oQue) {
  const alvo = normalizar(termo);
  if (!alvo) {
    return { success: false, error: "TermoVazio", message: `Termo de busca vazio para ${oQue}.` };
  }

  const exatos = candidatos.filter((c) => normalizar(descrever(c).texto) === alvo);
  const escolhidos = exatos.length
    ? exatos
    : candidatos.filter((c) => normalizar(descrever(c).texto).includes(alvo));

  if (escolhidos.length === 0) {
    return {
      success: false,
      error: "NaoEncontrado",
      message: `Nada em ${oQue} bate com '${termo}'.`,
    };
  }
  if (escolhidos.length > 1) {
    return {
      success: false,
      error: "Ambiguo",
      message: `'${termo}' bateu em ${escolhidos.length} ${oQue} — seja mais específico.`,
      candidatos: escolhidos.slice(0, MAX_CANDIDATOS).map(descrever),
    };
  }
  return { success: true, valor: escolhidos[0] };
}

/** Varre todas as páginas de um endpoint paginado. */
async function varrer(buscar, chave) {
  const acumulado = [];
  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const resposta = await buscar({ limit: PAGINA, offset: pagina * PAGINA });
    if (!resposta.success) return resposta;

    acumulado.push(...resposta[chave]);
    const total = resposta.total ?? acumulado.length;
    if (resposta[chave].length === 0 || acumulado.length >= total) break;
  }
  return { success: true, [chave]: acumulado };
}

// =========================================================
// RESOLUÇÃO
// =========================================================

/** Resolvedor de obra por id, com cache por chamada — igual ao de compras. */
function criarResolverObra() {
  const cache = new Map();
  return async function resolverObra(buildingId) {
    if (buildingId === null || buildingId === undefined) return null;
    if (cache.has(buildingId)) return cache.get(buildingId);

    const resposta = await buscarCentroDeCusto(buildingId);
    const obra = {
      id: buildingId,
      name: resposta.success ? (resposta.costCenter?.name ?? null) : null,
    };
    cache.set(buildingId, obra);
    return obra;
  };
}

/** Resolvedor de fornecedor por id, com cache por chamada. */
function criarResolverFornecedor() {
  const cache = new Map();
  return async function resolverFornecedor(creditorId) {
    if (creditorId === null || creditorId === undefined) return null;
    if (cache.has(creditorId)) return cache.get(creditorId);

    const resposta = await buscarCredor(creditorId);
    const fornecedor = resposta.success
      ? { id: creditorId, name: resposta.creditor?.name ?? null, cnpj: resposta.creditor?.cnpj }
      : { id: creditorId, name: null };
    cache.set(creditorId, fornecedor);
    return fornecedor;
  };
}

/**
 * Resolve um nome de obra para um buildingId único.
 *
 * A API de centro de custo não tem busca textual — busca a lista inteira
 * (poucas dezenas nesta conta) e filtra por substring aqui. Vale a mesma
 * observação de `purchaseClient`: nesta instalação o buildingId do contrato e
 * o costCenterId coincidem, e `detalharContrato` confere isso contra as obras
 * que o próprio contrato declara.
 */
async function resolverIdDaObraPorNome(nome) {
  const resposta = await buscarCentrosDeCusto({ limit: 200 });
  if (!resposta.success) return resposta;

  const termo = normalizar(nome);
  const candidatos = resposta.cost_centers.filter((c) => {
    const n = normalizar(c.name);
    // "NÃO USAR" no nome é obra desativada que a conta mantém por histórico.
    if (n.includes("nao usar")) return false;
    return true;
  });

  const achado = casarUnico(termo, candidatos, (c) => ({ texto: c.name, id: c.id, name: c.name }), "obras");
  if (!achado.success) {
    return achado.error === "NaoEncontrado"
      ? { ...achado, error: "ObraNaoEncontrada", message: `Nenhuma obra bate com '${nome}'.` }
      : { ...achado, error: "ObraAmbigua" };
  }
  // O nome volta junto: quem confirma uma escrita precisa ver "IU.06 -
  // Residencial Ipê Uva" na prévia, não só o id 30.
  return { success: true, id: achado.valor.id, name: achado.valor.name };
}

/**
 * Soma dois valores monetários tratando ausência como ausência.
 *
 * `0 + undefined` é 0, e um saldo zerado significa coisa MUITO diferente de um
 * saldo que a API não devolveu. Só soma o que existe; se nenhum dos dois veio,
 * devolve null.
 */
function somar(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? null : Number(b);
  if (b === null || b === undefined) return Number(a);
  return Number((Number(a) + Number(b)).toFixed(2));
}

/**
 * Prazo do contrato: início, fim e quantos dias faltam.
 *
 * `dias_restantes` é derivado da data de hoje e vem negativo quando o prazo já
 * venceu — o que não quer dizer contrato encerrado: contrato vencido com saldo
 * é justamente o que alguém precisa enxergar.
 */
function prazo(contrato) {
  const inicio = contrato.startDate ?? null;
  const fim = contrato.endDate ?? null;
  if (!inicio && !fim) return null;

  let dias = null;
  if (fim) {
    const alvo = new Date(`${fim}T12:00:00`);
    const agora = new Date(`${hoje()}T12:00:00`);
    if (!Number.isNaN(alvo.getTime())) {
      dias = Math.round((alvo - agora) / 86400000);
    }
  }
  return { startDate: inicio, endDate: fim, ...(dias === null ? {} : { dias_restantes: dias }) };
}

/**
 * Uma palavra do termo aparece no texto, tolerando plural e pontuação.
 *
 * O casamento é por PREFIXO, nos dois sentidos: "hidrossanitarias" acha
 * "Hidrossanitária" e vice-versa. Sem isso, o plural que a pessoa fala derruba
 * o casamento com o singular que está cadastrado — e a busca falha por causa
 * de um "s".
 *
 * Não vai além disso de propósito. Sinônimo de obra é outra coisa: nenhuma
 * regra de texto liga "hidrossanitária" a "HIDRAULICA, ESGOTO, GÁS E INCÊNDIO",
 * que é como o mesmo serviço aparece cadastrado no ERP de produção. Adivinhar
 * aí seria escolher o contrato errado com cara de acerto — para esse caso
 * existe a lista de candidatos.
 */
function temPalavra(texto, palavra) {
  const limpo = normalizar(texto).replace(/[^a-z0-9 ]+/g, " ");
  return limpo
    .split(" ")
    .some((p) => p.length > 3 && (p.startsWith(palavra) || palavra.startsWith(p)));
}

/**
 * Quantas palavras do termo LEMBRAM alguma palavra do objeto do contrato.
 *
 * Aqui a régua é mais frouxa que a de `temPalavra`, de propósito: basta uma
 * raiz de 6 letras em comum. É o que aproxima "instalações" de "INSTALAÇÃO" —
 * o plural em -ões contra o singular em -ão, que nenhuma comparação por
 * prefixo resolve, porque as duas divergem na nona letra.
 *
 * A frouxidão só é aceitável porque isto ORDENA, não escolhe. Uma raiz comum
 * também aproxima "contrato" de "contratação"; num ranking isso custa uma
 * linha fora de lugar, enquanto num casamento automático custaria o contrato
 * errado.
 */
function relevancia(objeto, palavras) {
  const doObjeto = normalizar(objeto)
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(" ")
    .filter((p) => p.length >= RAIZ_MINIMA);

  return palavras.filter((p) =>
    doObjeto.some((o) => raizComum(o, p) >= RAIZ_MINIMA)
  ).length;
}

/** Quantas letras iniciais duas palavras têm em comum. */
function raizComum(a, b) {
  const limite = Math.min(a.length, b.length);
  let i = 0;
  while (i < limite && a[i] === b[i]) i++;
  return i;
}

/**
 * Ordena os contratos da janela pelo quanto cada objeto lembra o termo
 * buscado, e corta numa lista que ainda caiba numa resposta.
 *
 * O corte é o ponto: a obra IU.06 tem 75 contratos em quatro anos. Devolver os
 * 75 é ilegível e caro; devolver os 15 primeiros por data escondeu justamente
 * o contrato certo, que era o 43º. Ordenar por relevância põe os candidatos
 * plausíveis no topo antes de cortar.
 */
function ordenarPorRelevancia(contratos, termo) {
  const palavras = normalizar(termo).split(" ").filter((p) => p.length > 3);
  if (!palavras.length) return contratos.slice(0, MAX_NA_JANELA);

  return [...contratos]
    .map((c) => ({ c, peso: relevancia(c.object, palavras) }))
    .sort((a, b) => b.peso - a.peso || String(b.c.contractDate).localeCompare(String(a.c.contractDate)))
    .slice(0, MAX_NA_JANELA)
    .map((x) => x.c);
}

/** Lê o primeiro nome de campo que a resposta de fato trouxe. */
function campo(objeto, ...nomes) {
  for (const nome of nomes) {
    const valor = objeto?.[nome];
    if (valor !== undefined && valor !== null) return valor;
  }
  return undefined;
}

/**
 * O id da obra que o RESTO DA API aceita — e ele não é o primeiro que aparece.
 *
 * `GET /supply-contracts/buildings` devolve DOIS ids para a mesma obra, e a
 * diferença entre eles custou uma tarde contra o tenant de produção:
 *
 *   buildingID: 21      id interno; NENHUM outro endpoint aceita
 *   buildingIdView: 20  código da obra no Sienge; é o que todos aceitam
 *
 * Note também o D maiúsculo em `buildingID` e `costCenterID`: o spec declara
 * as duas chaves em camelCase, a API responde outra coisa. Ler pelo nome do
 * spec devolve `undefined`.
 *
 * E o erro é dos piores porque só ÀS VEZES falha alto. Conferido em produção,
 * no contrato CTS/325 da obra iU.06:
 *
 *   GET /supply-contracts/items?buildingId=21   → 404 "Obra 21 não encontrada"
 *   GET /supply-contracts/all?buildingId=21     → 200 com 85 contratos de OUTRA obra
 *   GET /supply-contracts/all?buildingId=20     → 200 com os 75 contratos certos
 *
 * O 404 a gente vê; os 85 contratos de outra obra chegam como resposta bem
 * sucedida. É o mesmo id que `/cost-centers` usa (20) e o mesmo que as
 * medições devolvem em `buildingId`, então `view` é a moeda corrente aqui.
 */
function idDaObra(obraDoContrato) {
  return campo(
    obraDoContrato,
    "buildingIdView",
    "costCenterIdView",
    "buildingId",
    "buildingID"
  );
}

/**
 * Unidade construtiva bloqueada não recebe medição.
 *
 * O spec declara `L`/`B`; produção responde `RELEASED`. Aceita as duas, e
 * qualquer valor desconhecido conta como NÃO bloqueada — um aviso a menos é
 * melhor que um aviso falso a cada medição.
 */
function unidadeBloqueada(unidade) {
  const status = String(unidade?.status ?? "").toUpperCase();
  return status === "B" || status === "BLOCKED" || status === "BLOQUEADA";
}

/** Reduz um contrato aos campos que importam para identificar e decidir. */
function resumirContrato(contrato) {
  return {
    documentId: contrato.documentId,
    contractNumber: contrato.contractNumber,
    object: contrato.object,
    contractDate: contrato.contractDate,
    status: contrato.status,
    statusApproval: contrato.statusApproval,
    isAuthorized: contrato.isAuthorized,
    consistent: contrato.consistent,
    currentAuthorizationLevel: contrato.currentAuthorizationLevel,
    supplierId: contrato.supplierId,
    customerId: contrato.customerId,
    companyId: contrato.companyId,
    contractType: contrato.contractType,
    contractTemplateName: contrato.contractTemplateName,
    prazo: prazo(contrato),
    totalMaterialValue: contrato.totalMaterialValue,
    totalLaborValue: contrato.totalLaborValue,
    // O "valor do contrato" que se pergunta em voz alta é a soma dos dois. O
    // Sienge não a devolve pronta: material e mão de obra são campos separados
    // porque medem e pagam separado.
    valor_total: somar(contrato.totalMaterialValue, contrato.totalLaborValue),
    // Só o GET de um contrato traz saldo; a listagem não. Ausente é ausente,
    // não zero — por isso não há default aqui.
    ...(contrato.materialBalance !== undefined
      ? { materialBalance: contrato.materialBalance }
      : {}),
    ...(contrato.laborBalance !== undefined ? { laborBalance: contrato.laborBalance } : {}),
    ...(contrato.materialBalance !== undefined || contrato.laborBalance !== undefined
      ? { saldo_total: somar(contrato.materialBalance, contrato.laborBalance) }
      : {}),
    ...(contrato.disapprovalReason?.length
      ? { disapprovalReason: contrato.disapprovalReason }
      : {}),
  };
}

/** Rótulo curto de um contrato, para mensagem. */
function rotulo(documentId, contractNumber) {
  return `${documentId}/${contractNumber}`;
}

/**
 * Varre contratos numa janela, já com os filtros traduzidos para letra.
 *
 * A janela é OBRIGATÓRIA na API — ver o cabeçalho deste arquivo. Devolve
 * também qual janela usou, para a resposta poder dizer onde olhou.
 */
async function varrerContratos({ buildingId, companyId, desde, ate, autorizacao, consistencia }) {
  const periodo = janela(desde, ate);

  const varredura = await varrer(
    (pag) =>
      buscarContratos({
        ...periodo,
        buildingId,
        companyId,
        authorization: autorizacao,
        consistency: consistencia,
        ...pag,
      }),
    "contracts"
  );
  if (!varredura.success) return varredura;

  return { success: true, contracts: varredura.contracts, janela: periodo };
}

/**
 * Resolve uma referência solta de contrato para o par (documentId, contractNumber).
 *
 * Quatro caminhos, do mais barato ao mais caro:
 *
 *   documento + contrato → confere direto no GET, uma chamada
 *   contrato numérico    → varre a janela e casa por número
 *   texto                → varre a janela e casa pelo objeto do contrato
 *   nada, com obra       → varre a janela da obra; único contrato resolve
 *
 * Zero ou mais de um resultado vira erro COM OS CANDIDATOS, cada um com o par
 * que o identifica: quem chamou responde com o par exato na próxima tentativa
 * em vez de adivinhar de novo.
 */
async function resolverContratoPorReferencia({ contrato, documento, obra, desde, ate } = {}) {
  let buildingId, obraResolvida;

  if (obra !== undefined && obra !== null && obra !== "") {
    // Número é id, texto é nome. Resolver um id por nome varreria a lista de
    // centros de custo procurando "30" na descrição e não acharia nada.
    if (typeof obra === "number") {
      obraResolvida = { success: true, id: obra, name: null };
    } else {
      obraResolvida = await resolverIdDaObraPorNome(obra);
      if (!obraResolvida.success) return obraResolvida;
    }
    buildingId = obraResolvida.id;
  }

  // Caminho barato: o par completo já veio. Uma chamada confirma que existe.
  if (documento && contrato) {
    const resposta = await buscarContrato(documento, contrato);
    if (!resposta.success) return resposta;
    return {
      success: true,
      documentId: String(documento),
      contractNumber: String(contrato),
      contrato: resumirContrato(resposta.contract ?? {}),
      obra: obraResolvida ? { id: obraResolvida.id, name: obraResolvida.name } : undefined,
    };
  }

  if (!contrato && buildingId === undefined) {
    return {
      success: false,
      error: "ContratoNaoInformado",
      message:
        "Informe o contrato (número ou parte do objeto) ou a obra — sem um dos dois não " +
        "há como saber de qual contrato se está falando.",
    };
  }

  const varredura = await varrerContratos({ buildingId, desde, ate });
  if (!varredura.success) return varredura;

  const ondeOlhei =
    `contratos com data entre ${varredura.janela.contractStartDate} e ` +
    `${varredura.janela.contractEndDate}` +
    (obraResolvida ? `, na obra ${obraResolvida.name ?? buildingId}` : "");

  let candidatos = varredura.contracts;

  if (contrato) {
    const termo = normalizar(contrato);
    // Número primeiro: "1234" tem que resolver pelo número do contrato, e não
    // por um objeto que por acaso contenha 1234.
    const porNumero = candidatos.filter((c) => normalizar(c.contractNumber) === termo);

    if (porNumero.length) {
      candidatos = porNumero;
    } else {
      const porTrecho = candidatos.filter((c) => normalizar(c.object).includes(termo));
      // Substring falha no caso mais comum de todos: quem pergunta escreve
      // "instalações hidrossanitárias" e o objeto cadastrado é "Elaboração de
      // projeto executivo de instalações (Hidrossanitária, Gás...)". Nenhuma
      // palavra está errada — mudam a ordem, a pontuação e o plural. Então, se
      // o trecho inteiro não bater, exige-se que TODAS as palavras apareçam,
      // casando por prefixo para o plural não derrubar o casamento.
      const palavras = termo.split(" ").filter((p) => p.length > 3);
      candidatos = porTrecho.length
        ? porTrecho
        : palavras.length
          ? candidatos.filter((c) => palavras.every((p) => temPalavra(c.object, p)))
          : [];
    }
  }

  if (candidatos.length === 0) {
    return {
      success: false,
      error: "ContratoNaoEncontrado",
      message:
        `Nenhum contrato bate com '${contrato ?? obra}'. Olhei em ${ondeOlhei}. ` +
        `Contrato mais antigo que essa janela não aparece — informe 'desde' para ampliá-la. ` +
        `Abaixo, o que existe na janela: se um deles for o procurado, responda com o par ` +
        `documento + contrato dele.`,
      // O nome do cadastro raramente é o nome que a pessoa usa: em produção,
      // "instalações hidrossanitárias" está cadastrado como "SERVIÇO DE
      // INSTALAÇÃO HIDRAULICA, ESGOTO, GÁS E INCÊNDIO". Nenhuma regra de texto
      // liga os dois — só quem conhece a obra liga. Por isso a lista vem
      // ORDENADA por quantas palavras do termo aparecem no objeto: quem tem
      // "instalação" sobe, e a escolha certa costuma estar nas primeiras
      // linhas. Ordenar não é escolher; a decisão continua sendo de quem lê.
      contratos_na_janela: ordenarPorRelevancia(varredura.contracts, contrato).map((c) => ({
        documento: c.documentId,
        contrato: c.contractNumber,
        object: c.object,
        contractDate: c.contractDate,
        status: c.status,
      })),
      total_na_janela: varredura.contracts.length,
      janela: varredura.janela,
    };
  }
  if (candidatos.length > 1) {
    return {
      success: false,
      error: "ContratoAmbiguo",
      message:
        `'${contrato ?? obra}' bateu em ${candidatos.length} contratos — responda com o par ` +
        `documento + contrato de um deles.`,
      candidatos: candidatos.slice(0, MAX_CANDIDATOS).map((c) => ({
        documento: c.documentId,
        contrato: c.contractNumber,
        object: c.object,
        contractDate: c.contractDate,
        status: c.status,
      })),
      janela: varredura.janela,
    };
  }

  const escolhido = candidatos[0];
  return {
    success: true,
    documentId: escolhido.documentId,
    contractNumber: escolhido.contractNumber,
    contrato: resumirContrato(escolhido),
    obra: obraResolvida ? { id: obraResolvida.id, name: obraResolvida.name } : undefined,
    janela: varredura.janela,
  };
}

// =========================================================
// LEITURA
// =========================================================

/**
 * Lista contratos de suprimentos, com fornecedor resolvido.
 *
 * @param {object} [filtros]
 * @param {string} [filtros.obra] nome (ou parte) da obra
 * @param {string} [filtros.desde] início da janela (yyyy-MM-dd); padrão: 4 anos atrás
 * @param {string} [filtros.ate] fim da janela (yyyy-MM-dd); padrão: hoje
 * @param {"aguardando"|"aprovados"|"reprovados"|"todos"} [filtros.situacao]
 * @param {"consistente"|"inconsistente"|"inclusao"|"todos"} [filtros.consistencia]
 * @param {number} [filtros.empresa] código da empresa
 */
export async function listarContratos({
  obra,
  desde,
  ate,
  situacao,
  consistencia,
  empresa,
} = {}) {
  const autorizacao = letra(AUTORIZACAO, situacao, "autorização");
  if (autorizacao?.erro) return autorizacao.erro;
  const consistencial = letra(CONSISTENCIA, consistencia, "consistência");
  if (consistencial?.erro) return consistencial.erro;

  let buildingId, obraResolvida;
  if (obra) {
    obraResolvida = await resolverIdDaObraPorNome(obra);
    if (!obraResolvida.success) return obraResolvida;
    buildingId = obraResolvida.id;
  }

  const varredura = await varrerContratos({
    buildingId,
    companyId: empresa,
    desde,
    ate,
    autorizacao,
    consistencia: consistencial,
  });
  if (!varredura.success) return varredura;

  const resolverFornecedor = criarResolverFornecedor();
  const contratos = [];
  for (const contrato of varredura.contracts) {
    contratos.push({
      ...resumirContrato(contrato),
      supplier: await resolverFornecedor(contrato.supplierId),
    });
  }

  return {
    success: true,
    count: contratos.length,
    janela: varredura.janela,
    ...(obraResolvida ? { obra: { id: obraResolvida.id, name: obraResolvida.name } } : {}),
    contracts: contratos,
  };
}

/**
 * Raio-x de um contrato: cabeçalho, obras com suas unidades construtivas,
 * itens de cada planilha e, opcionalmente, os aditivos.
 *
 * Existe para não obrigar quem chama a encadear quatro tools. O contrato tem
 * os itens espalhados por planilha (obra × unidade construtiva) e não há
 * endpoint que devolva "todos os itens do contrato" — são N chamadas, e elas
 * acontecem aqui dentro.
 *
 * `incluir_itens: false` corta essas N chamadas quando a pergunta é só sobre
 * o cabeçalho.
 */
export async function detalharContrato({
  contrato,
  documento,
  obra,
  desde,
  ate,
  incluir_itens = true,
  incluir_aditivos = false,
} = {}) {
  const referencia = await resolverContratoPorReferencia({ contrato, documento, obra, desde, ate });
  if (!referencia.success) return referencia;

  const { documentId, contractNumber } = referencia;

  // O GET do contrato traz o que a listagem não traz — saldo de material e de
  // mão de obra —, então vale a chamada mesmo quando a referência já resolveu
  // pelo /all.
  const cabecalho = await buscarContrato(documentId, contractNumber);
  if (!cabecalho.success) return cabecalho;

  const resolverFornecedor = criarResolverFornecedor();
  const detalhe = {
    ...resumirContrato(cabecalho.contract ?? {}),
    supplier: await resolverFornecedor(cabecalho.contract?.supplierId),
  };

  const obrasResposta = await buscarObrasDoContrato(documentId, contractNumber, { limit: 200 });
  if (!obrasResposta.success) return obrasResposta;

  const obras = [];
  for (const obraDoContrato of obrasResposta.buildings) {
    const unidades = (obraDoContrato.constructUnits ?? []).map((u) => ({
      id: u.id,
      name: u.name,
      // Planilha bloqueada não recebe medição. O status vai cru — o spec diz
      // "L"/"B" e produção responde "RELEASED" — com a leitura já resolvida
      // ao lado, para ninguém precisar decidir qual vocabulário é o certo.
      status: u.status,
      bloqueada: unidadeBloqueada(u),
    }));

    const registro = {
      buildingId: idDaObra(obraDoContrato),
      buildingName: obraDoContrato.buildingName,
      costCenterId: campo(obraDoContrato, "costCenterIdView", "costCenterId", "costCenterID"),
      // O id interno vai junto, marcado: ele aparece na resposta da API e
      // alguém vai perguntar por que dois números descrevem a mesma obra.
      buildingIdInterno: campo(obraDoContrato, "buildingID", "buildingId"),
      constructUnits: unidades,
    };

    if (incluir_itens) {
      registro.planilhas = [];
      for (const unidade of unidades) {
        const itens = await buscarItensDoContrato(
          documentId,
          contractNumber,
          idDaObra(obraDoContrato),
          unidade.id,
          { limit: 200 }
        );
        registro.planilhas.push({
          buildingUnitId: unidade.id,
          buildingUnitName: unidade.name,
          count: itens.success ? itens.count : 0,
          items: itens.success ? itens.items.map(resumirItemDeContrato) : [],
          ...(itens.success ? {} : { erro: itens.message }),
        });
      }
    }

    obras.push(registro);
  }

  const resultado = {
    success: true,
    documento: documentId,
    contrato: contractNumber,
    contract: detalhe,
    buildings: obras,
  };

  if (incluir_aditivos) {
    const aditivos = await buscarAditivos({
      documentId,
      contractNumber,
      limit: 200,
    });
    resultado.addenda = aditivos.success ? aditivos.addenda : [];
    if (!aditivos.success) resultado.addenda_erro = aditivos.message;
  }

  return resultado;
}

/**
 * Reduz um item de contrato ao que se usa para reconhecê-lo e medi-lo.
 *
 * `mensuravel` é derivado, não vem da API: o spec diz que só se mede item de
 * ÚLTIMO NÍVEL — insumo ou serviço, nunca agrupador —, e que `resourceId` é
 * nulo em item de serviço enquanto `workItemId` é nulo em item de insumo. Um
 * item sem nenhum dos dois é agrupador da planilha.
 */
function resumirItemDeContrato(item) {
  return {
    id: item.id,
    wbsCode: item.wbsCode,
    level: item.level,
    description: item.description,
    detailDescription: item.detailDescription,
    unitOfMeasure: item.unitOfMeasure,
    quantity: item.quantity,
    materialPrice: item.materialPrice,
    laborPrice: item.laborPrice,
    // O preço unitário que se pergunta é um só; o Sienge guarda dois, porque
    // material e mão de obra são medidos e pagos separadamente. A soma vai
    // pronta, e as duas parcelas ficam do lado para quem precisa distinguir.
    precoUnitario: somar(item.materialPrice, item.laborPrice),
    valorTotal:
      item.quantity == null
        ? null
        : somar(
            item.materialPrice == null ? null : Number(item.materialPrice) * Number(item.quantity),
            item.laborPrice == null ? null : Number(item.laborPrice) * Number(item.quantity)
          ),
    auxiliaryCode: item.auxiliaryCode,
    hasAddendum: item.hasAddendum,
    mensuravel: item.resourceId != null || item.workItemId != null,
  };
}

/** Reduz uma medição ao que se usa para acompanhá-la e decidi-la. */
function resumirMedicao(medicao) {
  return {
    documentId: medicao.documentId,
    contractNumber: medicao.contractNumber,
    buildingId: medicao.buildingId,
    measurementNumber: medicao.measurementNumber,
    measurementDate: medicao.measurementDate,
    dueDate: medicao.dueDate,
    netValue: medicao.netValue,
    authorized: medicao.authorized,
    statusApproval: medicao.statusApproval,
    consistent: medicao.consistent,
    released: medicao.released,
    finalized: medicao.finalized,
    responsibleName: medicao.responsibleName,
    notes: medicao.notes,
  };
}

/**
 * Medições de um contrato, com a obra resolvida e, opcionalmente, a liberação
 * de cada uma — que é o elo com o financeiro (títulos gerados).
 *
 * `desde`/`ate` delimitam a janela usada para ACHAR o contrato, não as
 * medições: a listagem de medições não tem período obrigatório, então todas
 * as do contrato voltam.
 */
export async function listarMedicoesDoContrato({
  contrato,
  documento,
  obra,
  desde,
  ate,
  incluir_liberacao = false,
} = {}) {
  const referencia = await resolverContratoPorReferencia({ contrato, documento, obra, desde, ate });
  if (!referencia.success) return referencia;

  const { documentId, contractNumber } = referencia;

  const varredura = await varrer(
    (pag) =>
      buscarMedicoes({
        documentId,
        contractNumber,
        buildingId: referencia.obra?.id,
        ...pag,
      }),
    "measurements"
  );
  if (!varredura.success) return varredura;

  const resolverObra = criarResolverObra();
  const medicoes = [];
  for (const medicao of varredura.measurements) {
    const registro = {
      ...resumirMedicao(medicao),
      building: await resolverObra(medicao.buildingId),
    };

    if (incluir_liberacao) {
      const liberacao = await buscarLiberacao(
        documentId,
        contractNumber,
        medicao.buildingId,
        medicao.measurementNumber
      );
      registro.clearing = liberacao.success ? liberacao.clearing : null;
    }

    medicoes.push(registro);
  }

  return {
    success: true,
    documento: documentId,
    contrato: contractNumber,
    count: medicoes.length,
    measurements: medicoes,
  };
}

// =========================================================
// FILAS DE AUTORIZAÇÃO
// =========================================================
// Mesmo desenho das filas de compras: um cache curto serve a PRÉVIA, nunca a
// execução. Autorizar é irreversível por esta API, e entre ver a fila e mandar
// autorizar outra pessoa pode ter decidido o mesmo contrato — por isso quem
// grava relê a fila antes (`{ fresca: true }`).

const TTL_FILA_MS = 15 * 60 * 1000;
let filaDeContratos = null;
let filaDeMedicoes = null;

/**
 * Contratos aguardando autorização (`authorization: "N"`), com fornecedor e
 * obras resolvidos.
 *
 * Filtra SÓ por autorização. Em pedidos de compra a fila precisou também de
 * `consistency` e `status` para não trazer lixo — aqui isso não foi conferido
 * contra produção, então o campo `consistent` de cada contrato vai na resposta
 * em vez de virar filtro escondido: um contrato inconsistente aparece, e quem
 * decide vê que ele está inconsistente.
 */
export async function listarContratosParaAutorizacao({
  obra,
  desde,
  ate,
  fresca = false,
} = {}) {
  const agora = Date.now();
  const semFiltro = !obra && !desde && !ate;

  if (!fresca && semFiltro && filaDeContratos && agora - filaDeContratos.em < TTL_FILA_MS) {
    return { ...filaDeContratos.valor, do_cache: true };
  }

  const fila = await listarContratos({ obra, desde, ate, situacao: "aguardando" });
  if (!fila.success) return fila;

  const resolverObra = criarResolverObra();
  const contratos = [];
  for (const contrato of fila.contracts) {
    const obras = await buscarObrasDoContrato(contrato.documentId, contrato.contractNumber, {
      limit: 50,
    });
    contratos.push({
      ...contrato,
      buildings: obras.success
        ? await Promise.all(
            obras.buildings.map(async (b) => ({
              id: idDaObra(b),
              name: b.buildingName ?? (await resolverObra(idDaObra(b)))?.name ?? null,
            }))
          )
        : [],
    });
  }

  const resultado = {
    success: true,
    count: contratos.length,
    janela: fila.janela,
    contracts: contratos,
  };
  if (semFiltro) filaDeContratos = { em: agora, valor: resultado };
  return resultado;
}

/**
 * Medições aguardando autorização (`authorization: "N"`).
 *
 * Diferente da fila de contratos, esta NÃO precisa de janela de datas: a
 * listagem de medições não exige período.
 */
export async function listarMedicoesParaAutorizacao({
  contrato,
  documento,
  obra,
  fresca = false,
} = {}) {
  const agora = Date.now();
  const semFiltro = !contrato && !documento && !obra;

  if (!fresca && semFiltro && filaDeMedicoes && agora - filaDeMedicoes.em < TTL_FILA_MS) {
    return { ...filaDeMedicoes.valor, do_cache: true };
  }

  let buildingId;
  if (obra) {
    const resolvida = await resolverIdDaObraPorNome(obra);
    if (!resolvida.success) return resolvida;
    buildingId = resolvida.id;
  }

  const varredura = await varrer(
    (pag) =>
      buscarMedicoes({
        authorization: AUTORIZACAO.aguardando,
        documentId: documento,
        contractNumber: contrato,
        buildingId,
        ...pag,
      }),
    "measurements"
  );
  if (!varredura.success) return varredura;

  const resolverObra = criarResolverObra();
  const medicoes = [];
  for (const medicao of varredura.measurements) {
    medicoes.push({
      ...resumirMedicao(medicao),
      building: await resolverObra(medicao.buildingId),
    });
  }

  const resultado = { success: true, count: medicoes.length, measurements: medicoes };
  if (semFiltro) filaDeMedicoes = { em: agora, valor: resultado };
  return resultado;
}

// =========================================================
// DECISÃO — CONTRATOS E MEDIÇÕES
// =========================================================
// As duas decisões seguem o desenho já usado em compras, pelo mesmo motivo:
// só se decide o que a fila do ERP mostra como pendente. Um número lembrado
// de ontem pode já ter sido decidido por outra pessoa, e nem autorização nem
// reprovação têm endpoint que desfaça.

const DECISOES = {
  aprovar: { participio: "autorizado", acao: "autorização" },
  reprovar: { participio: "reprovado", acao: "reprovação" },
};

function validarDecisao(decisao) {
  if (!DECISOES[decisao]) {
    return {
      success: false,
      error: "DecisaoInvalida",
      message: `Decisão '${decisao}' não existe.`,
      opcoes: Object.keys(DECISOES),
    };
  }
  return null;
}

/**
 * Autoriza ou reprova contratos, conferindo antes contra a fila real.
 *
 * TRÊS MODOS, numa função só, para não obrigar quem chama a encadear:
 *
 *   sem `contratos`                  → devolve a fila, sem gravar
 *   com `contratos`, sem confirmar   → prévia do que seria decidido
 *   com `contratos` e confirmar      → grava
 *
 * IRREVERSÍVEL pela API, e NÃO ATÔMICO entre contratos: cada um é um PATCH
 * próprio. O retorno diz, um a um, o que passou e o que não passou.
 *
 * O aviso ao responsável só sai se o ERP estiver parametrizado como "Sempre
 * enviar aviso ao responsável" — é o próprio spec que condiciona o envio.
 * (Não confundir com o e-mail que a aprovação de PEDIDO DE COMPRA não dispara
 * por bug de paridade; ali a tela envia e o endpoint não.)
 *
 * @param {object} args
 * @param {Array<{contrato: string, documento?: string, observacao?: string}>} [args.contratos]
 * @param {"aprovar"|"reprovar"} [args.decisao="aprovar"]
 * @param {string} [args.observacao] observação aplicada a todos; até 300 caracteres
 * @param {boolean} [args.confirmar=false]
 */
export async function decidirContratos({
  contratos,
  decisao = "aprovar",
  observacao,
  confirmar = false,
} = {}) {
  const invalida = validarDecisao(decisao);
  if (invalida) return invalida;

  if (!contratos?.length) {
    const fila = await listarContratosParaAutorizacao();
    if (!fila.success) return fila;
    return {
      success: true,
      modo: "listagem",
      message:
        fila.count === 0
          ? "Nenhum contrato aguardando autorização na janela padrão."
          : `${fila.count} contrato(s) aguardando autorização. Nada foi gravado — para ` +
            `decidir, chame de novo informando 'contratos'.`,
      janela: fila.janela,
      count: fila.count,
      contracts: fila.contracts,
    };
  }

  // A prévia pode sair do cache; a execução relê a fila. Ver o comentário do
  // bloco de filas.
  const fila = await listarContratosParaAutorizacao({ fresca: confirmar });
  if (!fila.success) return fila;

  const alvos = [];
  const pendencias = [];

  for (const [indice, pedido] of contratos.entries()) {
    const numero = String(pedido?.contrato ?? "").trim();
    const nome = `contratos[${indice}]`;

    if (!numero) {
      pendencias.push({
        onde: nome,
        tipo: "Faltando",
        message: `${nome}: informe o número do contrato.`,
      });
      continue;
    }

    const candidatos = fila.contracts.filter(
      (c) =>
        normalizar(c.contractNumber) === normalizar(numero) &&
        (!pedido.documento || normalizar(c.documentId) === normalizar(pedido.documento))
    );

    if (candidatos.length === 0) {
      pendencias.push({
        onde: nome,
        tipo: "ForaDaFila",
        message:
          `${nome}: o contrato ${numero} não está aguardando autorização. Ou já foi ` +
          `decidido por outra pessoa, ou tem data fora da janela varrida ` +
          `(${fila.janela.contractStartDate} a ${fila.janela.contractEndDate}).`,
      });
      continue;
    }
    if (candidatos.length > 1) {
      pendencias.push({
        onde: nome,
        tipo: "Ambiguo",
        message:
          `${nome}: ${candidatos.length} contratos na fila têm o número ${numero} — ` +
          `informe também 'documento'.`,
        candidatos: candidatos.map((c) => ({ documento: c.documentId, contrato: c.contractNumber })),
      });
      continue;
    }

    alvos.push({ contrato: candidatos[0], observacao: pedido.observacao ?? observacao });
  }

  if (pendencias.length) {
    return {
      success: false,
      error: "DadosPendentes",
      message:
        `Nada foi gravado. ${pendencias.length} ponto(s) a resolver — todos abaixo, para ` +
        `você tratar de uma vez.`,
      pendencias,
    };
  }

  const previa = alvos.map(({ contrato, observacao: obs }) => ({
    documento: contrato.documentId,
    contrato: contrato.contractNumber,
    object: contrato.object,
    supplier: contrato.supplier?.name ?? contrato.supplierId,
    obras: contrato.buildings?.map((b) => b.name ?? b.id),
    totalMaterialValue: contrato.totalMaterialValue,
    totalLaborValue: contrato.totalLaborValue,
    consistent: contrato.consistent,
    currentAuthorizationLevel: contrato.currentAuthorizationLevel,
    ...(obs ? { observacao: obs } : {}),
  }));

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      decisao,
      message:
        `Nada foi gravado. ${alvos.length} contrato(s) seriam ${DECISOES[decisao].participio}s. ` +
        `Confira abaixo e, se estiver certo, chame de novo com confirmar: true e os MESMOS ` +
        `argumentos. A ${DECISOES[decisao].acao} é irreversível por esta API.`,
      previa,
    };
  }

  const resultados = [];
  for (const { contrato, observacao: obs } of alvos) {
    const executar = decisao === "aprovar" ? autorizarContrato : reprovarContrato;
    const resposta = await executar(contrato.documentId, contrato.contractNumber, {
      observation: obs,
    });

    resultados.push({
      documento: contrato.documentId,
      contrato: contrato.contractNumber,
      success: resposta.success,
      message: resposta.success ? resposta.message : (resposta.details ?? resposta.message),
    });
  }

  // A fila em cache ficou velha no instante em que a primeira decisão gravou.
  filaDeContratos = null;

  const ok = resultados.filter((r) => r.success).length;
  return {
    success: ok > 0,
    decisao,
    message:
      ok === resultados.length
        ? `✅ ${ok} contrato(s) ${DECISOES[decisao].participio}s.`
        : `⚠️ ${ok} de ${resultados.length} contrato(s) ${DECISOES[decisao].participio}s — ` +
          `cada contrato é uma chamada própria, então o resto não foi desfeito.`,
    resultados,
    previa,
  };
}

/**
 * Autoriza ou reprova medições, conferindo antes contra a fila real.
 *
 * Mesmos três modos e as mesmas garantias de `decidirContratos`. A diferença
 * é a identidade: medição é (documento, contrato, obra, número) — e o número
 * é sequencial POR OBRA, então "medição 3" sem obra é ambíguo por natureza
 * num contrato com mais de uma obra.
 *
 * @param {object} args
 * @param {Array<{contrato: string, documento?: string, obra?: string|number, medicao: number}>} [args.medicoes]
 * @param {"aprovar"|"reprovar"} [args.decisao="aprovar"]
 * @param {string} [args.observacao]
 * @param {boolean} [args.confirmar=false]
 */
export async function decidirMedicoes({
  medicoes,
  decisao = "aprovar",
  observacao,
  confirmar = false,
} = {}) {
  const invalida = validarDecisao(decisao);
  if (invalida) return invalida;

  if (!medicoes?.length) {
    const fila = await listarMedicoesParaAutorizacao();
    if (!fila.success) return fila;
    return {
      success: true,
      modo: "listagem",
      message:
        fila.count === 0
          ? "Nenhuma medição aguardando autorização."
          : `${fila.count} medição(ões) aguardando autorização. Nada foi gravado — para ` +
            `decidir, chame de novo informando 'medicoes'.`,
      count: fila.count,
      measurements: fila.measurements,
    };
  }

  const fila = await listarMedicoesParaAutorizacao({ fresca: confirmar });
  if (!fila.success) return fila;

  const alvos = [];
  const pendencias = [];

  for (const [indice, pedido] of medicoes.entries()) {
    const nome = `medicoes[${indice}]`;
    const numero = Number(pedido?.medicao);

    if (!Number.isInteger(numero)) {
      pendencias.push({
        onde: nome,
        tipo: "Faltando",
        message: `${nome}: informe o número da medição.`,
      });
      continue;
    }

    let buildingId;
    if (pedido.obra !== undefined && pedido.obra !== null && pedido.obra !== "") {
      if (typeof pedido.obra === "number") {
        buildingId = pedido.obra;
      } else {
        const resolvida = await resolverIdDaObraPorNome(pedido.obra);
        if (!resolvida.success) {
          pendencias.push({
            onde: `${nome}.obra`,
            tipo: "ObraNaoResolvida",
            message: `${nome}: ${resolvida.message}`,
            ...(resolvida.candidatos ? { candidatos: resolvida.candidatos } : {}),
          });
          continue;
        }
        buildingId = resolvida.id;
      }
    }

    const candidatos = fila.measurements.filter(
      (m) =>
        m.measurementNumber === numero &&
        (!pedido.contrato || normalizar(m.contractNumber) === normalizar(pedido.contrato)) &&
        (!pedido.documento || normalizar(m.documentId) === normalizar(pedido.documento)) &&
        (buildingId === undefined || m.buildingId === buildingId)
    );

    if (candidatos.length === 0) {
      pendencias.push({
        onde: nome,
        tipo: "ForaDaFila",
        message:
          `${nome}: a medição ${numero} não está aguardando autorização com esses dados. ` +
          `Ou já foi decidida, ou o contrato/obra informado não bate.`,
      });
      continue;
    }
    if (candidatos.length > 1) {
      pendencias.push({
        onde: nome,
        tipo: "Ambiguo",
        message:
          `${nome}: ${candidatos.length} medições na fila são a número ${numero} — o número é ` +
          `sequencial por obra, então informe 'obra' (e 'contrato', se preciso).`,
        candidatos: candidatos.map((m) => ({
          documento: m.documentId,
          contrato: m.contractNumber,
          obra: m.building?.name ?? m.buildingId,
          medicao: m.measurementNumber,
          measurementDate: m.measurementDate,
        })),
      });
      continue;
    }

    alvos.push({ medicao: candidatos[0], observacao: pedido.observacao ?? observacao });
  }

  if (pendencias.length) {
    return {
      success: false,
      error: "DadosPendentes",
      message:
        `Nada foi gravado. ${pendencias.length} ponto(s) a resolver — todos abaixo, para ` +
        `você tratar de uma vez.`,
      pendencias,
    };
  }

  const previa = alvos.map(({ medicao, observacao: obs }) => ({
    documento: medicao.documentId,
    contrato: medicao.contractNumber,
    obra: medicao.building?.name ?? medicao.buildingId,
    medicao: medicao.measurementNumber,
    measurementDate: medicao.measurementDate,
    dueDate: medicao.dueDate,
    netValue: medicao.netValue,
    consistent: medicao.consistent,
    ...(obs ? { observacao: obs } : {}),
  }));

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      decisao,
      message:
        `Nada foi gravado. ${alvos.length} medição(ões) seriam ${DECISOES[decisao].participio}s. ` +
        `Confira abaixo e, se estiver certo, chame de novo com confirmar: true e os MESMOS ` +
        `argumentos. A ${DECISOES[decisao].acao} é irreversível por esta API.`,
      previa,
    };
  }

  const resultados = [];
  for (const { medicao, observacao: obs } of alvos) {
    const executar = decisao === "aprovar" ? autorizarMedicao : reprovarMedicao;
    const resposta = await executar(
      medicao.documentId,
      medicao.contractNumber,
      medicao.buildingId,
      medicao.measurementNumber,
      { observation: obs }
    );

    resultados.push({
      documento: medicao.documentId,
      contrato: medicao.contractNumber,
      obra: medicao.building?.name ?? medicao.buildingId,
      medicao: medicao.measurementNumber,
      success: resposta.success,
      message: resposta.success ? resposta.message : (resposta.details ?? resposta.message),
    });
  }

  filaDeMedicoes = null;

  const ok = resultados.filter((r) => r.success).length;
  return {
    success: ok > 0,
    decisao,
    message:
      ok === resultados.length
        ? `✅ ${ok} medição(ões) ${DECISOES[decisao].participio}s.`
        : `⚠️ ${ok} de ${resultados.length} medição(ões) ${DECISOES[decisao].participio}s — ` +
          `cada medição é uma chamada própria, então o resto não foi desfeito.`,
    resultados,
    previa,
  };
}

// =========================================================
// CRIAÇÃO DE MEDIÇÃO
// =========================================================
// Quem mede fala em nomes: "medir 45 m² de alvenaria no contrato 1234 da obra
// IU.06". O POST quer documentId, contractNumber, buildingId, buildingUnitId e
// o itemId de cada item DENTRO da planilha. A tradução acontece toda aqui.

/**
 * Quanto já foi medido de cada item, derivado da ÚLTIMA medição da obra.
 *
 * A API não expõe saldo de item de contrato: `GetContractItemDto` traz a
 * quantidade contratada e mais nada. O acumulado só existe dentro do item de
 * MEDIÇÃO, como `cumulativeMeasuredQuantity` — "o total das medições
 * anteriores a esta". Então o já medido de um item é, na última medição em
 * que ele aparece, o acumulado mais o que aquela medição mediu.
 *
 * É DERIVAÇÃO, não dado da API, e vai rotulada como tal na prévia. Ela erra
 * se houver medição posterior não considerada aqui; por isso a base usada
 * (número da medição) viaja junto na resposta.
 */
async function jaMedidoPorItem(documentId, contractNumber, buildingId) {
  const varredura = await varrer(
    (pag) => buscarMedicoes({ documentId, contractNumber, buildingId, ...pag }),
    "measurements"
  );
  if (!varredura.success) return { success: true, porItem: new Map(), base: null };

  const numeros = varredura.measurements
    .map((m) => m.measurementNumber)
    .filter((n) => Number.isInteger(n));
  if (!numeros.length) return { success: true, porItem: new Map(), base: null };

  const ultima = Math.max(...numeros);
  const itens = await buscarItensDaMedicao(documentId, contractNumber, buildingId, ultima, {
    limit: 200,
  });
  if (!itens.success) return { success: true, porItem: new Map(), base: null };

  const porItem = new Map();
  for (const item of itens.items) {
    const acumulado = Number(item.cumulativeMeasuredQuantity ?? 0) + Number(item.measuredQuantity ?? 0);
    porItem.set(item.itemId, acumulado);
  }
  return { success: true, porItem, base: ultima };
}

/**
 * Cria uma medição de contrato a partir de nomes.
 *
 * ESCRITA IRREVERSÍVEL: o spec não expõe exclusão nem alteração de medição.
 * Criada errado, só se corrige pela tela do Sienge. Daí a prévia obrigatória.
 *
 * TODAS as pendências voltam de uma vez, cada uma nomeada (`itens[1]`) e com
 * o contexto da próxima pergunta — a unidade de medida do item, os candidatos
 * com seus códigos, o que já foi medido. Parar no primeiro erro gastaria um
 * turno do modelo por erro.
 *
 * `vencimento` NÃO tem padrão: é a data em que o título nasce vencendo, e
 * chutar uma data de vencimento é chutar dinheiro. Ausente, vira pendência.
 *
 * @param {object} args
 * @param {string} args.contrato número do contrato (ou parte do objeto)
 * @param {string} [args.documento] código do documento — dispensa a varredura
 * @param {string|number} args.obra nome da obra (ou o buildingId)
 * @param {string|number} [args.unidade_construtiva] nome ou id; dispensável
 *   quando a obra tem só uma
 * @param {Array<{item: string, quantidade: number}>} args.itens o que medir
 * @param {string} [args.data] data da medição (yyyy-MM-dd); padrão: hoje
 * @param {string} args.vencimento data de vencimento (yyyy-MM-dd)
 * @param {string} [args.observacao]
 * @param {boolean} [args.nascer_desautorizada=false] cria a medição já
 *   desautorizada, como se quem cadastrou não pudesse autorizar
 * @param {boolean} [args.confirmar=false]
 */
export async function criarMedicaoDeContrato({
  contrato,
  documento,
  obra,
  unidade_construtiva,
  itens,
  data,
  vencimento,
  observacao,
  nascer_desautorizada = false,
  confirmar = false,
} = {}) {
  if (!obra) {
    return {
      success: false,
      error: "ObraNaoInformada",
      message:
        "Informe a obra — a medição pertence a uma obra do contrato, e o número dela é " +
        "sequencial por obra.",
    };
  }

  const referencia = await resolverContratoPorReferencia({ contrato, documento, obra });
  if (!referencia.success) return referencia;

  const { documentId, contractNumber } = referencia;

  // A obra precisa ser uma das obras DO CONTRATO — não basta existir no
  // cadastro. É aqui que se descobre também a unidade construtiva.
  const obrasResposta = await buscarObrasDoContrato(documentId, contractNumber, { limit: 200 });
  if (!obrasResposta.success) return obrasResposta;

  const obraAlvo =
    typeof obra === "number"
      ? obrasResposta.buildings.find((b) => idDaObra(b) === obra)
      : (() => {
          const achado = casarUnico(
            obra,
            obrasResposta.buildings,
            (b) => ({ texto: b.buildingName, id: idDaObra(b), name: b.buildingName }),
            `obras do contrato ${rotulo(documentId, contractNumber)}`
          );
          return achado.success ? achado.valor : null;
        })();

  if (!obraAlvo) {
    return {
      success: false,
      error: "ObraForaDoContrato",
      message:
        `A obra '${obra}' não é uma das obras do contrato ${rotulo(documentId, contractNumber)}.`,
      obras_do_contrato: obrasResposta.buildings.map((b) => ({
        id: idDaObra(b),
        name: b.buildingName,
      })),
    };
  }

  const unidades = obraAlvo.constructUnits ?? [];
  let unidadeAlvo;

  if (unidade_construtiva !== undefined && unidade_construtiva !== null && unidade_construtiva !== "") {
    unidadeAlvo =
      typeof unidade_construtiva === "number"
        ? unidades.find((u) => u.id === unidade_construtiva)
        : (() => {
            const achado = casarUnico(
              unidade_construtiva,
              unidades,
              (u) => ({ texto: u.name, id: u.id, name: u.name }),
              "unidades construtivas da obra"
            );
            return achado.success ? achado.valor : null;
          })();
  } else if (unidades.length === 1) {
    unidadeAlvo = unidades[0];
  }

  if (!unidadeAlvo) {
    return {
      success: false,
      error: "UnidadeConstrutivaIndefinida",
      message:
        unidades.length > 1
          ? `A obra ${obraAlvo.buildingName} tem ${unidades.length} unidades construtivas — ` +
            `informe qual. Cada uma é uma planilha de itens diferente.`
          : `Não foi possível identificar a unidade construtiva da obra ${obraAlvo.buildingName}.`,
      unidades_construtivas: unidades.map((u) => ({
        id: u.id,
        name: u.name,
        status: u.status,
        bloqueada: unidadeBloqueada(u),
      })),
    };
  }

  const itensDaPlanilha = await buscarItensDoContrato(
    documentId,
    contractNumber,
    idDaObra(obraAlvo),
    unidadeAlvo.id,
    { limit: 200 }
  );
  if (!itensDaPlanilha.success) return itensDaPlanilha;

  const mensuraveis = itensDaPlanilha.items.map(resumirItemDeContrato).filter((i) => i.mensuravel);

  const acumulado = await jaMedidoPorItem(documentId, contractNumber, idDaObra(obraAlvo));

  const pendencias = [];
  const itensDoPayload = [];
  const retratos = [];

  // Aviso e não bloqueio: quem barra a medição é o Sienge, e o spec não diz
  // que bloqueada impede medir — mas deixar isso passar em silêncio faz o 400
  // do servidor chegar sem contexto.
  if (unidadeBloqueada(unidadeAlvo)) {
    pendencias.push({
      onde: "unidade_construtiva",
      tipo: "Aviso",
      message:
        `A unidade construtiva '${unidadeAlvo.name}' está BLOQUEADA ` +
        `(status ${unidadeAlvo.status}) no contrato. ` +
        `Se o Sienge recusar a medição, é por isso.`,
    });
  }

  if (!vencimento) {
    pendencias.push({
      onde: "vencimento",
      tipo: "Faltando",
      message:
        "Informe 'vencimento' (yyyy-MM-dd): é a data em que o título gerado pela medição " +
        "vence. A API exige, e não há padrão razoável para chutar.",
    });
  }

  if (!itens?.length) {
    pendencias.push({
      onde: "itens",
      tipo: "Faltando",
      message:
        "Informe ao menos um item em 'itens'. Uma medição comporta vários itens — junte " +
        "todos numa chamada só, em vez de medir um por vez.",
      itens_mensuraveis: mensuraveis.slice(0, MAX_ITENS_SUGERIDOS).map((i) => ({
        id: i.id,
        wbsCode: i.wbsCode,
        description: i.description,
        unitOfMeasure: i.unitOfMeasure,
        quantity: i.quantity,
      })),
    });
  }

  for (const [indice, pedido] of (itens ?? []).entries()) {
    const nome = `itens[${indice}]`;

    const achado = casarUnico(
      pedido?.item ?? "",
      mensuraveis,
      (i) => ({
        texto: `${i.description ?? ""} ${i.detailDescription ?? ""} ${i.auxiliaryCode ?? ""} ${i.wbsCode ?? ""}`,
        id: i.id,
        wbsCode: i.wbsCode,
        description: i.description,
        unitOfMeasure: i.unitOfMeasure,
        quantity: i.quantity,
      }),
      `itens mensuráveis da planilha ${unidadeAlvo.name}`
    );

    if (!achado.success) {
      pendencias.push({
        onde: nome,
        tipo: achado.error === "Ambiguo" ? "Ambiguo" : "NaoEncontrado",
        message: `${nome}: ${achado.message}`,
        ...(achado.candidatos ? { candidatos: achado.candidatos } : {}),
        ...(achado.error === "NaoEncontrado"
          ? {
              itens_mensuraveis: mensuraveis.slice(0, MAX_ITENS_SUGERIDOS).map((i) => ({
                id: i.id,
                wbsCode: i.wbsCode,
                description: i.description,
                unitOfMeasure: i.unitOfMeasure,
                quantity: i.quantity,
              })),
            }
          : {}),
      });
      continue;
    }

    const item = achado.valor;
    const quantidade = Number(pedido?.quantidade);
    const medido = acumulado.porItem.get(item.id) ?? 0;
    const saldo = item.quantity !== undefined ? Number(item.quantity) - medido : null;

    if (!(quantidade > 0)) {
      pendencias.push({
        onde: `${nome}.quantidade`,
        tipo: "Faltando",
        message:
          `${nome}: informe a quantidade medida de '${item.description}', em ` +
          `${item.unitOfMeasure ?? "unidade não informada pelo contrato"}. Precisa ser ` +
          `maior que zero.`,
        item: { id: item.id, description: item.description, unitOfMeasure: item.unitOfMeasure },
        contratado: item.quantity,
        ...(acumulado.base !== null
          ? { ja_medido: medido, saldo, derivado_da_medicao: acumulado.base }
          : { ja_medido: "sem medição anterior nesta obra" }),
      });
      continue;
    }

    const retrato = {
      onde: nome,
      itemId: item.id,
      wbsCode: item.wbsCode,
      description: item.description,
      detailDescription: item.detailDescription,
      unitOfMeasure: item.unitOfMeasure,
      quantidade,
      contratado: item.quantity,
      materialPrice: item.materialPrice,
      laborPrice: item.laborPrice,
      valor_estimado:
        Number(item.materialPrice ?? 0) + Number(item.laborPrice ?? 0) > 0
          ? Number(
              (quantidade * (Number(item.materialPrice ?? 0) + Number(item.laborPrice ?? 0))).toFixed(2)
            )
          : null,
      resumo: `${quantidade} ${item.unitOfMeasure ?? ""} de ${item.description}`.trim(),
      ...(acumulado.base !== null
        ? { ja_medido: medido, saldo, derivado_da_medicao: acumulado.base }
        : {}),
    };

    // Aviso, não bloqueio: o acumulado é derivado (ver `jaMedidoPorItem`) e a
    // quantidade contratada muda por aditivo. Barrar com base num número que
    // pode estar velho impediria uma medição legítima.
    if (saldo !== null && quantidade > saldo) {
      pendencias.push({
        onde: nome,
        tipo: "Aviso",
        message:
          `${nome}: ${quantidade} ${item.unitOfMeasure ?? ""} passa do saldo derivado ` +
          `(${saldo}) de '${item.description}'. O saldo vem da medição ` +
          `${acumulado.base} e não considera aditivo posterior — confira antes de confirmar.`,
      });
    }

    itensDoPayload.push({
      buildingUnitId: unidadeAlvo.id,
      itemId: item.id,
      measuredQuantity: quantidade,
    });
    retratos.push(retrato);
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
        documento: documentId,
        contrato: contractNumber,
        obra: { id: idDaObra(obraAlvo), name: obraAlvo.buildingName },
        unidade_construtiva: { id: unidadeAlvo.id, name: unidadeAlvo.name },
        ...(retratos.length ? { itens: retratos } : {}),
      },
    };
  }

  const measurementDate = data || hoje();
  const previa = {
    resumo:
      `${retratos.length} ${retratos.length === 1 ? "item" : "itens"} no contrato ` +
      `${rotulo(documentId, contractNumber)}, obra ${obraAlvo.buildingName}: ` +
      retratos.map((r) => r.resumo).join("; "),
    documento: documentId,
    contrato: contractNumber,
    object: referencia.contrato?.object,
    obra: { id: idDaObra(obraAlvo), name: obraAlvo.buildingName },
    unidade_construtiva: { id: unidadeAlvo.id, name: unidadeAlvo.name, status: unidadeAlvo.status },
    measurementDate,
    dueDate: vencimento,
    itens: retratos,
    valor_estimado: retratos.reduce((soma, r) => soma + (r.valor_estimado ?? 0), 0) || null,
    ...(observacao ? { observacao } : {}),
    ...(nascer_desautorizada
      ? { aviso_autorizacao: "A medição nascerá DESAUTORIZADA (makeUnauthorized: true)." }
      : {}),
    ...(pendencias.length ? { avisos: pendencias.map((p) => p.message) } : {}),
  };

  if (!confirmar) {
    return {
      success: true,
      confirmacao_pendente: true,
      message:
        "Nada foi gravado. Confira os códigos resolvidos abaixo e, se estiverem certos, " +
        "chame de novo com confirmar: true e os MESMOS argumentos. Criar medição é " +
        "IRREVERSÍVEL por esta API — não há endpoint que exclua ou altere.",
      previa,
    };
  }

  const resposta = await criarMedicao(documentId, contractNumber, idDaObra(obraAlvo), {
    measurementDate,
    dueDate: vencimento,
    items: itensDoPayload,
    notes: observacao,
    makeUnauthorized: nascer_desautorizada || undefined,
  });

  if (!resposta.success) return { ...resposta, previa };

  const measurementNumber = resposta.data?.measurementNumber;
  // Uma medição nova muda a fila de autorização.
  filaDeMedicoes = null;

  return {
    success: true,
    message: `✅ Medição ${measurementNumber ?? ""} criada: ${previa.resumo}.`,
    documento: documentId,
    contrato: contractNumber,
    obra: { id: idDaObra(obraAlvo), name: obraAlvo.buildingName },
    measurementNumber,
    itemCount: itensDoPayload.length,
    proximo_passo:
      "Criar não autoriza. Se o usuário da API não tiver alçada (ou com " +
      "nascer_desautorizada), a medição fica aguardando autorização e aparece na fila de " +
      "medições. A liberação — que gera o título a pagar — é passo seguinte, e não é " +
      "exposta pela API.",
    previa,
  };
}
