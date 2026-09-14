/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `contratos_pendentes_aprovacao` e `contratos_decidir`.
 *
 * O fluxo é "quais estão pendentes?" seguido de "aprova o 524 e o 568",
 * "aprova todos" ou "reprova o 596". Os defeitos que importam aqui são de dois tipos: a lista
 * sair incompleta sem avisar (e o modelo encadear tools para completar), e a
 * decisão gravar o que ninguém viu. Nenhuma das duas tem volta pela API.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { iniciarSienge, carregarSupplyContractClient, erroSienge } from "./helpers/fakeSienge.js";
import { supplyContractModule } from "../src/modules/supplyContract.js";

// Formato de ContractDTO conferido em produção: a listagem já traz
// `supplierName`, `buildings` (com o id View) e o motivo da pendência.
const NOVO = {
  documentId: "CTS",
  contractNumber: "596",
  object: "FORNECIMENTO DE BLOCO ESTRUTURAL.",
  supplierId: 41,
  supplierName: "Pré-Moldados Beta Ltda",
  buildings: [{ buildingId: 21, name: "iU.07 - SCP" }],
  contractDate: "2026-09-01",
  startDate: "2026-09-01",
  endDate: "2027-09-30",
  status: "PENDING",
  totalMaterialValue: 155488.28,
  totalLaborValue: 0,
  consistent: true,
  currentAuthorizationLevel: "FIRST_LEVEL",
  disapprovalReason: ["(1) valor total do contrato excede o limite permitido para o usuário"],
};

const ADITIVO = {
  ...NOVO,
  contractNumber: "524",
  object: "LOCAÇÃO DE MAQUINAS E EQUIPAMENTOS",
  supplierName: "Locação Gama Ltda",
  totalMaterialValue: 0,
  totalLaborValue: 28754,
  status: "PARTIALLY_MEASURED",
  currentAuthorizationLevel: "ADDENDUM",
  disapprovalReason: [
    "(1) valor total do contrato excede o limite permitido para o usuário",
    "(2) manutenção de aditivos de contratos",
  ],
};

const INCONSISTENTE = {
  ...NOVO,
  contractNumber: "88",
  object: "Serviços de marcenaria",
  buildings: [],
  totalMaterialValue: 0,
  totalLaborValue: 0,
  consistent: false,
  disapprovalReason: [],
};

const OBRA_DO_CONTRATO = [
  {
    buildingID: 22,
    buildingIdView: 21,
    buildingName: "iU.07 - SCP",
    constructUnits: [{ id: 1, name: "iU.07 - Obra", status: "RELEASED" }],
  },
];

const ITENS = [
  { id: 1, level: 0, description: "Agrupador" },
  {
    id: 2,
    level: 1,
    description: "bloco de concreto para vedação 14x19x39",
    unitOfMeasure: "un",
    quantity: 28800,
    materialPrice: 3.75,
    laborPrice: 0,
    resourceId: 900,
  },
];

const CENARIO = {
  centros: [{ id: 21, name: "iU.07 - SCP" }],
  contratos: [NOVO, ADITIVO, INCONSISTENTE],
  obrasDoContrato: OBRA_DO_CONTRATO,
  itensDoContrato: ITENS,
  aditivos: [
    { documentId: "CTS", contractNumber: "524", buildingId: 21, addendumNumber: 13, addendumDate: "2026-08-10", addendumDescription: "Aditivo antigo", totalLaborValue: 1500, totalMaterialValue: 0 },
    { documentId: "CTS", contractNumber: "524", buildingId: 21, addendumNumber: 14, addendumDate: "2026-09-11", addendumDescription: "Aditivo", totalLaborValue: 4480, totalMaterialValue: 0 },
  ],
  itensDoAditivo: [
    { description: "Motor vibrador costa 220v", unitOfMeasure: "un", quantityChange: 8, newLaborPrice: 180, newMaterialPrice: 0, totalCostChange: 1440 },
  ],
};

// =========================================================
// LISTAGEM
// =========================================================

