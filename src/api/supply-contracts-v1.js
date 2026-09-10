/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * supply-contracts-v1 — Contratos de Suprimentos.
 *
 * Escrito a partir da tag "Contratos de Suprimentos" do spec local
 * (`spec/openapi.yaml`, paths `/v1/supply-contracts*`). As MEDIÇÕES do
 * contrato são outra tag e ficam em arquivo próprio — aqui está só o
 * contrato: cabeçalho, obras, itens, aditivos, anexos e a decisão
 * (autorizar/reprovar).
 *
 * DUAS COISAS SÃO DIFERENTES DE TUDO QUE JÁ EXISTE EM `api/`:
 *
 * 1. O contrato NÃO tem id em path. A identidade é o par
 *    (`documentId`, `contractNumber`) e viaja em QUERY STRING, inclusive nas
 *    escritas — `PATCH /supply-contracts/authorize?documentId=CT&contractNumber=1234`.
 *    Não existe `/supply-contracts/{id}`; tentar montar assim devolve 404.
 *    `documentId` é string (`"CT"`), não número.
 *
 * 2. Os enums de filtro são LETRAS SOLTAS (`A`, `T`, `S`, `N`, `I`), não as
 *    palavras usadas em solicitações e pedidos (`APPROVED`, `CONSISTENT`…).
 *    E a mesma letra muda de sentido entre parâmetros: em `authorization`,
 *    `S` é "reprovados"; em `consistency`, `S` é "consistente". Mandar a
 *    palavra no lugar da letra não dá erro — o filtro é ignorado em silêncio.
 *
 * Aqui o spec grafa `consistent` CORRETAMENTE (o `consitent` sem "s" é vício
 * de `PurchaseRequest`, não deste recurso).
 *
 * Cada função chama `makeRequest` e devolve o formato padrão do servidor
 * (`success`, mais os dados ou o erro).
 *
 * NÃO TRADUZIDO AINDA: `baixarAnexo` (GET /supply-contracts/attachments,
 * resposta binária ou base64) e `inserirAnexo` (POST do mesmo path, corpo
 * multipart). As duas dependem de recursos que `makeRequest` ainda não tem —
 * mesma pendência de `purchase-orders-v1.js`. Ver `client/siengeClient.js`.
 */

import { makeRequest } from "../client/siengeClient.js";

const LIMIT_PADRAO = 100;
const LIMIT_MAXIMO = 200;

const RECURSO = "/supply-contracts";

// Enums de filtro, conferidos em components/parameters do spec. Ver o aviso
// no topo: são letras, e o significado de cada letra depende do parâmetro.
const SITUACOES_APROVACAO = ["D", "A"]; // D reprovado, A aprovado
const SITUACOES_AUTORIZACAO = ["T", "S", "A", "N"]; // T todos, S reprovados, A aprovados, N aguardando
const SITUACOES_CONSISTENCIA = ["T", "S", "N", "I"]; // T todos, S consistente, N inconsistente, I em inclusão

// Limite de 300 caracteres declarado em ObservationDTO.
const OBSERVACAO_MAX = 300;

// =========================================================
// HELPERS
// =========================================================
// Mesmos helpers de `purchase-orders-v1.js` e `purchase-requests-v1.js`,
// duplicados de propósito: cada arquivo de api/ é autocontido, e as
// divergências entre os specs de cada recurso moram aqui — neste, `chave()`,
// que não existe nos outros porque só aqui a identidade é composta.

/** Monta limit/offset respeitando o teto de 200 declarado no spec. */
function paginacao(limit, offset) {
  return {
    limit: Math.min(Number(limit ?? LIMIT_PADRAO), LIMIT_MAXIMO),
    offset: Math.max(Number(offset ?? 0), 0),
  };
}

/** Descarta chaves cujo valor é null/undefined, para não enviar filtro vazio na query. */
function semNulos(campos) {
  const saida = {};
  for (const [chave, valor] of Object.entries(campos)) {
    if (valor !== null && valor !== undefined) saida[chave] = valor;
  }
  return saida;
}

/** Confere um valor contra o enum do spec antes de chamar a API. */
function validarEnum(nome, valor, aceitos) {
  if (valor === null || valor === undefined) return undefined;
  if (!aceitos.includes(valor)) {
    throw new Error(`${nome} deve ser um de ${aceitos.join(", ")} — recebido '${valor}'`);
  }
  return valor;
}

