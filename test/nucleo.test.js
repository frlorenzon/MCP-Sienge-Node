/**
 * Licenciamento, recorte por módulos e diagnóstico.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SIENGE_MCP_HOME = "/tmp/sienge-mcp-test";

const licensing = await import("../src/licensing.js");
const modules = await import("../src/modules.js");
const bills = await import("../src/apis/bills.js");

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// LICENCIAMENTO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

test("licença ausente é reportada, não aceita", () => {
  delete process.env.SIENGE_MCP_LICENSE_KEY;
  const s = licensing.checkLicense();
  assert.equal(s.valid, false);
  assert.match(s.reason, /não configurada/);
});

test("token malformado é rejeitado", () => {
  for (const token of ["", "semponto", ".", "abc.", ".xyz"]) {
    process.env.SIENGE_MCP_LICENSE_KEY = token;
    assert.equal(licensing.checkLicense().valid, false, `aceitou '${token}'`);
  }
});

test("licença assinada por outra chave é rejeitada", () => {
  // Um invasor que conheça o formato ainda não tem a chave privada correta.
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const payload = Buffer.from(
    JSON.stringify({ client_name: "Invasor", expires_at: "2099-12-31" })
  );
  const assinatura = crypto.sign(null, payload, privateKey);
  process.env.SIENGE_MCP_LICENSE_KEY = `${payload.toString("base64url")}.${assinatura.toString("base64url")}`;

  const s = licensing.checkLicense();
  assert.equal(s.valid, false);
  assert.match(s.reason, /assinatura inválida/);
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// MÓDULOS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

test("catálogo cobre as 105 tools sem repetição", () => {
  assert.equal(modules.TOOL_TAGS.size, 105);
  const total = Object.values(modules.toolCounts()).reduce((a, b) => a + b, 0);
  assert.equal(total, 105);
});

test("SIENGE_PROFILE sempre inclui o núcleo", () => {
  const { modulos } = modules.parseProfile("compras,financeiro");
  assert.ok(modulos.has("nucleo"), "núcleo é o caminho de volta para os outros módulos");
  assert.ok(modulos.has("compras"));
  assert.deepEqual([...modulos].sort(), ["compras", "financeiro", "nucleo"]);
});

test("sem perfil configurado, só o núcleo sobe", () => {
  // O padrão antigo — tudo visível — cobrava o catálogo inteiro de quem nunca
  // pediu por ele, e tornava as tools de carregamento decorativas.
  assert.deepEqual([...modules.parseProfile("").modulos], ["nucleo"]);
});

test("'all' pede explicitamente tudo, e aí nada é recortado", () => {
  assert.equal(modules.parseProfile("all").modulos, null);
  assert.equal(modules.parseProfile("tudo").modulos, null);
});

test("módulo desconhecido no perfil avisa e não derruba", () => {
  const { modulos, avisos } = modules.parseProfile("compras,inexistente");
  assert.ok(modulos.has("compras"));
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /inexistente/);
});

test("perfil só com lixo cai para 'todas', com aviso", () => {
  const { modulos, avisos } = modules.parseProfile("xpto,foo");
  assert.equal(modulos, null, "melhor tudo visível do que nada acessível");
  assert.ok(avisos.some((a) => /nenhum módulo válido/.test(a)));
});

test("tool fora do catálogo cai no núcleo", () => {
  assert.deepEqual([...modules.tagsFor("tool_que_nao_existe")], ["nucleo"]);
});

test("tool com tag cruzada pertence aos dois módulos", () => {
  const tags = modules.tagsFor("create_purchase_invoice_simple");
  assert.ok(tags.has("financeiro"));
  assert.ok(tags.has("compras"));
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// MÓDULOS ANUNCIADOS vs IMPLEMENTADOS
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/** Sobe o servidor em memória e devolve um cliente MCP conectado a ele. */
async function servidorEmMemoria() {
  const { buildServer } = await import("../src/index.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const { server } = buildServer();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);

  const call = async (name, args = {}) =>
    JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  return { client, call };
}

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// DESCOBERTA
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/** make_request falso: devolve o envelope que a camada HTTP produz. */
function requestFalso(data) {
  return async () => ({ success: true, data, latency_ms: 1, request_id: "t" });
}

test("buscarTitulos devolve os títulos sob a chave 'bills'", async () => {
  // Regressão: se buscarTitulos devolver os itens sob 'results' em vez de 'bills',
  // discovery não os encontra e a busca de títulos responde vazio COM
  // success: true — falha indistinguível de "não há títulos no período".
  const r = await bills.buscarTitulos(
    requestFalso({
      results: [{ billId: 1, documentNumber: "NF-001" }],
      resultSetMetadata: { count: 1 },
    }),
    { start_date: "2026-01-01", end_date: "2026-06-30" }
  );
  assert.equal(r.success, true);
  assert.equal(r.count, 1);
  assert.deepEqual(r.bills, [{ billId: 1, documentNumber: "NF-001" }]);
});


test("carregar_compras traz as tools do módulo e diz quantas", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const antes = (await client.listTools()).tools.length;
    const r = await call("carregar_compras");
    const depois = (await client.listTools()).tools.length;

    assert.equal(r.success, true);
    assert.equal(r.tools_disponiveis, depois - antes, "o número relatado precisa bater");
    assert.ok(r.modulos_carregados.includes("compras"));
  } finally {
    await client.close();
  }
});

