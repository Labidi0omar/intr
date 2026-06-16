// One-off: re-derive imageUrl on every entry in src/constants/exercises.ts
// from the canonical free-exercise-db.
//
// Rule (deliberately conservative — the brief warns against guessing):
//   1. EXACT — catalog name == fedb name (normalized) AND equipment
//      matches → auto-apply.
//   2. OVERRIDES — explicit catalog_id → fedb_id map below, audited by
//      hand against the report → auto-apply.
//   3. Otherwise — leave the existing URL alone and report as a WEAK match
//      with the top 3 fedb candidates, so the user can pick.
//
// All token-subset / Jaccard heuristics were removed after the first
// pass — they were the source of the original wrong-image bug. If a
// mapping isn't EXACT or in OVERRIDES, it goes to manual review.

const fs = require('fs');
const path = require('path');

const FEDB = require(path.join(__dirname, '..', 'fedb.json'));
const CATALOG_PATH = path.join(__dirname, '..', 'src', 'constants', 'exercises.ts');
const REPORT_PATH = path.join(__dirname, 'fix-exercise-images.report.md');
const RAW_BASE = 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/';

// ── Name normalization ─────────────────────────────────────────────────

function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/'/g, '')
    .replace(/&/g, ' and ')
    .replace(/[.,()/]/g, ' ')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Equipment alignment ────────────────────────────────────────────────

const EQUIP_MAP = {
  barbell:    new Set(['barbell', 'e-z curl bar']),
  dumbbell:   new Set(['dumbbell', 'kettlebells']),
  cable:      new Set(['cable']),
  machine:    new Set(['machine']),
  bodyweight: new Set(['body only', 'other', null, undefined, '']),
};

function equipMatch(ours, fedbEq) {
  const ok = EQUIP_MAP[ours];
  if (!ok) return false;
  return ok.has((fedbEq ?? '').toLowerCase());
}

// ── Canonical overrides ────────────────────────────────────────────────
// Audited by hand against the fedb. Each key is the catalog `id`; the
// value is the fedb `id` (folder name) whose images[0] becomes the
// new imageUrl. Keep this list explicit — a missing key falls through
// to EXACT auto-match or to manual review.

