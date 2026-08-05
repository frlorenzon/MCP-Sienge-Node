/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Trilha de auditoria das operações de escrita no Sienge.
 *
 * Grava uma linha JSON por requisição mutante (tudo que não é GET), em modo
 * append, num arquivo separado do log de diagnóstico — este arquivo é a
 * evidência de quem alterou o quê no ERP, e nunca é truncado nem rotacionado.
 *
 * O nome da tool que originou a chamada viaja por um AsyncLocalStorage,
 * estabelecido pelo wrapper de registro em `src/registry.js` e preservado
 * através de cada `await`. Assim a auditoria acontece na camada HTTP (que
 * enxerga método, endpoint e payload reais) sem que cada tool precise se
 * lembrar de chamar nada — qualquer tool de escrita criada no futuro entra na
 * trilha automaticamente.
 */

import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolveFile } from "./paths.js";

export const AUDIT_PATH_ENV_VAR = "SIENGE_MCP_AUDIT_LOG";

const MAX_VALUE_CHARS = 200;

/**
 * Nome da tool MCP em execução, para correlacionar a requisição HTTP com a
 * ferramenta que o assistente chamou. "unknown" quando a chamada não veio de
 * uma tool (ex: uso direto dos helpers em um script).
 */
const storage = new AsyncLocalStorage();

/** Executa `fn` com `toolName` visível para toda a árvore de awaits abaixo dela. */
export function runWithTool(toolName, fn) {
  return storage.run(toolName, fn);
}

export function currentTool() {
  return storage.getStore() ?? "unknown";
}

/** Encurta valores longos (ex: Base64 de anexo) preservando o que identifica o dado. */
function truncate(value) {
  if (typeof value === "string" && value.length > MAX_VALUE_CHARS) {
    return `${value.slice(0, MAX_VALUE_CHARS)}...[+${value.length - MAX_VALUE_CHARS} chars]`;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(truncate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncate(v)]));
  }
  return value;
}

function resolvePath() {
  return resolveFile(AUDIT_PATH_ENV_VAR, "audit.log");
}

/** Anexa `event` à trilha de auditoria. Nunca lança: auditoria não derruba a operação. */
export function record(event) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      tool: currentTool(),
      ...Object.fromEntries(Object.entries(event).map(([k, v]) => [k, truncate(v)])),
    };
    const file = resolvePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // trilha de auditoria é best-effort
  }
}
