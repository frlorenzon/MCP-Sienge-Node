/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * compras_solicitacoes_para_aprovacao — a fila da etapa 2.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { iniciarSienge, carregarPurchaseClient } from "./helpers/fakeSienge.js";

/** Item no formato de PurchaseRequestItem do spec. */
function item(purchaseRequestId, itemNumber, extra = {}) {
  return {
    purchaseRequestId,
    itemNumber,
    productId: 1001,
    productDescription: "Cimento CP-II 50kg",
    detailId: 2,
    detailDescription: "Saco de 50kg, paletizado",
    trademarkId: 3,
    trademarkDescription: "Votoran",
    quantity: 15,
    unitySymbol: "sc",
    estimatedPrice: 0,
    notes: "Para a laje do 3º pavimento",
    authorized: false,
    disapproved: false,
    competenceLevel: 0,
    estimatedDeliveryTime: 5,
    tenantUrl: "https://exemplo",
    links: [],
    ...extra,
  };
}

function cabecalho(id, extra = {}) {
  return {
    id,
    buildingId: 11,
    departamentId: 5,
    requesterUser: "ana.silva",
    requestDate: "2026-08-01",
    notes: "obra atrasada",
    status: "PENDING",
    consitent: "CONSISTENT", // grafia do spec, sem o segundo "s"
    draft: false,
    ...extra,
  };
}

async function comFila(cfg, corpo) {
  const sienge = await iniciarSienge({
    centros: [{ id: 11, name: "Residencial 11" }, { id: 12, name: "Residencial 12" }],
    ...cfg,
  });
  const { listarSolicitacoesParaAprovacao } = await carregarPurchaseClient();
  try {
    await corpo(listarSolicitacoesParaAprovacao, sienge);
  } finally {
    await sienge.fechar();
  }
}

test("agrupa os itens por solicitação e resolve o cabeçalho de cada uma", async () => {
  await comFila(
    {
      itensDeSolicitacao: [item(19, 1), item(19, 2), item(622, 1)],
      cabecalhos: {
        19: cabecalho(19),
        622: cabecalho(622, { requesterUser: "bruno.costa", requestDate: "2026-06-15", buildingId: 12 }),
      },
    },
    async (listar) => {
      const r = await listar();
      assert.equal(r.success, true);
      assert.equal(r.count, 2);
      assert.equal(r.itemCount, 3);
      // Mais antiga primeiro: numa fila, o que espera há mais tempo vem antes.
      assert.deepEqual(r.purchaseRequests.map((s) => s.id), [622, 19]);
      assert.equal(r.purchaseRequests[0].building.name, "Residencial 12");
      assert.equal(r.purchaseRequests[1].itemCount, 2);
    }
  );
});

test("os quatro filtros vão na própria requisição", async () => {
  await comFila({ itensDeSolicitacao: [], cabecalhos: {} }, async (listar, sienge) => {
    await listar();
    // authorized:false sozinho traria item reprovado e solicitação já atendida.
    const chamada = sienge.chamadas.find((c) => c.includes("/all/items"));
    assert.ok(chamada, "a fila precisa consultar /purchase-requests/all/items");
  });
});

test("rascunho fica de fora: não espera decisão de ninguém", async () => {
  await comFila(
    {
      itensDeSolicitacao: [item(19, 1), item(777, 1)],
      cabecalhos: { 19: cabecalho(19), 777: cabecalho(777, { draft: true }) },
    },
    async (listar) => {
      const r = await listar();
      assert.deepEqual(r.purchaseRequests.map((s) => s.id), [19]);
      assert.equal(r.itemCount, 1, "o item do rascunho não pode entrar na contagem");
    }
  );
});

