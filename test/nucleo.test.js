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

test("catálogo cobre todas as tools sem repetição", () => {
  // Sem número fixo: o que importa é que as duas contagens batam. Se uma tool
  // aparecesse em dois módulos, `toolCounts` a contaria duas vezes e o Map não.
  const total = Object.values(modules.toolCounts()).reduce((a, b) => a + b, 0);
  assert.equal(modules.TOOL_TAGS.size, total);
});

test("todo módulo que não é o núcleo tem carregador no catálogo", () => {
  // A garantia que o registro automático depende: o nome existe no catálogo e
  // pertence ao núcleo, senão o carregador sumiria junto com o módulo que ele
  // serve para carregar.
  const doNucleo = new Set(modules.toolsIn("nucleo"));
  for (const modulo of Object.keys(modules.MODULES)) {
    if (modulo === "nucleo") continue;
    const carregador = modules.nomeDoCarregador(modulo);
    assert.ok(doNucleo.has(carregador), `${carregador} fora do núcleo`);
    assert.deepEqual([...modules.tagsFor(carregador)], ["nucleo"]);
  }
});

test("módulo sem 'chamada' não passa da importação", () => {
  // O modo de falha que o registro automático poderia esconder: módulo com
  // tools, sem texto para o carregador, inalcançável em silêncio.
  for (const [nome, def] of Object.entries(modules.MODULES)) {
    if (nome === "nucleo") continue;
    assert.equal(typeof def.chamada, "string", `${nome} sem chamada`);
    assert.ok(def.chamada.length > 40, `${nome}: chamada curta demais para decidir`);
  }
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

test("perfil não reconhecido cai no padrão, não em 'tudo'", () => {
  // Um valor inválido é quase sempre erro de digitação de quem queria
  // restringir. Abrir o catálogo inteiro daria a esse engano mais acesso e
  // mais custo do que não configurar nada — falha na direção errada.
  const { modulos, avisos } = modules.parseProfile("xpto,foo");
  assert.deepEqual([...modulos], ["nucleo"]);
  assert.ok(avisos.some((a) => /nenhum módulo válido/.test(a)));
});

test("'minimal' e 'min' valem o mesmo que 'mínimo'", () => {
  // O projeto mistura nomes em português e inglês; quem escreve 'minimal'
  // está pedindo a mesma coisa. Antes caía em desconhecido e abria tudo.
  for (const alias of ["minimo", "mínimo", "minimal", "min", "minimum", "core", "nucleo"]) {
    assert.deepEqual([...modules.parseProfile(alias).modulos], ["nucleo"], `alias '${alias}'`);
  }
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
    const antes = (await client.listTools()).tools.map((t) => t.name);
    const r = await call("carregar_compras");
    const depois = (await client.listTools()).tools.map((t) => t.name);

    assert.equal(r.success, true);
    assert.ok(r.modulos_carregados.includes("compras"));

    // Toda tool anunciada na resposta precisa estar de fato em tools/list: é
    // pelos nomes que o modelo chama, sem depender de o cliente reindexar.
    for (const nome of r.tools) assert.ok(depois.includes(nome), `${nome} não apareceu`);

    // O que surgiu é o módulo, mais `descarregar_modulos` — que só passa a
    // existir agora que há algo a descarregar.
    const surgiram = depois.filter((n) => !antes.includes(n));
    assert.deepEqual(surgiram.sort(), [...r.tools, "descarregar_modulos"].sort());
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
    await call("carregar_compras");
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
    await call("carregar_compras");
    const r = await call("descarregar_modulos", { modulos: ["inventado"] });
    assert.equal(r.success, false);
    assert.match(r.error, /Módulo desconhecido/);
  } finally {
    await client.close();
  }
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// DESCARREGAR_MODULOS SÓ QUANDO HÁ O QUE DESCARREGAR
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

test("descarregar_modulos vai e volta conforme haja módulo carregado", async () => {
  const { client, call } = await servidorEmMemoria();
  const visivel = async () =>
    (await client.listTools()).tools.some((t) => t.name === "descarregar_modulos");
  try {
    assert.equal(await visivel(), false, "com só o núcleo, não há o que descarregar");
    await call("carregar_compras");
    assert.equal(await visivel(), true, "carregou um módulo: agora há");
    await call("descarregar_modulos", { modulos: ["compras"] });
    assert.equal(await visivel(), false, "voltou ao núcleo: some de novo");
  } finally {
    await client.close();
  }
});

test("descarregar_modulos desabilitada responde em vez de dar erro de protocolo", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("descarregar_modulos", { modulos: ["compras"] });
    assert.equal(r.success, false);
    assert.match(r.error, /Nada a descarregar/);
  } finally {
    await client.close();
  }
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// NOTIFICAÇÕES DE MUDANÇA DE CATÁLOGO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

/**
 * Conta as `tools/list_changed` que o cliente recebe. `enable()`/`disable()`
 * do SDK notificam mesmo quando o estado não muda, e um cliente que reage à
 * notificação refaz um `tools/list` por notificação recebida.
 */
async function contadorDeNotificacoes(client) {
  const { ToolListChangedNotificationSchema } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );
  const estado = { n: 0 };
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    estado.n += 1;
  });
  return estado;
}

