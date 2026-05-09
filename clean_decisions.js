#!/usr/bin/env node
/*
 * clean_decisions.js — send user_decisions.jsonl through Adaption Labs and
 * write user_decisions_cleaned.jsonl back next to it.
 *
 * Pipeline: initiate dataset -> PUT to presigned S3 -> complete -> wait for
 * ingestion -> run(deduplication) -> poll -> download.
 *
 * Usage:  ADAPTION_API_KEY=... node clean_decisions.js [in.jsonl] [out.jsonl]
 * Defaults to ../llm-proxy/user_decisions{,_cleaned}.jsonl
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = process.env.ADAPTION_BASE_URL || "https://api.adaptionlabs.ai";
const KEY = process.env.ADAPTION_API_KEY;
if (!KEY) { console.error("ADAPTION_API_KEY not set"); process.exit(1); }

const IN = path.resolve(process.argv[2] || "../llm-proxy/user_decisions.jsonl");
const OUT = path.resolve(process.argv[3] || "../llm-proxy/user_decisions_cleaned.jsonl");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, extraHeaders = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const bytes = fs.readFileSync(IN);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  console.log(`→ ${IN}  (${bytes.length} bytes, ${bytes.toString().split("\n").filter(Boolean).length} rows)`);

  // 1. create dataset (returns presigned PUT URL)
  const created = await api("POST", "/api/v1/datasets", {
    source: { type: "file", file_format: "jsonl", name: "user-decisions" },
  });
  const id = created.dataset_id;
  const url = created.upload_instructions?.url;
  if (!url) throw new Error("no upload_instructions.url");
  console.log(`  dataset ${id}`);

  // 2. PUT bytes to S3
  const put = await fetch(url, { method: "PUT", body: bytes });
  if (!put.ok) throw new Error(`S3 PUT ${put.status}`);

  // 3. complete upload
  await api("POST", `/api/v1/datasets/${id}/upload/complete`, {
    file_size_bytes: bytes.length,
    sha256,
  });

  // 4. wait for ingestion
  for (let i = 0; i < 60; i++) {
    const s = await api("GET", `/api/v1/datasets/${id}/status`);
    if (s.row_count != null) { console.log(`  ingested ${s.row_count} rows`); break; }
    process.stdout.write(`  ingesting... ${s.status}\r`);
    await sleep(2000);
  }

  // 5. run — recipes omitted, Adaption uses backend defaults
  const run = await api("POST", `/api/v1/datasets/${id}/run`, {
    column_mapping: { prompt: "offending_text", completion: "decision" },
    estimate: false,
  });
  console.log(`  run ${run.run_id}`);

  // 6. poll
  let status;
  for (let i = 0; i < 180; i++) {
    const s = await api("GET", `/api/v1/datasets/${id}/status`);
    status = s.status;
    process.stdout.write(`  ${status}${s.progress ? ` ${s.progress.percent}%` : ""}            \r`);
    if (status === "succeeded" || status === "failed") break;
    await sleep(5000);
  }
  console.log();
  if (status !== "succeeded") throw new Error(`run ended: ${status}`);

  // 7. download
  const dl = await api("GET", `/api/v1/datasets/${id}/download?file_format=jsonl`);
  let body;
  if (typeof dl === "string") {
    body = dl;
  } else if (dl?.url) {
    body = await (await fetch(dl.url)).text();
  } else if (dl?.content) {
    body = dl.content;
  } else {
    body = JSON.stringify(dl);
  }

  fs.writeFileSync(OUT, body);
  const rows = body.split("\n").filter(Boolean).length;
  console.log(`← ${OUT}  (${body.length} bytes, ${rows} rows)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

