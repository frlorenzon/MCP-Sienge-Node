/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Catálogo de erros conhecidos da API do Sienge.
 *
 * As mensagens vêm em português, do próprio ERP, e não têm código estável —
 * casar por regex é o que existe. Cada entrada traduz a mensagem crua em uma
 * ação concreta, porque o modelo que recebe o erro precisa saber o que fazer
 * em seguida, não só que falhou.
 */

const KNOWN_ERRORS = [
  {
    pattern:
      /Não é possível utilizar centros de custo que não estão vinculados a empresa do título/i,
    type: "COST_CENTER_MISMATCH",
    suggestion: "O centro de custo do pedido de compra não pertence à empresa da nota fiscal.",
    action:
      "Use validate_purchase_order_company() para verificar a empresa correta antes de criar a NF.",
    severity: "error",
  },
  {
    pattern: /O código da empresa é inválido/i,
    type: "INVALID_COMPANY_ID",
    suggestion: "O company_id fornecido não existe no Sienge.",
    action: "Use get_sienge_projects() para listar empresas válidas.",
    severity: "error",
  },
  {
    pattern: /Documento NF.+já está cadastrado/i,
    type: "DUPLICATE_INVOICE",
    suggestion: "Esta nota fiscal já foi cadastrada no Sienge.",
    action: "Use get_sienge_bills() para buscar o título existente.",
    severity: "warning",
  },
  {
    pattern: /HTTP 401/i,
    type: "UNAUTHORIZED",
    suggestion: "Credenciais de autenticação inválidas ou expiradas.",
    action: "Verifique SIENGE_API_KEY ou SIENGE_USERNAME/PASSWORD no arquivo .env.",
    severity: "critical",
  },
  {
    pattern: /HTTP 422/i,
    type: "VALIDATION_ERROR",
    suggestion: "Erro de validação nos dados enviados.",
    action: "Verifique os campos obrigatórios e formatos dos dados.",
    severity: "error",
  },
  {
    pattern: /HTTP 429/i,
    type: "RATE_LIMIT",
    suggestion: "Limite de requisições excedido (rate limit).",
    action: "Aguarde alguns segundos. O sistema já faz retry automático.",
    severity: "warning",
  },
];

/** Casa a mensagem de erro da API contra padrões conhecidos e sugere uma ação. */
export function parseSiengeError(errorMessage) {
  const texto = errorMessage ?? "";
  for (const known of KNOWN_ERRORS) {
    if (known.pattern.test(texto)) {
      return {
        type: known.type,
        suggestion: known.suggestion,
        action: known.action,
        severity: known.severity,
        original_error: texto,
        matched: true,
      };
    }
  }
  return {
    type: "UNKNOWN_ERROR",
    suggestion: "Erro não catalogado no parser.",
    action: "Verifique os logs detalhados.",
    severity: "error",
    original_error: texto,
    matched: false,
  };
}