test("a fila chega completa numa chamada: fornecedor, valor, prazo, motivo e itens", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { listarContratosPendentesDeAprovacao } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    const novo = r.contratos.find((c) => c.contrato === "CTS/596");

    assert.equal(novo.fornecedor, "Pré-Moldados Beta Ltda");
    assert.equal(novo.valor_total, 155488.28);
    assert.equal(novo.prazo.endDate, "2027-09-30");
    assert.deepEqual(novo.obras, ["iU.07 - SCP"]);
    assert.equal(novo.itens.length, 1, "o agrupador fica de fora, o item com preço entra");
    assert.equal(novo.itens[0].preco_unitario, 3.75);
    assert.equal(novo.itens[0].valor, 108000);

    // O "(1) " é numeração do ERP, não parte do motivo.
    assert.deepEqual(novo.motivo_da_pendencia, ["valor total do contrato excede o limite permitido para o usuário"]);

    // O fornecedor já vem na listagem: buscar credor seria uma chamada por
    // contrato sem ganho nenhum.
    assert.equal(sienge.contar("/creditors"), 0);
  } finally {
    await sienge.fechar();
  }
});

test("a fila varre desde 2000 — aditivo pendente pode estar num contrato antigo", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { listarContratosPendentesDeAprovacao } = await carregarSupplyContractClient();

  try {
    await listarContratosPendentesDeAprovacao();
    const params = sienge.query("/supply-contracts/all");
    assert.equal(params.contractStartDate, "2000-01-01", "a janela de 4 anos esconderia aditivo em contrato velho");
    assert.equal(params.authorization, "N", "N é 'aguardando'; a palavra seria ignorada em silêncio");
    // S é "consistente". Não N: em produção, N devolve zero mesmo com
    // contratos incompletos na fila — eles estão em I, "inclusão".
    assert.equal(params.consistency, "S");
  } finally {
    await sienge.fechar();
  }
});

test("aditivo pendente é reconhecido pela alçada e traz o que o mais recente mudou", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { listarContratosPendentesDeAprovacao } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    const aditivo = r.contratos.find((c) => c.contrato === "CTS/524");

    assert.equal(aditivo.tipo, "aditivo");
    assert.equal(aditivo.aditivos.total_de_aditivos, 2);
    assert.equal(aditivo.aditivos.recentes.length, 1, "um por obra, o de número mais alto");
    assert.equal(aditivo.aditivos.recentes[0].numero, 14);
    assert.equal(aditivo.aditivos.recentes[0].variacao_valor, 4480);
    assert.equal(aditivo.aditivos.recentes[0].itens_alterados[0].variacao_custo, 1440);

    // Contrato novo não busca aditivo: seria uma chamada por contrato à toa.
    assert.equal(r.contratos.find((c) => c.contrato === "CTS/596").aditivos, undefined);
    assert.match(r.message, /1 contrato\(s\) e 1 aditivo\(s\)/);
  } finally {
    await sienge.fechar();
  }
});

