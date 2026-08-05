/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Núcleo compartilhado das chamadas à API do Sienge (v1 e bulk-data v1).
 *
 * Concentra o que toda chamada precisa e nenhuma tool deveria repetir:
 * autenticação, política de retry, tradução de erro, contagem de cota e
 * trilha de auditoria.
 */

import crypto from "node:crypto";
import { baseUrl, cleanSubdomain, requestTimeoutMs, resolveAuth } from "../config.js";
import { parseSiengeError } from "./errors.js";
import * as apiQuota from "../utils/apiQuota.js";
import * as audit from "../utils/audit.js";
import { getLogger } from "../utils/logger.js";

const logger = getLogger();

const MAX_ATTEMPTS = 5;

// Repetir uma chamada só é seguro quando isso não pode duplicar um efeito.
// GET/PUT/DELETE são idempotentes por definição; POST e PATCH não são — repetir
// um POST cujo timeout ocorreu DEPOIS de o Sienge processar o pedido cria nota
// fiscal, título ou parcela duplicados.
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * Códigos de erro em que a requisição comprovadamente não chegou a ser
 * entregue: a falha aconteceu ao abrir a conexão, antes de qualquer byte do
 * pedido sair. Aqui repetir é seguro mesmo para POST/PATCH.
 *
 * ECONNRESET e EPIPE ficam de fora de propósito — podem ocorrer depois de a
 * requisição ter sido enviada, e nesse caso o servidor pode tê-la processado.
 * O mesmo vale para o timeout do AbortSignal: é o caso ambíguo por excelência.
 */
const UNDELIVERED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
]);

/** `fetch` embrulha a causa real em TypeError; o código útil está em `cause`. */
function errorCode(exc) {
  return exc?.cause?.code ?? exc?.code ?? null;
}

function isTimeout(exc) {
  return exc?.name === "TimeoutError" || exc?.name === "AbortError";
}

/** Decide se repetir `method` após `exc` é seguro (não duplica efeito). */
function mayRetryAfterNetworkError(method, exc) {
  return IDEMPOTENT_METHODS.has(method.toUpperCase()) || UNDELIVERED_CODES.has(errorCode(exc));
}

function backoffMs(attempt, retryAfter = null) {
  if (retryAfter) {
    const parsed = Number.parseFloat(retryAfter);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }
  return Math.min(2 ** attempt, 60) * 1000;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Monta a query string ignorando parâmetros nulos, como o httpx faz. */
function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item !== null && item !== undefined) search.append(key, item);
    } else if (typeof value === "boolean") {
      // A API espera "true"/"false" em minúsculas, que é o que String() produz.
      search.append(key, String(value));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

async function formatSiengeResponse(response, requestId, latencyMs, rawResponse) {
  if (![200, 201, 204].includes(response.status)) {
    const text = await response.text().catch(() => "");
    logger.warn(`HTTP ${response.status} from ${response.url}: ${text}`);
    const errorInfo = parseSiengeError(text);
    return {
      success: false,
      error: `HTTP ${response.status}`,
      message: text,
      status_code: response.status,
      latency_ms: latencyMs,
      request_id: requestId,
      error_type: errorInfo.type,
      suggestion: errorInfo.suggestion,
      recommended_action: errorInfo.action,
      severity: errorInfo.severity,
    };
  }

  if (rawResponse) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      success: true,
      content_base64: buffer.toString("base64"),
      content_type: response.headers.get("content-type"),
      status_code: response.status,
      latency_ms: latencyMs,
      request_id: requestId,
    };
  }

  let data = null;
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      data = { message: "Success" };
    }
  }

  return {
    success: true,
    data,
    status_code: response.status,
    latency_ms: latencyMs,
    request_id: requestId,
  };
}

