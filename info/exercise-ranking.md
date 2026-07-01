# Exercise Ranking — balanced scoring for the planner

*Research output for re-ranking the 103-exercise catalog (`src/constants/exercises.ts`). Objective chosen: **balanced** — effectiveness + popularity + accessibility. Scope: re-rank existing exercises only (no catalog expansion).*

## Why this exists

The generator (`pickExercises` in `planGeneration.ts`) currently selects exercises **at random** within each muscle slot (seeded shuffle / variety score + random tie-break). It has no concept of exercise quality, so nothing guarantees the primary compound (bench, squat, row) is even chosen — a chest slot can come back as two flyes. These scores fix that: the generator should rank by `score`, guarantee a compound, and rotate only accessories for variety.

## Scoring model

Each exercise gets three judgments, combined into one `score` (0–100):

- **Effectiveness** (hypertrophy value for the target muscle, from RP/Israetel hierarchy, Nippard breakdowns, Schoenfeld/stretch-mediated-hypertrophy literature): **S = 95, A = 80, B = 60**.
- **Popularity** (how liked / commonly programmed — adherence signal): **High = 90, Med = 65, Low = 40**.
- **Movement**: **C = compound, I = isolation** (explicit, replaces keyword-guessing).

`score = round(0.6 × effectiveness + 0.4 × popularity)`. Effectiveness is weighted heavier so a beloved-but-mediocre move can't outrank a staple, but popularity still pulls familiar exercises up.

**`PRIMARY`** marks the top compound per muscle that the generator should *guarantee* in any slot of count ≥ 2 (for the major muscles). For back, guarantee one horizontal pull (row) **and** one vertical pull (pulldown/pull-up) when count ≥ 2.

---

## Chest

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Barbell Bench Press | barbell | gym | C | S | H | **93** | **PRIMARY** |
| Incline Barbell Bench Press | barbell | gym | C | S | H | 92 | |
| Incline Dumbbell Press | dumbbell | gym | C | S | H | 91 | |
| Dumbbell Bench Press | dumbbell | gym | C | A | H | 89 | |
| Cable Fly | cable | gym | I | A | H | 80 | |
| Chest Dips | bodyweight | gym | C | A | M | 79 | |
| High Cable Fly | cable | gym | I | A | M | 73 | |
| Dumbbell Fly | dumbbell | gym | I | A | M | 72 | |
| Decline Barbell Press | barbell | gym | C | A | M | 71 | |
| Decline Dumbbell Press | dumbbell | gym | C | A | M | 69 | |
| Paused Bench Press | barbell | gym | C | A | L | 63 | strength variant |
| Dumbbell Pullover | dumbbell | gym | I | B | M | 59 | |
| Push-Up | bodyweight | home | C | A | H | 77 | **PRIMARY (home)** |
| Decline Push-Up | bodyweight | home | C | A | M | 65 | |
| Wide Push-Up | bodyweight | home | C | B | M | 61 | |

## Shoulders

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Overhead Press | barbell | gym | C | S | H | **90** | **PRIMARY** |
| Lateral Raise | dumbbell | gym | I | S | H | 90 | side-delt staple — guarantee as the isolation |
| Cable Lateral Raise | cable | gym | I | S | H | 87 | |
| Seated Dumbbell Press | dumbbell | gym | C | A | H | 85 | |
| Dumbbell Shoulder Press | dumbbell | gym | C | A | H | 84 | |
| Seated Barbell Press | barbell | gym | C | S | M | 81 | |
| Arnold Press | dumbbell | gym | C | A | M | 76 | |
| Machine Shoulder Press | machine | gym | C | A | M | 71 | |
| Upright Row | barbell | gym | C | B | M | 60 | impingement risk — low priority |
| Front Raise | dumbbell | gym | I | B | M | 57 | redundant with pressing |
| Pike Push-Up | bodyweight | home | C | A | M | 67 | **PRIMARY (home)** |

