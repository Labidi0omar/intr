// Apply score / movement / isPrimary from info/exercise-ranking.md to every
// catalog entry in src/constants/exercises.ts. Read the doc table, build a
// name→{score,movement,isPrimary} map, then rewrite the catalog file.
//
// Combined rows like "Pull-Up / Wide Grip Pull-Up" expand to both names.
// "Tricep Dips (gym)" / "Tricep Dips (home)" disambiguate by location:
// when the catalog entry's name is "Tricep Dips", pick the one whose
// `loc` matches the catalog entry's location.
//
// Catalog exercises not found in the doc → score=60, movement derived via
// classifyCompoundness, isPrimary=false. They're listed in stdout.

const fs = require('fs');
const path = require('path');

const RANKING_PATH = path.join(__dirname, '..', 'info', 'exercise-ranking.md');
const CATALOG_PATH = path.join(__dirname, '..', 'src', 'constants', 'exercises.ts');

const raw = fs.readFileSync(RANKING_PATH, 'utf8');

// ── Parse markdown tables ──────────────────────────────────────────────
// Each section header is `## <muscle>`. Tables under it use
// `| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |`.
//
// We don't need eff/pop separately — `score` is precomputed in the doc.

const lines = raw.split('\n');
/** name (lowercased) → { score, movement, isPrimary, loc?, equip? } */
const byName = new Map();

function normalize(s) {
  return s.toLowerCase().trim();
}

function addEntry(name, score, move, flag, loc, equip) {
  const movement = move === 'C' ? 'compound' : 'isolation';
  const isPrimary = /PRIMARY/.test(flag);
  byName.set(normalize(name), { score, movement, isPrimary, loc, equip });
}

let i = 0;
while (i < lines.length) {
  const headerMatch = lines[i].match(/^##\s+(.+)$/);
  if (!headerMatch) { i++; continue; }
  const muscle = headerMatch[1].trim();
  // Skip until table header
  while (i < lines.length && !lines[i].startsWith('| Exercise')) i++;
  if (i >= lines.length) break;
  i += 2; // skip header + separator
  while (i < lines.length && lines[i].startsWith('|')) {
    const cells = lines[i].split('|').map(s => s.trim());
    // cells: ['', 'Exercise', 'Equip', 'Loc', 'Move', 'Eff', 'Pop', 'Score', 'Flag', '']
    if (cells.length >= 9) {
      const exCell = cells[1];
      const equip = cells[2];
      const loc = cells[3];
      const move = cells[4];
      const scoreRaw = cells[7];
      const flag = cells[8];
      const score = parseInt(scoreRaw.replace(/\*\*/g, ''), 10);
      if (!isNaN(score)) {
        // Expand combined names "A / B" → both A and B.
        const names = exCell.split('/').map(s => s.trim());
        for (const n of names) {
          addEntry(n, score, move, flag, loc, equip);
        }
      }
    }
    i++;
  }
}

console.log(`parsed ${byName.size} ranking entries from the doc`);

// ── Special-case dual entries: "Tricep Dips" appears twice (gym + home) ──
// The doc lists them with explicit loc; the catalog also has two rows.
// For unambiguous mapping, store under suffixed keys.
const TRICEP_DIPS_GYM = byName.get('tricep dips (gym)');
const TRICEP_DIPS_HOME = byName.get('tricep dips (home)');

// Also handle the home variants the doc spells differently from the catalog:
// the doc has "Pull-Up" (home, score 88) AND "Pull-Up / Wide Grip Pull-Up"
// (gym, score 88). Both map to score 88, so disambiguation is moot — the
// resulting values are identical.

// ── Build classifyCompoundness fallback (mirrors planGeneration.ts) ───
const ISOLATION_KEYWORDS = [
  'curl', 'extension', 'raise', 'fly', 'flye', 'kickback', 'pulldown' /* …most are compound */,
];
function fallbackMovement(name) {
  const n = name.toLowerCase();
  if (/\b(press|row|squat|deadlift|push-up|pushup|lunge|hip thrust|glute bridge|pull-up|pullup|chin-up|chinup|dip|pulldown)\b/.test(n)) return 'compound';
  return 'isolation';
}

// ── Parse + rewrite catalog ────────────────────────────────────────────

const src = fs.readFileSync(CATALOG_PATH, 'utf8');
const entryRe = /(\{ id: "([^"]+)", imageUrl: "([^"]+)", name: "([^"]+)", equipment: "([^"]+)"[^}]*?, restSeconds: \d+ \})/g;

const unmatched = [];
const updated = src.replace(entryRe, (full, _whole, id, imageUrl, name, equipment) => {
  // Special handling: "Tricep Dips" in catalog appears at push_h005 (home)
  // and push_030 (gym); the doc has them under "Tricep Dips (gym)" and
  // "Tricep Dips (home)". Pick by id.
  let info;
  if (name === 'Tricep Dips') {
    info = id.startsWith('push_h') ? TRICEP_DIPS_HOME : TRICEP_DIPS_GYM;
  } else {
    info = byName.get(normalize(name));
  }

  if (!info) {
    unmatched.push({ id, name, equipment });
    info = { score: 60, movement: fallbackMovement(name), isPrimary: false };
  }

  // Append the three new fields BEFORE the closing brace.
  if (full.includes('score:')) {
    // already has them — replace
    return full
      .replace(/, score: \d+/, `, score: ${info.score}`)
      .replace(/, movement: "[^"]+"/, `, movement: "${info.movement}"`)
      .replace(/, isPrimary: (true|false)/, `, isPrimary: ${info.isPrimary}`);
  }
  return full.replace(/ \}$/, `, score: ${info.score}, movement: "${info.movement}", isPrimary: ${info.isPrimary} }`);
});

fs.writeFileSync(CATALOG_PATH, updated);
console.log(`rewrote ${CATALOG_PATH}`);
if (unmatched.length === 0) {
  console.log('all catalog entries matched');
} else {
  console.log(`UNMATCHED (${unmatched.length}) — filled with default score=60:`);
  for (const u of unmatched) console.log(`  ${u.id}  ${u.name}  (${u.equipment})`);
}