/**
 * Núcleo compartilhado das chamadas à API do Sienge.
 *
 * `baseSegment` é o caminho completo até a versão da API (ex:
 * "/{subdominio}/public/api/v1" ou "/{subdominio}/public/api/bulk-data/v1"),
 * resolvido por quem chama (`makeSiengeRequest` / `makeSiengeBulkRequest`).
 *
 * `maxAttempts`/`timeoutMs` permitem uma política de retry mais curta que a
 * padrão (ex: um health-check que deve falhar rápido, em vez de repetir a
 * política de 5 tentativas usada pelas chamadas de negócio).
 *
 * Erros de rede só são repetidos quando repetir não pode duplicar um efeito:
 * métodos idempotentes sempre, POST/PATCH apenas quando a requisição não
 * chegou a ser entregue. Nos demais casos a resposta volta com
 * `error="Ambiguous Failure"`, sinalizando que o estado no Sienge é incerto.
 * HTTP 429 é repetido em qualquer método, pois a requisição foi rejeitada
 * sem ser processada.
 */
async function sendSiengeRequest({
  baseSegment,
  method,
  endpoint,
  params = null,
  jsonData = null,
  files = null,
  rawResponse = false,
  errorPrefix = "Erro na requisição",
  maxAttempts = null,
  timeoutMs = null,
  trilha = apiQuota.REST,
}) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const attemptsAllowed = maxAttempts || MAX_ATTEMPTS;
  const requestTimeout = timeoutMs ?? requestTimeoutMs();
  const upperMethod = method.toUpperCase();

  const elapsed = () => Date.now() - startedAt;

  /** Registra a chamada na trilha de auditoria (só escritas) e devolve `result`. */
  const withAudit = (result) => {
    if (upperMethod !== "GET") {
      audit.record({
        method,
        endpoint,
        request_id: requestId,
        success: result.success,
        status_code: result.status_code,
        error: result.error,
        payload: jsonData,
        files: files ? Object.keys(files).sort() : null,
        latency_ms: result.latency_ms,
      });
    }
    return result;
  };

  const auth = resolveAuth();
  if (!auth.ok) {
    return withAudit({
      success: false,
      error: "No Authentication",
      message: "Configure SIENGE_API_KEY ou SIENGE_USERNAME/PASSWORD no .env",
      request_id: requestId,
    });
  }

  const headers = {
    Accept: "application/json",
    "X-Request-Id": requestId,
    ...auth.headers,
  };

  let body;
  if (files) {
    // Com multipart, o Content-Type precisa carregar o boundary — que só o
    // FormData sabe. Defini-lo aqui quebraria o upload.
    const form = new FormData();
    for (const [field, file] of Object.entries(files)) {
      form.append(field, new Blob([file.content], { type: file.contentType }), file.filename);
    }
    for (const [field, value] of Object.entries(jsonData || {})) {
      form.append(field, typeof value === "string" ? value : JSON.stringify(value));
    }
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    if (jsonData !== null && jsonData !== undefined) body = JSON.stringify(jsonData);
  }

  const url = `${baseUrl()}${baseSegment}${endpoint}${buildQuery(params)}`;

  let attempt = 0;
  while (true) {
    attempt += 1;
    let response;
    try {
      response = await fetch(url, {
        method: upperMethod,
        headers,
        body,
        signal: AbortSignal.timeout(requestTimeout),
      });
    } catch (exc) {
      const retryable = mayRetryAfterNetworkError(upperMethod, exc);
      logger.warn(
        `Request error to ${url}: ${exc} ` +
          `(attempt ${attempt}/${attemptsAllowed}, retryable=${retryable})`
      );

      if (!retryable) {
        const detail = errorCode(exc) ? `${exc.name}: ${errorCode(exc)}` : String(exc);
        return withAudit({
          success: false,
          error: "Ambiguous Failure",
          message:
            `${method} ${endpoint} falhou sem resposta do Sienge (${detail}). ` +
            "A operação PODE ter sido aplicada — não repita a chamada às " +
            "cegas: consulte o estado no Sienge antes de tentar de novo.",
          method,
          retried: false,
          latency_ms: elapsed(),
          request_id: requestId,
        });
      }

      if (attempt >= attemptsAllowed) {
        const timedOut = isTimeout(exc);
        return withAudit({
          success: false,
          error: timedOut ? "Timeout" : String(errorCode(exc) || exc),
          message: timedOut
            ? `A requisição excedeu o tempo limite de ${requestTimeout / 1000}s`
            : `${errorPrefix}: ${exc}`,
          latency_ms: elapsed(),
          request_id: requestId,
        });
      }

      await sleep(backoffMs(attempt));
      continue;
    }

    if (response.status === 429) {
      // 429 cobre dois casos: excesso momentâneo, que espera resolve, e cota
      // diária esgotada, que só o dia seguinte resolve. Quando o contador
      // indica esgotamento, insistir é gasto de tempo — e o diagnóstico diz
      // qual é o caso.
      const diagnostico = apiQuota.diagnosticoDe429(trilha);
      const esgotada = diagnostico.includes("cota diária está esgotada");
      const wait = backoffMs(attempt, response.headers.get("Retry-After"));
      logger.warn(
        `HTTP 429 from ${url} (tentativa ${attempt}/${attemptsAllowed}) — ${diagnostico}`
      );

      if (esgotada || attempt >= attemptsAllowed) {
        const details = await response.text().catch(() => "");
        return withAudit({
          success: false,
          error: "HTTP 429",
          message: diagnostico,
          details,
          status_code: 429,
          cota: apiQuota.saldo(trilha),
          latency_ms: elapsed(),
          request_id: requestId,
        });
      }
      await sleep(wait);
      continue;
    }

    return withAudit(await formatSiengeResponse(response, requestId, elapsed(), rawResponse));
  }
}

