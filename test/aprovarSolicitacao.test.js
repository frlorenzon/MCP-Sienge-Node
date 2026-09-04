/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * compras_aprovar_solicitacoes — etapa 2, e a segunda escrita do servidor.
 *
 * Aprovar é irreversível por esta API: não há endpoint que desfaça. Por isso o
 * que mais se testa aqui não é o caminho feliz, e sim as recusas — aprovar o
 * que a fila não mostra como pendente é o erro que a tool existe para impedir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { iniciarSienge, carregarPurchaseClient, erroSienge } from "./helpers/fakeSienge.js";

function item(purchaseRequestId, itemNumber, extra = {}) {
  return {
    purchaseRequestId,
    itemNumber,
    productId: 1001,
    productDescription: "Cimento CP-II 50kg",
    detailDescription: "Saco de 50kg",
    quantity: 15,
    unitySymbol: "sc",
    authorized: false,
    disapproved: false,
    competenceLevel: 0,
    ...extra,
  };
}

function cabecalho(id, extra = {}) {
  return {
    id,
    buildingId: 11,
    requesterUser: "ana.silva",
    requestDate: "2026-08-01",
    status: "PENDING",
    draft: false,
    ...extra,
  };
}

// Fila com duas solicitações: a 19 com três itens, a 622 com um.
const FILA = {
  centros: [{ id: 11, name: "Residencial Ipê Uva" }],
  itensDeSolicitacao: [item(19, 1), item(19, 2), item(19, 3), item(622, 1)],
  cabecalhos: {
    19: cabecalho(19),
    622: cabecalho(622, { requesterUser: "bruno.costa", requestDate: "2026-06-15" }),
  },
};

async function comFila(cfg, corpo) {
  const sienge = await iniciarSienge({ ...FILA, ...cfg });
  const { aprovarSolicitacoesDeCompra } = await carregarPurchaseClient();
  try {
    await corpo(aprovarSolicitacoesDeCompra, sienge);
  } finally {
    await sienge.fechar();
  }
}

test("sem argumentos, mostra o pendente e não grava nada", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar();
    assert.equal(r.success, true);
    assert.equal(r.confirmacao_pendente, true);
    assert.equal(r.pendentes.length, 2);
    assert.equal(sienge.recebido.autorizacoes.length, 0);
    assert.match(r.message, /Nada foi gravado/);
  });
});

test("fila vazia diz que não há nada a aprovar", async () => {
  await comFila({ itensDeSolicitacao: [], cabecalhos: {} }, async (aprovar) => {
    const r = await aprovar();
    assert.match(r.message, /Nada pendente de aprovação/);
  });
});

test("a prévia não aprova", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 19 }] });
    assert.equal(r.success, true);
    assert.equal(r.confirmacao_pendente, true);
    assert.equal(sienge.recebido.autorizacoes.length, 0);
    assert.match(r.previa[0].escopo, /solicitação inteira — 3 item/);
    assert.match(r.message, /IRREVERSÍVEL/);
  });
});

test("solicitação inteira vai no PATCH de authorize da solicitação", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 19 }], confirmar: true });
    assert.equal(r.success, true);
    assert.deepEqual(sienge.recebido.autorizacoes, [
      { solicitacao: 19, escopo: "inteira", corpo: null },
    ]);
    assert.match(r.message, /3 item\(ns\) aprovado/);
  });
});

test("itens escolhidos vão no PATCH de items/authorize, no formato do spec", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 19, itens: [1, 3] }], confirmar: true });
    assert.equal(r.success, true);

    const [autorizacao] = sienge.recebido.autorizacoes;
    assert.equal(autorizacao.escopo, "itens");
    assert.deepEqual(autorizacao.corpo, {
      items: [{ purchaseRequestItemNumber: 1 }, { purchaseRequestItemNumber: 3 }],
    });
  });
});