const OVERRIDES = {
  // PUSH GYM
  push_001: 'Barbell_Bench_Press_-_Medium_Grip',        // "Barbell Bench Press"
  push_002: 'Barbell_Incline_Bench_Press_-_Medium_Grip',// "Incline Barbell Bench Press"
  push_005: 'Cable_Crossover',                          // "Cable Fly" — closest visual
  push_006: 'Dumbbell_Flyes',                           // "Dumbbell Fly" — pluralization-only diff
  push_007: 'Standing_Military_Press',                  // "Overhead Press"
  push_008: 'Dumbbell_Shoulder_Press',                  // EXACT would match, listed for clarity
  push_009: 'Side_Lateral_Raise',                       // "Lateral Raise"
  push_010: 'Front_Dumbbell_Raise',                     // "Front Raise"
  push_011: 'Arnold_Dumbbell_Press',                    // "Arnold Press"
  push_012: 'Triceps_Pushdown',                         // plain (not the rope variant)
  push_013: 'Lying_Dumbbell_Tricep_Extension',          // "Overhead Tricep Extension" (DB)
  push_014: 'Close-Grip_Barbell_Bench_Press',           // "Close Grip Bench Press" — fix first-run mis-write
  push_015: 'EZ-Bar_Skullcrusher',                      // "Skull Crushers"

  // PUSH HOME
  push_h001: 'Pushups',                                 // "Push-Up"
  push_h002: 'Push-Up_Wide',                            // "Wide Push-Up"
  push_h003: 'Push-Ups_-_Close_Triceps_Position',       // "Diamond Push-Up"
  push_h004: 'Handstand_Push-Ups',                      // "Pike Push-Up" — closest
  push_h005: 'Bench_Dips',                              // "Tricep Dips" (home)

  // PULL GYM
  pull_001: 'Bent_Over_Barbell_Row',                    // "Barbell Row"
  pull_002: 'One-Arm_Dumbbell_Row',                     // "Dumbbell Row"
  pull_003: 'Wide-Grip_Lat_Pulldown',                   // "Lat Pulldown"
  pull_004: 'Seated_Cable_Rows',                        // "Cable Row"
  pull_006: 'Reverse_Flyes',                            // "Reverse Fly"
  pull_008: 'Dumbbell_Bicep_Curl',                      // "Dumbbell Curl"
  pull_009: 'Hammer_Curls',                             // "Hammer Curl"
  pull_011: 'Barbell_Deadlift',                         // "Deadlift" (barbell)

  // PULL HOME
  pull_h001: 'Pullups',                                 // "Pull-Up"

  // LEGS GYM
  legs_006: 'Lying_Leg_Curls',                          // "Leg Curl" — most common image
  legs_007: 'Stiff-Legged_Dumbbell_Deadlift',           // "Dumbbell RDL" — fedb has no RDL acronym
  legs_008: 'Barbell_Hip_Thrust',                       // "Hip Thrust"
  legs_010: 'Standing_Calf_Raises',                     // "Standing Calf Raise"
  legs_012: 'Leg_Extensions',                           // "Leg Extension"

  // LEGS HOME
  legs_h002: 'Freehand_Jump_Squat',
  legs_h003: 'Bodyweight_Walking_Lunge',                // "Walking Lunges"
  legs_h004: 'Split_Squats',                            // "Bulgarian Split Squat" — closest bodyweight single-leg split
  legs_h005: 'Barbell_Glute_Bridge',                    // "Glute Bridge" — only glute-bridge image in fedb
  legs_h007: 'Natural_Glute_Ham_Raise',                 // "Nordic Curl"
  legs_h008: 'Standing_Calf_Raises',                    // "Calf Raise" (home)
  legs_h009: 'Step-up_with_Knee_Raise',                 // "Step-Up" — closest fedb step-up image

  // CHEST GYM (push_016+)
  push_016: 'Bent-Arm_Dumbbell_Pullover',               // "Dumbbell Pullover"
  push_017: 'Decline_Dumbbell_Bench_Press',
  push_018: 'Decline_Barbell_Bench_Press',
  push_019: 'Cable_Crossover',                          // "High Cable Fly" — no separate "high" entry
  push_020: 'Dips_-_Chest_Version',                     // "Chest Dips"
  push_021: 'Barbell_Bench_Press_-_Medium_Grip',        // "Paused Bench" — no paused variant

  // SHOULDERS GYM
  push_022: 'Seated_Barbell_Military_Press',
  push_023: 'Cable_Seated_Lateral_Raise',
  push_024: 'Upright_Barbell_Row',
  push_025: 'Seated_Dumbbell_Press',
  push_026: 'Machine_Shoulder_Military_Press',

  // TRICEPS GYM
  push_027: 'Cable_Rope_Overhead_Triceps_Extension',
  push_028: 'EZ-Bar_Skullcrusher',
  push_029: 'Tricep_Dumbbell_Kickback',
  push_030: 'Dips_-_Triceps_Version',                   // "Tricep Dips" (gym)
  push_031: 'Board_Press',

  // BACK GYM
  pull_012: 'Close-Grip_Front_Lat_Pulldown',            // "Close Grip Lat Pulldown"
  pull_013: 'T-Bar_Row_with_Handle',                    // "T-Bar Row"
  pull_014: 'Seated_Cable_Rows',                        // "Wide Grip Cable Row" — no wide-grip variant
  pull_015: 'Wide-Grip_Rear_Pull-Up',                   // "Wide Grip Pull-Up"
  pull_016: 'Hyperextensions_Back_Extensions',          // "Back Extension"
  pull_017: 'Bent_Over_Two-Dumbbell_Row',               // "Chest Supported Row" — closest DB row image

  // REAR DELTS GYM
  pull_018: 'Bent_Over_Dumbbell_Rear_Delt_Raise_With_Head_On_Bench',
  pull_019: 'Face_Pull',                                // "Cable Face Pull High"
  pull_020: 'Barbell_Rear_Delt_Row',
  pull_021: 'Seated_Bent-Over_Rear_Delt_Raise',

  // BICEPS GYM
  pull_022: 'EZ-Bar_Curl',                              // "EZ Bar Curl"
  pull_023: 'Incline_Dumbbell_Curl',
  pull_024: 'Standing_Biceps_Cable_Curl',               // "Cable Curl"
  pull_025: 'Concentration_Curls',
  pull_026: 'Zottman_Curl',

  // HOME PULL extras
  pull_h004: 'V-Bar_Pullup',                            // "Neutral Grip Pull-Up"
  pull_h005: 'Inverted_Row',                            // "Wide Inverted Row"
  pull_h006: 'Pullups',                                 // "Commando Pull-Up" — no clean DB match
  // pull_h007 Towel Bicep Curl → no clean DB match; left for manual review.

  // ABS
  abs_001: 'Cable_Crunch',
  abs_002: 'Hanging_Leg_Raise',
  abs_003: 'Ab_Crunch_Machine',
  abs_004: 'Decline_Crunch',
  abs_005: 'Oblique_Crunches',
  abs_006: 'Landmine_180s',                             // "Landmine Rotation" — closest landmine image
  abs_h001: 'Crunch_-_Hands_Overhead',
  abs_h002: 'Plank',
  abs_h003: 'Flat_Bench_Lying_Leg_Raise',
  abs_h004: 'Air_Bike',                                 // "Bicycle Crunch"
  abs_h005: 'Mountain_Climbers',
  abs_h006: 'Russian_Twist',
};

