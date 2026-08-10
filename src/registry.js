/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Registro de tools — o ponto único por onde toda tool passa.
 *
 * É aqui que se resolve, uma vez só, o que de outro modo cada tool teria de
 * lembrar de fazer:
 *
 *   1. publicar o nome da tool para a trilha de auditoria montada na camada
 *      HTTP (`utils/audit.js`);
 *   2. anexar o aviso de licença ao resultado, quando houver;
 *   3. aplicar a tag do módulo (`modules.js`), que é o que permite recortar o
 *      catálogo por SIENGE_PROFILE ou por enable_sienge_modules;
 *   4. embrulhar o retorno no envelope de conteúdo que o protocolo MCP espera.
 *
 * O ponto 4 é o que mantém as tools legíveis: elas devolvem objetos comuns, e
 * a conversão para `{content: [...]}` acontece neste arquivo, e em nenhum
 * outro lugar.
 */

import { z } from "zod";
import { CONFIRM_PARAM } from "./confirmation.js";
import { getLicenseStatus } from "./licensing.js";
import * as tagRegistry from "./modules.js";
import * as audit from "./utils/audit.js";

/**
 * O aviso de licença é informação de estado, não de resultado: repeti-lo em
 * toda resposta não avisa mais ninguém, só ocupa contexto — e ocupa a cada
 * chamada, que numa varredura são dezenas. Emitir uma vez por processo dá o
 * mesmo efeito prático a custo fixo. `getLicenseStatus` já cacheia a
 * verificação; aqui cacheia-se a *emissão*.
 */
let avisoDeLicencaEmitido = false;

function withLicenseWarning(result) {
  const status = getLicenseStatus();
  if (status.valid) return result;
  if (result === null || typeof result !== "object" || Array.isArray(result)) return result;
  if ("license_warning" in result) return result;
  if (avisoDeLicencaEmitido) return result;

  avisoDeLicencaEmitido = true;
  return {
    ...result,
    license_warning:
      `⚠️ MCP Sienge sem licença válida (${status.reason}). ` +
      "Contate angulo.glifos8t@icloud.com para regularizar. " +
      "Este aviso é emitido uma vez por sessão — a condição permanece " +
      "até que SIENGE_MCP_LICENSE_KEY seja configurada.",
  };
}

/**
 * Metadados de diagnóstico que a camada HTTP anexa a toda resposta. Em uma
 * resposta bem-sucedida eles não informam nada ao modelo — só ocupam contexto,
 * a cada chamada. Em uma falha são o que permite rastrear o que aconteceu, e
 * por isso só são removidos quando `success` é verdadeiro.
 */
const METADADOS_DE_DIAGNOSTICO = new Set(["request_id", "latency_ms", "status_code"]);

/**
 * Remove do resultado o que o modelo não lê: chaves nulas e, em respostas
 * bem-sucedidas, os metadados de diagnóstico.
 *
 * A API do Sienge devolve `null` em profusão — campos de cadastro não
 * preenchidos, datas ausentes, documentos vazios. Cada um deles é um par
 * chave/valor tokenizado e cobrado a cada resposta, dizendo exatamente o mesmo
 * que a ausência da chave já diria.
 *
 * Arrays preservam os elementos nulos: ali a posição é significativa, e
 * remover um item deslocaria todos os seguintes.
 */
function enxugar(valor, sucesso, profundidade = 0) {
  // Um teto de profundidade evita que uma estrutura circular ou
  // patologicamente aninhada trave a serialização.
  if (profundidade > 20) return valor;
  if (Array.isArray(valor)) {
    return valor.map((v) => enxugar(v, sucesso, profundidade + 1));
  }
  if (valor === null || typeof valor !== "object") return valor;
  // Date, Buffer e afins não são objetos de dados — copiá-los chave a chave os
  // destruiria.
  if (valor.constructor !== Object) return valor;

  const saida = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (v === null || v === undefined) continue;
    if (sucesso && profundidade === 0 && METADADOS_DE_DIAGNOSTICO.has(chave)) continue;
    saida[chave] = enxugar(v, sucesso, profundidade + 1);
  }
  return saida;
}

/**
 * Serializa o retorno da tool no envelope de conteúdo do protocolo MCP.
 *
 * Sem indentação: `JSON.stringify(x, null, 2)` produz espaços em branco que o
 * modelo não lê e que são tokenizados e cobrados como qualquer outro caractere
 * — numa listagem de 50 registros, ~28% da resposta.
 *
 * `manterMetadados` existe para as tools cujo propósito É o diagnóstico, como
 * testar_conexao: nelas a latência e o id da requisição são o
 * resultado, não ruído.
 */
function toContent(result, { manterMetadados = false } = {}) {
  const sucesso = result?.success === true && !manterMetadados;
  const enxuto = enxugar(result, sucesso);
  return {
    content: [{ type: "text", text: JSON.stringify(enxuto) }],
  };
}

