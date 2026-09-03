/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * compras_criar_solicitacao — a única tool de ESCRITA do servidor.
 *
 * Os casos aqui não são hipóteses: cada um corresponde a um erro que já
 * aconteceu contra o Sienge real, e o teste existe para que não volte.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { iniciarSienge, carregarPurchaseClient, erroSienge } from "./helpers/fakeSienge.js";

const CENTROS = [
  { id: 30, name: "IU.06 - Residencial Ipê Uva" },
  { id: 31, name: "IU.07 - Residencial Ipê Amarelo" },
  { id: 32, name: "NAO USAR - IU.05 antiga" },
];

// Insumo cadastrado em PEÇA, e não em metro: é o caso do tubo de esgoto,
// vendido em barras de 6 m.
const INSUMOS = [
  {
    id: 1001,
    description: "Tubo de Esgoto",
    unitOfMeasure: "pç",
    details: [
      { id: 7, description: '2"', detailCode: "D2", status: "ACTIVE" },
      { id: 8, description: '4"', detailCode: "D4", status: "ACTIVE" },
    ],
  },
  { id: 1002, description: "Tubo de Esgoto Reforçado", unitOfMeasure: "pç", details: [] },
];

// Planilha com níveis misturados: só os de nível 2 são apropriáveis.
const PLANILHA = [
  { wbsCode: "02", description: "Instalações" },
  { wbsCode: "02.031", description: "Instalações Elétricas" },
  { wbsCode: "02.032", description: "Instalações de Incêndio, Água e Esgoto" },
  { wbsCode: "02.033", description: "Canteiro de Obras" },
  { wbsCode: "02.032.000.002", description: "Conexões hidráulicas" },
];

const CENARIO = { centros: CENTROS, insumos: INSUMOS, planilha: PLANILHA };
const NIVEL_2 = { env: { SIENGE_NIVEL_APROPRIACAO: "2" } };

const PEDIDO = {
  obra: "iu.06",
  insumo: "Tubo de Esgoto",
  detalhe: '2"',
  quantidade: 9,
  apropriacoes: [{ item: "02.032", percentual: 100 }],
};

async function comSienge(cfg, corpoDoTeste) {
  const sienge = await iniciarSienge({ ...CENARIO, ...cfg });
  const { criarSolicitacaoDeCompra } = await carregarPurchaseClient();
  try {
    await corpoDoTeste(criarSolicitacaoDeCompra, sienge);
  } finally {
    await sienge.fechar();
  }
}

test("a prévia não grava nada", async () => {
  await comSienge(NIVEL_2, async (criar, sienge) => {
    const r = await criar(PEDIDO);
    assert.equal(r.success, true);
    assert.equal(r.confirmacao_pendente, true);
    assert.equal(sienge.contar("POST"), 0, "prévia não pode chamar nenhum POST");
    assert.match(r.previa.resumo, /9 pç de 'Tubo de Esgoto' detalhe '2"'/);
  });
});

test("confirmar envia o corpo exato que o spec exige", async () => {
  await comSienge(NIVEL_2, async (criar, sienge) => {
    const r = await criar({ ...PEDIDO, confirmar: true });
    assert.equal(r.success, true);
    assert.equal(r.purchaseRequestId, 2104);

    // createdBy foi o campo cuja ausência derrubou a primeira criação real.
    assert.deepEqual(sienge.recebido.cabecalho, {
      buildingId: 30,
      requesterUser: "FELIPERL",
      requestDate: sienge.recebido.cabecalho.requestDate,
      createdBy: "FELIPERL",
    });
    // `draft` é readOnly no spec: mandá-lo seria recusado.
    assert.ok(!("draft" in sienge.recebido.cabecalho));

    const [item] = sienge.recebido.itens;
    assert.equal(item.productId, 1001);
    assert.equal(item.detailId, 7);
    assert.equal(item.unitySymbol, "pç");
    assert.deepEqual(item.buildingsApropriations, [
      { buildingUnitId: 1, costEstimationItemReference: "02.032", percentage: 100 },
    ]);
    assert.equal(item.deliveryRequirements.length, 1);
    assert.equal(item.deliveryRequirements[0].requirementQuantity, 9);
  });
});