test("um item só também usa a rota de itens, não a da solicitação", async () => {
  await comFila({}, async (aprovar, sienge) => {
    await aprovar({ solicitacoes: [{ id: 19, itens: [2] }], confirmar: true });
    const [autorizacao] = sienge.recebido.autorizacoes;
    assert.equal(autorizacao.escopo, "itens");
    assert.deepEqual(autorizacao.corpo.items, [{ purchaseRequestItemNumber: 2 }]);
  });
});

test("duas solicitações numa chamada só", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({
      solicitacoes: [{ id: 19, itens: [1] }, { id: 622 }],
      confirmar: true,
    });
    assert.equal(r.success, true);
    assert.equal(r.resultados.length, 2);
    assert.deepEqual(
      sienge.recebido.autorizacoes.map((a) => [a.solicitacao, a.escopo]),
      [[19, "itens"], [622, "inteira"]]
    );
  });
});

test("id fora da fila é recusado, não aprovado às cegas", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 999 }], confirmar: true });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "NaoEstaPendente");
    assert.deepEqual(r.pendencias[0].pendentes_agora, [622, 19]);
    assert.equal(sienge.recebido.autorizacoes.length, 0, "nada pode ser gravado");
  });
});

test("item que não está pendente é recusado, e a recusa diz quais estão", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 19, itens: [1, 9] }], confirmar: true });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "ItensNaoPendentes");
    assert.deepEqual(r.pendencias[0].itens_pendentes, [1, 2, 3]);
    assert.match(r.pendencias[0].message, /não estão pendentes/);
    assert.equal(sienge.recebido.autorizacoes.length, 0);
  });
});

test("pendências de solicitações diferentes vêm juntas", async () => {
  await comFila({}, async (aprovar) => {
    const r = await aprovar({
      solicitacoes: [{ id: 999 }, { id: 19, itens: [7] }, { id: 622 }],
    });
    assert.equal(r.pendencias.length, 2);
    assert.deepEqual(r.pendencias.map((p) => p.campo), [
      "solicitacoes[0].id",
      "solicitacoes[1].itens",
    ]);
    // O que era válido no pedido aparece, para não ser redigitado.
    assert.equal(r.previa.length, 1);
    assert.equal(r.previa[0].solicitacao, 622);
  });
});

test("confirmar relê a fila em vez de confiar no cache", async () => {
  await comFila({}, async (aprovar, sienge) => {
    await aprovar({ solicitacoes: [{ id: 19 }] });
    const aposPrevia = sienge.contar("/all/items");

    await aprovar({ solicitacoes: [{ id: 19 }], confirmar: true });
    assert.ok(
      sienge.contar("/all/items") > aposPrevia,
      "entre ver a fila e aprovar, outra pessoa pode ter decidido o mesmo item"
    );
  });
});

test("a prévia repetida aproveita o cache", async () => {
  await comFila({}, async (aprovar, sienge) => {
    await aprovar({ solicitacoes: [{ id: 19 }] });
    const aposPrimeira = sienge.contar("/all/items");
    await aprovar({ solicitacoes: [{ id: 622 }] });
    assert.equal(sienge.contar("/all/items"), aposPrimeira);
  });
});

test("falha numa solicitação não esconde a que passou", async () => {
  await comFila(
    {
      patchAutorizar: (id) =>
        id === 622
          ? { status: 422, body: erroSienge(422, "Usuário sem alçada para esta obra") }
          : { status: 204 },
    },
    async (aprovar) => {
      const r = await aprovar({ solicitacoes: [{ id: 19 }, { id: 622 }], confirmar: true });
      assert.equal(r.success, false);
      assert.deepEqual(r.resultados.map((x) => [x.solicitacao, x.aprovado]), [
        [19, true],
        [622, false],
      ]);
      assert.equal(r.resultados[1].details, "Usuário sem alçada para esta obra");
      assert.match(r.message, /as que passaram estão gravadas/);
    }
  );
});

test("id ausente na lista vira pendência, não erro genérico", async () => {
  await comFila({}, async (aprovar) => {
    const r = await aprovar({ solicitacoes: [{ itens: [1] }] });
    assert.equal(r.pendencias[0].campo, "solicitacoes[0].id");
    assert.equal(r.pendencias[0].tipo, "Faltando");
  });
});
