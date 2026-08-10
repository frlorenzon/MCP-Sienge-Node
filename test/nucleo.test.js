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

test("catálogo cobre as 106 tools sem repetição", () => {
  assert.equal(modules.TOOL_TAGS.size, 106);
  const total = Object.values(modules.toolCounts()).reduce((a, b) => a + b, 0);
  assert.equal(total, 106);
});

test("SIENGE_PROFILE sempre inclui o núcleo", () => {
  const { modulos } = modules.parseProfile("compras,financeiro");
  assert.ok(modulos.has("nucleo"), "núcleo é o caminho de volta para os outros módulos");
  assert.ok(modulos.has("compras"));
  assert.deepEqual([...modulos].sort(), ["compras", "financeiro", "nucleo"]);
});

test("perfil vazio ou 'all' não recorta nada", () => {
  assert.equal(modules.parseProfile("").modulos, null);
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

test("list_sienge_modules só anuncia módulos que têm tools", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("list_sienge_modules");
    for (const m of r.modulos) {
      assert.ok(m.tools > 0, `módulo '${m.modulo}' anunciado com ${m.tools} tools`);
    }
    // O que está no catálogo mas não implementado precisa aparecer como
    // previsto, e não some da resposta — some da lista de carregáveis.
    assert.ok(r.modulos_previstos.includes("titulos"));
    assert.match(r.aviso_de_versao, /não têm tools/);
  } finally {
    await client.close();
  }
});

test("enable_sienge_modules recusa módulo sem tools em vez de mentir", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const antes = (await client.listTools()).tools.length;
    const r = await call("enable_sienge_modules", { modules: ["titulos"] });
    const depois = (await client.listTools()).tools.length;

    assert.equal(r.success, false, "carregar módulo vazio não pode reportar sucesso");
    assert.match(r.error, /não disponível nesta versão/);
    assert.equal(depois, antes, "nenhuma tool devia ter aparecido");
  } finally {
    await client.close();
  }
});

test("enable_sienge_modules ainda recusa módulo inexistente", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("enable_sienge_modules", { modules: ["inventado"] });
    assert.equal(r.success, false);
    assert.match(r.error, /Módulo desconhecido/);
  } finally {
    await client.close();
  }
});

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

