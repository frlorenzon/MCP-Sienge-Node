import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// Módulos que podem ser carregados sob demanda. O núcleo não entra aqui —
// ele é carregado à parte, sempre, e nunca é descarregado.
const MODULOS = {
  compras: {
    resumo: "cotações, pedidos de compra, fornecedores",
    carregar: () => import("./modules/purchase.js").then((m) => m.purchaseModule),
  },
  financeiro: {
    resumo: "contas a pagar e a receber, boletos, fluxo de caixa",
    carregar: () => import("./modules/financial.js").then((m) => m.financialModule),
  },
};

function ok(resultado) {
  return { content: [{ type: "text", text: JSON.stringify(resultado) }] };
}

export async function setupToolsGroupRouter(server) {
  const { coreModule } = await import("./modules/core.js");
  const carregados = new Map(); // nome do módulo -> módulo carregado

  // SIENGE_PROFILE="compras,financeiro" pré-carrega módulos na subida, antes
  // do primeiro tools/list — contorna o bug do Claude Desktop em que uma tool
  // que só aparece via list_changed no meio da conversa fica sem handler.
  const perfil = (process.env.SIENGE_PROFILE || "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const nome of perfil) {
    if (!MODULOS[nome]) {
      console.error(`[sienge] SIENGE_PROFILE ignorou '${nome}': módulo não existe.`);
      continue;
    }
    carregados.set(nome, await MODULOS[nome].carregar());
  }

  function handlerDaTool(nome) {
    if (coreModule.handlers[nome]) return coreModule.handlers[nome];
    for (const modulo of carregados.values()) {
      if (modulo.handlers[nome]) return modulo.handlers[nome];
    }
    return null;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [...coreModule.tools];

    for (const modulo of carregados.values()) tools.push(...modulo.tools);

    for (const [nome, spec] of Object.entries(MODULOS)) {
      if (carregados.has(nome)) continue;
      tools.push({
        name: `carregar_${nome}`,
        description: `Carrega as ferramentas de ${nome}: ${spec.resumo}.`,
        inputSchema: { type: "object", properties: {} },
      });
    }

    if (carregados.size > 0) {
      tools.push({
        name: "descarregar_modulos",
        description: "Libera do contexto as ferramentas dos módulos carregados.",
        inputSchema: { type: "object", properties: {} },
      });
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    if (name.startsWith("carregar_")) {
      const alvo = name.slice("carregar_".length);
      const spec = MODULOS[alvo];
      if (!spec) return ok({ success: false, message: `módulo '${alvo}' não existe` });

      if (!carregados.has(alvo)) {
        carregados.set(alvo, await spec.carregar());
        await server.notification({ method: "notifications/tools/list_changed" });
      }

      return ok({
        success: true,
        modulo: alvo,
        ferramentas: carregados.get(alvo).tools.map((t) => t.name),
      });
    }

    if (name === "descarregar_modulos") {
      carregados.clear();
      await server.notification({ method: "notifications/tools/list_changed" });
      return ok({ success: true });
    }

    const handler = handlerDaTool(name);
    if (!handler) return ok({ success: false, message: `tool '${name}' não encontrada` });

    return ok(await handler(args));
  });
}