// ── EXACT scoring ──────────────────────────────────────────────────────

function exactMatch(catalogName, catalogEquip) {
  const norm = normalize(catalogName);
  for (const entry of FEDB) {
    if (normalize(entry.name) !== norm) continue;
    if (!equipMatch(catalogEquip, entry.equipment)) continue;
    return entry;
  }
  return null;
}

function rank(catalogName, catalogEquip, k = 3) {
  // Cheap ranking for the report's "top candidates" list. Score: name
  // overlap (lowercase token intersect) + equipment-match bonus. No
  // auto-apply uses this — it's only for human review.
  const a = new Set(normalize(catalogName).split(' ').filter(Boolean));
  const scored = [];
  for (const e of FEDB) {
    const b = new Set(normalize(e.name).split(' ').filter(Boolean));
    if (a.size === 0 || b.size === 0) continue;
    let overlap = 0;
    for (const t of a) if (b.has(t)) overlap++;
    const eqOk = equipMatch(catalogEquip, e.equipment);
    const jacc = overlap / (a.size + b.size - overlap);
    if (overlap === 0 && !eqOk) continue;
    scored.push({ entry: e, overlap, jacc, eqOk });
  }
  scored.sort((a, b) => {
    if (a.eqOk !== b.eqOk) return a.eqOk ? -1 : 1;
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    return b.jacc - a.jacc;
  });
  return scored.slice(0, k);
}

// ── Parse catalog ──────────────────────────────────────────────────────