test("contrato ainda em inclusão não aparece — nem pode ser decidido", async () => {
  // Em produção, 3 dos 9 pendentes estavam "em inclusão": alguém ainda
  // cadastrando, valor zerado, sem obra. Não há o que decidir neles.
  const sienge = await iniciarSienge(CENARIO);
  const { listarContratosPendentesDeAprovacao, decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    assert.ok(!r.contratos.some((c) => c.contrato === "CTS/88"), "o incompleto não aparece");
    assert.equal(r.count, 2);

    const d = await decidirContratos({ contratos: ["CTS/88"], confirmar: true });
    assert.equal(d.success, false);
    assert.equal(d.pendencias[0].tipo, "ForaDaFila");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});

test("contrato reprovado não aparece — mesmo vindo junto em authorization=N", async () => {
  // A armadilha: reprovar não tira o contrato da fila de "aguardando". Em
  // produção, CTS/324 e CTS/466 vinham em authorization=N E em =S. Confiando
  // no nome do filtro, a tool ofereceria para aprovar o que alguém já reprovou.
  const REPROVADO = { ...NOVO, contractNumber: "466", statusApproval: "DISAPPROVED" };
  const sienge = await iniciarSienge({ ...CENARIO, contratos: [NOVO, ADITIVO, REPROVADO] });
  const { listarContratosPendentesDeAprovacao, decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    assert.ok(!r.contratos.some((c) => c.contrato === "CTS/466"), "o reprovado não aparece");
    assert.equal(sienge.query("/supply-contracts/all").statusApproval, "A");

    const d = await decidirContratos({ contratos: ["CTS/466"], confirmar: true });
    assert.equal(d.success, false, "nem pode ser decidido de novo");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});

test("contrato concluído ou revogado não aparece nem pode ser decidido", async () => {
  // Não há filtro de situação na API — estes saem no código. Em produção havia
  // dois concluídos aguardando autorização: estado do ERP, não decisão a tomar.
  const CONCLUIDO = { ...NOVO, contractNumber: "137", status: "COMPLETED" };
  const REVOGADO = { ...NOVO, contractNumber: "200", status: "RESCINDED" };
  const sienge = await iniciarSienge({ ...CENARIO, contratos: [NOVO, ADITIVO, CONCLUIDO, REVOGADO] });
  const { listarContratosPendentesDeAprovacao, decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    assert.deepEqual(r.contratos.map((c) => c.contrato).sort(), ["CTS/524", "CTS/596"]);
    assert.match(r.message, /^2 pendente/, "a contagem não inclui concluído nem revogado");

    const d = await decidirContratos({ contratos: ["CTS/137", "CTS/200"], confirmar: true });
    assert.equal(d.success, false);
    assert.equal(d.pendencias.length, 2, "os dois são recusados, cada um nomeado");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});

test("item acima do teto é contado, nunca cortado em silêncio", async () => {
  const muitos = Array.from({ length: 45 }, (_, i) => ({
    id: 100 + i,
    description: `Item ${i}`,
    unitOfMeasure: "un",
    quantity: 1,
    materialPrice: 10,
    resourceId: 1,
  }));
  const sienge = await iniciarSienge({ ...CENARIO, contratos: [NOVO], itensDoContrato: muitos });
  const { listarContratosPendentesDeAprovacao } = await carregarSupplyContractClient();

  try {
    const r = await listarContratosPendentesDeAprovacao();
    assert.equal(r.contratos[0].itens.length, 30);
    assert.equal(r.contratos[0].itens_omitidos, 15);
    assert.ok(r.sobre_itens, "a resposta diz onde ver o resto");
  } finally {
    await sienge.fechar();
  }
});

// =========================================================
// APROVAÇÃO
// =========================================================

test("sem contratos informados, recusa — não existe 'aprovar tudo que estiver pendente'", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ confirmar: true });
    assert.equal(r.success, false);
    assert.equal(r.error, "ContratosNaoInformados");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});

test("a prévia não grava nada, e diz o que ficou de fora", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ contratos: ["CTS/524"] });

    assert.equal(r.confirmacao_pendente, true);
    assert.equal(sienge.recebido.contratos.length, 0, "prévia não pode mandar PATCH");
    assert.deepEqual(r.previa.map((c) => c.contrato), ["CTS/524"]);
    assert.deepEqual(r.continuam_pendentes.map((c) => c.contrato), ["CTS/596"]);
    assert.match(r.message, /IRREVERSÍVEL/);
  } finally {
    await sienge.fechar();
  }
});

test("a referência é lida como a pessoa escreve", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    for (const escrita of ["CTS/524", "cts 524", "CTS-524", "524"]) {
      const r = await decidirContratos({ contratos: [escrita] });
      assert.equal(r.confirmacao_pendente, true, `'${escrita}' deveria resolver`);
      assert.equal(r.previa[0].contrato, "CTS/524");
    }
  } finally {
    await sienge.fechar();
  }
});

test("uma referência errada na lista impede TODAS as aprovações", async () => {
  // Validar tudo antes de gravar qualquer coisa: um número errado no meio não
  // pode deixar metade aprovada.
  const sienge = await iniciarSienge(CENARIO);
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ contratos: ["CTS/524", "CTS/999", "596"], confirmar: true });

    assert.equal(r.success, false);
    assert.equal(r.pendencias.length, 1);
    assert.equal(r.pendencias[0].onde, "contratos[1]");
    assert.equal(sienge.recebido.contratos.length, 0, "nenhum PATCH pode ter saído");
    assert.ok(r.pendentes_na_fila.includes("CTS/524"), "a resposta mostra o que existe de fato");
  } finally {
    await sienge.fechar();
  }
});