## Triceps

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Tricep Pushdown | cable | gym | I | A | H | 85 | |
| Cable Overhead Tricep Extension | cable | gym | I | S | M | 81 | long-head stretch |
| EZ Bar Skull Crusher | barbell | gym | I | A | M | 77 | |
| Overhead Tricep Extension | dumbbell | gym | I | A | M | 76 | |
| Close Grip Bench Press | barbell | gym | C | A | M | 76 | **PRIMARY (compound)** |
| Tricep Dips (gym) | bodyweight | gym | C | A | M | 76 | |
| Skull Crushers | barbell | gym | I | A | M | 75 | |
| Tricep Kickback | dumbbell | gym | I | B | M | 59 | |
| Board Press | barbell | gym | C | B | L | 52 | strength variant |
| Tricep Dips (home) | bodyweight | home | C | A | M | 73 | **PRIMARY (home)** |
| Diamond Push-Up | bodyweight | home | C | A | M | 69 | |

## Back

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Barbell Row | barbell | gym | C | S | H | **90** | **PRIMARY (horizontal)** |
| Deadlift | barbell | gym | C | S | H | 89 | |
| Pull-Up / Wide Grip Pull-Up | bodyweight | gym | C | S | H | 88 | **PRIMARY (vertical)** |
| Lat Pulldown | cable | gym | C | A | H | 87 | vertical for non-pull-up users |
| Dumbbell Row | dumbbell | gym | C | A | H | 85 | |
| Cable Row | cable | gym | C | A | H | 85 | |
| T-Bar Row | barbell | gym | C | A | H | 84 | |
| Chest Supported Row | dumbbell | gym | C | A | M | 80 | high SFR, no low-back fatigue |
| Close Grip Lat Pulldown | cable | gym | C | A | M | 78 | |
| Wide Grip Cable Row | cable | gym | C | A | M | 77 | |
| Back Extension | machine | gym | I | B | M | 60 | erectors |
| Pull-Up | bodyweight | home | C | S | H | 88 | **PRIMARY (home, vertical)** |
| Neutral Grip Pull-Up | bodyweight | home | C | A | M | 77 | |
| Inverted Row | bodyweight | home | C | A | M | 74 | **PRIMARY (home, horizontal)** |
| Wide Inverted Row | bodyweight | home | C | A | M | 71 | |
| Commando Pull-Up | bodyweight | home | C | B | L | 57 | |

## Rear delts

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Face Pull | cable | gym | I | S | H | **85** | **PRIMARY** |
| Bent Over Rear Delt Fly | dumbbell | gym | I | A | H | 80 | |
| Reverse Fly | dumbbell | gym | I | A | H | 79 | |
| Cable Face Pull High | cable | gym | I | A | M | 76 | |
| Seated Rear Delt Raise | dumbbell | gym | I | A | M | 73 | |
| Rear Delt Barbell Row | barbell | gym | C | B | L | 57 | |

## Biceps

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Barbell Curl | barbell | gym | I | A | H | 86 | **PRIMARY (staple)** |
| Dumbbell Curl | dumbbell | gym | I | A | H | 85 | |
| EZ Bar Curl | barbell | gym | I | A | H | 84 | |
| Hammer Curl | dumbbell | gym | I | A | H | 83 | brachialis |
| Incline Dumbbell Curl | dumbbell | gym | I | S | M | 82 | stretch-biased, elite |
| Cable Curl | cable | gym | I | A | M | 78 | |
| Preacher Curl | barbell | gym | I | A | M | 78 | |
| Concentration Curl | dumbbell | gym | I | A | M | 73 | |
| Zottman Curl | dumbbell | gym | I | B | L | 60 | |
| Chin-Up | bodyweight | home | C | S | H | 86 | **PRIMARY (home)** |
| Towel Bicep Curl | bodyweight | home | I | B | L | 51 | weak match, low priority |

## Quads

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Barbell Squat | barbell | gym | C | S | H | **93** | **PRIMARY** |
| Leg Press | machine | gym | C | A | H | 86 | |
| Hack Squat | machine | gym | C | S | M | 83 | |
| Dumbbell Lunges | dumbbell | gym | C | A | H | 81 | |
| Leg Extension | machine | gym | I | A | H | 81 | |
| Goblet Squat | dumbbell | gym | C | A | M | 75 | beginner-friendly |
| Bulgarian Split Squat | bodyweight | home | C | S | M | 82 | **PRIMARY (home)** |
| Walking Lunges | bodyweight | home | C | A | H | 78 | |
| Step-Up | bodyweight | home | C | A | M | 70 | |
| Bodyweight Squat | bodyweight | home | C | B | M | 63 | |
| Jump Squat | bodyweight | home | C | B | M | 60 | |