/**
 * Tools registradas, por nome — a base para o recorte por módulo. Guarda o
 * handle devolvido pelo SDK, que expõe `enable()`/`disable()` e dispara a
 * notificação `tools/list_changed`.
 *
 * @type {Map<string, {handle: object, tags: Set<string>}>}
 */
export const registered = new Map();

/**
 * Registra uma tool no servidor MCP.
 *
 * @param {object} server instância de McpServer
 * @param {object} spec
 * @param {string} spec.name nome da tool, como aparece para o modelo
 * @param {string} spec.description texto que o modelo lê para decidir chamá-la
 * @param {object} [spec.inputSchema] mapa de campos Zod; omitido = sem parâmetros
 * @param {(args: object) => Promise<object>} spec.handler
 * @param {boolean} [spec.requiresConfirm] exige que o schema declare `confirm`
 * @param {boolean} [spec.manterMetadados] preserva request_id/latency_ms/
 *   status_code mesmo em sucesso — para tools cujo propósito é o diagnóstico
 */
export function registerTool(server, spec) {
  const {
    name,
    description,
    inputSchema = {},
    handler,
    requiresConfirm = false,
    manterMetadados = false,
  } = spec;

  // Uma tool de escrita que esquece de declarar `confirm` no schema perde o
  // gate inteiro sem nenhum sinal: o handler embrulhado nunca receberia o
  // parâmetro, e o modelo não teria como enviá-lo. Falhar na subida é o que
  // impede isso de chegar em produção.
  if (requiresConfirm && !(CONFIRM_PARAM in inputSchema)) {
    throw new Error(
      `${name} usa requiresConfirmation mas não declara '${CONFIRM_PARAM}' no inputSchema.`
    );
  }

  const tags = tagRegistry.tagsFor(name);

  const handle = server.registerTool(
    name,
    { description, inputSchema },
    async (args) =>
      audit.runWithTool(name, async () => {
        try {
          return toContent(withLicenseWarning(await handler(args ?? {})), { manterMetadados });
        } catch (err) {
          // Uma exceção não tratada derrubaria a chamada com um erro de
          // protocolo, sem contexto. As tools deste servidor sempre respondem
          // com um objeto — inclusive quando falham.
          return toContent({
            success: false,
            error: err?.name ?? "Error",
            message: err?.message ?? String(err),
            tool: name,
          });
        }
      })
  );

  // O SDK injeta `execution: { taskSupport: "forbidden" }` em toda tool
  // registrada, e o valor é redundante: o próprio spec diz que a ausência do
  // campo já significa "forbidden", e o cliente só reage quando ele é
  // "required" ou "optional". São 40 caracteres por tool em toda resposta de
  // tools/list — 108 tokens com 10 tools, 324 com 30.
  //
  // Se uma versão futura do SDK mudar essa estrutura, o campo volta a
  // aparecer: perde-se a economia, nada quebra.
  handle.execution = undefined;

  registered.set(name, { handle, tags });
  return handle;
}

/**
 * Quantas tools de cada módulo estão de fato registradas neste servidor.
 *
 * Diferente de `modules.toolCounts()`, que conta o catálogo completo — a
 * especificação de onde cada tool vai morar quando existir. A diferença entre
 * os dois é o que ainda não foi implementado, e é por isso que as tools de
 * módulo consultam esta função e não aquela: anunciar um módulo que não tem
 * tools faz o modelo carregá-lo, receber sucesso e não ganhar ferramenta
 * nenhuma.
 */
export function contarPorTag() {
  const contagem = {};
  for (const { tags } of registered.values()) {
    for (const tag of tags) contagem[tag] = (contagem[tag] ?? 0) + 1;
  }
  return contagem;
}

/** Módulos que têm ao menos uma tool registrada. */
export function modulosDisponiveis() {
  return new Set(Object.keys(contarPorTag()));
}

/** Habilita as tools cujas tags estejam em `tagsAtivas`. */
export function enableByTags(tagsAtivas) {
  for (const { handle, tags } of registered.values()) {
    if ([...tags].some((t) => tagsAtivas.has(t))) handle.enable();
  }
}

/** Desabilita as tools cujas tags estejam em `tagsAlvo`. */
export function disableByTags(tagsAlvo) {
  for (const { handle, tags } of registered.values()) {
    if ([...tags].some((t) => tagsAlvo.has(t))) handle.disable();
  }
}

/**
 * Aplica um allowlist: desabilita tudo e reabilita só o que tem as tags
 * pedidas. A ordem importa — uma tool com duas tags precisa sobreviver se
 * qualquer uma delas estiver ativa.
 */
export function applyProfile(tagsAtivas) {
  for (const { handle } of registered.values()) handle.disable();
  enableByTags(tagsAtivas);
}

/** Reexporta o `z` para as tools, evitando um import a mais em cada arquivo. */
export { z };