/**
 * A identidade do contrato, em query.
 *
 * `documentId` é código de documento (`"CT"`), `contractNumber` é o número do
 * contrato — string no spec, mesmo quando parece número (`"1234"`). Ambos são
 * obrigatórios em todo endpoint deste arquivo, exceto na consulta de aditivos.
 */
function chave(documentId, contractNumber) {
  return { documentId: String(documentId), contractNumber: String(contractNumber) };
}

/** Rótulo do contrato para as mensagens — "CT/1234" lê melhor que dois campos soltos. */
function rotulo(documentId, contractNumber) {
  return `${documentId}/${contractNumber}`;
}

function falha(resposta, contexto) {
  return {
    success: false,
    message: `❌ ${contexto}`,
    error: resposta.error,
    details: resposta.message,
    status_code: resposta.status_code,
    // Vem do ErrorMessage do Sienge e diz QUAL campo foi recusado — sem isso,
    // um 400 chega ao usuário como "Bad Request" e ninguém sabe o que corrigir.
    ...(resposta.campos_invalidos ? { campos_invalidos: resposta.campos_invalidos } : {}),
    ...(resposta.client_message ? { client_message: resposta.client_message } : {}),
  };
}

/** Normaliza as respostas paginadas (resultSetMetadata + results) do spec. */
function lista(resposta, chaveSaida, contexto) {
  if (!resposta.success) return falha(resposta, contexto);

  const dados = resposta.data ?? {};
  const ehObjeto = dados && typeof dados === "object" && !Array.isArray(dados);
  const itens = ehObjeto ? (dados.results ?? []) : (dados ?? []);
  const meta = ehObjeto ? (dados.resultSetMetadata ?? {}) : {};

  return {
    success: true,
    [chaveSaida]: itens,
    count: itens.length,
    total: meta.count ?? itens.length,
    offset: meta.offset ?? 0,
    limit: meta.limit,
  };
}

/** Normaliza as respostas de recurso único (sem paginação). */
function unico(resposta, chaveSaida, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return { success: true, [chaveSaida]: resposta.data };
}

/** Normaliza as respostas de operação de escrita. */
function confirmacao(resposta, mensagem, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return {
    success: true,
    message: mensagem,
    data: resposta.data,
    status_code: resposta.status_code,
  };
}

// =========================================================
// CONSULTA DO CONTRATO
// =========================================================

/**
 * GET /supply-contracts — consulta UM contrato.
 *
 * Apesar do path sem sufixo, este endpoint devolve um contrato só: quem
 * escolhe é o par (documentId, contractNumber), ambos obrigatórios. A
 * listagem é `/supply-contracts/all` — ver buscarContratos().
 */
export async function buscarContrato(documentId, contractNumber) {
  const resposta = await makeRequest("GET", RECURSO, {
    params: chave(documentId, contractNumber),
  });
  return unico(
    resposta,
    "contract",
    `Erro ao consultar o contrato ${rotulo(documentId, contractNumber)}`
  );
}

/**
 * GET /supply-contracts/all — lista contratos de um período.
 *
 * `contractStartDate` e `contractEndDate` são OBRIGATÓRIOS (yyyy-MM-dd) e
 * filtram pela data do contrato. Não existe listagem sem período: a API
 * recusa a chamada, não devolve "todos".
 *
 * @param {object} filtros
 * @param {string} filtros.contractStartDate limite inferior da data do contrato
 * @param {string} filtros.contractEndDate limite superior da data do contrato
 * @param {number} [filtros.companyId] código da empresa
 * @param {number} [filtros.buildingId] código interno da obra
 * @param {"D"|"A"} [filtros.statusApproval] situação de aprovação
 * @param {"T"|"S"|"A"|"N"} [filtros.authorization] situação de autorização
 * @param {"T"|"S"|"N"|"I"} [filtros.consistency] situação de consistência
 */
