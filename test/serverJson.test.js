/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * server.json — o manifesto do registro oficial do MCP.
 *
 * Existe porque a dessincronia aqui é SILENCIOSA. `mcp-publisher validate`
 * passa, a publicação passa, e o registro fica apontando para uma versão de
 * npm que não existe — ninguém descobre até alguém tentar instalar. O bump de
 * versão acontece toda semana e a versão aparece em dois lugares neste
 * arquivo, então confiar na memória é questão de tempo até falhar.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const ler = (nome) => JSON.parse(fs.readFileSync(new URL(`../${nome}`, import.meta.url), "utf8"));
const server = ler("server.json");
const pkg = ler("package.json");

test("a versão do topo acompanha o package.json", () => {
  assert.equal(server.version, pkg.version);
});

test("a versão de cada pacote acompanha o package.json", () => {
  // O segundo lugar, que é o esquecido: o `version` do topo identifica o
  // manifesto, este aponta para o tarball que será baixado.
  for (const p of server.packages) {
    assert.equal(p.version, pkg.version, `pacote ${p.identifier}`);
  }
});

test("o pacote declarado é o que este repositório publica", () => {
  assert.equal(server.packages[0].identifier, pkg.name);
  assert.equal(server.packages[0].registryType, "npm");
});

test("a descrição cabe no limite do registro", () => {
  // O registro recusa com HTTP 422 acima de 100 caracteres. Já aconteceu.
  assert.ok(
    server.description.length <= 100,
    `descrição tem ${server.description.length} caracteres, o limite é 100`
  );
});

test("o namespace é o que o login do GitHub consegue provar", () => {
  // Publicar em io.github.<usuário>/* exige estar autenticado como esse
  // usuário; um namespace trocado só falha na hora de publicar.
  assert.match(server.name, /^io\.github\.frlorenzon\//);
});

test("declara as variáveis sem as quais o servidor não sobe", () => {
  const declaradas = server.packages[0].environmentVariables.map((v) => v.name);
  for (const obrigatoria of ["SIENGE_SUBDOMAIN", "SIENGE_API_KEY", "SIENGE_SOLICITANTE"]) {
    assert.ok(declaradas.includes(obrigatoria), `${obrigatoria} não está no server.json`);
  }
});

test("credencial é marcada como secreta, e só ela", () => {
  // isSecret governa como o cliente MCP trata o valor na interface. Marcar de
  // menos expõe senha; marcar demais esconde o subdomínio de quem configura.
  const porNome = Object.fromEntries(
    server.packages[0].environmentVariables.map((v) => [v.name, v.isSecret === true])
  );
  assert.equal(porNome.SIENGE_API_KEY, true);
  assert.equal(porNome.SIENGE_PASSWORD, true);
  assert.equal(porNome.SIENGE_SUBDOMAIN, false);
  assert.equal(porNome.SIENGE_USERNAME, false);
});