test("entrega padrão cai 7 dias depois da solicitação", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar(PEDIDO);
    const pedidoEm = new Date(`${r.previa.requestDate}T12:00:00`);
    const entregaEm = new Date(`${r.previa.entrega.requirementDate}T12:00:00`);
    assert.equal((entregaEm - pedidoEm) / 86400000, 7);
  });
});

test("createdBy segue SIENGE_CADASTRANTE quando ele difere do solicitante", async () => {
  await comSienge({ env: { ...NIVEL_2.env, SIENGE_CADASTRANTE: "INTEGRACAO" } }, async (criar, sienge) => {
    const r = await criar({ ...PEDIDO, confirmar: true });
    assert.equal(r.success, true);
    assert.equal(sienge.recebido.cabecalho.createdBy, "INTEGRACAO");
    assert.equal(sienge.recebido.cabecalho.requesterUser, "FELIPERL");
  });
});

test("departamento e categoria vão no corpo quando configurados", async () => {
  await comSienge(
    { env: { ...NIVEL_2.env, SIENGE_DEPARTAMENTO: "5", SIENGE_CATEGORIA: "1" } },
    async (criar, sienge) => {
      await criar({ ...PEDIDO, confirmar: true });
      assert.equal(sienge.recebido.cabecalho.departamentId, 5, "grafia do spec, com um 'r'");
      assert.equal(sienge.recebido.cabecalho.categoryId, 1);
    }
  );
});

test("sem quantidade, a pendência traz a unidade do insumo", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({ obra: "iu.06", insumo: "Tubo de Esgoto", detalhe: '2"' });
    assert.equal(r.success, false);
    assert.equal(r.error, "DadosPendentes");

    const quantidade = r.pendencias.find((p) => p.campo === "quantidade");
    assert.equal(quantidade.unidade_do_insumo, "pç");
    assert.match(quantidade.message, /EM 'pç'/);
    // O erro que originou este teste: a tool cobrava quantidade sem dizer a
    // unidade, e quem perguntava oferecia "metros" para um insumo em peça. A
    // mensagem cita "metros" de propósito — para PROIBIR —, então o que se
    // verifica é que ela pede na unidade do cadastro e veta as outras.
    assert.match(quantidade.message, /não ofereça outra/);
    assert.equal(r.resolvido.insumo.unidade, "pç");
  });
});

test("todas as pendências vêm juntas, não uma por vez", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({
      obra: "iu.06",
      insumo: "tubo", // ambíguo
      apropriacoes: [{ item: "instalações", percentual: 100 }], // ambíguo
    });
    assert.equal(r.success, false);
    const campos = r.pendencias.map((p) => p.campo).sort();
    assert.deepEqual(campos, ["apropriacoes[0].item", "insumo", "quantidade"]);
    // O que já resolveu vem junto, para não ser perguntado de novo.
    assert.equal(r.resolvido.obra.name, "IU.06 - Residencial Ipê Uva");
  });
});

test("sem o insumo identificado, a cobrança de quantidade não inventa unidade", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({ obra: "iu.06", insumo: "tubo" });
    const quantidade = r.pendencias.find((p) => p.campo === "quantidade");
    assert.ok(!("unidade_do_insumo" in quantidade));
    assert.match(quantidade.message, /só pode ser dita depois/);
  });
});

test("nome sem correspondência devolve o catálogo para o modelo deduzir", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({
      ...PEDIDO,
      apropriacoes: [{ item: "instalações hidrossanitárias", percentual: 100 }],
    });
    const pendencia = r.pendencias.find((p) => p.campo === "apropriacoes[0].item");
    assert.equal(pendencia.tipo, "NaoEncontrado");

    const codigos = pendencia.itens_disponiveis.map((i) => i.wbsCode);
    assert.deepEqual(codigos, ["02.031", "02.032", "02.033"], "só os de nível 2");
    assert.match(pendencia.message, /sinônimo/);
    assert.match(pendencia.message, /Não peça ao usuário que adivinhe/);
  });
});

test("igualdade exata vence substring", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    // "Tubo de Esgoto" também é prefixo de "Tubo de Esgoto Reforçado";
    // sem a regra, o nome curto seria ineditável.
    const r = await criar(PEDIDO);
    assert.equal(r.success, true);
    assert.equal(r.previa.insumo.productId, 1001);
  });
});

