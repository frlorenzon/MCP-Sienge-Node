#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Verificador de schemas contra o catálogo de referência.
 *
 * `contract/catalogo-tools.json` é a especificação das 131 tools deste
 * servidor: nome, descrição e schema de cada parâmetro. Este script sobe o
 * servidor em memória, pede `tools/list` e confere que o que está implementado
 * corresponde ao que o catálogo declara.
 *
 * Uma divergência aqui é uma tool que o modelo vai enxergar diferente do
 * especificado — um default que mudou, uma descrição que se perdeu, um
 * parâmetro que virou obrigatório sem querer. O tipo de defeito que não quebra
 * nenhum teste e muda todas as chamadas.
 *
 * O ponto: isto roda inteiramente offline, sem gastar uma única chamada da cota
 * diária da API do Sienge. O que ele não verifica é comportamento — para isso
 * são os testes com `fetch` dublado, em `test/`.
 *
 *   node scripts/check-schemas.js             # o que já está implementado
 *   node scripts/check-schemas.js --pendentes # lista também o que falta
 *   node scripts/check-schemas.js --sync      # grava as tools implementadas no catálogo
 *
 * `--sync` existe porque melhorar a descrição de uma tool é uma decisão
 * deliberada, e sem ele o catálogo passaria a acusar como divergência aquilo
 * que se acabou de decidir. Nunca roda sozinho: o padrão é sempre verificar, e
 * a sincronização é um ato explícito de quem sabe o que mudou.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Todas as tools precisam estar visíveis para serem conferidas, qualquer que
// seja a configuração de quem roda o script — inclusive o modo profundo, que
// vem desligado por padrão.
process.env.SIENGE_PROFILE = "all";
process.env.SIENGE_DEEP_MODE = "on";

const { buildServer } = await import(path.join(raiz, "src/index.js"));

const catalogo = JSON.parse(
  fs.readFileSync(path.join(raiz, "contract/catalogo-tools.json"), "utf8")
);
const porNome = new Map(catalogo.map((t) => [t.name, t]));

const { server } = buildServer();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "schema-check", version: "1.0.0" });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const { tools } = await client.listTools();