export async function buscarContratos({
  contractStartDate,
  contractEndDate,
  companyId,
  buildingId,
  statusApproval,
  authorization,
  consistency,
  limit,
  offset,
} = {}) {
  validarEnum("statusApproval", statusApproval, SITUACOES_APROVACAO);
  validarEnum("authorization", authorization, SITUACOES_AUTORIZACAO);
  validarEnum("consistency", consistency, SITUACOES_CONSISTENCIA);

  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      contractStartDate,
      contractEndDate,
      companyId,
      buildingId,
      statusApproval,
      authorization,
      consistency,
    }),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/all`, { params });
  return lista(resposta, "contracts", "Erro ao consultar contratos de suprimentos");
}

/**
 * GET /supply-contracts/buildings — obras do contrato e suas unidades construtivas.
 *
 * É por aqui que se descobre o `buildingUnitId` — a unidade construtiva
 * identifica a PLANILHA do contrato, e sem ela não dá para pedir os itens.
 */
export async function buscarObrasDoContrato(documentId, contractNumber, { limit, offset } = {}) {
  const resposta = await makeRequest("GET", `${RECURSO}/buildings`, {
    params: { ...chave(documentId, contractNumber), ...paginacao(limit, offset) },
  });
  return lista(
    resposta,
    "buildings",
    `Erro ao consultar obras do contrato ${rotulo(documentId, contractNumber)}`
  );
}

/**
 * GET /supply-contracts/items — itens do contrato numa planilha.
 *
 * Os quatro parâmetros são obrigatórios: o contrato (documentId,
 * contractNumber) e a planilha (buildingId, buildingUnitId). Não existe
 * consulta de "todos os itens do contrato" — os itens vivem por planilha, e
 * um contrato com várias obras precisa de uma chamada por obra/unidade.
 * Planilha sem itens devolve array vazio, não 404.
 */
export async function buscarItensDoContrato(
  documentId,
  contractNumber,
  buildingId,
  buildingUnitId,
  { limit, offset } = {}
) {
  const resposta = await makeRequest("GET", `${RECURSO}/items`, {
    params: {
      ...chave(documentId, contractNumber),
      buildingId,
      buildingUnitId,
      ...paginacao(limit, offset),
    },
  });
  return lista(
    resposta,
    "items",
    `Erro ao consultar itens do contrato ${rotulo(documentId, contractNumber)}`
  );
}

/**
 * GET /supply-contracts/items/purchase-requests — solicitações atendidas por um item.
 *
 * Liga o contrato de volta à ETAPA 1 do processo de compras: devolve as
 * solicitações de compra vinculadas a UM item do contrato, agrupadas por
 * solicitação, item e categoria, com a soma da quantidade atendida
 * (`attendedQuantity`) de cada agrupamento.
 *
 * `itemNumber` é o número do item DO CONTRATO, o mesmo devolvido por
 * buscarItensDoContrato() para aquela planilha.
 */
export async function buscarSolicitacoesDoItem(
  documentId,
  contractNumber,
  buildingId,
  buildingUnitId,
  itemNumber,
  { limit, offset } = {}
) {
  const resposta = await makeRequest("GET", `${RECURSO}/items/purchase-requests`, {
    params: {
      ...chave(documentId, contractNumber),
      buildingId,
      buildingUnitId,
      itemNumber,
      ...paginacao(limit, offset),
    },
  });
  return lista(
    resposta,
    "purchaseRequests",
    `Erro ao consultar solicitações do item ${itemNumber} do contrato ` +
      rotulo(documentId, contractNumber)
  );
}

// =========================================================
// ADITIVOS
// =========================================================

/**
 * GET /supply-contracts/addenda — aditivos de obras do contrato.
 *
 * ÚNICO endpoint deste arquivo em que documentId e contractNumber são
 * OPCIONAIS: dá para varrer aditivos por obra ou por período sem fixar um
 * contrato. Por isso recebe um objeto de filtros, e não a chave posicional.
 *
 * `addendumStartDate`/`addendumEndDate` filtram pela data do aditivo (yyyy-MM-dd).
 */
export async function buscarAditivos({
  documentId,
  contractNumber,
  buildingId,
  addendumNumber,
  addendumStartDate,
  addendumEndDate,
  limit,
  offset,
} = {}) {
  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      documentId,
      contractNumber,
      buildingId,
      addendumNumber,
      addendumStartDate,
      addendumEndDate,
    }),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/addenda`, { params });
  return lista(resposta, "addenda", "Erro ao consultar aditivos de contratos");
}

