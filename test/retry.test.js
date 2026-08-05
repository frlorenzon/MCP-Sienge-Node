/**
 * A regra de retry é a que separa "resiliente" de "duplicou o título".
 * Estes testes existem porque o erro que ela previne não aparece em
 * desenvolvimento — só em produção, com rede ruim, e como uma nota fiscal
 * lançada duas vezes.
 */

import test from "node:test";
import assert from "node:assert/strict";

process.env.SIENGE_API_KEY = "chave-de-teste";
process.env.SIENGE_SUBDOMAIN = "empresa";
process.env.SIENGE_MCP_HOME = "/tmp/sienge-mcp-test";
process.env.REQUEST_TIMEOUT = "1";

const { makeSiengeRequest } = await import("../src/http/client.js");

/** Substitui o fetch global por um dublê que registra as chamadas. */
function comFetch(impl) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, init) => {
    chamadas.push({ url, init });
    return impl(chamadas.length, url, init);
  };
  return {
    chamadas,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

function respostaOk(body = { results: [] }) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Erro de conexão recusada — a requisição comprovadamente não foi entregue. */
function erroDeConexao() {
  const err = new TypeError("fetch failed");
  err.cause = { code: "ECONNREFUSED" };
  return err;
}

/** Reset em socket: pode ter acontecido depois de o servidor processar. */
function erroAmbiguo() {
  const err = new TypeError("fetch failed");
  err.cause = { code: "ECONNRESET" };
  return err;
}

test("POST não é repetido quando a falha é ambígua", async () => {
  const fake = comFetch(() => {
    throw erroAmbiguo();
  });
  try {
    const r = await makeSiengeRequest("POST", "/bills", { jsonData: { valor: 100 } });
    assert.equal(fake.chamadas.length, 1, "não pode ter repetido");
    assert.equal(r.success, false);
    assert.equal(r.error, "Ambiguous Failure");
    assert.match(r.message, /PODE ter sido aplicada/);
  } finally {
    fake.restaurar();
  }
});

test("POST é repetido quando a requisição não chegou a ser entregue", async () => {
  const fake = comFetch((n) => {
    if (n === 1) throw erroDeConexao();
    return respostaOk({ id: 7 });
  });
  try {
    const r = await makeSiengeRequest("POST", "/bills", {
      jsonData: { valor: 100 },
      maxAttempts: 2,
    });
    assert.equal(fake.chamadas.length, 2, "devia ter repetido uma vez");
    assert.equal(r.success, true);
    assert.deepEqual(r.data, { id: 7 });
  } finally {
    fake.restaurar();
  }
});

test("GET é repetido mesmo em falha ambígua", async () => {
  const fake = comFetch((n) => {
    if (n === 1) throw erroAmbiguo();
    return respostaOk({ results: [{ id: 1 }] });
  });
  try {
    const r = await makeSiengeRequest("GET", "/customers", { maxAttempts: 2 });
    assert.equal(fake.chamadas.length, 2);
    assert.equal(r.success, true);
  } finally {
    fake.restaurar();
  }
});

test("429 com cota esgotada não insiste", async () => {
  process.env.SIENGE_MCP_API_PACKAGE = "free";
  process.env.SIENGE_MCP_QUOTA_COUNTER = "/tmp/sienge-mcp-test/quota-esgotada.json";

  const apiQuota = await import("../src/utils/apiQuota.js");
  // Free = 100 REST/dia; estourar o teto faz o diagnóstico dizer "esgotada".
  apiQuota.registrar(apiQuota.REST, 200);

  const fake = comFetch(() => new Response("limite", { status: 429 }));
  try {
    const r = await makeSiengeRequest("GET", "/customers");
    assert.equal(fake.chamadas.length, 1, "cota esgotada: insistir é gasto de tempo");
    assert.equal(r.error, "HTTP 429");
    assert.match(r.message, /cota diária está esgotada/);
  } finally {
    fake.restaurar();
    delete process.env.SIENGE_MCP_API_PACKAGE;
    delete process.env.SIENGE_MCP_QUOTA_COUNTER;
  }
});

test("erro HTTP conhecido vira sugestão acionável", async () => {
  const fake = comFetch(
    () => new Response("O código da empresa é inválido", { status: 400 })
  );
  try {
    const r = await makeSiengeRequest("GET", "/customers");
    assert.equal(r.success, false);
    assert.equal(r.error_type, "INVALID_COMPANY_ID");
    assert.match(r.recommended_action, /get_sienge_projects/);
  } finally {
    fake.restaurar();
  }
});

test("204 devolve sucesso com data nula", async () => {
  const fake = comFetch(() => new Response(null, { status: 204 }));
  try {
    const r = await makeSiengeRequest("DELETE", "/bills/1");
    assert.equal(r.success, true);
    assert.equal(r.data, null);
  } finally {
    fake.restaurar();
  }
});

test("parâmetros nulos não viram query string", async () => {
  const fake = comFetch(() => respostaOk());
  try {
    await makeSiengeRequest("GET", "/customers", {
      params: { limit: 50, cpf: null, cnpj: undefined, onlyActive: false },
    });
    const url = fake.chamadas[0].url;
    assert.match(url, /limit=50/);
    assert.match(url, /onlyActive=false/, "false é filtro válido, não ausência");
    assert.doesNotMatch(url, /cpf/);
    assert.doesNotMatch(url, /cnpj/);
  } finally {
    fake.restaurar();
  }
});

test("sem credenciais, nem tenta a chamada", async () => {
  const key = process.env.SIENGE_API_KEY;
  delete process.env.SIENGE_API_KEY;
  const fake = comFetch(() => respostaOk());
  try {
    const r = await makeSiengeRequest("GET", "/customers");
    assert.equal(fake.chamadas.length, 0);
    assert.equal(r.error, "No Authentication");
  } finally {
    fake.restaurar();
    process.env.SIENGE_API_KEY = key;
  }
});
