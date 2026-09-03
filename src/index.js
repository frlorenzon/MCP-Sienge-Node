#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Ponto de entrada: monta o servidor, instala o roteamento e conecta o
 * transporte stdio.
 *
 * `Server`, e não `McpServer`, porque o roteamento instala os handlers de
 * `tools/list` e `tools/call` por conta própria — e o McpServer instala os
 * dele preguiçosamente, no primeiro `registerTool`, sobrescrevendo sem aviso.
 * Ver o cabeçalho de `toolsGroupRouter.js`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { setupToolsGroupRouter } from "./toolsGroupRouter.js";

const { version: VERSAO } = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8"
  )
);

export async function buildServer() {
  const server = new Server(
    { name: "Sienge API Integration 🏗️ - Node", version: VERSAO },
    {
      capabilities: {
        // `listChanged` é o que autoriza o servidor a avisar que o catálogo
        // mudou. Sem ela declarada, o carregamento sob demanda publica as
        // tools e o cliente nunca fica sabendo.
        tools: { listChanged: true },
      },
    }
  );

  await setupToolsGroupRouter(server);
  return server;
}

// Só sobe o transporte quando o arquivo é executado, não quando é importado —
// é o que permite que um teste construa o servidor sem tomar o stdio.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await buildServer();
  await server.connect(new StdioServerTransport());
  console.error("[sienge] servidor no ar (stdio)");
}
