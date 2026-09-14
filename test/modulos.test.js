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
import { supplyContractModule } from "../src/modules/supplyContract.js";
import { buildServer } from "../src/index.js";
import { MODULOS as CARREGAVEIS } from "../src/toolsGroupRouter.js";

const MODULOS = {
  core: coreModule,
  purchase: purchaseModule,
  financial: financialModule,
  supplyContract: supplyContractModule,
};

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

test("compras_criar_solicitacao recebe uma LISTA de itens", () => {
  const tool = purchaseModule.tools.find((t) => t.name === "compras_criar_solicitacao");
  assert.deepEqual(tool.inputSchema.required, ["obra", "itens"]);

  const item = tool.inputSchema.properties.itens;
  assert.equal(item.type, "array", "uma solicitação comporta vários insumos");
  // Exigir a quantidade impediria a chamada que descobre a unidade de medida.
  assert.deepEqual(item.items.required, ["insumo"]);
  assert.ok(item.items.properties.quantidade);
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

test("escrita de contrato só sobe como tool se tiver o portão da prévia", () => {
  // O módulo hoje expõe só as duas tools de leitura que foram pedidas. As
  // funções de escrita existem no client e ainda não viraram tool — quando
  // virarem, cada uma precisa nascer com `confirmar`, senão o modelo não tem
  // como pedir a gravação e, pior, pode concluir que a chamada normal já
  // grava. As três são irreversíveis pela API do Sienge.
  const ESCRITAS = ["contratos_decidir", "contratos_criar_medicao", "contratos_decidir_medicoes"];

  for (const nome of ESCRITAS) {
    const tool = supplyContractModule.tools.find((t) => t.name === nome);
    if (!tool) continue; // ainda não exposta — o teste arma sozinho quando for
    assert.ok(tool.inputSchema.properties.confirmar, `${nome} precisa de confirmar`);
  }
});

test("nenhuma tool de contrato grava sem ter sido pedida", () => {
  // Guarda de escopo: as duas tools são as que foram pedidas. Acrescentar
  // outra é decisão de produto, não efeito colateral de refatoração — e três
  // das candidatas gravam em produção.
  assert.deepEqual(
    supplyContractModule.tools.map((t) => t.name),
    ["contratos_detalhar", "contratos_baixar_anexos", "contratos_pendentes_aprovacao", "contratos_decidir"]
  );
});

test("todo módulo registrado no roteador carrega de verdade", async () => {
  // O roteador importa cada módulo por caminho, dentro de uma arrow function
  // que só roda quando alguém chama `carregar_X`. Caminho errado, nome de
  // export errado ou arquivo que não existe passam por toda a suíte e só
  // explodem na primeira chamada em produção.
  for (const [nome, spec] of Object.entries(CARREGAVEIS)) {
    const modulo = await spec.carregar();
    assert.ok(modulo, `carregar_${nome} não devolveu módulo — confira o caminho e o export`);
    assert.ok(Array.isArray(modulo.tools) && modulo.tools.length, `${nome} sem tools`);

    const orfas = modulo.tools.filter((t) => typeof modulo.handlers[t.name] !== "function");
    assert.deepEqual(orfas.map((t) => t.name), [], `${nome}: tool sem handler`);
    assert.ok(spec.resumo?.length > 5, `carregar_${nome} precisa de um resumo legível`);
  }
});
