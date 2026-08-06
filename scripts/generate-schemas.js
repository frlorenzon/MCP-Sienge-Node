#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Gerador de esqueletos de tool a partir do catálogo de referência.
 *
 * `contract/catalogo-tools.json` especifica as 130 tools deste servidor com
 * seus 540 parâmetros, defaults e descrições. Escrever os objetos Zod
 * correspondentes à mão seria trabalho mecânico repetido 130 vezes, e o tipo de
 * trabalho em que um default trocado passa despercebido.
 *
 * O que este script gera é um esqueleto: schema completo e descrição fiel, com
 * o handler marcado como TODO. A tradução do schema é mecânica e confiável; a
 * lógica do handler não é, e por isso não é adivinhada aqui.
 *
 *   node scripts/generate-schemas.js cadastros        # um módulo
 *   node scripts/generate-schemas.js cadastros --out src/tools/cadastros.js
 *   node scripts/generate-schemas.js --list           # módulos disponíveis
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogo = JSON.parse(
  fs.readFileSync(path.join(raiz, "contract/catalogo-tools.json"), "utf8")
);

const args = process.argv.slice(2);

if (args.includes("--list") || args.length === 0) {
  const porModulo = {};
  for (const t of catalogo) {
    for (const tag of t.tags ?? ["sem_modulo"]) (porModulo[tag] ??= []).push(t.name);
  }
  console.log("\nMódulos no catálogo:\n");
  for (const [modulo, nomes] of Object.entries(porModulo).sort()) {
    console.log(`  ${modulo.padEnd(14)} ${String(nomes.length).padStart(3)} tools`);
  }
  console.log("\nUso: node scripts/generate-schemas.js <modulo> [--out <arquivo>]\n");
  process.exit(0);
}

const modulo = args[0];
const outIdx = args.indexOf("--out");
const destino = outIdx >= 0 ? args[outIdx + 1] : null;

const alvo = catalogo.filter((t) => (t.tags ?? []).includes(modulo));
if (alvo.length === 0) {
  console.error(`Nenhuma tool com a tag '${modulo}'. Use --list para ver os módulos.`);
  process.exit(1);
}

/** Escapa uma string para literal JS entre aspas duplas. */
function lit(s) {
  return JSON.stringify(s ?? "");
}

/**
 * Traduz um JSON Schema de parâmetro para a expressão Zod equivalente.
 *
 * Opcionalidade chega como `anyOf: [T, null]`. `.nullish()` é o equivalente
 * exato: aceita o parâmetro ausente e aceita null explícito.
 */
function zodDe(def, obrigatorio) {
  let expr = base(def);

  const desc = (def.description ?? "").trim();
  if (desc) expr += `.describe(${lit(desc)})`;

  if (!obrigatorio) {
    const temDefault = def.default !== undefined && def.default !== null;
    if (temDefault) expr += `.default(${JSON.stringify(def.default)})`;
    else expr += ".nullish()";
  }
  return expr;
}

function base(def) {
  if (def.anyOf) {
    const naoNulos = def.anyOf.filter((v) => v.type !== "null");
    if (naoNulos.length === 1) return base(naoNulos[0]);
    return `z.union([${naoNulos.map(base).join(", ")}])`;
  }
  if (def.enum) return `z.enum([${def.enum.map(lit).join(", ")}])`;

  switch (def.type) {
    case "string":
      return "z.string()";
    case "integer":
      return "z.number().int()";
    case "number":
      return "z.number()";
    case "boolean":
      return "z.boolean()";
    case "array":
      return `z.array(${def.items ? base(def.items) : "z.any()"})`;
    case "object":
      return "z.record(z.string(), z.any())";
    default:
      return "z.any()";
  }
}

/** Reindenta a descrição como literal de várias linhas, legível no fonte. */
function descricaoLiteral(texto) {
  const linhas = (texto ?? "").split("\n");
  if (linhas.length === 1) return `      ${lit(linhas[0])},`;
  return linhas
    .map((l, i) => `      ${lit(i === linhas.length - 1 ? l : `${l}\n`)}${i === linhas.length - 1 ? "," : " +"}`)
    .join("\n");
}

const blocos = alvo.map((tool) => {
  const props = tool.inputSchema?.properties ?? {};
  const required = new Set(tool.inputSchema?.required ?? []);
  const nomes = Object.keys(props);

  const schema = nomes.length
    ? `    inputSchema: {\n${nomes
        .map((n) => `      ${n}: ${zodDe(props[n], required.has(n))},`)
        .join("\n")}\n    },\n`
    : "";

  const argsHandler = nomes.length ? `{ ${nomes.join(", ")} }` : "";

  return `  registerTool(server, {
    name: ${lit(tool.name)},
    description:
${descricaoLiteral(tool.description)}
${schema}    handler: async (${argsHandler}) => {
      // TODO: implementar — ver a especificação de ${tool.name} no catálogo
      throw new Error("${tool.name} ainda não implementada");
    },
  });`;
});

const saida = `/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Módulo '${modulo}' — ${alvo.length} tools.
 *
 * ⚠️ ESQUELETO GERADO por scripts/generate-schemas.js a partir do catálogo de
 * referência. Os schemas e as descrições estão prontos e conferem com a
 * especificação (\`npm run check\` verifica). Os handlers são TODO.
 */

import { z } from "zod";
import { registerTool } from "../registry.js";
import { makeSiengeRequest, makeSiengeBulkRequest } from "../http/client.js";
import { cacheGet, cacheSet } from "../http/cache.js";
import { fetchAllPaginated } from "../http/paginate.js";

export function registrar${modulo.charAt(0).toUpperCase() + modulo.slice(1).replace(/_(.)/g, (_, c) => c.toUpperCase())}(server) {
${blocos.join("\n\n")}
}
`;

if (destino) {
  const caminho = path.resolve(raiz, destino);
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, saida, "utf8");
  const params = alvo.reduce(
    (n, t) => n + Object.keys(t.inputSchema?.properties ?? {}).length,
    0
  );
  console.log(`✅ ${alvo.length} tools (${params} parâmetros) → ${destino}`);
} else {
  process.stdout.write(saida);
}
