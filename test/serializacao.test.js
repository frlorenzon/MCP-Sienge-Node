/**
 * A serialização das respostas.
 *
 * Toda resposta de toda tool passa por aqui, então um desperdício neste ponto
 * é cobrado 131 vezes — e uma poda agressiva demais destrói dado real 131
 * vezes. Os dois lados precisam estar travados por teste.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.SIENGE_MCP_HOME = "/tmp/sienge-mcp-test";
process.env.SIENGE_API_KEY = "chave-de-teste";
process.env.SIENGE_SUBDOMAIN = "empresa";

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { registerTool } = await import("../src/registry.js");
const { z } = await import("zod");

/** Registra uma tool que devolve `resposta` e chama-a, devolvendo o texto cru. */
async function textoDaResposta(resposta, spec = {}) {
  const server = new McpServer({ name: "t", version: "1.0.0" });
  registerTool(server, {
    name: "testar_conexao", // nome do catálogo, para herdar a tag nucleo
    description: "tool de teste",
    handler: async () => resposta,
    ...spec,
  });

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  const r = await client.callTool({ name: "testar_conexao", arguments: {} });
  await client.close();
  return r.content[0].text;
}

test("não gasta tokens com indentação", async () => {
  const texto = await textoDaResposta({ success: true, data: { id: 1, nome: "ACME" } });
  assert.doesNotMatch(texto, /\n/, "quebras de linha viram tokens sem informar nada");
  assert.doesNotMatch(texto, / {2}/, "indentação viram tokens sem informar nada");

  // O aviso de licença é anexado à primeira resposta do processo, e qual teste
  // roda primeiro varia. Ele tem cobertura própria; aqui só atrapalharia.
  const { license_warning, ...r } = JSON.parse(texto);
  assert.deepEqual(r, { success: true, data: { id: 1, nome: "ACME" } });
});

test("descarta chaves nulas, que não dizem nada que a ausência não diga", async () => {
  const texto = await textoDaResposta({
    success: true,
    customers: [{ id: 1, name: "ACME", cpf: null, birthDate: null, cnpj: "123" }],
  });
  const r = JSON.parse(texto);
  assert.deepEqual(r.customers[0], { id: 1, name: "ACME", cnpj: "123" });
  assert.doesNotMatch(texto, /null/);
});

test("preserva null dentro de arrays, onde a posição importa", async () => {
  // Remover um elemento deslocaria todos os seguintes e mudaria o significado.
  const texto = await textoDaResposta({ success: true, valores: [1, null, 3] });
  assert.deepEqual(JSON.parse(texto).valores, [1, null, 3]);
});

test("preserva false e 0, que são dados e não ausência", async () => {
  const texto = await textoDaResposta({
    success: true,
    ativo: false,
    saldo: 0,
    texto: "",
  });
  const r = JSON.parse(texto);
  assert.equal(r.ativo, false);
  assert.equal(r.saldo, 0);
  assert.equal(r.texto, "");
});

test("poda metadados de diagnóstico quando a chamada deu certo", async () => {
  const texto = await textoDaResposta({
    success: true,
    data: { id: 1 },
    request_id: "a3f2c1d4-5e6b-7890-abcd-ef1234567890",
    latency_ms: 187,
    status_code: 200,
  });
  const r = JSON.parse(texto);
  assert.equal(r.request_id, undefined);
  assert.equal(r.latency_ms, undefined);
  assert.equal(r.status_code, undefined);
  assert.deepEqual(r.data, { id: 1 });
});

test("mantém metadados quando a chamada falhou — são o rastro do que houve", async () => {
  const texto = await textoDaResposta({
    success: false,
    error: "HTTP 422",
    message: "Erro de validação",
    request_id: "a3f2c1d4",
    latency_ms: 187,
    status_code: 422,
  });
  const r = JSON.parse(texto);
  assert.equal(r.request_id, "a3f2c1d4");
  assert.equal(r.latency_ms, 187);
  assert.equal(r.status_code, 422);
});

test("manterMetadados preserva o diagnóstico mesmo em sucesso", async () => {
  const texto = await textoDaResposta(
    { success: true, api_status: "Online", latency_ms: 187, request_id: "abc" },
    { manterMetadados: true }
  );
  const r = JSON.parse(texto);
  assert.equal(r.latency_ms, 187, "para uma tool de diagnóstico, a latência É o resultado");
  assert.equal(r.request_id, "abc");
});

test("metadados aninhados não são podados — só os do topo", async () => {
  // `status_code` dentro de um item de dado é dado, não metadado da chamada.
  const texto = await textoDaResposta({
    success: true,
    pedidos: [{ id: 1, status_code: "APPROVED" }],
  });
  assert.equal(JSON.parse(texto).pedidos[0].status_code, "APPROVED");
});

test("estrutura profunda não trava a serialização", async () => {
  let profundo = { fim: true };
  for (let i = 0; i < 60; i += 1) profundo = { nivel: profundo };
  const texto = await textoDaResposta({ success: true, profundo });
  assert.ok(texto.length > 0);
  assert.ok(JSON.parse(texto).success);
});

test("o catálogo não carrega o campo redundante que o SDK injeta", async () => {
  // `execution: { taskSupport: "forbidden" }` é o padrão do próprio spec
  // quando o campo está ausente, e o cliente só reage a "required"/"optional".
  // Enviá-lo custa 40 caracteres por tool em toda resposta de tools/list.
  const { buildServer } = await import("../src/index.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const { server } = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);

  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    for (const t of tools) {
      assert.equal(t.execution, undefined, `${t.name} ainda carrega 'execution'`);
    }
    assert.doesNotMatch(JSON.stringify(tools), /taskSupport/);

    // E as tools continuam chamáveis — o campo não era necessário para isso.
    const r = await client.callTool({ name: "consultar_cota", arguments: {} });
    assert.ok(r.content?.[0]?.text, "a tool precisa continuar respondendo");
  } finally {
    await client.close();
  }
});