test("recarregar um módulo já carregado não anuncia mudança nenhuma", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const contador = await contadorDeNotificacoes(client);
    await call("carregar_compras");
    // Deixa as notificações pendentes chegarem antes de conferir.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(contador.n, 0, "nada mudou de estado: não há o que anunciar");
  } finally {
    await client.close();
  }
});

test("descarregar anuncia só as tools que de fato saíram", async () => {
  // O descarregamento reafirma tudo o que continua carregado, para não derrubar
  // as tools de tag cruzada. Sem a guarda, essa reafirmação sozinha anunciava
  // uma mudança por tool do núcleo.
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const antes = (await client.listTools()).tools.length;
    const contador = await contadorDeNotificacoes(client);
    await call("descarregar_modulos", { modulos: ["compras"] });
    const depois = (await client.listTools()).tools.length;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(contador.n, antes - depois, "uma notificação por tool que saiu, e só");
  } finally {
    await client.close();
  }
});

// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
// TOOL FORA DO MÓDULO CARREGADO
// %%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

test("tool de módulo não carregado devolve o nome do carregador", async () => {
  // Sem isto o SDK responde `McpError: Tool ... disabled`, que não diz que a
  // tool existe nem como alcançá-la — beco sem saída no caminho mais provável.
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("compras_pedidos_para_aprovar", {});
    assert.equal(r.success, false);
    assert.equal(r.modulo, "compras");
    assert.equal(r.carregar_com, "carregar_compras");
  } finally {
    await client.close();
  }
});

test("a dica some assim que o módulo é carregado", async () => {
  // Depois do carregamento, a chamada precisa chegar no handler de verdade:
  // se o interceptador continuasse respondendo, a tool estaria inalcançável.
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const r = await call("compras_pedidos_para_aprovar", {});
    assert.equal(r.carregar_com, undefined, "não pode mais ser a dica");
  } finally {
    await client.close();
  }
});

test("tool inexistente continua caindo no erro do SDK", async () => {
  // Adivinhar um módulo para um nome inventado mandaria o modelo carregar algo
  // à toa; o "not found" do SDK já é exato.
  const { client } = await servidorEmMemoria();
  try {
    const r = await client.callTool({ name: "tool_que_nao_existe", arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /not found/);
  } finally {
    await client.close();
  }
});

test("tool prevista no catálogo mas não implementada se identifica como tal", async () => {
  // `compras_historico_preco_insumo` está em TOOLS_BY_MODULE e ainda não foi
  // registrada. Carregar o módulo não a traria — a resposta precisa dizer isso.
  const { client, call } = await servidorEmMemoria();
  try {
    await call("carregar_compras");
    const r = await call("compras_historico_preco_insumo", {});
    assert.equal(r.success, false);
    assert.match(r.error, /não existe nesta versão/);
    assert.equal(r.modulo_previsto, "compras");
    assert.equal(r.carregar_com, undefined);
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
    assert.ok(!nomes.includes("chamar_api"));
    assert.ok(!nomes.includes("listar_endpoints_api"));
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
      assert.ok(nomes.includes("chamar_api"), `'${valor}' devia habilitar`);
      await client.close();
    }
    for (const valor of ["off", "false", "0", "", "talvez"]) {
      process.env.SIENGE_DEEP_MODE = valor;
      const { client } = await servidorEmMemoria();
      const nomes = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(!nomes.includes("chamar_api"), `'${valor}' não devia habilitar`);
      await client.close();
    }
  } finally {
    if (anterior !== undefined) process.env.SIENGE_DEEP_MODE = anterior;
    else delete process.env.SIENGE_DEEP_MODE;
  }
});