test("carregar duas vezes é idempotente e avisa", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const n = (await client.listTools()).tools.length;
    const r = await call("carregar_compras");
    assert.equal(r.success, true);
    assert.equal(r.ja_estava_carregado, true);
    assert.equal((await client.listTools()).tools.length, n);
  } finally {
    await client.close();
  }
});

test("descarregar_modulos devolve o contexto das próximas mensagens", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const carregado = (await client.listTools()).tools.length;
    const r = await call("descarregar_modulos", { modulos: ["compras"] });
    const descarregado = (await client.listTools()).tools.length;

    assert.equal(r.success, true);
    assert.ok(descarregado < carregado, "as tools precisam sumir de tools/list");
    assert.ok(!r.modulos_carregados.includes("compras"));
  } finally {
    await client.close();
  }
});

test("o núcleo não pode ser descarregado", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("descarregar_modulos", { modulos: ["nucleo"] });
    assert.equal(r.success, false);
    assert.match(r.error, /permanente/);
  } finally {
    await client.close();
  }
});

test("descarregar_modulos recusa nome desconhecido", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("descarregar_modulos", { modulos: ["inventado"] });
    assert.equal(r.success, false);
    assert.match(r.error, /Módulo desconhecido/);
  } finally {
    await client.close();
  }
});

test("o modo profundo vem desligado, e some por inteiro do catálogo", async () => {
  // O padrão é a decisão: leitura de todos os endpoints com a credencial
  // configurada é acesso amplo demais para vir ligado sem ninguém escolher.
  const anterior = process.env.SIENGE_DEEP_MODE;
  delete process.env.SIENGE_DEEP_MODE;
  try {
    const { client } = await servidorEmMemoria();
    const nomes = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!nomes.includes("sienge_api_call"));
    assert.ok(!nomes.includes("sienge_api_endpoints"));
    await client.close();
  } finally {
    if (anterior !== undefined) process.env.SIENGE_DEEP_MODE = anterior;
  }
});

test("SIENGE_DEEP_MODE aceita as formas usuais de dizer sim", async () => {
  const anterior = process.env.SIENGE_DEEP_MODE;
  try {
    for (const valor of ["on", "true", "1", "sim", "ON"]) {
      process.env.SIENGE_DEEP_MODE = valor;
      const { client } = await servidorEmMemoria();
      const nomes = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(nomes.includes("sienge_api_call"), `'${valor}' devia habilitar`);
      await client.close();
    }
    for (const valor of ["off", "false", "0", "", "talvez"]) {
      process.env.SIENGE_DEEP_MODE = valor;
      const { client } = await servidorEmMemoria();
      const nomes = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(!nomes.includes("sienge_api_call"), `'${valor}' não devia habilitar`);
      await client.close();
    }
  } finally {
    if (anterior !== undefined) process.env.SIENGE_DEEP_MODE = anterior;
    else delete process.env.SIENGE_DEEP_MODE;
  }
});
