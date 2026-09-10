/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * supply-contracts-measurements-v1 — Medições de Contratos de Suprimentos.
 *
 * Escrito a partir da tag "Medições de Contratos de Suprimentos" do spec local
 * (`spec/openapi.yaml`, paths `/v1/supply-contracts/measurements*`, originados
 * de `measurement-v1.yaml`). O contrato em si — cabeçalho, obras, itens,
 * aditivos — fica em `supply-contracts-v1.js`.
 *
 * Medir é o que transforma um contrato em dinheiro a pagar: a medição declara
 * QUANTO de cada item do contrato foi executado no período, e é dela que sai o
 * título a pagar (ver `buscarLiberacao`, que devolve os `bills` gerados).
 *
 * A identidade herda as duas esquisitices do contrato (ver o cabeçalho de
 * `supply-contracts-v1.js`) e acrescenta duas próprias:
 *
 * 1. A chave da medição é de QUATRO partes — documentId, contractNumber,
 *    buildingId e measurementNumber — e as quatro viajam em QUERY STRING,
 *    inclusive no POST e nos PATCH. Não existe path com id.
 *
 * 2. `measurementNumber` é sequencial POR OBRA do contrato, não por contrato:
 *    duas obras do mesmo contrato têm, cada uma, a sua medição número 1. Por
 *    isso `buildingId` é obrigatório em tudo aqui, até para ler uma medição.
 *
 * `statusApproval` NÃO é o campo de "aguardando aprovação": segundo o spec,
 * toda medição nasce `APPROVED` e só vira `DISAPPROVED` se for reprovada.
 * Quem responde "está esperando alguém?" é `authorization` — letra `N`.
 *
 * Cada função chama `makeRequest` e devolve o formato padrão do servidor
 * (`success`, mais os dados ou o erro).
 *
 * NÃO TRADUZIDO AINDA: `baixarAnexo` (GET .../measurements/attachments,
 * resposta binária) e `inserirAnexo` (POST do mesmo path, corpo multipart).
 * As duas dependem de recursos que `makeRequest` ainda não tem — mesma
 * pendência de `purchase-orders-v1.js`. Ver `client/siengeClient.js`.
 */

import { makeRequest } from "../client/siengeClient.js";

const LIMIT_PADRAO = 100;
const LIMIT_MAXIMO = 200;

const RECURSO = "/supply-contracts/measurements";

// Enums de filtro da medição — letras, como no contrato, e com o mesmo perigo:
// a mesma letra muda de sentido entre parâmetros (`S` é "reprovados" em
// authorization e "consistente" em consistency). Mandar a palavra no lugar da
// letra não dá erro; o filtro é ignorado em silêncio.
const SITUACOES_APROVACAO = ["D", "A"]; // D reprovada, A aprovada
const SITUACOES_AUTORIZACAO = ["T", "S", "A", "N"]; // T todas, S reprovadas, A aprovadas, N aguardando
const SITUACOES_CONSISTENCIA = ["T", "S", "N", "I"]; // T todas, S consistente, N inconsistente, I em inclusão

// Limite de 300 caracteres declarado em ObservationDTO.
const OBSERVACAO_MAX = 300;

// =========================================================
// HELPERS
// =========================================================
// Duplicados dos outros arquivos de api/ de propósito — cada um é
// autocontido. O que é só daqui é `chave()`, de quatro partes.

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
 * A identidade da medição, em query: contrato + obra + número da medição.
 *
 * `documentId` e `contractNumber` são strings no spec (`"CT"`, `"1234"`),
 * mesmo quando o número parece número.
 */
function chave(documentId, contractNumber, buildingId, measurementNumber) {
  return {
    documentId: String(documentId),
    contractNumber: String(contractNumber),
    buildingId,
    measurementNumber,
  };
}

/** Identidade do contrato + obra, sem número de medição — para o POST. */
function chaveDaObra(documentId, contractNumber, buildingId) {
  return {
    documentId: String(documentId),
    contractNumber: String(contractNumber),
    buildingId,
  };
}