test("estimatedPrice zero é ruído e não entra", async () => {
  await comFila(
    {
      itensDeSolicitacao: [item(19, 1), item(19, 2, { estimatedPrice: 42.9 })],
      cabecalhos: { 19: cabecalho(19) },
    },
    async (listar) => {
      const [solicitacao] = (await listar()).purchaseRequests;
      assert.ok(!("estimatedPrice" in solicitacao.items[0]));
      assert.equal(solicitacao.items[1].estimatedPrice, 42.9);
    }
  );
});

test("insumo e detalhe são campos separados", async () => {
  await comFila(
    { itensDeSolicitacao: [item(19, 1)], cabecalhos: { 19: cabecalho(19) } },
    async (listar) => {
      const [{ items }] = (await listar()).purchaseRequests;
      assert.equal(items[0].product, "Cimento CP-II 50kg");
      assert.equal(items[0].detail, "Saco de 50kg, paletizado");
    }
  );
});

test("nota de 4000 caracteres é cortada para não dominar o contexto", async () => {
  await comFila(
    {
      itensDeSolicitacao: [item(19, 1, { notes: "x".repeat(4000) })],
      cabecalhos: { 19: cabecalho(19) },
    },
    async (listar) => {
      const [{ items }] = (await listar()).purchaseRequests;
      assert.equal(items[0].notes.length, 301, "300 caracteres mais as reticências");
    }
  );
});

test("competenceLevel ganha tradução legível", async () => {
  await comFila(
    {
      itensDeSolicitacao: [
        item(19, 1, { competenceLevel: 0 }),
        item(19, 2, { competenceLevel: 1 }),
        item(19, 3, { competenceLevel: null }),
      ],
      cabecalhos: { 19: cabecalho(19) },
    },
    async (listar) => {
      const [{ items }] = (await listar()).purchaseRequests;
      assert.match(items[0].approvalStage, /nenhuma alçada/);
      assert.match(items[1].approvalStage, /1ª alçada/);
      assert.match(items[2].approvalStage, /fora do processo/);
    }
  );
});

test("pagina até o fim, para não partir uma solicitação entre páginas", async () => {
  const itens = Array.from({ length: 250 }, (_, i) => item(19, i));
  await comFila(
    { itensDeSolicitacao: itens, cabecalhos: { 19: cabecalho(19) } },
    async (listar, sienge) => {
      const r = await listar();
      assert.equal(r.itemCount, 250);
      assert.equal(sienge.contar("/all/items"), 2, "200 por página, então duas páginas");
      assert.ok(!r.truncated);
    }
  );
});

test("avisa quando o teto de páginas é atingido, em vez de mentir o total", async () => {
  const itens = Array.from({ length: 200 }, (_, i) => item(19, i));
  await comFila(
    { itensDeSolicitacao: itens, totalDeItens: 5000, cabecalhos: { 19: cabecalho(19) } },
    async (listar) => {
      const r = await listar();
      assert.equal(r.truncated, true);
      assert.match(r.message, /Há solicitações fora desta lista/);
    }
  );
});

test("um cabeçalho por solicitação, e a obra sai do cache", async () => {
  await comFila(
    {
      itensDeSolicitacao: [item(19, 1), item(19, 2), item(622, 1)],
      // As duas solicitações na mesma obra: o centro de custo é lido uma vez.
      cabecalhos: { 19: cabecalho(19), 622: cabecalho(622) },
    },
    async (listar, sienge) => {
      await listar();
      assert.equal(sienge.contar("/purchase-requests/19"), 1);
      assert.equal(sienge.contar("/cost-centers"), 1);
    }
  );
});

test("DTO com nomes desconhecidos devolve as chaves reais em vez de campos vazios", async () => {
  await comFila(
    {
      itensDeSolicitacao: [{ purchaseRequestId: 19, codigoInsumo: 9, textoLivre: "x" }],
      cabecalhos: { 19: cabecalho(19) },
    },
    async (listar) => {
      const r = await listar();
      assert.deepEqual(r.camposNaoReconhecidos, ["purchaseRequestId", "codigoInsumo", "textoLivre"]);
    }
  );
});
