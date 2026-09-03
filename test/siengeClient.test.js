/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * makeRequest — o único ponto que fala HTTP com o Sienge.
 *
 * O foco é o tratamento de erro: durante meses toda recusa da API chegou ao
 * usuário como "Bad Request", porque o cliente lia `message` num corpo que
 * nunca teve esse campo. Ler o ErrorMessage certo é o que torna qualquer
 * outro diagnóstico possível.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

async function comResposta(status, corpo, contentType = "application/json") {
  const servidor = http.createServer((req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", contentType);
    res.end(typeof corpo === "string" ? corpo : JSON.stringify(corpo));
  });
  await new Promise((pronto) => servidor.listen(0, pronto));

  const anterior = { ...process.env };
  Object.assign(process.env, {
    SIENGE_BASE_URL: `http://127.0.0.1:${servidor.address().port}`,
    SIENGE_SUBDOMAIN: "teste",
    SIENGE_API_KEY: "chave",
  });

  const { makeRequest } = await import(`../src/client/siengeClient.js?v=${status}-${Math.random()}`);
  const resposta = await makeRequest("GET", "/qualquer");

  for (const chave of Object.keys(process.env)) if (!(chave in anterior)) delete process.env[chave];
  Object.assign(process.env, anterior);
  await new Promise((pronto) => servidor.close(pronto));
  return resposta;
}

test("developerMessage do ErrorMessage vira a mensagem, não o statusText", async () => {
  const r = await comResposta(400, {
    status: 400,
    developerMessage: "Parâmetro obrigatório ausente",
    clientMessage: "A requisição contém dados inválidos ou incompletos.",
  });
  assert.equal(r.success, false);
  assert.equal(r.status_code, 400);
  // Antes desta correção, isto era "Bad Request".
  assert.equal(r.message, "Parâmetro obrigatório ausente");
  assert.equal(r.client_message, "A requisição contém dados inválidos ou incompletos.");
});

test("errors[] chega a quem chamou: é o que diz QUAL campo", async () => {
  const r = await comResposta(400, {
    status: 400,
    developerMessage: "Dados inválidos",
    clientMessage: "Dados inválidos",
    errors: [{ field: "createdBy", message: "O campo createdBy não está presente" }],
  });
  assert.deepEqual(r.campos_invalidos, [
    { field: "createdBy", message: "O campo createdBy não está presente" },
  ]);
  // clientMessage igual ao developerMessage não se repete no retorno.
  assert.ok(!("client_message" in r));
});

test("sem developerMessage, cai no clientMessage antes do statusText", async () => {
  const r = await comResposta(422, { status: 422, clientMessage: "Estrutura inválida." });
  assert.equal(r.message, "Estrutura inválida.");
});

test("resposta que não é JSON é preservada como corpo bruto", async () => {
  const r = await comResposta(502, "<html>Bad Gateway</html>", "text/html");
  assert.equal(r.success, false);
  assert.match(r.corpo_bruto, /Bad Gateway/);
});

test("sucesso devolve os dados sem enfeite", async () => {
  const r = await comResposta(200, { id: 7, nome: "ok" });
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { id: 7, nome: "ok" });
});

test("sem credencial não sai requisição nenhuma", async () => {
  const anterior = { ...process.env };
  delete process.env.SIENGE_API_KEY;
  delete process.env.SIENGE_USERNAME;
  delete process.env.SIENGE_PASSWORD;
  const { makeRequest } = await import(`../src/client/siengeClient.js?v=semauth-${Math.random()}`);
  const r = await makeRequest("GET", "/qualquer");
  assert.equal(r.success, false);
  assert.equal(r.error, "AuthNotConfigured");
  Object.assign(process.env, anterior);
});
