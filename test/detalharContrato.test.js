/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `contratos_detalhar` — a tool que responde "me dê informações do contrato de
 * instalações hidrossanitárias da obra Residencial Aurora": fornecedor, itens com preço
 * unitário, valor, prazo e saldo, numa chamada só.
 *
 * Cada caso aqui corresponde a um jeito de a resposta sair errada SEM ERRO
 * NENHUM — que é como este recurso falha: a API não lista contrato sem
 * período, soma nenhuma vem pronta, e nome que não bate volta vazio.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { iniciarSienge, carregarSupplyContractClient } from "./helpers/fakeSienge.js";

const CENTROS = [{ id: 30, name: "OB.01 - Residencial Aurora" }];

const HIDRO = {
  documentId: "CT",
  contractNumber: "1234",
  object: "Execução das Instalações Hidrossanitárias - Torre A",
  contractDate: "2023-03-11",
  startDate: "2023-04-01",
  endDate: "2030-12-20",
  status: "PARTIALLY_MEASURED",
  supplierId: 7,
  totalMaterialValue: 180000.5,
  totalLaborValue: 120000.25,
};

const PINTURA = {
  documentId: "CT",
  contractNumber: "1235",
  object: "Pintura interna",
  contractDate: "2025-05-02",
  supplierId: 8,
};

const OBRAS = [
  {
    buildingId: 30,
    buildingName: "OB.01 - Residencial Aurora",
    costCenterId: 30,
    constructUnits: [{ id: 2, name: "Torre A", status: "L" }],
  },
];

const ITENS = [
  { id: 10, wbsCode: "01", level: 0, description: "Serviços preliminares" },
  {
    id: 25,
    wbsCode: "01.001",
    level: 1,
    description: "Tubo PVC esgoto",
    detailDescription: "100mm",
    unitOfMeasure: "m",
    quantity: 1200,
    materialPrice: 18.5,
    laborPrice: 6.25,
    resourceId: 555,
  },
];

const CENARIO = {
  centros: CENTROS,
  credores: { 7: { id: 7, name: "Hidráulica Beta Ltda", cnpj: "12345678000199" } },
  contratos: [HIDRO, PINTURA],
  obrasDoContrato: OBRAS,
  itensDoContrato: ITENS,
};

test("a varredura vai com período de 4 anos — sem ele a API recusa a listagem", async () => {
  const sienge = await iniciarSienge({
    ...CENARIO,
    contrato: { ...HIDRO, materialBalance: 60000.5, laborBalance: 40000.25 },
  });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    await detalharContrato({ contrato: "instalações hidrossanitárias", obra: "ob.01" });

    const params = sienge.query("/supply-contracts/all");
    const inicio = new Date(`${params.contractStartDate}T12:00:00`);
    const fim = new Date(`${params.contractEndDate}T12:00:00`);
    const anos = (fim - inicio) / (365.25 * 86400000);

    assert.ok(params.contractStartDate, "sem contractStartDate a API responde 400");
    assert.ok(params.contractEndDate, "sem contractEndDate a API responde 400");
    assert.ok(anos > 3.9 && anos < 4.1, `janela padrão deveria ser de 4 anos, veio ${anos}`);
  } finally {
    await sienge.fechar();
  }
});

test("valor, saldo e prazo são compostos — o Sienge não devolve nenhum dos três pronto", async () => {
  const sienge = await iniciarSienge({
    ...CENARIO,
    contrato: { ...HIDRO, materialBalance: 60000.5, laborBalance: 40000.25 },
  });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "1234", documento: "CT", obra: "ob.01" });
    assert.equal(r.success, true);

    assert.equal(r.contract.valor_total, 300000.75, "valor = material + mão de obra");
    assert.equal(r.contract.saldo_total, 100000.75, "saldo = material + mão de obra");
    assert.equal(r.contract.prazo.startDate, "2023-04-01");
    assert.equal(r.contract.prazo.endDate, "2030-12-20");
    assert.ok(r.contract.prazo.dias_restantes > 0, "prazo futuro tem dias restantes positivos");
    assert.equal(r.contract.supplier.name, "Hidráulica Beta Ltda");
  } finally {
    await sienge.fechar();
  }
});

test("saldo que a API não devolveu não vira zero", async () => {
  // Um contrato sem saldo na resposta é "não sei", e um contrato com saldo
  // zero é "acabou". Somar undefined como 0 transformaria um no outro — e a
  // listagem NUNCA traz saldo, só o GET de um contrato.
  const sienge = await iniciarSienge({ ...CENARIO, contrato: { ...HIDRO } });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "1234", documento: "CT" });
    assert.equal(r.success, true);
    assert.equal(r.contract.saldo_total, undefined, "sem saldo na API, sem saldo na resposta");
    assert.equal(r.contract.valor_total, 300000.75, "o valor, esse a API traz");
  } finally {
    await sienge.fechar();
  }
});

test("o item traz preço unitário somado e o total da linha", async () => {
  const sienge = await iniciarSienge({ ...CENARIO, contrato: { ...HIDRO } });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "1234", documento: "CT" });
    const itens = r.buildings[0].planilhas[0].items;

    const tubo = itens.find((i) => i.id === 25);
    assert.equal(tubo.precoUnitario, 24.75, "material 18,50 + mão de obra 6,25");
    assert.equal(tubo.valorTotal, 29700, "1200 m × 24,75");
    assert.equal(tubo.unitOfMeasure, "m", "sem unidade, o preço unitário não quer dizer nada");

    // Item agrupador não é medível e não tem preço — precisa aparecer marcado,
    // não sumir: é ele que dá a estrutura da planilha.
    const grupo = itens.find((i) => i.id === 10);
    assert.equal(grupo.mensuravel, false);
    assert.equal(grupo.precoUnitario, null);
  } finally {
    await sienge.fechar();
  }
});

