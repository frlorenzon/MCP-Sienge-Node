/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * `contratos_baixar_anexos` — baixa os anexos do contrato e os salva.
 *
 * O que pode dar errado aqui não é a API: é o DISCO. Nome de anexo é texto
 * digitado por gente e vira caminho no computador de quem chamou; dois
 * contratos podem ter um "contrato assinado.pdf" cada; e um anexo que falhe
 * não pode levar os outros junto.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { iniciarSienge, carregarSupplyContractClient } from "./helpers/fakeSienge.js";

const CONTRATO = {
  documentId: "CTS",
  contractNumber: "325",
  object: "Projeto executivo de instalações",
  contractDate: "2024-05-14",
  supplierId: 17,
};

const BASE = {
  centros: [{ id: 20, name: "OB.01 - Residencial Aurora" }],
  credores: { 17: { id: 17, name: "Projetos Alfa Ltda", cnpj: "00000000000191" } },
  contratos: [CONTRATO],
  contrato: CONTRATO,
};

async function pastaTemporaria() {
  return mkdtemp(join(tmpdir(), "sienge-anexos-"));
}

test("sem a pasta configurada, recusa antes de chamar a API", async () => {
  const sienge = await iniciarSienge({ ...BASE, env: { SIENGE_PASTA_ANEXOS: "" } });
  const { baixarAnexosDoContrato } = await carregarSupplyContractClient();

  try {
    const r = await baixarAnexosDoContrato({ contrato: "325", documento: "CTS" });
    assert.equal(r.success, false);
    assert.equal(r.error, "PastaNaoConfigurada");
    assert.match(r.message, /SIENGE_PASTA_ANEXOS/);
    assert.equal(sienge.contar("/supply-contracts"), 0, "não devia ter chamado a API");
  } finally {
    await sienge.fechar();
  }
});

test("vários anexos viram vários arquivos, numa pasta por contrato e fornecedor", async () => {
  const base = await pastaTemporaria();
  const sienge = await iniciarSienge({
    ...BASE,
    env: { SIENGE_PASTA_ANEXOS: base },
    anexos: [
      { contractAttachmentNumber: 1, name: "contrato assinado.pdf", description: "via do fornecedor" },
      { contractAttachmentNumber: 2, name: "cronograma.xlsx", description: "prazos" },
    ],
    conteudoAnexo: { 1: "conteudo-do-pdf", 2: "conteudo-da-planilha" },
  });
  const { baixarAnexosDoContrato } = await carregarSupplyContractClient();

  try {
    const r = await baixarAnexosDoContrato({ contrato: "325", documento: "CTS" });

    assert.equal(r.success, true);
    assert.equal(r.count, 2, "dois anexos, dois arquivos");
    assert.equal(r.pasta, join(base, "CTS-325 - Projetos Alfa Ltda"));

    const naPasta = (await readdir(r.pasta)).sort();
    assert.deepEqual(naPasta, ["contrato assinado.pdf", "cronograma.xlsx"]);

    // Os bytes chegam como vieram: nada é lido, interpretado ou reescrito.
    assert.equal(await readFile(r.arquivos[0].arquivo, "utf8"), "conteudo-do-pdf");

    // O caminho serve ao terminal, a URL ao clique, e o comando abre o
    // gerenciador de arquivos — a resposta precisa dos três.
    assert.ok(r.abrir_pasta.startsWith("file://"));
    assert.match(r.comando_para_abrir, /(open|explorer|xdg-open)/);
    assert.ok(r.arquivos[0].abrir.startsWith("file://"));
    assert.match(r.message, /salvos na pasta/);
  } finally {
    await sienge.fechar();
  }
});

test("nome de anexo com barra não escreve fora da pasta", async () => {
  // O nome vem do ERP, digitado por gente. Sem sanear, um anexo chamado
  // "../../.ssh/authorized_keys" gravaria fora da pasta configurada.
  const base = await pastaTemporaria();
  const sienge = await iniciarSienge({
    ...BASE,
    env: { SIENGE_PASTA_ANEXOS: base },
    anexos: [{ contractAttachmentNumber: 1, name: "../../.ssh/authorized_keys" }],
    conteudoAnexo: { 1: "nao-deveria-sair-da-pasta" },
  });
  const { baixarAnexosDoContrato } = await carregarSupplyContractClient();

  try {
    const r = await baixarAnexosDoContrato({ contrato: "325", documento: "CTS" });

    assert.equal(r.success, true);
    assert.ok(r.arquivos[0].arquivo.startsWith(r.pasta), "o arquivo tem que ficar dentro da pasta");
    assert.ok(!r.arquivos[0].nome.includes("/"), "nenhuma barra sobrevive no nome");
    assert.deepEqual(await readdir(r.pasta), [r.arquivos[0].nome]);
  } finally {
    await sienge.fechar();
  }
});

test("um anexo que falha não derruba os outros", async () => {
  const base = await pastaTemporaria();
  const sienge = await iniciarSienge({
    ...BASE,
    env: { SIENGE_PASTA_ANEXOS: base },
    anexos: [
      { contractAttachmentNumber: 1, name: "ok.pdf" },
      { contractAttachmentNumber: 2, name: "quebrado.pdf" },
      { contractAttachmentNumber: 3, name: "tambem-ok.pdf" },
    ],
    conteudoAnexo: { 1: "um", 2: { status: 500 }, 3: "tres" },
  });
  const { baixarAnexosDoContrato } = await carregarSupplyContractClient();

  try {
    const r = await baixarAnexosDoContrato({ contrato: "325", documento: "CTS" });

    assert.equal(r.success, true, "dois de três salvos ainda é sucesso parcial");
    assert.equal(r.count, 2);
    assert.equal(r.falhas.length, 1);
    assert.equal(r.falhas[0].anexo, 2);
    assert.ok(r.falhas[0].motivo, "a falha precisa dizer por quê");
    assert.deepEqual((await readdir(r.pasta)).sort(), ["ok.pdf", "tambem-ok.pdf"]);
  } finally {
    await sienge.fechar();
  }
});

test("contrato sem anexo nenhum não cria pasta vazia", async () => {
  const base = await pastaTemporaria();
  const sienge = await iniciarSienge({ ...BASE, env: { SIENGE_PASTA_ANEXOS: base }, anexos: [] });
  const { baixarAnexosDoContrato } = await carregarSupplyContractClient();

  try {
    const r = await baixarAnexosDoContrato({ contrato: "325", documento: "CTS" });
    assert.equal(r.success, true);
    assert.equal(r.count, 0);
    assert.deepEqual(await readdir(base), [], "nada foi criado no disco");
  } finally {
    await sienge.fechar();
  }
});
