#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Sienge MCP Server (Node) — ponto de entrada.
 *
 * Sobe o servidor sobre transporte stdio e aplica o recorte estático de
 * SIENGE_PROFILE. Nada aqui escreve em stdout: sob stdio, stdout é o canal do
 * protocolo, e um `console.log` perdido corrompe a sessão. Diagnóstico vai
 * para stderr e para o arquivo de log.
 */

import fs, { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getAuthInfo } from "./config.js";
import * as tagRegistry from "./modules.js";
import { applyProfile } from "./registry.js";
import { registrarNucleo } from "./tools/nucleo.js";
import { definirModulosCarregados, registrarModulos } from "./tools/modulos.js";
import { registrarCompras } from "./tools/compras.js";
import { registrarDeep } from "./tools/deep.js";
import { getLogger } from "./utils/logger.js";

const logger = getLogger();

/**
 * Versão do package.json, não uma constante à parte.
 *
 * O `initialize` do MCP devolve esta versão ao cliente, e duas fontes de
 * verdade divergem no primeiro `npm version` que alguém rodar — foi o que
 * aconteceu: a 0.2.0 empacotada se anunciava como 0.1.0.
 */
const { version: VERSAO } = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8"
  )
);

export function buildServer() {
  const { modulos: perfilModulos, avisos } = tagRegistry.parseProfile(process.env.SIENGE_PROFILE);
  for (const aviso of avisos) logger.warn(aviso);

  const server = new McpServer({
    name: "Sienge API Integration 🏗️ - Node",
    version: VERSAO,
  });

  registrarNucleo(server);
  registrarModulos(server);
  const deepAtivo = registrarDeep(server);
  registrarCompras(server);
  definirModulosCarregados(perfilModulos);

  // Precisa rodar depois do último registro: monta um allowlist (desabilita
  // tudo, depois habilita as tags pedidas) sobre o que já está registrado.
  if (perfilModulos !== null) applyProfile(perfilModulos);

  return { server, perfilModulos, deepAtivo };
}

async function main() {
  const { server, perfilModulos, deepAtivo } = buildServer();

  const authInfo = getAuthInfo();
  const contagem = tagRegistry.toolCounts();
  const total = Object.values(contagem).reduce((a, b) => a + b, 0);

  logger.info("Sienge MCP (Node) iniciando", {
    auth_method: authInfo.auth_method,
    configured: authInfo.configured,
    base_url: authInfo.base_url,
    perfil: perfilModulos === null ? "todos os módulos" : [...perfilModulos].sort().join(", "),
    modo_profundo: deepAtivo ? "habilitado" : "desligado (SIENGE_DEEP_MODE)",
    tools_no_catalogo: total,
  });

  if (!authInfo.configured) {
    logger.warn(
      "Autenticação não configurada. Defina SIENGE_API_KEY (Bearer) ou " +
        "SIENGE_USERNAME + SIENGE_PASSWORD + SIENGE_SUBDOMAIN (Basic) no ambiente."
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Servidor MCP pronto para uso (stdio)");
}

/**
 * Este módulo foi executado diretamente, ou apenas importado?
 *
 * A comparação ingênua — `import.meta.url === \`file://${process.argv[1]}\`` —
 * dá falso negativo em três situações, e o servidor simplesmente não sobe:
 *
 *   1. instalado via npm, o binário é um symlink em `node_modules/.bin/`, e
 *      `import.meta.url` já vem com o caminho real resolvido;
 *   2. caminhos não-canônicos (`/tmp` é symlink para `/private/tmp` no macOS);
 *   3. qualquer espaço ou acento no caminho, que numa URL precisa vir escapado.
 *
 * `realpathSync` resolve (1) e (2); `pathToFileURL` resolve (3).
 */
function executadoDiretamente() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] apontando para algo que não existe: não fomos nós.
    return false;
  }
}

// Importar este módulo (por testes ou pelo verificador de schemas) deve
// registrar as tools sem falar com ninguém.
if (executadoDiretamente()) {
  main().catch((err) => {
    logger.error("Falha ao iniciar o servidor", { error: err?.message ?? String(err) });
    process.exit(1);
  });
}