test("confirmado, cada contrato vira um PATCH com a identidade na query", async () => {
  const sienge = await iniciarSienge(CENARIO);
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ contratos: ["CTS/524", "596"], observacao: "ok diretoria", confirmar: true });

    assert.equal(r.success, true);
    const enviados = sienge.recebido.contratos.map((c) => `${c.documentId}/${c.contractNumber}`).sort();
    assert.deepEqual(enviados, ["CTS/524", "CTS/596"]);
    assert.ok(sienge.recebido.contratos.every((c) => c.decisao === "aprovar"));
    assert.deepEqual(sienge.recebido.contratos[0].corpo, { observation: "ok diretoria" });
    assert.equal(r.continuam_pendentes, undefined, "pediu os dois que existiam: nada ficou de fora");
  } finally {
    await sienge.fechar();
  }
});

test("contrato que já saiu da fila entre a listagem e a aprovação não é gravado", async () => {
  // A execução relê a fila. Se outra pessoa aprovou o 596 nesse meio-tempo,
  // ele não está mais lá — e mandar o PATCH seria decidir às cegas.
  const sienge = await iniciarSienge({ ...CENARIO, contratos: [ADITIVO] });
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ contratos: ["CTS/524", "CTS/596"], confirmar: true });
    assert.equal(r.success, false);
    assert.equal(r.pendencias[0].tipo, "ForaDaFila");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});

test("recusa do Sienge num contrato não desfaz os outros, e o motivo aparece", async () => {
  const sienge = await iniciarSienge({
    ...CENARIO,
    decidirContrato: (_doc, numero) =>
      numero === "596"
        ? { status: 422, body: erroSienge(422, "Usuário sem alçada para o valor do contrato") }
        : { status: 204 },
  });
  const { decidirContratos } = await carregarSupplyContractClient();

  try {
    const r = await decidirContratos({ contratos: ["CTS/524", "CTS/596"], confirmar: true });

    assert.equal(r.success, true, "um aprovado ainda é sucesso parcial");
    const falha = r.resultados.find((x) => x.contrato === "CTS/596");
    assert.equal(falha.success, false);
    assert.match(falha.motivo, /alçada/);
    assert.equal(r.resultados.filter((x) => x.success).length, 1);
    assert.match(r.message, /1 recusado/);
  } finally {
    await sienge.fechar();
  }
});

test("reprovar pela mesma tool vai para /disapprove, com o motivo", async () => {
  const sienge = await iniciarSienge(CENARIO);
  await carregarSupplyContractClient();

  try {
    const r = await supplyContractModule.handlers.contratos_decidir({
      contratos: ["CTS/596"],
      decisao: "reprovar",
      observacao: "preço acima da cotação",
      confirmar: true,
    });
    assert.equal(r.success, true);
    assert.equal(sienge.recebido.contratos.length, 1);
    assert.equal(sienge.recebido.contratos[0].decisao, "reprovar");
    assert.deepEqual(sienge.recebido.contratos[0].corpo, { observation: "preço acima da cotação" });
    assert.match(r.message, /reprovado/);
  } finally {
    await sienge.fechar();
  }
});

test("sem decisão informada, aprova — reprovar nunca é o padrão", async () => {
  const sienge = await iniciarSienge(CENARIO);
  await carregarSupplyContractClient();

  try {
    await supplyContractModule.handlers.contratos_decidir({ contratos: ["CTS/524"], confirmar: true });
    assert.equal(sienge.recebido.contratos[0].decisao, "aprovar");
  } finally {
    await sienge.fechar();
  }
});

test("decisão desconhecida é recusada antes de qualquer PATCH", async () => {
  // "cancelar", "suspender" — o modelo pode inventar. Nada disso pode cair
  // num default e virar aprovação.
  const sienge = await iniciarSienge(CENARIO);
  await carregarSupplyContractClient();

  try {
    const r = await supplyContractModule.handlers.contratos_decidir({
      contratos: ["CTS/524"],
      decisao: "cancelar",
      confirmar: true,
    });
    assert.equal(r.success, false);
    assert.equal(r.error, "DecisaoInvalida");
    assert.equal(sienge.recebido.contratos.length, 0);
  } finally {
    await sienge.fechar();
  }
});
