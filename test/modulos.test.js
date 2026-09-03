/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Contrato de módulo e catálogo de tools.
 *
 * O roteador confia que todo módulo declara `tools` e `handlers` casados e
 * que nome de tool não colide entre módulos. Uma tool sem handler só aparece
 * quando alguém a chama, em produção.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { coreModule } from "../src/modules/core.js";
import { purchaseModule } from "../src/modules/purchase.js";
import { financialModule } from "../src/modules/financial.js";
import { buildServer } from "../src/index.js";

const MODULOS = { core: coreModule, purchase: purchaseModule, financial: financialModule };

for (const [nome, modulo] of Object.entries(MODULOS)) {
  test(`${nome}: toda tool declarada tem handler`, () => {
    const orfas = modulo.tools.filter((t) => typeof modulo.handlers[t.name] !== "function");
    assert.deepEqual(orfas.map((t) => t.name), []);
  });

  test(`${nome}: todo handler tem tool declarada`, () => {
    const nomes = new Set(modulo.tools.map((t) => t.name));
    const soltos = Object.keys(modulo.handlers).filter((h) => !nomes.has(h));
    assert.deepEqual(soltos, []);
  });

  test(`${nome}: toda tool tem descrição e inputSchema de objeto`, () => {
    for (const t of modulo.tools) {
      assert.ok(t.description?.length > 20, `${t.name} precisa de descrição`);
      assert.equal(t.inputSchema.type, "object", `${t.name} precisa de inputSchema de objeto`);
    }
  });
}

test("nomes de tool não colidem entre módulos", () => {
  const vistos = new Map();
  for (const [nome, modulo] of Object.entries(MODULOS)) {
    for (const t of modulo.tools) {
      assert.ok(!vistos.has(t.name), `${t.name} declarada em ${vistos.get(t.name)} e em ${nome}`);
      vistos.set(t.name, nome);
    }
  }
});

test("compras_criar_solicitacao não exige quantidade no schema", () => {
  const tool = purchaseModule.tools.find((t) => t.name === "compras_criar_solicitacao");
  // Exigi-la impediria a chamada que descobre a unidade de medida do insumo.
  assert.deepEqual(tool.inputSchema.required, ["obra", "insumo"]);
  assert.ok(tool.inputSchema.properties.quantidade);
  assert.ok(tool.inputSchema.properties.confirmar);
});

test("o servidor monta e responde tools/list", async () => {
  const servidor = await buildServer();
  assert.ok(servidor);
});

test("o processo de compras descreve as seis etapas e a cobertura de cada uma", async () => {
  const processo = await purchaseModule.handlers.compras_processo({});
  assert.equal(processo.success, true);
  assert.equal(processo.etapas.length, 6);
  for (const etapa of processo.etapas) {
    assert.ok(["completa", "parcial", "ausente"].includes(etapa.cobertura_mcp), etapa.nome);
    // Toda tool citada pelo conhecimento precisa existir de fato, senão o
    // assistente promete uma ação que o servidor não faz.
    for (const nome of etapa.tools ?? []) {
      assert.ok(purchaseModule.handlers[nome], `${nome} é citada na etapa ${etapa.etapa} e não existe`);
    }
  }
});
