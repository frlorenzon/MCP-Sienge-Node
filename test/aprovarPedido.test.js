/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * compras_decidir_pedidos — etapa 5, e a terceira escrita do servidor.
 *
 * O que se testa aqui, além das recusas da etapa 2, é o que só existe no
 * pedido: o compromisso financeiro (o valor tem que aparecer antes de gravar),
 * a bifurcação PUT/PATCH da observação, e o AVISO DE E-MAIL — o Sienge não
 * dispara os envios parametrizados quando a aprovação vem pela API, e um
 * aviso que some de alguma resposta é um fornecedor que fica sem a via.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { iniciarSienge, carregarPurchaseClient, erroSienge } from "./helpers/fakeSienge.js";

function itemDePedido(numero, extra = {}) {
  return {
    itemNumber: numero,
    productId: 1001,
    productDescription: "Tubo de esgoto 100mm",
    detailDescription: "Barra de 6m",
    quantity: 20,
    unitOfMeasureSymbol: "br",
    unitPrice: 45.5,
    ...extra,
  };
}

// Fila com dois pedidos, de fornecedores e obras diferentes.
const FILA = {
  centros: [
    { id: 11, name: "Residencial Ipê Uva" },
    { id: 12, name: "Edifício Jacarandá" },
  ],
  credores: {
    501: { id: 501, name: "Hidráulica Central Ltda" },
    502: { id: 502, name: "Comercial Ferragens SA" },
  },
  pedidos: [
    {
      id: 8801,
      date: "2026-08-20",
      supplierId: 501,
      buildingId: 11,
      buyerId: "carlos.m",
      totalAmount: 910,
      paymentCondition: "30/60 dias",
    },
    {
      id: 8802,
      date: "2026-08-22",
      supplierId: 502,
      buildingId: 12,
      buyerId: "carlos.m",
      totalAmount: 1250.4,
      paymentCondition: "à vista",
    },
  ],
  itensDePedido: { 8801: [itemDePedido(1)], 8802: [itemDePedido(1), itemDePedido(2)] },
};

async function comFila(cfg, corpo) {
  const sienge = await iniciarSienge({ ...FILA, ...cfg });
  const { decidirPedidosDeCompra } = await carregarPurchaseClient();
  try {
    await corpo(decidirPedidosDeCompra, sienge);
  } finally {
    await sienge.fechar();
  }
}

// ---------------------------------------------------------------------------
// O AVISO DE E-MAIL
// ---------------------------------------------------------------------------
// O bug de paridade só protege alguém se o aviso chegar a quem lê a resposta.
// Some numa das três (listagem, prévia, sucesso) e o caminho justamente mais
// perigoso — aprovar direto com confirmar: true — é o que fica sem aviso.

test("aprovar avisa do e-mail nas três respostas: listagem, prévia e sucesso", async () => {
  await comFila({}, async (decidir) => {
    const listagem = await decidir({});
    const previa = await decidir({ pedidos: [{ id: 8801 }] });
    const gravado = await decidir({ pedidos: [{ id: 8801 }], confirmar: true });

    for (const [onde, r] of [["listagem", listagem], ["prévia", previa], ["sucesso", gravado]]) {
      assert.ok(r.aviso_email, `sem aviso de e-mail na ${onde}`);
      assert.match(r.aviso_email.o_que_acontece, /NÃO envia e-mail/);
      assert.match(r.aviso_email.mesmo_que, /parametrizado/);
    }
  });
});

test("o aviso não aparece na reprovação — não há envio na tela para faltar", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ pedidos: [{ id: 8801 }], decisao: "reprovar", confirmar: true });
    assert.equal(r.success, true);
    assert.equal(r.aviso_email, undefined);
  });
});

test("o sucesso da aprovação não diz que o fornecedor foi comunicado", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ pedidos: [{ id: 8801 }], confirmar: true });
    assert.match(r.proximo_passo, /NINGUÉM FOI AVISADO/);
  });
});

test("a aprovação gravada convida a abrir chamado; a prévia e a listagem não", async () => {
  await comFila({}, async (decidir) => {
    // O convite existe para virar volume de relatos na Starian, que hoje trata
    // o caso como melhoria — sem prazo. Se ele sumir da resposta, some junto a
    // única chance de a correção sair do limbo.
    const gravado = await decidir({ pedidos: [{ id: 8801 }], confirmar: true });
    assert.ok(gravado.ajude_a_corrigir, "sem convite na aprovação gravada");
    assert.match(gravado.ajude_a_corrigir.por_que_importa, /MELHORIA/);
    assert.match(gravado.ajude_a_corrigir.o_que_fazer, /PERGUNTE/);

    // Antes de gravar ninguém foi atingido ainda: perguntar ali é ruído.
    assert.equal((await decidir({})).ajude_a_corrigir, undefined);
    assert.equal((await decidir({ pedidos: [{ id: 8801 }] })).ajude_a_corrigir, undefined);
  });
});

test("reprovar não convida a abrir chamado — o bug não atinge a reprovação", async () => {
  await comFila({}, async (decidir) => {
    const r = await decidir({ pedidos: [{ id: 8801 }], decisao: "reprovar", confirmar: true });
    assert.equal(r.ajude_a_corrigir, undefined);
  });
});

// ---------------------------------------------------------------------------
// PRÉVIA E COMPROMISSO FINANCEIRO
// ---------------------------------------------------------------------------