/** Rótulo da medição para as mensagens — "medição 3 de CT/1234, obra 101". */
function rotulo(documentId, contractNumber, buildingId, measurementNumber) {
  return `medição ${measurementNumber} de ${documentId}/${contractNumber}, obra ${buildingId}`;
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

/**
 * Normaliza as respostas de operação de escrita.
 *
 * Devolve `data` porque o POST responde `{ measurementNumber }` — é por ele
 * que se acha a medição recém-criada, já que o número é sequencial por obra
 * e não dá para prever.
 */
function confirmacao(resposta, mensagem, contexto) {
  if (!resposta.success) return falha(resposta, contexto);
  return {
    success: true,
    message: mensagem,
    data: resposta.data,
    status_code: resposta.status_code,
  };
}

/** Ausente para efeito de validação de item: null, undefined, "" ou lista vazia. */
function vazio(valor) {
  if (Array.isArray(valor)) return valor.length === 0;
  return valor === null || valor === undefined || valor === "";
}

// =========================================================
// CONSULTA
// =========================================================

/** GET /supply-contracts/measurements — consulta UMA medição. */
export async function buscarMedicao(documentId, contractNumber, buildingId, measurementNumber) {
  const resposta = await makeRequest("GET", RECURSO, {
    params: chave(documentId, contractNumber, buildingId, measurementNumber),
  });
  return unico(
    resposta,
    "measurement",
    `Erro ao consultar a ${rotulo(documentId, contractNumber, buildingId, measurementNumber)}`
  );
}

/**
 * GET /supply-contracts/measurements/all — lista medições com filtros.
 *
 * Diferente da listagem de CONTRATOS, aqui nenhum filtro é obrigatório — nem
 * o período. Uma chamada sem filtro nenhum varre todas as medições do tenant,
 * página a página; na prática, informe ao menos o contrato ou o período.
 *
 * `measurementDate` filtra por uma data exata; `measurementStartDate` e
 * `measurementEndDate` delimitam um intervalo (yyyy-MM-dd). São parâmetros
 * distintos e coexistem no spec.
 *
 * @param {object} filtros
 * @param {string} [filtros.documentId] código do documento do contrato
 * @param {string} [filtros.contractNumber] número do contrato
 * @param {number} [filtros.buildingId] código interno da obra
 * @param {number} [filtros.measurementNumber] número da medição (por obra)
 * @param {number} [filtros.contractSupplierId] id do fornecedor do contrato
 * @param {number} [filtros.contractCustomerId] id do cliente do contrato
 * @param {"D"|"A"} [filtros.statusApproval] situação de aprovação
 * @param {"T"|"S"|"A"|"N"} [filtros.authorization] situação de autorização
 * @param {"T"|"S"|"N"|"I"} [filtros.consistency] situação de consistência
 */
export async function buscarMedicoes({
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  contractSupplierId,
  contractCustomerId,
  measurementDate,
  measurementStartDate,
  measurementEndDate,
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
      documentId,
      contractNumber,
      buildingId,
      measurementNumber,
      contractSupplierId,
      contractCustomerId,
      measurementDate,
      measurementStartDate,
      measurementEndDate,
      statusApproval,
      authorization,
      consistency,
    }),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/all`, { params });
  return lista(resposta, "measurements", "Erro ao consultar medições de contratos");
}

/**
 * GET /supply-contracts/measurements/items — itens medidos numa medição.
 *
 * Cada item traz a quantidade medida NESTA medição (`measuredQuantity`) e a
 * acumulada nas anteriores (`cumulativeMeasuredQuantity`) — são coisas
 * diferentes, e confundir as duas mede o mesmo serviço duas vezes.
 *
 * `buildingAppropriations` vem vazio quando a obra tem nível de apropriação
 * definido como "obra"; array vazio aqui é configuração, não falta de dado.
 */
export async function buscarItensDaMedicao(
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  { limit, offset } = {}
) {
  const resposta = await makeRequest("GET", `${RECURSO}/items`, {
    params: {
      ...chave(documentId, contractNumber, buildingId, measurementNumber),
      ...paginacao(limit, offset),
    },
  });
  return lista(
    resposta,
    "items",
    `Erro ao consultar itens da ${rotulo(documentId, contractNumber, buildingId, measurementNumber)}`
  );
}

/**
 * GET /supply-contracts/measurements/clearing — liberação da medição.
 *
 * É o elo com o financeiro: devolve os títulos gerados a partir da medição
 * (`bills`), o título da caução (`securityDepositBillId`), o da permuta
 * (`exchangeBillId`), o valor de adiantamento e se a liberação está
 * finalizada (`isFinished`). Medição sem liberação ainda não virou conta a
 * pagar.
 */
export async function buscarLiberacao(
  documentId,
  contractNumber,
  buildingId,
  measurementNumber
) {
  const resposta = await makeRequest("GET", `${RECURSO}/clearing`, {
    params: chave(documentId, contractNumber, buildingId, measurementNumber),
  });
  return unico(
    resposta,
    "clearing",
    `Erro ao consultar a liberação da ${rotulo(documentId, contractNumber, buildingId, measurementNumber)}`
  );
}

/**
 * GET /supply-contracts/measurements/attachments/all — anexos de medições por período.
 *
 * O período é OBRIGATÓRIO e filtra pela data da medição, não pela do anexo —
 * não existe "anexos desta medição" sem informar as datas. Contrato, obra e
 * número da medição são filtros opcionais que estreitam o resultado.
 *
 * @param {object} filtros
 * @param {string} filtros.measurementStartDate data inicial, inclusive (yyyy-MM-dd)
 * @param {string} filtros.measurementEndDate data final, inclusive (yyyy-MM-dd)
 */
export async function buscarAnexosDeMedicoes({
  measurementStartDate,
  measurementEndDate,
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  limit,
  offset,
} = {}) {
  const params = {
    ...paginacao(limit, offset),
    ...semNulos({
      measurementStartDate,
      measurementEndDate,
      documentId,
      contractNumber,
      buildingId,
      measurementNumber,
    }),
  };

  const resposta = await makeRequest("GET", `${RECURSO}/attachments/all`, { params });
  return lista(resposta, "attachments", "Erro ao consultar anexos de medições de contratos");
}

// baixarAnexo (GET .../measurements/attachments, resposta binária, exige
// attachmentNumber) e inserirAnexo (POST do mesmo path, corpo multipart, campo
// `file`, 70 MB, nome de até 100 caracteres, um anexo por requisição, e
// `description` obrigatória em query) ficam de fora por enquanto — ver o aviso
// no topo do arquivo.

// =========================================================
// CRIAÇÃO
// =========================================================

/**
 * POST /supply-contracts/measurements — cria uma medição para o contrato e a obra.
 *
 * ESCRITA IRREVERSÍVEL PELA API: não há endpoint de exclusão nem de alteração
 * de medição no spec. Criada errado, só se corrige pela tela do Sienge.
 *
 * @param {string} documentId código do documento do contrato
 * @param {string} contractNumber número do contrato
 * @param {number} buildingId código interno da obra
 * @param {object} dados
 * @param {string} dados.measurementDate data da medição, yyyy-MM-dd (obrigatória)
 * @param {string} dados.dueDate data de vencimento, yyyy-MM-dd (obrigatória).
 *   O spec declara `format: date` e exemplifica `"2021-06-22"` no corpo, mas o
 *   exemplo do schema `DueDate` mostra `2018-12-22T00:00:00Z`. Vale o formato
 *   declarado — yyyy-MM-dd.
 * @param {Array<object>} [dados.items] itens do contrato sendo medidos:
 *   `{ buildingUnitId, itemId, measuredQuantity }`. `itemId` é o código do
 *   item NO CONTRATO e precisa ser de último nível — insumo ou serviço, nunca
 *   item agrupador. `measuredQuantity` tem 4 casas e precisa ser maior que
 *   zero. O array é opcional no spec: sem ele, a medição nasce sem itens.
 * @param {boolean} [dados.makeUnauthorized] quando true, a medição nasce
 *   DESAUTORIZADA, como se quem a cadastrou não tivesse permissão para gerar
 *   medição autorizada. Omitido ou false, quem decide é o Sienge, pelas regras
 *   normais e pelo usuário da API.
 * @param {string} [dados.notes] observação da medição
 *
 * A conferência dos obrigatórios do item é feita aqui, antes da chamada,
 * porque o erro do servidor para um item incompleto não diz qual item.
 * `buildingUnitId` não é validado: o spec não o marca como obrigatório,
 * embora o exemplo o traga preenchido — e num contrato com mais de uma
 * unidade construtiva ele é o que diz de qual planilha o item veio.
 */
export async function criarMedicao(
  documentId,
  contractNumber,
  buildingId,
  { measurementDate, dueDate, items, makeUnauthorized, notes } = {}
) {
  const ausentes = [
    ["measurementDate", measurementDate],
    ["dueDate", dueDate],
  ]
    .filter(([, valor]) => vazio(valor))
    .map(([nome]) => nome);

  if (ausentes.length) {
    return {
      success: false,
      message: `❌ Campos obrigatórios ausentes: ${ausentes.join(", ")}.`,
      error: "MISSING_FIELDS",
    };
  }

  for (const [posicao, item] of (items ?? []).entries()) {
    const faltando = ["itemId", "measuredQuantity"].filter((campo) => vazio(item?.[campo]));
    if (faltando.length) {
      return {
        success: false,
        message:
          `❌ Item na posição ${posicao} está sem os campos obrigatórios: ` +
          `${faltando.join(", ")}.`,
        error: "INCOMPLETE_ITEM",
      };
    }
    if (!(Number(item.measuredQuantity) > 0)) {
      return {
        success: false,
        message:
          `❌ Item na posição ${posicao}: measuredQuantity precisa ser maior que zero — ` +
          `recebido '${item.measuredQuantity}'.`,
        error: "INVALID_QUANTITY",
      };
    }
  }

  const corpo = semNulos({ measurementDate, dueDate, items, makeUnauthorized, notes });

  const resposta = await makeRequest("POST", RECURSO, {
    params: chaveDaObra(documentId, contractNumber, buildingId),
    body: corpo,
  });
  const resultado = confirmacao(
    resposta,
    `✅ Medição criada no contrato ${documentId}/${contractNumber}, obra ${buildingId}` +
      (resposta.data?.measurementNumber ? ` — número ${resposta.data.measurementNumber}` : ""),
    `Erro ao criar medição no contrato ${documentId}/${contractNumber}, obra ${buildingId}`
  );
  // Numa recusa, o que FOI ENVIADO vale tanto quanto o motivo: é comparando os
  // dois que se descobre o campo errado. Só no erro.
  if (!resultado.success) resultado.payload_enviado = corpo;
  return resultado;
}

// =========================================================
// AUTORIZAÇÃO E REPROVAÇÃO
// =========================================================
// Como no contrato, só existe PATCH — não há variante sem corpo. O corpo
// (ObservationDTO) é opcional; sem observação, mandamos a requisição sem
// corpo em vez de um objeto vazio. As duas respondem 204 sem conteúdo, então
// o `data` da confirmação vem null.
//
// O spec condiciona a notificação ao responsável à parametrização "Sempre
// enviar aviso ao responsável" no ERP. Não confundir com o bug de paridade da
// aprovação de PEDIDO DE COMPRA, em que a tela dispara e-mail e o endpoint
// não — aqui é o próprio spec que condiciona o envio.

async function decidir(
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  operacao,
  observacao,
  participio,
  infinitivo
) {
  const opcoes = { params: chave(documentId, contractNumber, buildingId, measurementNumber) };
  if (observacao) opcoes.body = { observation: String(observacao).slice(0, OBSERVACAO_MAX) };

  const resposta = await makeRequest("PATCH", `${RECURSO}/${operacao}`, opcoes);
  const alvo = rotulo(documentId, contractNumber, buildingId, measurementNumber);

  return confirmacao(resposta, `✅ ${alvo} ${participio}`, `Erro ao ${infinitivo} a ${alvo}`);
}

/**
 * PATCH /supply-contracts/measurements/authorize — autoriza uma medição que aguarda autorização.
 * `observation` é opcional e limitada a 300 caracteres; é CONCATENADA às
 * observações de autorização já existentes, não as substitui.
 */
export async function autorizarMedicao(
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  { observation } = {}
) {
  return decidir(
    documentId,
    contractNumber,
    buildingId,
    measurementNumber,
    "authorize",
    observation,
    "autorizada",
    "autorizar"
  );
}

/**
 * PATCH /supply-contracts/measurements/disapprove — reprova uma medição que aguarda autorização.
 * Mesma regra de `observation` da autorização.
 */
export async function reprovarMedicao(
  documentId,
  contractNumber,
  buildingId,
  measurementNumber,
  { observation } = {}
) {
  return decidir(
    documentId,
    contractNumber,
    buildingId,
    measurementNumber,
    "disapprove",
    observation,
    "reprovada",
    "reprovar"
  );
}