test("nome que não bate devolve os contratos da janela, não um 'não encontrado' seco", async () => {
  // O nome do cadastro raramente é o nome que a pessoa usa. Sem a lista, cada
  // tentativa de adivinhar a grafia do ERP custa um turno do modelo.
  const sienge = await iniciarSienge({ ...CENARIO, contrato: { ...HIDRO } });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "impermeabilização", obra: "ob.01" });

    assert.equal(r.success, false);
    assert.equal(r.error, "ContratoNaoEncontrado");
    assert.equal(r.total_na_janela, 2);
    assert.deepEqual(
      r.contratos_na_janela.map((c) => c.contrato).sort(),
      ["1234", "1235"]
    );
    // A janela varrida vai junto: "não achei" precisa dizer ONDE olhou, senão
    // vira "não existe" — que é outra coisa.
    assert.ok(r.janela.contractStartDate);
  } finally {
    await sienge.fechar();
  }
});

test("dois contratos batendo no mesmo termo viram candidatos com o par de cada um", async () => {
  const sienge = await iniciarSienge({
    ...CENARIO,
    contratos: [HIDRO, { ...PINTURA, object: "Instalações Hidrossanitárias - Torre B" }],
    contrato: { ...HIDRO },
  });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "instalações hidrossanitárias", obra: "ob.01" });

    assert.equal(r.success, false);
    assert.equal(r.error, "ContratoAmbiguo");
    // Sem o documento junto, o candidato não é chamável na tentativa seguinte.
    for (const candidato of r.candidatos) {
      assert.ok(candidato.documento, "candidato precisa do documento");
      assert.ok(candidato.contrato, "candidato precisa do número");
    }
  } finally {
    await sienge.fechar();
  }
});

test("o plural do jeito que se fala acha o singular do jeito que está cadastrado", async () => {
  // Caso real de produção: o contrato está cadastrado como "Elaboração de
  // projeto executivo de instalações (Hidrossanitária, Gás, Elétrica...)" e a
  // pergunta veio como "instalações hidrossanitárias". Antes do casamento por
  // prefixo, um "s" a mais derrubava a busca.
  const cadastrado = {
    ...PINTURA,
    contractNumber: "325",
    object: "Elaboração de projeto executivo de instalações (Hidrossanitária, Gás, Elétrica).",
  };
  const sienge = await iniciarSienge({
    ...CENARIO,
    contratos: [PINTURA, cadastrado],
    contrato: cadastrado,
  });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({
      contrato: "instalações hidrossanitárias",
      obra: "ob.01",
      incluir_itens: false,
    });
    assert.equal(r.success, true, JSON.stringify(r.message ?? ""));
    assert.equal(r.contrato, "325");
  } finally {
    await sienge.fechar();
  }
});

test("sem casamento, a lista vem ordenada por relevância — não por data", async () => {
  // Também de produção: nenhuma regra de texto liga "hidrossanitária" a
  // "SERVIÇO DE INSTALAÇÃO HIDRAULICA, ESGOTO, GÁS E INCÊNDIO". Com 75
  // contratos na janela e um corte na lista, ordenar por data escondia o
  // contrato certo; por relevância, quem divide a palavra "instalação" sobe.
  const irrelevantes = Array.from({ length: 30 }, (_, i) => ({
    ...PINTURA,
    contractNumber: String(900 + i),
    object: "Seguro Riscos de Engenharia",
    contractDate: "2026-01-15",
  }));
  const certo = {
    ...PINTURA,
    contractNumber: "508",
    object: "SERVIÇO DE INSTALAÇÃO HIDRAULICA, ESGOTO, GÁS E INCÊNDIO",
    contractDate: "2022-11-02",
  };
  const sienge = await iniciarSienge({ ...CENARIO, contratos: [...irrelevantes, certo] });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "instalações hidrossanitárias", obra: "ob.01" });

    assert.equal(r.success, false);
    // O mais antigo de todos, e ainda assim o primeiro da lista.
    assert.equal(r.contratos_na_janela[0].contrato, "508");
  } finally {
    await sienge.fechar();
  }
});

test("entre os dois ids de obra, vale o que o resto da API aceita", async () => {
  // O caso que custou mais caro em produção. `/supply-contracts/buildings`
  // devolve buildingID (interno) e buildingIdView (código no Sienge), com o D
  // maiúsculo que o spec não declara. Usar o interno em /items dá 404 — mas em
  // /all dá 200 com os contratos de OUTRA obra, sem erro nenhum.
  const obraComOsDoisIds = {
    buildingID: 21,
    buildingIdView: 20,
    buildingName: "OB.01 - Residencial Aurora",
    costCenterID: 21,
    costCenterIdView: 20,
    constructUnits: [{ id: 1, name: "OB.01 - Obra", status: "RELEASED" }],
  };
  const sienge = await iniciarSienge({
    ...CENARIO,
    obrasDoContrato: [obraComOsDoisIds],
    contrato: { ...HIDRO },
  });
  const { detalharContrato } = await carregarSupplyContractClient();

  try {
    const r = await detalharContrato({ contrato: "1234", documento: "CT" });

    assert.equal(r.buildings[0].buildingId, 20, "o id que vai para as outras chamadas é o view");
    assert.equal(r.buildings[0].buildingIdInterno, 21, "o interno aparece, marcado como tal");
    assert.equal(sienge.query("/supply-contracts/items").buildingId, "20");

    // "RELEASED" é o que produção responde; o spec declara "L". Ler só o spec
    // marcaria toda planilha como estado desconhecido.
    assert.equal(r.buildings[0].constructUnits[0].bloqueada, false);
  } finally {
    await sienge.fechar();
  }
});