test("sem confirmar, nada é gravado e a prévia traz valor, fornecedor e obra", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ pedidos: [{ id: 8801 }, { id: 8802 }] });

    assert.equal(r.confirmacao_pendente, true);
    assert.deepEqual(sienge.recebido.pedidos, [], "não podia ter gravado nada");
    assert.equal(r.valor_total, 2160.4);
    assert.deepEqual(
      r.previa.map((p) => [p.pedido, p.fornecedor, p.obra, p.totalAmount]),
      [
        [8801, "Hidráulica Central Ltda", "Residencial Ipê Uva", 910],
        [8802, "Comercial Ferragens SA", "Edifício Jacarandá", 1250.4],
      ]
    );
    assert.match(r.message, /IRREVERSÍVEL/);
  });
});

test("chamada sem pedidos lista a fila sem gravar", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({});
    assert.equal(r.pendentes.length, 2);
    assert.deepEqual(sienge.recebido.pedidos, []);
    assert.match(r.message, /100 últimos/);
  });
});

// ---------------------------------------------------------------------------
// RECUSAS
// ---------------------------------------------------------------------------

test("pedido fora da fila é recusado sem afirmar que já foi decidido", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ pedidos: [{ id: 9999 }], confirmar: true });

    assert.equal(r.success, false);
    assert.equal(r.error, "DadosPendentes");
    assert.deepEqual(sienge.recebido.pedidos, [], "não podia gravar às cegas");
    // A janela de 100 pedidos é hipótese real para um id ausente: dizer que já
    // foi decidido seria uma afirmação falsa sobre um pedido antigo.
    assert.match(r.pendencias[0].message, /FORA DA JANELA/);
    assert.deepEqual(r.pendencias[0].pendentes_agora, [8801, 8802]);
  });
});

test("id repetido na mesma chamada é recusado antes de gravar duas vezes", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ pedidos: [{ id: 8801 }, { id: 8801 }], confirmar: true });

    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "Duplicado");
    assert.deepEqual(sienge.recebido.pedidos, []);
  });
});

test("uma pendência barra a chamada inteira, e os válidos aparecem na prévia", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ pedidos: [{ id: 8801 }, { id: 9999 }], confirmar: true });

    assert.equal(r.success, false);
    assert.deepEqual(sienge.recebido.pedidos, [], "nada grava enquanto houver pendência");
    assert.deepEqual(r.previa.map((p) => p.pedido), [8801]);
  });
});

test("decisão inválida não chega a consultar a fila", async () => {
  await comFila({}, async (decidir, sienge) => {
    const r = await decidir({ pedidos: [{ id: 8801 }], decisao: "cancelar", confirmar: true });
    assert.equal(r.error, "DecisaoInvalida");
    assert.equal(sienge.contar("/purchase-orders"), 0);
  });
});

// ---------------------------------------------------------------------------
// EXECUÇÃO
// ---------------------------------------------------------------------------

test("sem observação usa PUT; com observação usa PATCH e manda o corpo", async () => {
  await comFila({}, async (decidir, sienge) => {
    await decidir({ pedidos: [{ id: 8801 }], confirmar: true });
    await decidir({ pedidos: [{ id: 8802, observacao: "conferido com o orçamento" }], confirmar: true });

    assert.deepEqual(
      sienge.recebido.pedidos.map((p) => [p.pedido, p.metodo, p.corpo]),
      [
        [8801, "PUT", null],
        [8802, "PATCH", { observation: "conferido com o orçamento" }],
      ]
    );
  });
});

test("reprovar bate no endpoint de reprovação, não no de autorização", async () => {
  await comFila({}, async (decidir, sienge) => {
    await decidir({ pedidos: [{ id: 8801 }], decisao: "reprovar", confirmar: true });
    assert.deepEqual(sienge.recebido.pedidos.map((p) => p.decisao), ["reprovar"]);
  });
});

test("falha num pedido não esconde o que já foi gravado no outro", async () => {
  await comFila(
    { decidirPedido: (id) => (id === 8802 ? { status: 422, body: erroSienge(422, "Sem alçada") } : { status: 204 }) },
    async (decidir) => {
      const r = await decidir({ pedidos: [{ id: 8801 }, { id: 8802 }], confirmar: true });

      assert.equal(r.success, false);
      // Não é atômico: o 8801 está gravado e some da conversa se o retorno
      // reportar só a falha.
      assert.deepEqual(r.resultados.map((x) => [x.pedido, x.aprovado]), [[8801, true], [8802, false]]);
      assert.match(r.message, /1 de 2/);
    }
  );
});

// ---------------------------------------------------------------------------
// CACHE
// ---------------------------------------------------------------------------

test("a execução relê a fila do ERP mesmo com o cache quente", async () => {
  await comFila({}, async (decidir, sienge) => {
    await decidir({});
    const depoisDaListagem = sienge.contar("GET /teste/public/api/v1/purchase-orders");

    await decidir({ pedidos: [{ id: 8801 }] });
    assert.equal(
      sienge.contar("GET /teste/public/api/v1/purchase-orders"),
      depoisDaListagem,
      "a prévia podia sair do cache"
    );

    await decidir({ pedidos: [{ id: 8801 }], confirmar: true });
    assert.ok(
      sienge.contar("GET /teste/public/api/v1/purchase-orders") > depoisDaListagem,
      "a execução tinha que reler: outra pessoa pode ter decidido nesse meio-tempo"
    );
  });
});
