/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Diagnóstico de conectividade.
 *
 * Sonda `/customer-types` porque é o endpoint mais barato da API: confirma que
 * a credencial autentica sem trazer volume nenhum.
 */

/** Faz uma chamada de baixo custo à API pra confirmar que as credenciais estão válidas. */
export async function testSiengeConnection(makeRequest, config) {
  const timestamp = new Date().toISOString();
  let result;
  try {
    result = await makeRequest("GET", "/customer-types");
  } catch (exc) {
    return {
      success: false,
      message: "❌ Erro ao testar conexão",
      error: String(exc),
      timestamp,
    };
  }

  if (result.success) {
    return {
      success: true,
      message: "✅ Conexão com API do Sienge estabelecida com sucesso!",
      api_status: "Online",
      auth_method: config.SIENGE_API_KEY ? "Bearer Token" : "Basic Auth",
      timestamp,
      latency_ms: result.latency_ms,
      request_id: result.request_id,
    };
  }

  return {
    success: false,
    message: "❌ Falha ao conectar com API do Sienge",
    error: result.error,
    details: result.message,
    timestamp,
    latency_ms: result.latency_ms,
    request_id: result.request_id,
  };
}
