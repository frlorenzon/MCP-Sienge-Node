/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Log de diagnóstico.
 *
 * Nunca escreve em stdout: sob transporte stdio, stdout é o canal do protocolo
 * MCP e qualquer byte fora do lugar corrompe a sessão. O destino é o arquivo em
 * SIENGE_MCP_LOG_FILE (ou <state_dir>/sienge-mcp.log); stderr recebe cópia
 * apenas de warn e error, que é o que o cliente MCP costuma mostrar.
 *
 * Diferente da trilha de auditoria (utils/audit.js), este arquivo é rotacionado
 * e pode ser descartado — é diagnóstico, não evidência.
 */

import fs from "node:fs";
import path from "node:path";
import { resolveFile } from "./paths.js";

export const LOG_FILE_ENV_VAR = "SIENGE_MCP_LOG_FILE";
export const LOG_LEVEL_ENV_VAR = "SIENGE_MCP_LOG_LEVEL";

const LEVELS = { TRACE: 5, DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function configuredLevel() {
  const raw = (process.env[LOG_LEVEL_ENV_VAR] || "").trim().toUpperCase();
  return LEVELS[raw] ?? LEVELS.INFO;
}

/** Serializa o payload estruturado, tolerando valores que não viram JSON. */
function render(data) {
  if (data === undefined || data === null) return "";
  try {
    return ` | ${JSON.stringify(data)}`;
  } catch {
    return ` | ${String(data)}`;
  }
}

/**
 * Rotaciona por tamanho, guardando uma geração anterior. Nada de bibliotecas:
 * um rename quando o arquivo passa do teto resolve o caso de um servidor que
 * roda por semanas sem ninguém olhar o log.
 */
function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      fs.renameSync(file, `${file}.1`);
    }
  } catch {
    // arquivo ainda não existe — nada a rotacionar
  }
}

class SiengeLogger {
  constructor(name = "SiengeMCP") {
    this.name = name;
    this.level = configuredLevel();
    this.file = resolveFile(LOG_FILE_ENV_VAR, "sienge-mcp.log");
    this.fileUsable = true;
  }

  emit(levelName, message, data) {
    if (LEVELS[levelName] < this.level) return;

    const line =
      `[${new Date().toISOString()}] [PID:${process.pid}] ${levelName} ` +
      `[${this.name}]: ${message}${render(data)}\n`;

    if (LEVELS[levelName] >= LEVELS.WARN) process.stderr.write(line);

    if (!this.fileUsable) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      rotateIfNeeded(this.file);
      fs.appendFileSync(this.file, line, "utf8");
    } catch {
      // Um diretório de estado não-gravável não pode derrubar o servidor.
      // Desiste do arquivo uma vez e segue só com stderr.
      this.fileUsable = false;
    }
  }

  trace(m, d) { this.emit("TRACE", m, d); }
  debug(m, d) { this.emit("DEBUG", m, d); }
  info(m, d) { this.emit("INFO", m, d); }
  warn(m, d) { this.emit("WARN", m, d); }
  warning(m, d) { this.emit("WARN", m, d); }
  error(m, d) { this.emit("ERROR", m, d); }
}

let _logger = null;

export function getLogger(name = "SiengeMCP") {
  if (!_logger) _logger = new SiengeLogger(name);
  return _logger;
}