test("item fora do nível configurado não é apropriável", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({
      ...PEDIDO,
      apropriacoes: [{ item: "Conexões hidráulicas", percentual: 100 }],
    });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "NaoEncontrado");
  });
});

test("sem SIENGE_NIVEL_APROPRIACAO, todos os níveis valem", async () => {
  await comSienge({}, async (criar) => {
    const r = await criar({
      ...PEDIDO,
      apropriacoes: [{ item: "Conexões hidráulicas", percentual: 100 }],
    });
    assert.equal(r.success, true);
    assert.equal(r.previa.apropriacoes[0].costEstimationItemReference, "02.032.000.002");
  });
});

test("percentuais que não fecham 100 barram antes de qualquer POST", async () => {
  await comSienge(NIVEL_2, async (criar, sienge) => {
    const r = await criar({
      ...PEDIDO,
      apropriacoes: [
        { item: "02.032", percentual: 50 },
        { item: "02.033", percentual: 40 },
      ],
    });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "PercentuaisNaoFecham");
    assert.equal(sienge.contar("POST"), 0);
  });
});

test("unidade divergente vira aviso na prévia, não recusa", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({ ...PEDIDO, quantidade: 50, unidade: "m" });
    assert.equal(r.success, true);
    assert.match(r.previa.avisoUnidade, /informou a quantidade em 'm'/);
    assert.match(r.previa.avisoUnidade, /solicitado em 'pç'/);
  });
});

test("obra ambígua devolve candidatos em vez de escolher", async () => {
  await comSienge(NIVEL_2, async (criar) => {
    const r = await criar({ ...PEDIDO, obra: "iu.0" });
    assert.equal(r.success, false);
    assert.equal(r.error, "ObraAmbigua");
    // Obra marcada "NAO USAR" nunca entra nos candidatos.
    assert.ok(!r.candidatos.some((c) => /NAO USAR/.test(c.name)));
  });
});

test("SIENGE_SOLICITANTE ausente recusa antes de chamar a API", async () => {
  await comSienge({ env: { ...NIVEL_2.env, SIENGE_SOLICITANTE: "" } }, async (criar, sienge) => {
    const r = await criar({ ...PEDIDO, confirmar: true });
    assert.equal(r.error, "SolicitanteNaoConfigurado");
    assert.equal(sienge.chamadas.length, 0);
  });
});

test("400 no cabeçalho: nada foi criado, e o motivo vem nomeado", async () => {
  await comSienge(
    {
      ...NIVEL_2,
      postCabecalho: () => ({
        status: 400,
        body: erroSienge(400, "createdBy não pode ser nulo", [
          { field: "createdBy", message: "O campo createdBy não está presente" },
        ]),
      }),
    },
    async (criar) => {
      const r = await criar({ ...PEDIDO, confirmar: true });
      assert.equal(r.success, false);
      assert.equal(r.etapa_que_falhou, "cabecalho");
      // Sem esta linha o usuário recebia apenas "Bad Request".
      assert.equal(r.details, "createdBy não pode ser nulo");
      assert.equal(r.campos_invalidos[0].field, "createdBy");
      assert.ok(r.payload_enviado, "o que foi enviado é metade do diagnóstico");
    }
  );
});

test("400 nos itens: a solicitação ficou criada e vazia, e o retorno diz isso", async () => {
  await comSienge(
    { ...NIVEL_2, postItens: () => ({ status: 400, body: erroSienge(400, "Quantidade inválida") }) },
    async (criar) => {
      const r = await criar({ ...PEDIDO, confirmar: true });
      assert.equal(r.success, false);
      assert.equal(r.error, "ItensNaoInseridos");
      assert.equal(r.purchaseRequestId, 2104);
      assert.match(r.message, /foi CRIADA, mas o item não entrou/);
    }
  );
});

test("o orçamento é lido uma vez por chamada, não uma vez por apropriação", async () => {
  await comSienge(NIVEL_2, async (criar, sienge) => {
    await criar({
      ...PEDIDO,
      apropriacoes: [
        { item: "02.032", percentual: 50 },
        { item: "02.033", percentual: 50 },
      ],
    });
    assert.equal(sienge.contar("/sheets/"), 1);
    assert.equal(sienge.contar("/resources"), 1);
  });
});
