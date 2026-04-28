import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

const RAPIDAPI_KEY = "cb9f880eb0msh44fbd81653f2599p1c0334jsn4e930ea2c8c9";

const app = express();
app.use(cors());

// --- DB SETUP ---
const db = await open({
  filename: "./lotto.db",
  driver: sqlite3.Database
});

await db.exec(`
CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  game TEXT,
  numbers TEXT,
  date TEXT
)
`);

// --- FETCH REAL DATA (Ontario Lotto Max) ---
async function fetchLatestResults() {
  const today = "2026-04-25"; // last Lotto Max draw date

  const url = `https://canada-lottery.p.rapidapi.com/lottomax/results/${today}/regions/ontario`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "x-rapidapi-host": "canada-lottery.p.rapidapi.com",
        "x-rapidapi-key": RAPIDAPI_KEY
      }
    });

    const data = await res.json();

    return {
      lottoMax: {
        numbers: data?.draw?.numbers || [],
        jackpot: data?.draw?.jackpot || 0,
        date: today
      }
    };
  } catch (err) {
    console.log("API ERROR:", err);

    // fallback if API fails
    return {
      lottoMax: {
        numbers: [],
        jackpot: 0,
        date: today
      }
    };
  }
}

// --- STORE DATA (avoid duplicates) ---
async function storeDraw(game, numbers) {
  if (!numbers || numbers.length === 0) return;

  const exists = await db.get(
    "SELECT * FROM draws WHERE game=? AND numbers=?",
    [game, JSON.stringify(numbers)]
  );

  if (!exists) {
    await db.run(
      "INSERT INTO draws (game, numbers, date) VALUES (?, ?, datetime('now'))",
      [game, JSON.stringify(numbers)]
    );
  }
}

// --- LOAD HISTORY ---
async function getHistory(game) {
  const rows = await db.all(
    "SELECT numbers FROM draws WHERE game = ? ORDER BY id DESC LIMIT 500",
    [game]
  );
  return rows.map(r => JSON.parse(r.numbers));
}

// --- BUILD WEIGHTS ---
function buildWeights(history, maxNumber) {
  let freq = {};
  for (let i = 1; i <= maxNumber; i++) freq[i] = 0;

  history.forEach((draw, idx) => {
    const weight = 1 + (idx / history.length);
    draw.forEach(n => freq[n] += weight);
  });

  return freq;
}

// --- ANTI-CROWD ---
function antiCrowd(line) {
  let score = 0;

  if (line.filter(n => n <= 31).length > 4) score -= 15;
  score -= line.filter(n => n % 5 === 0).length * 2;

  for (let i = 0; i < line.length - 1; i++) {
    if (line[i] + 1 === line[i + 1]) score -= 4;
  }

  return score;
}

// --- DISTRIBUTION ---
function distribution(line) {
  let odd = line.filter(n => n % 2).length;
  let low = line.filter(n => n <= 25).length;

  let score = 0;
  if (odd >= 3 && odd <= 4) score += 10;
  if (low >= 3 && low <= 4) score += 10;

  return score;
}

// --- WEIGHTED PICK ---
function weightedPick(weights, pickCount) {
  let pool = [];

  for (let n in weights) {
    for (let i = 0; i < Math.floor(weights[n]); i++) {
      pool.push(Number(n));
    }
  }

  let line = [];
  while (line.length < pickCount) {
    let pick = pool[Math.floor(Math.random() * pool.length)];
    if (!line.includes(pick)) line.push(pick);
  }

  return line.sort((a, b) => a - b);
}

// --- GENERATOR ---
async function generate(game) {
  const config = {
    max: 50,
    pick: 7
  };

  const history = await getHistory("max");
  const weights = buildWeights(history, config.max);

  let candidates = [];

  for (let i = 0; i < 20000; i++) {
    let line = weightedPick(weights, config.pick);

    let score =
      distribution(line) * 0.4 +
      antiCrowd(line) * 0.4 +
      Math.random() * 5;

    candidates.push({ line, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, 5);
}

// --- API ROUTES ---

// Generate smart lines
app.get("/generate", async (req, res) => {
  const lines = await generate();
  res.json(lines);
});

// Get results + history
app.get("/results", async (req, res) => {
  const data = await fetchLatestResults();
console.log("API RESPONSE:", JSON.stringify(data, null, 2));
  await storeDraw("max", data.lottoMax.numbers);

  const last5 = await db.all(
    "SELECT numbers, date FROM draws WHERE game='max' ORDER BY id DESC LIMIT 5"
  );

  res.json({
    latest: data.lottoMax,
    history: last5.map(r => ({
      numbers: JSON.parse(r.numbers),
      date: r.date
    }))
  });
});

app.listen(3001, () => console.log("Server running on port 3001"));
