/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Resolução de credenciais e configuração do servidor.
 *
 * As variáveis são lidas a cada chamada, e não capturadas na subida do
 * processo, para que trocar uma credencial não exija reiniciar o servidor —
 * e para que os testes possam ajustar `process.env` sem recarregar o módulo.
 */

export const PLACEHOLDER_API_KEY = "sua_api_key_aqui";

export function baseUrl() {
  return process.env.SIENGE_BASE_URL || "https://api.sienge.com.br";
}

export function requestTimeoutMs() {
  const raw = Number.parseInt(process.env.REQUEST_TIMEOUT || "30", 10);
  return (Number.isFinite(raw) && raw > 0 ? raw : 30) * 1000;
}

export function cleanSubdomain() {
  return (process.env.SIENGE_SUBDOMAIN || "").trim().replace(/^\/+|\/+$/g, "");
}

/**
 * Escolhe o mecanismo de autenticação disponível: Bearer > Basic > nenhum.
 *
 * @returns {{ok: boolean, method: string, headers: Record<string,string>}}
 */
export function resolveAuth() {
  const apiKey = (process.env.SIENGE_API_KEY || "").trim();
  const username = process.env.SIENGE_USERNAME || "";
  const password = process.env.SIENGE_PASSWORD || "";

  if (apiKey && apiKey !== PLACEHOLDER_API_KEY) {
    return {
      ok: true,
      method: "Bearer Token",
      headers: { Authorization: `Bearer ${apiKey}` },
    };
  }
  if (username && password) {
    // Basic Auth montado à mão: `fetch` não tem equivalente ao objeto `auth`
    // do httpx, e o header é o mesmo que ele produziria.
    const basic = Buffer.from(`${username}:${password}`, "utf8").toString("base64");
    return {
      ok: true,
      method: "Basic Auth",
      headers: { Authorization: `Basic ${basic}` },
    };
  }
  return { ok: false, method: "None", headers: {} };
}

/** Snapshot legível da configuração de autenticação atual. */
export function getAuthInfo() {
  const auth = resolveAuth();
  if (!auth.ok) {
    return {
      auth_method: "None",
      configured: false,
      message: "Configure SIENGE_API_KEY ou SIENGE_USERNAME/PASSWORD no .env",
    };
  }
  if (auth.method === "Bearer Token") {
    return {
      auth_method: auth.method,
      configured: true,
      base_url: baseUrl(),
      api_key_configured: true,
    };
  }
  return {
    auth_method: auth.method,
    configured: true,
    base_url: baseUrl(),
    subdomain: process.env.SIENGE_SUBDOMAIN || "",
    username: process.env.SIENGE_USERNAME || "",
  };
}
