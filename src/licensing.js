/**
 * SPDX-FileCopyrightText: © 2026 Felipe Ribeiro Lorenzon
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 *
 * Validação de licença offline via assinatura Ed25519.
 *
 * Não bloqueia a execução das tools: apenas informa se a licença configurada
 * em SIENGE_MCP_LICENSE_KEY é válida, para que o resultado de cada chamada
 * possa carregar um aviso quando não for. A chave abaixo é pública -- serve só
 * para VERIFICAR assinaturas, nunca para emitir novas licenças (isso exige a
 * chave privada, mantida fora deste repositório).
 *
 * `node:crypto` verifica Ed25519 nativamente — passar `null` como algoritmo em
 * crypto.verify é o que seleciona a verificação pura de Ed25519, sem hash
 * prévio. Nenhuma dependência externa entra por causa disto.
 */

import crypto from "node:crypto";

export const LICENSE_ENV_VAR = "SIENGE_MCP_LICENSE_KEY";

const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEASlocwjxFe0rLV/Nv6kRDD1y3IX7pAGj779TtN+orjNY=
-----END PUBLIC KEY-----
`;

const publicKey = crypto.createPublicKey(PUBLIC_KEY_PEM);

/**
 * @typedef {object} LicenseStatus
 * @property {boolean} valid
 * @property {string} reason
 * @property {string|null} [client_name]
 * @property {string|null} [expires_at]
 */

function status(valid, reason, clientName = null, expiresAt = null) {
  return { valid, reason, client_name: clientName, expires_at: expiresAt };
}

/** Data local em YYYY-MM-DD, para comparar com `expires_at` sem passar por UTC. */
function hojeISO() {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, "0");
  const dia = String(agora.getDate()).padStart(2, "0");
  return `${agora.getFullYear()}-${mes}-${dia}`;
}

function decodeToken(token) {
  const sep = token.indexOf(".");
  if (sep <= 0 || sep === token.length - 1) {
    throw new Error("token de licença malformado");
  }
  // Buffer aceita base64url e já tolera a ausência do padding "=", que o
  // emissor de licenças remove.
  const payload = Buffer.from(token.slice(0, sep), "base64url");
  const signature = Buffer.from(token.slice(sep + 1), "base64url");
  if (payload.length === 0 || signature.length === 0) {
    throw new Error("token de licença malformado");
  }
  return { payload, signature };
}

function verifyToken(token) {
  let payload;
  try {
    const decoded = decodeToken(token);
    if (!crypto.verify(null, decoded.payload, publicKey, decoded.signature)) {
      return status(false, "assinatura inválida ou token corrompido");
    }
    payload = JSON.parse(decoded.payload.toString("utf8"));
  } catch {
    return status(false, "assinatura inválida ou token corrompido");
  }

  const clientName = payload.client_name ?? null;
  const expiresAt = payload.expires_at ?? null;

  if (expiresAt) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) {
      return status(false, "data de expiração ilegível na licença", clientName, expiresAt);
    }
    if (expiresAt < hojeISO()) {
      return status(false, `licença expirada em ${expiresAt}`, clientName, expiresAt);
    }
  }

  return status(true, "licença válida", clientName, expiresAt);
}

/** Lê e valida SIENGE_MCP_LICENSE_KEY do ambiente. Roda inteiramente offline. */
export function checkLicense() {
  const token = (process.env[LICENSE_ENV_VAR] || "").trim();
  if (!token) return status(false, `variável ${LICENSE_ENV_VAR} não configurada`);
  return verifyToken(token);
}

let cachedStatus = null;

/** Mesmo resultado de checkLicense(), computado uma vez e reaproveitado no processo. */
export function getLicenseStatus() {
  if (cachedStatus === null) cachedStatus = checkLicense();
  return cachedStatus;
}