## Hamstrings

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Romanian Deadlift | barbell | gym | C | S | H | **89** | **PRIMARY** |
| Leg Curl | machine | gym | I | S | H | 87 | direct knee-flexion — guarantee alongside RDL |
| Dumbbell RDL | dumbbell | gym | C | A | M | 79 | |
| Nordic Curl | bodyweight | home | I | S | M | 77 | **PRIMARY (home)** |

## Glutes

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Hip Thrust | barbell | gym | C | S | H | **89** | **PRIMARY** |
| Glute Bridge | bodyweight | home | C | A | M | 74 | **PRIMARY (home)** |
| Single Leg Glute Bridge | bodyweight | home | C | A | M | 70 | |

## Calves

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Standing Calf Raise | machine | gym | I | S | H | **86** | **PRIMARY** |
| Seated Calf Raise | machine | gym | I | A | H | 83 | soleus |
| Calf Raise | bodyweight | home | I | B | M | 64 | **PRIMARY (home)** |

## Abs

| Exercise | Equip | Loc | Move | Eff | Pop | Score | Flag |
|---|---|---|---|---|---|---|---|
| Cable Crunch | cable | gym | I | S | H | **85** | **PRIMARY** |
| Hanging Leg Raise | bodyweight | gym | I | S | H | 85 | |
| Leg Raise | bodyweight | home | I | A | H | 78 | **PRIMARY (home)** |
| Bicycle Crunch | bodyweight | home | I | A | H | 78 | |
| Ab Machine Crunch | machine | gym | I | A | M | 75 | |
| Decline Crunch | bodyweight | gym | I | A | M | 74 | |
| Crunch | bodyweight | home | I | B | H | 71 | |
| Plank | bodyweight | home | I | B | H | 70 | anti-extension, low hypertrophy |
| Russian Twist | bodyweight | home | I | B | M | 63 | |
| Oblique Crunch | bodyweight | gym | I | B | M | 62 | |
| Mountain Climbers | bodyweight | home | I | B | M | 59 | more conditioning |
| Landmine Rotation | barbell | gym | I | B | L | 57 | |

---

## What the generator should do with this

1. **Add fields to each catalog entry:** `score` (number), `movement` ('compound' | 'isolation'), and a per-muscle `isPrimary` flag (true for the PRIMARY rows).
2. **Rank by `score` desc** in `pickExercises`; seeded random becomes only the final tie-break between equal scores. (Keeps mesocycle determinism.)
3. **Guarantee a compound** for the major muscles (chest, back, shoulders, quads, hamstrings, glutes) when a slot's count ≥ 2: force the top pick to be the highest-`score` exercise with `movement: 'compound'`. Back is special: guarantee one horizontal (row) **and** one vertical (pulldown/pull-up) when count ≥ 2.
4. **Tier-aware variety:** keep `isPrimary` compounds stable across mesocycle blocks (they're the progression anchors); rotate only the lower-`score` accessories for freshness. Don't let the variety logic rotate the bench/squat/row away.

## Judgment calls worth a second look

- **Shoulders & arms:** the top *isolation* (lateral raise, curls, pushdown) scores as high as or higher than the compound, on purpose — side delts and arms grow primarily from isolation. The "guarantee a compound" rule still seeds the press first, then the high-scoring isolation fills the next slot, which is the ideal shoulder day.
- **Deadlift** is scored under Back (89) but is a whole-posterior-chain lift; if it ever lands in the same session as heavy rows + RDLs, that's a lot of lower-back fatigue. Consider capping one heavy hinge per session later.
- **Abs/Plank, Mountain Climbers** are popular but low-hypertrophy; they're scored down despite being well-liked, which is the balanced model working as intended.
