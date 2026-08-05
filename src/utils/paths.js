/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Diretório de estado do servidor — onde ficam o log de diagnóstico e a trilha
 * de auditoria.
 *
 * Fica no diretório do usuário de propósito. Derivar o caminho da localização
 * do pacote (import.meta.url subindo níveis) quebra assim que o pacote é
 * instalado via npm: aponta para dentro de node_modules, que pode nem ser
 * gravável. E derivar do diretório de trabalho faz o destino depender de onde
 * o cliente MCP subiu o processo.
 */

import os from "node:os";
import path from "node:path";

export const HOME_ENV_VAR = "SIENGE_MCP_HOME";

const DEFAULT_DIR_NAME = ".sienge-mcp";

/** Expande `~` no início do caminho, que o Node não resolve sozinho. */
function expandUser(p) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Diretório base do servidor: SIENGE_MCP_HOME ou ~/.sienge-mcp. */
export function stateDir() {
  const configured = (process.env[HOME_ENV_VAR] || "").trim();
  if (configured) return expandUser(configured);
  return path.join(os.homedir(), DEFAULT_DIR_NAME);
}

/** Caminho de um arquivo de estado: `envVar`, se definida, ou `stateDir()/defaultName`. */
export function resolveFile(envVar, defaultName) {
  const configured = (process.env[envVar] || "").trim();
  if (configured) return expandUser(configured);
  return path.join(stateDir(), defaultName);
}