/**
 * GET /supply-contracts/addenda/items — itens alterados por um aditivo.
 *
 * Devolve os itens do contrato que aquele aditivo modificou, numa obra
 * específica. Todos os quatro parâmetros são obrigatórios — inclusive o
 * `addendumNumber`, que é sequencial POR OBRA, não por contrato.
 */
export async function buscarItensDoAditivo(
  documentId,
  contractNumber,
  buildingId,
  addendumNumber,
  { limit, offset } = {}
) {
  const resposta = await makeRequest("GET", `${RECURSO}/addenda/items`, {
    params: {
      ...chave(documentId, contractNumber),
      buildingId,
      addendumNumber,
      ...paginacao(limit, offset),
    },
  });
  return lista(
    resposta,
    "addendumItems",
    `Erro ao consultar itens do aditivo ${addendumNumber} do contrato ` +
      rotulo(documentId, contractNumber)
  );
}

// =========================================================
// ANEXOS
// =========================================================

/**
 * GET /supply-contracts/attachments/all — metadados dos anexos do contrato.
 *
 * A resposta é paginada (resultSetMetadata + results), mas o spec NÃO declara
 * limit/offset para este endpoint — então não os enviamos. Se um contrato
 * tiver mais anexos que a página padrão do servidor, não há como pedir a
 * página seguinte por aqui.
 */
export async function buscarAnexosDoContrato(documentId, contractNumber) {
  const resposta = await makeRequest("GET", `${RECURSO}/attachments/all`, {
    params: chave(documentId, contractNumber),
  });
  return lista(
    resposta,
    "attachments",
    `Erro ao listar anexos do contrato ${rotulo(documentId, contractNumber)}`
  );
}

// baixarAnexo (GET /supply-contracts/attachments — devolve binário, ou base64
// quando o Accept é text/plain) e inserirAnexo (POST do mesmo path, corpo
// multipart, campo `file`, 70 MB, nome de até 100 caracteres, um anexo por
// requisição) ficam de fora por enquanto — ver o aviso no topo do arquivo.

// =========================================================
// AUTORIZAÇÃO E REPROVAÇÃO
// =========================================================
// Diferente de pedidos de compra, aqui só existe PATCH — não há variante PUT
// sem corpo. O corpo (ObservationDTO) é opcional; quando ausente, mandamos a
// requisição sem corpo em vez de um objeto vazio.
//
// As duas operações respondem 204 sem conteúdo: o `data` da confirmação vem
// null, e é assim mesmo.
//
// SOBRE O AVISO AO RESPONSÁVEL: o spec diz que a notificação só sai se o ERP
// estiver configurado como "Sempre enviar aviso ao responsável". Não confundir
// com o bug de paridade da aprovação de PEDIDO, onde a tela dispara e-mail e o
// endpoint não — aqui o próprio spec condiciona o envio à parametrização.

async function decidir(documentId, contractNumber, operacao, observacao, participio, infinitivo) {
  const opcoes = { params: chave(documentId, contractNumber) };
  if (observacao) opcoes.body = { observation: String(observacao).slice(0, OBSERVACAO_MAX) };

  const resposta = await makeRequest("PATCH", `${RECURSO}/${operacao}`, opcoes);
  const alvo = rotulo(documentId, contractNumber);

  return confirmacao(
    resposta,
    `✅ Contrato ${alvo} ${participio}`,
    `Erro ao ${infinitivo} o contrato ${alvo}`
  );
}

/**
 * PATCH /supply-contracts/authorize — autoriza um contrato que aguarda autorização.
 * `observation` é opcional e limitada a 300 caracteres; ela é CONCATENADA às
 * observações de autorização já existentes, não as substitui.
 */
export async function autorizarContrato(documentId, contractNumber, { observation } = {}) {
  return decidir(documentId, contractNumber, "authorize", observation, "autorizado", "autorizar");
}

/**
 * PATCH /supply-contracts/disapprove — reprova um contrato que aguarda autorização.
 * Mesma regra de `observation` da autorização.
 */
export async function reprovarContrato(documentId, contractNumber, { observation } = {}) {
  return decidir(documentId, contractNumber, "disapprove", observation, "reprovado", "reprovar");
}
