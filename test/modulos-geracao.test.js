/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Geração automática dos carregadores.
 *
 * Hoje só `compras` tem tools, então o servidor de verdade exercita um caso só
 * — e o caso que importa aqui é o próximo módulo, o que ainda não existe.
 * Estes testes registram uma tool de `financeiro` à mão e conferem que o
 * carregador aparece sem que ninguém o anuncie.
 *
 * ⚠️ Arquivo separado de propósito. `registered`, em registry.js, é global ao
 * processo: registrar uma tool que o servidor de verdade não registra deixaria
 * `modulosDisponiveis()` mentindo para todos os testes seguintes do mesmo
 * arquivo. `node --test` isola por arquivo, e é essa isolação que se está
 * usando aqui.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool, registered } from "../src/registry.js";
import { registrarModulos } from "../src/tools/modulos.js";
import * as modules from "../src/modules.js";

/** Uma tool de `financeiro`, o módulo que ainda não foi implementado. */
const TOOL_FINANCEIRA = "get_sienge_bills";

test("módulo ganha carregador assim que ganha a primeira tool", () => {
  const server = new McpServer({ name: "teste", version: "1.0.0" });

  // O nome é o que decide a tag: `tagsFor` o encontra em TOOLS_BY_MODULE.
  assert.deepEqual([...modules.tagsFor(TOOL_FINANCEIRA)], ["financeiro"]);
  registerTool(server, {
    name: TOOL_FINANCEIRA,
    description: "tool de mentira, só para o módulo existir",
    handler: async () => ({ success: true }),
  });

  registrarModulos(server);

  const carregador = modules.nomeDoCarregador("financeiro");
  assert.ok(registered.has(carregador), `${carregador} não foi gerado`);

  // A descrição precisa ser a `chamada` do módulo, não um texto inventado:
  // é o único texto pelo qual o modelo decide carregar.
  assert.equal(
    registered.get(carregador).handle.description,
    modules.MODULES.financeiro.chamada
  );

  // E nenhum carregador para módulo sem tool: seria pagar contexto em toda
  // requisição para dizer "ainda não".
  for (const m of ["cotacoes", "contratos", "titulos", "compras_api"]) {
    const orfao = modules.nomeDoCarregador(m);
    assert.ok(!registered.has(orfao), `${orfao} não deveria existir`);
  }

  // Nem para o núcleo, que não se carrega.
  assert.ok(!registered.has(modules.nomeDoCarregador("nucleo")));
});

test("o carregador gerado liga as tools do módulo", async () => {
  // O laço registra; falta conferir que o handler gerado faz o trabalho —
  // habilitar por tag e devolver os nomes exatos que passaram a existir.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = new McpServer({ name: "teste", version: "1.0.0" });
  registerTool(server, {
    name: TOOL_FINANCEIRA,
    description: "tool de mentira, só para o módulo existir",
    handler: async () => ({ success: true }),
  });
  registrarModulos(server);
  registered.get(TOOL_FINANCEIRA).handle.disable();

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  try {
    const antes = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!antes.includes(TOOL_FINANCEIRA), "deveria começar desligada");

    const r = JSON.parse(
      (
        await client.callTool({
          name: modules.nomeDoCarregador("financeiro"),
          arguments: {},
        })
      ).content[0].text
    );
    assert.equal(r.success, true);
    assert.deepEqual(r.tools, [TOOL_FINANCEIRA]);

    const depois = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(depois.includes(TOOL_FINANCEIRA), "o carregador não a habilitou");
  } finally {
    await client.close();
  }
});
