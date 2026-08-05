/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Gate de confirmação para operações de alto impacto.
 *
 * Uma tool embrulhada por `requiresConfirmation(...)` não executa na primeira
 * chamada: ela devolve uma prévia do que seria feito e exige que o assistente
 * repita a chamada com `confirm=true`. O objetivo é que nenhuma operação que
 * mexe em dinheiro aconteça como efeito colateral de um encadeamento
 * automático — ela vira sempre um ato deliberado, e a tentativa bloqueada fica
 * registrada na trilha de auditoria.
 *
 * Para proteger uma tool nova, declare `confirm` no schema Zod e embrulhe o
 * handler:
 *
 *     handler: requiresConfirmation(
 *       "authorize_purchase_order",
 *       { action: "Autorizar o pedido de compra {purchase_order_id}",
 *         fields: ["purchase_order_id"] },
 *       async ({ purchase_order_id }) => { ... }
 *     )
 *
 * `action` é um template preenchido com os argumentos recebidos e `fields`
 * lista os parâmetros ecoados na prévia, para o usuário conferir antes de
 * aprovar.
 *
 * A garantia de que a tool realmente declara `confirm` fica em `registry.js`:
 * argumentos desestruturados não são inspecionáveis em tempo de execução, então
 * a checagem é feita contra o `inputSchema` no momento do registro — e falha na
 * subida do servidor, não em produção.
 */

import * as audit from "./utils/audit.js";

export const CONFIRM_PARAM = "confirm";

export const CONFIRM_DESCRIPTION =
  "proteção contra execução acidental — a chamada só é efetivada com " +
  "confirm=true. Sem ele, a tool devolve uma prévia do que seria feito, " +
  "para você conferir com o usuário.";

/** Resposta devolvida quando a operação foi barrada por falta de confirmação. */
export function pendingConfirmation(action, details, impact) {
  return {
    success: false,
    requires_confirmation: true,
    executed: false,
    action,
    impact,
    details,
    message:
      `⚠️ NADA foi alterado no Sienge. Esta operação tem impacto ${impact} e ` +
      `exige confirmação explícita: ${action}. ` +
      "Mostre os dados acima ao usuário, aguarde a aprovação dele e só então " +
      "repita a chamada com confirm=true.",
  };
}

/** Preenche o template de `action` com os argumentos, tolerando placeholders ausentes. */
function describe(action, values) {
  return action.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match
  );
}

/**
 * Embrulha `fn` de modo que só execute com `confirm: true`.
 *
 * @param {string} toolName nome da tool, para a trilha de auditoria
 * @param {{action: string, fields?: string[], impact?: string}} opts
 * @param {(args: object) => Promise<object>} fn
 */
export function requiresConfirmation(toolName, opts, fn) {
  const { action, fields = [], impact = "financeiro" } = opts;

  return async (args = {}) => {
    if (args[CONFIRM_PARAM]) return fn(args);

    const described = describe(action, args);
    const details = fields.length
      ? Object.fromEntries(fields.map((f) => [f, args[f]]))
      : { ...args };

    audit.record({
      method: "BLOCKED",
      endpoint: toolName,
      success: false,
      error: "Confirmation Required",
      payload: details,
      action: described,
    });

    return pendingConfirmation(described, details, impact);
  };
}
