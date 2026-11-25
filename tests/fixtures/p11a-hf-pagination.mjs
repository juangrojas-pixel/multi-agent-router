import { appendFileSync } from "node:fs";

const fetchReal = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  const url = new URL(input);
  if (url.hostname !== "datasets-server.huggingface.co") return fetchReal(input, ...args);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const length = Number(url.searchParams.get("length"));
  const total = Number(url.searchParams.get("total"));
  appendFileSync(process.env.P11A_HF_REQUESTS, `${url.pathname} ${offset} ${length}\n`);
  if (length !== 1 || url.searchParams.get("where") !== "coding" || offset >= total) return Response.json({}, { status: 400 });
  return Response.json({ num_rows_total: total, rows: [{ row: {
    model_name: "Gemini 4 Neon (High)", category: "coding", rank: offset === total - 1 ? 2 : 9,
    rating: 1500, leaderboard_publish_date: "2026-11-22",
  } }] });
};
