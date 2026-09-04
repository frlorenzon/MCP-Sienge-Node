/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * compras_decidir_solicitacoes — etapa 2, e a segunda escrita do servidor.
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
  const { decidirSolicitacoesDeCompra } = await carregarPurchaseClient();
  try {
    await corpo(decidirSolicitacoesDeCompra, sienge);
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
    assert.match(r.previa[0].escopo, /solicitação inteira — todos os 3 item/);
    assert.match(r.message, /IRREVERSÍVEL/);
  });
});

test("solicitação inteira vai no PATCH de authorize da solicitação", async () => {
  await comFila({}, async (aprovar, sienge) => {
    const r = await aprovar({ solicitacoes: [{ id: 19 }], confirmar: true });
    assert.equal(r.success, true);
    assert.deepEqual(sienge.recebido.autorizacoes, [
      { solicitacao: 19, decisao: "aprovar", escopo: "inteira", corpo: null },
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

// ── Reprovação ───────────────────────────────────────────────────────────────
// Mesma conferência da aprovação, porque o risco é o mesmo: reprovar o que não
// se olhou tira do caminho um insumo de que a obra precisa, e a API também não
// desfaz uma reprovação.

test("reprovar a solicitação inteira usa a rota de disapproval", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({
      solicitacoes: [{ id: 19 }],
      decisao: "reprovar",
      confirmar: true,
    });
    assert.equal(r.success, true);
    assert.equal(r.decisao, "reprovar");
    assert.deepEqual(sienge.recebido.autorizacoes, [
      { solicitacao: 19, decisao: "reprovar", escopo: "inteira", corpo: null },
    ]);
    assert.match(r.message, /reprovado/);
  });
});

test("reprovar itens é um PATCH por item — o spec não tem lote", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({
      solicitacoes: [{ id: 19, itens: [1, 3] }],
      decisao: "reprovar",
      confirmar: true,
    });
    assert.equal(r.success, true);
    assert.equal(sienge.recebido.autorizacoes.length, 2, "reprovação não aceita lote");
    assert.deepEqual(
      sienge.recebido.autorizacoes.map((a) => [a.itemNumber, a.decisao]),
      [[1, "reprovar"], [3, "reprovar"]]
    );
  });
});

test("reprovação parcialmente gravada diz quais itens já entraram", async () => {
  await comFila(
    {
      patchAutorizar: (_id, item) =>
        item === 3
          ? { status: 422, body: erroSienge(422, "Item já atendido por um pedido") }
          : { status: 204 },
    },
    async (decidir) => {
      const r = await decidir({
        solicitacoes: [{ id: 19, itens: [1, 3] }],
        decisao: "reprovar",
        confirmar: true,
      });
      assert.equal(r.success, false);
      // O item 1 JÁ foi reprovado; dizer que a solicitação inteira falhou seria mentira.
      assert.deepEqual(r.resultados[0].itens_ja_gravados, [1]);
      assert.equal(r.resultados[0].details, "Item já atendido por um pedido");
    }
  );
});

test("decisão inválida é recusada antes de qualquer chamada", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ solicitacoes: [{ id: 19 }], decisao: "arquivar", confirmar: true });
    assert.equal(r.error, "DecisaoInvalida");
    assert.equal(sienge.chamadas.length, 0);
  });
});

test("a reprovação confere a fila igual à aprovação", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({
      solicitacoes: [{ id: 999 }],
      decisao: "reprovar",
      confirmar: true,
    });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "NaoEstaPendente");
    assert.equal(sienge.recebido.autorizacoes.length, 0);
  });
});

// ── Deixar para depois ───────────────────────────────────────────────────────
// Não decidir é uma saída legítima. O que a tool não pode fazer é deixar isso
// invisível: decidir dois de cinco não pode parecer ter resolvido a solicitação.

test("decidir parte da solicitação mostra o que continua aguardando", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ solicitacoes: [{ id: 19, itens: [1] }] });
    const [retrato] = r.previa;

    assert.equal(retrato.itens.length, 1);
    assert.deepEqual(retrato.permanecem_pendentes.map((i) => i.itemNumber), [2, 3]);
    assert.match(retrato.aviso_pendentes, /decidir depois é uma opção/);
    assert.match(r.message, /2 item\(ns\) ficariam SEM decisão/);
  });
});

test("decidir a solicitação inteira não deixa resto nem aviso", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ solicitacoes: [{ id: 19 }] });
    assert.ok(!("permanecem_pendentes" in r.previa[0]));
    assert.doesNotMatch(r.message, /SEM decisão/);
  });
});

test("depois de gravar, o retorno lembra o que ficou aguardando", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ solicitacoes: [{ id: 19, itens: [2] }], confirmar: true });
    assert.equal(r.success, true);
    assert.match(r.message, /2 item\(ns\) continuam aguardando decisão/);
  });
});