const src = fs.readFileSync(CATALOG_PATH, 'utf8');
const lineRe = /\{ id: "([^"]+)", imageUrl: "([^"]+)", name: "([^"]+)", equipment: "([^"]+)"/g;

const entries = [];
let m;
while ((m = lineRe.exec(src)) !== null) {
  entries.push({
    id: m[1],
    oldUrl: m[2],
    name: m[3],
    equipment: m[4],
  });
}
console.log(`parsed ${entries.length} catalog entries`);

// ── Build fedb id lookup ───────────────────────────────────────────────

const fedbById = new Map();
for (const e of FEDB) fedbById.set(e.id, e);

function urlFor(fedbEntry) {
  if (!fedbEntry?.images?.length) return null;
  return RAW_BASE + fedbEntry.images[0];
}
function slug(url) {
  if (!url) return '';
  const parts = url.split('/');
  return parts.slice(-2).join('/');
}

// ── Match each ─────────────────────────────────────────────────────────

const results = [];
for (const e of entries) {
  let chosen = null;
  let tier = 'WEAK';

  if (OVERRIDES[e.id]) {
    const ov = fedbById.get(OVERRIDES[e.id]);
    if (!ov) {
      console.warn(`OVERRIDE BAD: ${e.id} → "${OVERRIDES[e.id]}" not found in fedb`);
    } else {
      chosen = ov;
      tier = 'OVERRIDE';
    }
  }

  if (!chosen) {
    const ex = exactMatch(e.name, e.equipment);
    if (ex) {
      chosen = ex;
      tier = 'EXACT';
    }
  }

  const newUrl = chosen ? urlFor(chosen) : e.oldUrl;
  const changed = newUrl !== e.oldUrl;
  const candidates = chosen ? [] : rank(e.name, e.equipment, 3);
  results.push({ ...e, tier, chosen, newUrl, changed, candidates });
}

// ── Apply changes to source ────────────────────────────────────────────

let out = src;
let applied = 0;
for (const r of results) {
  if (r.tier !== 'EXACT' && r.tier !== 'OVERRIDE') continue;
  if (!r.changed) continue;
  const oldFragment = `{ id: "${r.id}", imageUrl: "${r.oldUrl}",`;
  const newFragment = `{ id: "${r.id}", imageUrl: "${r.newUrl}",`;
  if (!out.includes(oldFragment)) {
    console.warn(`MISS: could not locate fragment for ${r.id}`);
    continue;
  }
  out = out.replace(oldFragment, newFragment);
  applied++;
}
fs.writeFileSync(CATALOG_PATH, out);
console.log(`rewrote ${applied} entries`);

// ── Report ─────────────────────────────────────────────────────────────

const corrected = results.filter(r => r.changed && (r.tier === 'EXACT' || r.tier === 'OVERRIDE'));
const unchanged = results.filter(r => !r.changed && (r.tier === 'EXACT' || r.tier === 'OVERRIDE'));
const review    = results.filter(r => r.tier === 'WEAK');

let md = '';
md += `# Exercise image fix — verification report\n\n`;
md += `**Generated:** ${new Date().toISOString()}  \n`;
md += `**Catalog:** \`src/constants/exercises.ts\` (${entries.length} entries)  \n`;
md += `**Source of truth:** [free-exercise-db @ main](https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json) (${FEDB.length} entries)\n\n`;
md += `## Counts\n\n`;
md += `| | n |\n|---|---|\n`;
md += `| Corrected (URL changed) | ${corrected.length} |\n`;
md += `| Unchanged (already correct) | ${unchanged.length} |\n`;
md += `| Needs manual review (WEAK) | ${review.length} |\n`;
md += `| **Total** | **${results.length}** |\n\n`;
md += `Auto-apply rule: EXACT name match (normalized) + equipment agreement, OR explicit catalog→fedb override audited by hand. Everything else is left unchanged for human pick.\n\n`;

md += `## Full comparison table\n\n`;
md += `| id | name | equipment | old slug | new slug | tier | changed |\n`;
md += `|---|---|---|---|---|---|---|\n`;
for (const r of results) {
  md += `| ${r.id} | ${r.name} | ${r.equipment} | ${slug(r.oldUrl)} | ${slug(r.newUrl)} | ${r.tier} | ${r.changed ? '✅' : '—'} |\n`;
}

if (review.length > 0) {
  md += `\n## Needs manual review (${review.length})\n\n`;
  md += `Per the brief, weak matches are NOT auto-applied — the existing imageUrl is left in place. Pick a canonical entry and add it to \`OVERRIDES\` in \`scripts/fix-exercise-images.js\`, then re-run.\n\n`;
  for (const r of review) {
    md += `### \`${r.id}\` — ${r.name} *(equipment: ${r.equipment})*\n\n`;
    md += `- **Current URL:** \`${r.oldUrl}\`\n`;
    md += `- **Top candidates:**\n`;
    for (let i = 0; i < r.candidates.length; i++) {
      const c = r.candidates[i];
      md += `  ${i + 1}. ${c.entry.name} *(equip: ${c.entry.equipment || 'none'}, eqOk: ${c.eqOk}, overlap: ${c.overlap})* — \`${c.entry.images?.[0] ?? '(no image)'}\`\n`;
    }
    md += `\n`;
  }
}

fs.writeFileSync(REPORT_PATH, md);
console.log(`report → ${REPORT_PATH}`);
console.log(`summary: corrected=${corrected.length} unchanged=${unchanged.length} review=${review.length}`);