/** Normaliza um JSON Schema para comparação: só o que o modelo enxerga. */
function normalizarSchema(schema) {
  const props = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  return Object.fromEntries(
    Object.entries(props)
      .map(([nome, def]) => [
        nome,
        {
          tipo: tipoDe(def),
          obrigatorio: required.has(nome),
          default: def.default ?? null,
          description: (def.description ?? "").trim() || null,
        },
      ])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

/**
 * Reduz o schema de um parâmetro a um rótulo de tipo.
 *
 * Opcionalidade chega em duas formas — `anyOf: [{type:"string"},{type:"null"}]`
 * e `type: ["string","null"]`. São o mesmo contrato escrito de dois jeitos, e
 * ambas viram "string?": a comparação precisa acusar diferença de significado,
 * não de dialeto de JSON Schema.
 */
function tipoDe(def) {
  if (def.anyOf) {
    const naoNulos = def.anyOf.filter((v) => v.type !== "null");
    const sufixo = naoNulos.length < def.anyOf.length ? "?" : "";
    return `${naoNulos.map(tipoDe).join("|")}${sufixo}`;
  }
  if (Array.isArray(def.type)) {
    const naoNulos = def.type.filter((t) => t !== "null");
    const sufixo = naoNulos.length < def.type.length ? "?" : "";
    return `${naoNulos.map((t) => tipoDe({ ...def, type: t })).join("|")}${sufixo}`;
  }
  if (def.type === "array") return `array<${def.items ? tipoDe(def.items) : "any"}>`;
  if (def.enum) return `enum(${def.enum.join(",")})`;
  return def.type ?? "any";
}

const divergencias = [];
const conferidas = [];

for (const tool of tools) {
  const esperado = porNome.get(tool.name);
  if (!esperado) {
    divergencias.push({ tool: tool.name, campo: "existência", detalhe: "não está no catálogo" });
    continue;
  }

  const descEsperada = (esperado.description ?? "").trim();
  const descAtual = (tool.description ?? "").trim();
  if (descEsperada !== descAtual) {
    divergencias.push({
      tool: tool.name,
      campo: "description",
      detalhe: primeiraDiferenca(descEsperada, descAtual),
    });
  }

  const schemaEsperado = normalizarSchema(esperado.inputSchema);
  const schemaAtual = normalizarSchema(tool.inputSchema);
  const camposEsperados = new Set(Object.keys(schemaEsperado));
  const camposAtuais = new Set(Object.keys(schemaAtual));

  for (const campo of camposEsperados) {
    if (!camposAtuais.has(campo)) {
      divergencias.push({ tool: tool.name, campo, detalhe: "declarado no catálogo, ausente na tool" });
      continue;
    }
    const a = schemaEsperado[campo];
    const b = schemaAtual[campo];
    for (const prop of ["tipo", "obrigatorio", "default", "description"]) {
      if (JSON.stringify(a[prop]) !== JSON.stringify(b[prop])) {
        divergencias.push({
          tool: tool.name,
          campo: `${campo}.${prop}`,
          detalhe: `catálogo=${JSON.stringify(a[prop])} tool=${JSON.stringify(b[prop])}`,
        });
      }
    }
  }
  for (const campo of camposAtuais) {
    if (!camposEsperados.has(campo)) {
      divergencias.push({ tool: tool.name, campo, detalhe: "existe na tool, não no catálogo" });
    }
  }

  conferidas.push(tool.name);
}

function primeiraDiferenca(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return `divergem no caractere ${i}: catálogo…${JSON.stringify(a.slice(i, i + 40))} tool…${JSON.stringify(b.slice(i, i + 40))}`;
}

const implementadas = new Set(conferidas);
const pendentes = catalogo.filter((t) => !implementadas.has(t.name));

console.log(`\nVerificação de schemas — MCP Sienge Node`);
console.log(`${"─".repeat(60)}`);
console.log(`Tools no catálogo   : ${catalogo.length}`);
console.log(`Implementadas       : ${conferidas.length}`);
console.log(`Pendentes           : ${pendentes.length}`);
console.log(`Divergências        : ${divergencias.length}`);

if (divergencias.length) {
  console.log(`\n❌ Divergências:\n`);
  for (const d of divergencias) {
    console.log(`  ${d.tool} → ${d.campo}`);
    console.log(`     ${d.detalhe}`);
  }
}

if (process.argv.includes("--pendentes") && pendentes.length) {
  const porModulo = {};
  for (const t of pendentes) {
    const modulo = t.tags?.[0] ?? "sem_modulo";
    (porModulo[modulo] ??= []).push(t.name);
  }
  console.log(`\nPendentes por módulo:\n`);
  for (const [modulo, nomes] of Object.entries(porModulo).sort()) {
    console.log(`  ${modulo} (${nomes.length}):`);
    for (const n of nomes) console.log(`     ${n}`);
  }
}

if (process.argv.includes("--sync")) {
  // Sincroniza APENAS a descrição. O inputSchema fica como está de propósito:
  // é a especificação contra a qual o código é verificado, e sobrescrevê-lo
  // com o que o código produz transformaria a verificação numa tautologia —
  // um parâmetro que virasse obrigatório por engano passaria a ser "o
  // esperado". Descrição se melhora deliberadamente; schema, não se ajusta
  // sozinho.
  let alteradas = 0;
  const atualizado = catalogo.map((t) => {
    const viva = tools.find((x) => x.name === t.name);
    if (!viva || viva.description === t.description) return t;
    alteradas += 1;
    return { ...t, description: viva.description };
  });

  // Tool implementada que não está no catálogo é lacuna da especificação, não
  // do código — entra com o schema que o código produz, que aqui é a única
  // fonte que existe. Diferente de uma tool já especificada, cujo schema nunca
  // é sobrescrito.
  const { tagsFor } = await import(path.join(raiz, "src/modules.js"));
  const conhecidas = new Set(catalogo.map((t) => t.name));
  const novas = tools.filter((t) => !conhecidas.has(t.name));
  for (const t of novas) {
    atualizado.push({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      tags: [...tagsFor(t.name)].sort(),
    });
  }

  if (alteradas === 0 && novas.length === 0) {
    console.log(`\n📝 Nada a sincronizar: o catálogo já bate com o servidor.\n`);
  } else {
    fs.writeFileSync(
      path.join(raiz, "contract/catalogo-tools.json"),
      `${JSON.stringify(atualizado, null, 2)}\n`,
      "utf8"
    );
    const partes = [];
    if (alteradas) partes.push(`${alteradas} descrição(ões) atualizada(s)`);
    if (novas.length) partes.push(`${novas.length} tool(s) nova(s): ${novas.map((t) => t.name).join(", ")}`);
    console.log(`\n📝 Catálogo sincronizado: ${partes.join("; ")}.\n`);
  }
  await client.close();
  process.exit(0);
}

if (!divergencias.length) {
  console.log(`\n✅ As ${conferidas.length} tools implementadas batem com o catálogo.`);
}
console.log();

await client.close();
process.exit(divergencias.length ? 1 : 0);
