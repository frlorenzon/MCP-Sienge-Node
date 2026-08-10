/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo `compras` — compras no nível da decisão.
 *
 * Uma tool por pergunta que alguém faz, não por endpoint que a API expõe.
 * A camada crua continua acessível por `chamar_api` com `deep_mode`, para
 * o pedido específico que este recorte não previu.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest } from "../http/client.js";
import { cacheGet, cacheSet } from "../http/cache.js";
import * as purchaseApproval from "../workflows/purchaseApproval.js";
import { pendingConfirmation } from "../confirmation.js";
import * as audit from "../utils/audit.js";

/**
 * A tentativa barrada também entra na trilha.
 *
 * Uma aprovação que ficou pendente de confirmação é informação de auditoria:
 * mostra o que se tentou fazer e quando, mesmo que não tenha sido feito.
 */
function registrarBloqueio(tool, ids, observacao) {
  audit.record({
    method: "BLOCKED",
    endpoint: tool,
    success: false,
    error: "Confirmation Required",
    payload: { pedidos: ids, observacao },
    action: `Autorizar ${ids.length} pedido(s) de compra`,
  });
}

export function registrarCompras(server) {
  registerTool(server, {
    name: "compras_pedidos_para_aprovar",
    description:
      "Fila de pedidos de compra pendentes de aprovação, pronta para análise.\n\n" +
      "Numa chamada só: pedido, data, fornecedor, obra, valor, e por item o\n" +
      "insumo, a quantidade, a unidade e o preço unitário. As divergências vêm\n" +
      "marcadas em `alertas`.\n\n" +
      "Use sempre que a pergunta for \"quais pedidos preciso aprovar\" ou\n" +
      "equivalente. Não monte esse percurso à mão com chamadas cruas: o\n" +
      "resultado é o mesmo e custa dezenas de vezes mais.\n\n" +
      "`fornecedor`, `obra` e `insumo` vêm como id na linha; os nomes estão nos\n" +
      "dicionários `fornecedores`, `obras` e `insumos` no fim da resposta, cada um\n" +
      "escrito uma vez só. Faça o join a partir deles — não há chamada a fazer\n" +
      "para descobrir esses nomes.\n\n" +
      "Não cobre anexos, apropriações nem previsões de entrega — para esses, use\n" +
      "chamar_api com deep_mode.\n\n" +
      "Não aprova nada: aprovar é ato separado, de outra pessoa. Ver\n" +
      "explicar_processo_compras().\n\n" +
      "Janela fixa de 180 dias. A data volta em `data`, então recorte menor se faz\n" +
      "sobre o resultado.",
    inputSchema: {
      building_id: z.number().int().nullish().describe("restringe a uma obra"),
      max_pedidos: z
        .number()
        .int()
        .default(50)
        .describe("teto de pedidos analisados (padrão 50, máximo 200)"),
    },
    handler: ({ building_id, max_pedidos = 50 }) =>
      purchaseApproval.analisarPedidosParaAprovacao(
        makeSiengeRequest,
        { cacheGet, cacheSet },
        { building_id, max_pedidos }
      ),
  });

  registerTool(server, {
    name: "compras_aprovar_pedidos",
    description:
      "Autoriza um ou mais pedidos de compra de uma vez. AÇÃO IRREVERSÍVEL pelo " +
      "MCP: desfazer só no próprio Sienge.\n\n" +
      "Na primeira chamada, sem `confirm`, devolve uma prévia com fornecedor, obra, " +
      "valor e número de itens de cada pedido, mais o total. Mostre essa prévia ao " +
      "usuário, aguarde a aprovação dele e só então repita com confirm: true.\n\n" +
      "Aprova um a um e relata cada resultado: um pedido que falha não impede os " +
      "seguintes, e a resposta separa o que foi autorizado do que não foi. Máximo de " +
      "50 por chamada.",
    requiresConfirm: true,
    inputSchema: {
      pedidos: z
        .array(z.number().int())
        .describe("ids dos pedidos de compra a autorizar, como vêm em `pedido` na fila"),
      observacao: z
        .string()
        .max(300)
        .nullish()
        .describe("justificativa registrada no Sienge, até 300 caracteres"),
      confirm: z
        .boolean()
        .default(false)
        .describe(
          "proteção contra execução acidental — só executa com confirm=true. Sem ele, devolve a prévia do que seria aprovado"
        ),
    },
    handler: async ({ pedidos, observacao, confirm = false }) => {
      const ids = [...new Set(pedidos ?? [])];

      if (ids.length === 0) {
        return { success: false, error: "Informe ao menos um pedido em `pedidos`." };
      }
      if (ids.length > purchaseApproval.MAX_POR_LOTE) {
        return {
          success: false,
          error:
            `${ids.length} pedidos excedem o máximo de ${purchaseApproval.MAX_POR_LOTE} ` +
            "por chamada. O limite existe para que a prévia continue conferível por " +
            "uma pessoa — divida em lotes menores.",
        };
      }

      const deps = { cacheGet, cacheSet };

      if (!confirm) {
        const previa = await purchaseApproval.previaDeAprovacao(makeSiengeRequest, deps, ids);
        registrarBloqueio("compras_aprovar_pedidos", ids, observacao);
        return {
          ...pendingConfirmation(
            `Autorizar ${ids.length} pedido(s) de compra, somando ${previa.total}`,
            {
              pedidos: previa.linhas,
              total: previa.total,
              ...(previa.naoEncontrados.length
                ? { nao_encontrados: previa.naoEncontrados }
                : {}),
              ...(previa.itensNaoLidos.length
                ? {
                    valor_incompleto:
                      `Os itens dos pedidos ${previa.itensNaoLidos.join(", ")} não foram ` +
                      "lidos — o valor deles não entra no total acima.",
                  }
                : {}),
            },
            "financeiro"
          ),
          observacao: observacao ?? undefined,
        };
      }

      return purchaseApproval.aprovarPedidosEmLote(makeSiengeRequest, ids, observacao);
    },
  });
}
