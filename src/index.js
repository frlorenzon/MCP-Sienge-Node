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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getAuthInfo } from "./config.js";
import * as tagRegistry from "./modules.js";
import { applyProfile } from "./registry.js";
import { definirModulosAtivos, registrarNucleo } from "./tools/nucleo.js";
import { getLogger } from "./utils/logger.js";

const logger = getLogger();

export function buildServer() {
  const { modulos: perfilModulos, avisos } = tagRegistry.parseProfile(process.env.SIENGE_PROFILE);
  for (const aviso of avisos) logger.warn(aviso);

  const server = new McpServer({
    name: "Sienge API Integration 🏗️ - Node",
    version: "0.1.0",
  });

  registrarNucleo(server, { perfilConfigurado: perfilModulos });
  definirModulosAtivos(perfilModulos);

  // Precisa rodar depois do último registro: monta um allowlist (desabilita
  // tudo, depois habilita as tags pedidas) sobre o que já está registrado.
  if (perfilModulos !== null) applyProfile(perfilModulos);

  return { server, perfilModulos };
}

async function main() {
  const { server, perfilModulos } = buildServer();

  const authInfo = getAuthInfo();
  const contagem = tagRegistry.toolCounts();
  const total = Object.values(contagem).reduce((a, b) => a + b, 0);

  logger.info("Sienge MCP (Node) iniciando", {
    auth_method: authInfo.auth_method,
    configured: authInfo.configured,
    base_url: authInfo.base_url,
    perfil: perfilModulos === null ? "todos os módulos" : [...perfilModulos].sort().join(", "),
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

// Só sobe o transporte quando executado diretamente; importar este módulo (por
// testes ou pelo verificador de schemas) deve registrar as tools sem falar com
// ninguém.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error("Falha ao iniciar o servidor", { error: err?.message ?? String(err) });
    process.exit(1);
  });
}
