/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo `compras` — compras no nível da decisão.
 *
 * Uma tool por pergunta que alguém faz, não por endpoint que a API expõe.
 * A camada crua continua acessível por `sienge_api_call` com `deep_mode`, para
 * o pedido específico que este recorte não previu.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest } from "../http/client.js";
import { cacheGet, cacheSet } from "../http/cache.js";
import * as purchaseApproval from "../workflows/purchaseApproval.js";

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
      "sienge_api_call com deep_mode.\n\n" +
      "Não aprova nada: aprovar é ato separado, de outra pessoa. Ver\n" +
      "describe_purchase_process().\n\n" +
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
}
