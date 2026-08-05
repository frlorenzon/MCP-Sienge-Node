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

/** Serializa o retorno da tool no envelope de conteúdo do protocolo MCP. */
function toContent(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
 */
export function registerTool(server, spec) {
  const { name, description, inputSchema = {}, handler, requiresConfirm = false } = spec;

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
          return toContent(withLicenseWarning(await handler(args ?? {})));
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
