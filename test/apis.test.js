/**
 * O inventário de endpoints.
 *
 * `sienge_api_endpoints` responde qual é o path de um recurso, e um 404 de
 * `sienge_api_call` sugere os endpoints conhecidos. As duas coisas só valem se
 * o inventário refletir o que os módulos de `src/apis/` realmente chamam — um
 * inventário desatualizado é pior que nenhum, porque o modelo confia nele.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dirApis = path.join(raiz, "src/apis");

const arquivos = fs
  .readdirSync(dirApis)
  .filter((f) => f.endsWith(".js") && !f.startsWith("_"));

/**
 * Extrai os paths que um módulo de fato chama, do texto do arquivo.
 *
 * Casa `makeRequest("GET", RECURSO)` e as formas com template literal, e
 * normaliza cada interpolação para `{id}` — que é como o inventário os declara.
 */
function pathsChamados(fonte, recurso) {
  const chamadas = [];
  const re = /makeRequest\(\s*"(GET|POST|PUT|PATCH|DELETE)",\s*(`[^`]*`|RECURSO|"[^"]*")/g;
  for (const [, metodo, alvo] of fonte.matchAll(re)) {
    let p;
    if (alvo === "RECURSO") p = recurso;
    else if (alvo.startsWith('"')) p = alvo.slice(1, -1);
    else p = alvo.slice(1, -1).replace(/\$\{RECURSO\}/g, recurso).replace(/\$\{[^}]+\}/g, "{id}");
    chamadas.push(`${metodo} ${p}`);
  }
  return chamadas;
}

/** `{qualquerCoisa}` → `{id}`: o inventário nomeia os parâmetros, o código não. */
function assinatura(endpoint) {
  return endpoint.replace(/\{[^}]+\}/g, "{id}");
}

for (const arquivo of arquivos) {
  test(`${arquivo}: todo path chamado está declarado em ENDPOINTS`, async () => {
    const mod = await import(path.join(dirApis, arquivo));
    assert.ok(mod.RECURSO, `${arquivo} precisa exportar RECURSO`);
    assert.ok(Array.isArray(mod.ENDPOINTS), `${arquivo} precisa exportar ENDPOINTS`);

    const declarados = new Set(mod.ENDPOINTS.map(assinatura));
    const fonte = fs.readFileSync(path.join(dirApis, arquivo), "utf8");

    for (const chamado of pathsChamados(fonte, mod.RECURSO)) {
      assert.ok(
        declarados.has(assinatura(chamado)),
        `${arquivo} chama '${chamado}' mas não o declara em ENDPOINTS — ` +
          "o inventário ficaria mentindo para o modelo"
      );
    }
  });

  test(`${arquivo}: endpoints declarados pertencem ao recurso`, async () => {
    const mod = await import(path.join(dirApis, arquivo));
    for (const e of mod.ENDPOINTS) {
      const [metodo, p] = e.split(" ");
      assert.match(metodo, /^(GET|POST|PUT|PATCH|DELETE)$/, `método inválido em '${e}'`);
      assert.ok(
        p.startsWith(mod.RECURSO),
        `'${e}' não pertence a ${mod.RECURSO} — estaria no arquivo errado`
      );
    }
  });
}

test("contract/endpoints.json está atualizado", async () => {
  // O inventário é gerado; se alguém editar um módulo e esquecer de rodar o
  // build, este teste falha antes de o modelo receber um path que não existe.
  const { coletarEndpoints } = await import("../scripts/build-endpoints.js");
  const gerado = await coletarEndpoints();
  const gravado = JSON.parse(
    fs.readFileSync(path.join(raiz, "contract/endpoints.json"), "utf8")
  );
  assert.deepEqual(
    gravado,
    gerado,
    "rode: node scripts/build-endpoints.js"
  );
});