test("explicar_processo_compras não recomenda tool que não existe", async () => {
  // O conhecimento foi escrito quando havia 131 tools; aqui há 9. Citar as
  // outras 37 fazia o modelo sair procurando o que o próprio servidor
  // prometeu e não tem — e insistir, porque a fonte era confiável.
  const { client, call } = await servidorEmMemoria();
  try {
    const existentes = new Set((await client.listTools()).tools.map((t) => t.name));
    const r = await call("explicar_processo_compras");

    const { registered } = await import("../src/registry.js");
    const todas = new Set(registered.keys());

    for (const etapa of r.etapas) {
      // `tools` são as chamáveis agora.
      for (const t of etapa.tools) {
        assert.ok(existentes.has(t), `etapa ${etapa.etapa} recomenda '${t}', não visível`);
      }
      // `tools_apos_carregar` existem, só estão atrás de um carregador.
      for (const t of etapa.tools_apos_carregar ?? []) {
        assert.ok(todas.has(t), `etapa ${etapa.etapa} promete '${t}', que não existe`);
        assert.match(etapa.como_habilitar, /carregar_/);
      }
      // Etapa sem caminho nenhum precisa dizer por onde ir, não sumir em silêncio.
      const alcancavel = etapa.tools.length + (etapa.tools_apos_carregar?.length ?? 0);
      if (alcancavel === 0) {
        assert.match(etapa.cobertura_mcp, /sem tool dedicada/);
        assert.match(etapa.como_fazer, /chamar_api|próprio Sienge/);
        assert.equal(etapa.por_onde_comecar, undefined, "apontaria para tool inexistente");
      }
    }
    assert.match(r.aviso_de_cobertura, /das \d+ etapas/);
  } finally {
    await client.close();
  }
});

test("cobertura declarada bate com o que está registrado", async () => {
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("explicar_processo_compras");
    for (const e of r.etapas) {
      const alcancavel = e.tools.length + (e.tools_apos_carregar?.length ?? 0);
      if (alcancavel > 0) {
        assert.notEqual(e.cobertura_mcp, "sem tool dedicada nesta versão");
      } else {
        assert.match(e.cobertura_mcp, /sem tool dedicada/);
      }
      // "completa" só quando todas as previstas são alcançáveis.
      if (e.cobertura_mcp === "completa") {
        assert.doesNotMatch(String(e.cobertura_mcp), /parcial/);
      }
    }
  } finally {
    await client.close();
  }
});

test("carregar_compras devolve os nomes, não só a contagem", async () => {
  // O servidor emite notifications/tools/list_changed, mas nem todo cliente
  // reindexa ao receber. Quando não reindexa, "2 tools carregadas" deixa o
  // modelo sem saber quais são e sem entender por que não as encontra.
  const { client, call } = await servidorEmMemoria();
  try {
    const r = await call("carregar_compras");
    assert.ok(Array.isArray(r.tools), "precisa devolver os nomes");
    assert.ok(r.tools.includes("compras_pedidos_para_aprovar"));

    // E os nomes precisam ser chamáveis de fato, não só listados.
    const visiveis = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const nome of r.tools) {
      assert.ok(visiveis.has(nome), `'${nome}' foi anunciado mas não está ativo`);
    }
    assert.match(r.como_usar, /chame-os pelo nome|SIENGE_PROFILE/);
  } finally {
    await client.close();
  }
});
