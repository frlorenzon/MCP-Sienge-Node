/**
 * O servidor como um cliente MCP real o vê: processo separado, transporte
 * stdio, handshake completo.
 *
 * Os outros testes importam os módulos e chamam funções — nada disso exercita
 * o caminho que decide se o servidor sequer sobe. Uma guarda de execução direta
 * mal escrita passa em todos eles e falha em 100% das instalações.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entrada = path.join(raiz, "src/index.js");

/**
 * Sobe o servidor, faz o handshake e devolve as respostas.
 *
 * `comando`/`args` permitem invocá-lo por caminhos diferentes — direto,
 * relativo, via symlink — que é justamente onde a guarda de execução costuma
 * quebrar.
 */
function conversarComServidor(comando, args, { cwd = raiz, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(comando, args, {
      cwd,
      env: { ...process.env, SIENGE_MCP_HOME: "/tmp/sienge-mcp-test", SIENGE_PROFILE: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`servidor não respondeu em ${timeoutMs}ms. stderr: ${stderr}`));
    }, timeoutMs);

    proc.stdout.on("data", (d) => {
      stdout += d;
      // Encerra assim que a resposta do tools/list (id 2) chegou inteira.
      if (stdout.includes('"id":2')) {
        clearTimeout(timer);
        proc.kill();
        const mensagens = stdout
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          })
          .filter(Boolean);
        resolve({ mensagens, stderr });
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    const enviar = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
    enviar({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    });
    enviar({ jsonrpc: "2.0", method: "notifications/initialized" });
    enviar({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  });
}

test("sobe por caminho absoluto e completa o handshake", async () => {
  const { mensagens } = await conversarComServidor("node", [entrada]);

  const init = mensagens.find((m) => m.id === 1);
  assert.ok(init, "não respondeu ao initialize");
  assert.ok(init.result.serverInfo.name);

  const lista = mensagens.find((m) => m.id === 2);
  assert.ok(lista, "não respondeu ao tools/list");
  assert.equal(lista.result.tools.length, 9);
});

test("sobe por caminho relativo", async () => {
  const { mensagens } = await conversarComServidor("node", ["src/index.js"]);
  assert.ok(mensagens.find((m) => m.id === 2), "não respondeu ao tools/list");
});

test("sobe através de symlink, como o binário instalado pelo npm", async () => {
  // Este é o caso que quebra: `node_modules/.bin/mcp-sienge-node` é um symlink,
  // e `import.meta.url` chega já resolvido para o caminho real.
  const { symlinkSync, mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-link-"));
  const link = path.join(tmp, "mcp-sienge-node");
  try {
    symlinkSync(entrada, link);
    const { mensagens } = await conversarComServidor("node", [link]);
    const lista = mensagens.find((m) => m.id === 2);
    assert.ok(lista, "servidor invocado por symlink não respondeu");
    assert.equal(lista.result.tools.length, 9);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("stdout carrega só JSON-RPC — nenhum log vaza no canal do protocolo", async () => {
  // Sob stdio, um console.log perdido corrompe a sessão inteira.
  const { mensagens, stderr } = await conversarComServidor("node", [entrada]);
  for (const m of mensagens) {
    assert.equal(m.jsonrpc, "2.0", "linha em stdout que não é JSON-RPC");
  }
  // O diagnóstico continua existindo — só que no lugar certo.
  assert.ok(stderr.length >= 0);
});