/**
 * Chama a API "v1" do Sienge. Suporta Bearer Token e Basic Auth, upload
 * multipart via `files`, e `rawResponse=true` para baixar binários em
 * Base64 em vez de decodificar a resposta como JSON.
 *
 * `maxAttempts`/`timeoutMs` são opcionais e sobrescrevem a política de retry
 * padrão (5 tentativas) para chamadas que precisam falhar rápido, como um
 * teste de conectividade.
 */
export async function makeSiengeRequest(method, endpoint, options = {}) {
  apiQuota.registrar(apiQuota.REST);
  return sendSiengeRequest({
    baseSegment: `/${cleanSubdomain()}/public/api/v1`,
    trilha: apiQuota.REST,
    method,
    endpoint,
    errorPrefix: "Erro na requisição",
    ...options,
  });
}

/**
 * Chama a API "bulk-data v1" do Sienge (mesma autenticação da v1).
 *
 * A cota BULK é diária e baixa — 10 a 200 chamadas por dia conforme o pacote,
 * contra milhares na trilha REST. Cada chamada é contada e o saldo do dia
 * acompanha a resposta em `cota_bulk`, para o custo ficar visível no momento
 * em que é pago. Ver `utils/apiQuota.js`.
 */
export async function makeSiengeBulkRequest(method, endpoint, options = {}) {
  apiQuota.registrar(apiQuota.BULK);
  const resultado = await sendSiengeRequest({
    baseSegment: `/${cleanSubdomain()}/public/api/bulk-data/v1`,
    trilha: apiQuota.BULK,
    method,
    endpoint,
    errorPrefix: "Erro na requisição bulk-data",
    ...options,
  });
  resultado.cota_bulk = apiQuota.saldo(apiQuota.BULK);
  return resultado;
}

/**
 * Variante de makeSiengeRequest para health-checks: falha em ~10s numa única
 * tentativa, em vez de repetir a política de retry de 5 tentativas (que pode
 * levar minutos com rede lenta/instável) usada pelas chamadas de negócio.
 */
export async function fastConnectionProbe(method, endpoint, options = {}) {
  return makeSiengeRequest(method, endpoint, { ...options, maxAttempts: 1, timeoutMs: 10_000 });
}
