#!/usr/bin/env node
/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Monta `contract/endpoints.json` a partir do que os módulos de `src/apis/`
 * declaram em `ENDPOINTS`.
 *
 * O inventário existe para `sienge_api_endpoints` responder qual é o path de
 * um recurso sem que o modelo precise adivinhar — e para que a resposta de um
 * 404 possa sugerir o endpoint correto. Nasce do mesmo arquivo que faz as
 * chamadas, então não tem como envelhecer sozinho: `npm test` falha se um
 * módulo chamar um path que não declarou, ou se este arquivo ficar para trás.
 *
 *   node scripts/build-endpoints.js          # grava o inventário
 *   node scripts/build-endpoints.js --check  # só verifica se está atualizado
 */

import fs from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirApis = path.join(raiz, "src/apis");
const destino = path.join(raiz, "contract/endpoints.json");

/** Lê os módulos de recurso — `_helpers.js` e afins ficam de fora. */
export async function coletarEndpoints() {
  const arquivos = fs
    .readdirSync(dirApis)
    .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
    .sort();

  const inventario = {};
  for (const arquivo of arquivos) {
    const mod = await import(path.join(dirApis, arquivo));
    if (!mod.ENDPOINTS || !mod.RECURSO) continue;
    inventario[mod.RECURSO.replace(/^\//, "")] = {
      arquivo: `src/apis/${arquivo}`,
      endpoints: [...mod.ENDPOINTS].sort(),
    };
  }
  return inventario;
}

/** Serialização canônica — é o que o teste de atualização compara. */
export function serializar(inventario) {
  return `${JSON.stringify(inventario, null, 2)}\n`;
}

async function main() {
  const inventario = await coletarEndpoints();
  const conteudo = serializar(inventario);
  const recursos = Object.keys(inventario).length;
  const total = Object.values(inventario).reduce((n, r) => n + r.endpoints.length, 0);

  if (process.argv.includes("--check")) {
    const atual = fs.existsSync(destino) ? fs.readFileSync(destino, "utf8") : "";
    if (atual !== conteudo) {
      console.error(
        "❌ contract/endpoints.json está desatualizado. Rode: node scripts/build-endpoints.js"
      );
      process.exit(1);
    }
    console.log(`✅ Inventário atualizado: ${recursos} recursos, ${total} endpoints.`);
    return;
  }

  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, conteudo, "utf8");
  console.log(`✅ ${recursos} recursos, ${total} endpoints → contract/endpoints.json`);
}

/**
 * Só executa quando invocado como script. Importar este módulo — o teste faz
 * isso, para comparar o inventário gerado com o gravado — não pode gravar
 * nada: um build disparado por import faria o teste corrigir em silêncio
 * exatamente aquilo que ele existe para acusar.
 */
function executadoDiretamente() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (executadoDiretamente()) await main();
