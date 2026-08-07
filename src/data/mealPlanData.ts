import mealsData from './mealPlanData.json';

export interface Ingredient {
  name: string;
  amount: number;
  unit: 'г' | 'мл' | 'ком';
}

export type MealType = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export interface PlanMeal {
  meal_type: MealType;
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  categories: MealPlanType[];
  ingredients: Ingredient[];
}

export type TaggedMeal = PlanMeal & { type: 'main' | 'snack' };
export type DayPlan = TaggedMeal[];
export type WeekPlan = DayPlan[];

export type MealPlanType = 'high_protein' | 'low_fat' | 'low_carbs' | 'vegetarian' | 'lactose_free';

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  let s = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = s ^ (s >>> 16);
    const j = Math.abs(s) % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

const ALL_MEALS = mealsData as PlanMeal[];

// ---------------------------------------------------------------------------
// Plan type filters
// ---------------------------------------------------------------------------

function mealsByType(mealType: MealType): PlanMeal[] {
  return ALL_MEALS.filter(meal => meal.meal_type === mealType);
}

function sortByBestForPlan(meals: PlanMeal[], planType: MealPlanType): PlanMeal[] {
  const sorted = [...meals];
  switch (planType) {
    case 'high_protein':
      return sorted.sort((a, b) => (b.protein / Math.max(1, b.kcal)) - (a.protein / Math.max(1, a.kcal)));
    case 'low_fat':
      return sorted.sort((a, b) => a.fat - b.fat);
    case 'low_carbs':
      return sorted.sort((a, b) => a.carbs - b.carbs);
    default:
      return sorted;
  }
}

function getPlanMacroPenalty(meal: PlanMeal, planType: MealPlanType): number {
  const kcalBase = Math.max(1, meal.kcal);
  const proteinDensity = meal.protein / kcalBase;
  const carbsDensity = meal.carbs / kcalBase;
  const fatDensity = meal.fat / kcalBase;

  switch (planType) {
    case 'high_protein':
      return (1 - Math.min(1, proteinDensity / 0.12)) * 3.4 + (carbsDensity * 0.45) + (fatDensity * 0.35);
    case 'low_carbs':
      return (carbsDensity * 5.2) + (meal.carbs / 100) + (fatDensity * 0.2);
    case 'low_fat':
      return (fatDensity * 7.5) + (meal.fat / 40) + (carbsDensity * 0.15);
    case 'vegetarian':
      return (1 - Math.min(1, proteinDensity / 0.09)) * 1.6;
    case 'lactose_free':
      return (1 - Math.min(1, proteinDensity / 0.1)) * 1.1;
    default:
      return 0;
  }
}

function scoreSimilarity(base: PlanMeal, candidate: PlanMeal): number {
  const kcalScore = Math.abs(candidate.kcal - base.kcal) / Math.max(1, base.kcal);
  const proteinScore = Math.abs(candidate.protein - base.protein) / Math.max(1, base.protein || 1);
  const carbsScore = Math.abs(candidate.carbs - base.carbs) / Math.max(1, base.carbs || 1);
  const fatScore = Math.abs(candidate.fat - base.fat) / Math.max(1, base.fat || 1);
  return (kcalScore * 1.4) + (proteinScore * 1.2) + carbsScore + fatScore;
}

function filterByPlanType(meals: PlanMeal[], planType: MealPlanType): PlanMeal[] {
  const filtered = meals.filter(meal => meal.categories.includes(planType));
  return sortByBestForPlan(filtered, planType);
}

const MAIN_MEAL_SHARE = 0.92;
const MAIN_MEAL_SPLITS: Record<'breakfast' | 'lunch' | 'dinner', number> = {
  breakfast: 0.28,
  lunch: 0.38,
  dinner: 0.34,
};

function rankMealsForTarget(meals: PlanMeal[], targetCalories: number, seed: number, planType: MealPlanType): PlanMeal[] {
  return seededShuffle(meals, seed).sort((a, b) =>
    (Math.abs(a.kcal - targetCalories) / Math.max(1, targetCalories) + (getPlanMacroPenalty(a, planType) * 0.22)) -
    (Math.abs(b.kcal - targetCalories) / Math.max(1, targetCalories) + (getPlanMacroPenalty(b, planType) * 0.22)),
  );
}

function pickMainMeals(targetCalories: number, seed: number, planType: MealPlanType): PlanMeal[] {
  const breakfastPool = filterByPlanType(mealsByType('breakfast'), planType);
  const lunchPool     = filterByPlanType(mealsByType('lunch'), planType);
  const dinnerPool    = filterByPlanType(mealsByType('dinner'), planType);

  if (breakfastPool.length === 0 || lunchPool.length === 0 || dinnerPool.length === 0) return [];

  const mainTargetCalories = Math.max(0, Math.round(targetCalories * MAIN_MEAL_SHARE));
  const breakfastTarget = Math.round(mainTargetCalories * MAIN_MEAL_SPLITS.breakfast);
  const lunchTarget = Math.round(mainTargetCalories * MAIN_MEAL_SPLITS.lunch);
  const dinnerTarget = Math.max(0, mainTargetCalories - breakfastTarget - lunchTarget);

  const breakfastCandidates = rankMealsForTarget(breakfastPool, breakfastTarget, seed, planType).slice(0, Math.min(16, breakfastPool.length));
  const lunchCandidates = rankMealsForTarget(lunchPool, lunchTarget, seed + 1111, planType).slice(0, Math.min(16, lunchPool.length));
  const dinnerCandidates = rankMealsForTarget(dinnerPool, dinnerTarget, seed + 2222, planType).slice(0, Math.min(16, dinnerPool.length));

  let bestMeals: PlanMeal[] = [];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const breakfast of breakfastCandidates) {
    for (const lunch of lunchCandidates) {
      for (const dinner of dinnerCandidates) {
        const totalKcal = breakfast.kcal + lunch.kcal + dinner.kcal;
        const totalScore = Math.abs(totalKcal - mainTargetCalories) / Math.max(1, mainTargetCalories);
        const slotScore =
          Math.abs(breakfast.kcal - breakfastTarget) / Math.max(1, breakfastTarget) +
          Math.abs(lunch.kcal - lunchTarget) / Math.max(1, lunchTarget) +
          Math.abs(dinner.kcal - dinnerTarget) / Math.max(1, dinnerTarget);
        const macroScore =
          getPlanMacroPenalty(breakfast, planType) +
          getPlanMacroPenalty(lunch, planType) +
          getPlanMacroPenalty(dinner, planType);
        const score = (totalScore * 2.2) + slotScore + (macroScore * 0.65);

        if (score < bestScore) {
          bestScore = score;
          bestMeals = [breakfast, lunch, dinner];
        }
      }
    }
  }

  return bestMeals;
}

function scoreSnackFit(
  snack: PlanMeal,
  currentCalories: number,
  targetCalories: number,
  upperBound: number,
  proteinRemaining: number,
  planType: MealPlanType,
): number {
  const projectedCalories = currentCalories + snack.kcal;
  const calorieGap = Math.abs(targetCalories - projectedCalories) / Math.max(1, targetCalories);
  const overshootPenalty = projectedCalories > upperBound
    ? ((projectedCalories - upperBound) / Math.max(1, targetCalories)) * 4
    : 0;
  const proteinPenalty = proteinRemaining > 0
    ? Math.max(0, proteinRemaining - snack.protein) / Math.max(1, proteinRemaining)
    : 0;
  return calorieGap + overshootPenalty + (proteinPenalty * 0.8) + (getPlanMacroPenalty(snack, planType) * 0.7);
}

function scoreSnackReplacement(current: TaggedMeal, candidate: PlanMeal): number {
  const kcalScore = (Math.abs(candidate.kcal - current.kcal) / Math.max(1, current.kcal)) * 2.4;
  const proteinScore = Math.abs(candidate.protein - current.protein) / Math.max(1, current.protein || 1);
  const carbsScore = Math.abs(candidate.carbs - current.carbs) / Math.max(1, current.carbs || 1);
  const fatScore = Math.abs(candidate.fat - current.fat) / Math.max(1, current.fat || 1);
  return kcalScore + proteinScore + carbsScore + fatScore;
}

function scoreMainReplacement(current: TaggedMeal, candidate: PlanMeal, planType: MealPlanType): number {
  return scoreSimilarity(current, candidate) + (getPlanMacroPenalty(candidate, planType) * 0.55);
}

function trimDayPlanCalories(
  day: DayPlan,
  targetCalories: number,
  lowerBound: number,
  upperBound: number,
): DayPlan {
  let result = day.map(meal => ({ ...meal }));
  let totalCalories = result.reduce((sum, meal) => sum + meal.kcal, 0);

  while (totalCalories > targetCalories) {
    const snackIndexes = result
      .map((meal, index) => meal.type === 'snack' ? index : -1)
      .filter(index => index >= 0);

    if (snackIndexes.length === 0) break;

    let bestIndex = -1;
    let bestGap = Math.abs(totalCalories - targetCalories);

    for (const snackIndex of snackIndexes) {
      const nextCalories = totalCalories - result[snackIndex].kcal;
      if (nextCalories < lowerBound) continue;
      const nextGap = Math.abs(nextCalories - targetCalories);
      if (nextGap < bestGap) {
        bestGap = nextGap;
        bestIndex = snackIndex;
      }
    }

    if (bestIndex < 0) break;

    totalCalories -= result[bestIndex].kcal;
    result = result.filter((_, index) => index !== bestIndex);

    if (totalCalories <= upperBound) {
      const currentGap = Math.abs(totalCalories - targetCalories);
      const removableSnackExists = result.some((meal, index) =>
        meal.type === 'snack' && (totalCalories - result[index].kcal) >= lowerBound &&
        Math.abs((totalCalories - result[index].kcal) - targetCalories) < currentGap,
      );

      if (!removableSnackExists) break;
    }
  }

  return result;
}

function rebalanceDayPlanCalories(
  day: DayPlan,
  targetCalories: number,
  targetProtein: number,
  seed: number,
  planType: MealPlanType,
): DayPlan {
  const snackPool = filterByPlanType(mealsByType('snack'), planType);
  if (snackPool.length === 0) return day;

  const calorieTolerance = Math.max(100, Math.round(targetCalories * 0.04));
  const lowerBound = Math.max(0, targetCalories - calorieTolerance);
  const upperBound = targetCalories + calorieTolerance;
  const result = day.map(meal => ({ ...meal }));
  const usedSnackNames = new Set(result.filter(meal => meal.type === 'snack').map(meal => meal.name));
  let currentCalories = result.reduce((sum, meal) => sum + meal.kcal, 0);
  let currentProtein = result.reduce((sum, meal) => sum + meal.protein, 0);

  for (let attempt = 0; attempt < 3 && currentCalories < lowerBound; attempt++) {
    const proteinRemaining = Math.max(0, targetProtein - currentProtein);
    const shuffledSnacks = seededShuffle(snackPool, seed + 5555 + attempt * 131);
    const uniqueSnacks = shuffledSnacks.filter(snack => !usedSnackNames.has(snack.name));
    const candidateSource = uniqueSnacks.length > 0 ? uniqueSnacks : shuffledSnacks;
    const inRangeCandidates = candidateSource.filter(snack => currentCalories + snack.kcal <= upperBound);
    const candidatePool = inRangeCandidates.length > 0 ? inRangeCandidates : candidateSource;
    const snack = [...candidatePool].sort((a, b) =>
      scoreSnackFit(a, currentCalories, targetCalories, upperBound, proteinRemaining, planType) -
      scoreSnackFit(b, currentCalories, targetCalories, upperBound, proteinRemaining, planType),
    )[0];

    if (!snack) break;

    result.push({ ...snack, type: 'snack' });
    currentCalories += snack.kcal;
    currentProtein += snack.protein;
    usedSnackNames.add(snack.name);
  }

  return trimDayPlanCalories(result, targetCalories, lowerBound, upperBound);
}

// ---------------------------------------------------------------------------
// Plan generator – fixed Појадок / Ручек / Вечера + ужинки to fill calorie target
// ---------------------------------------------------------------------------

function generateDayPlan(targetCalories: number, targetProtein: number, seed: number, planType: MealPlanType): DayPlan {
  const snackPool     = filterByPlanType(mealsByType('snack'), planType);

  const mains = pickMainMeals(targetCalories, seed, planType);
  if (mains.length !== 3) return [];

  // Fill remaining calories with light snacks (Ужинки)
  const mainTotal = mains.reduce((s, m) => s + m.kcal, 0);
  const mainProtein = mains.reduce((s, m) => s + m.protein, 0);
  const snacks: PlanMeal[] = [];
  let snackTotal = 0;
  let snackProtein = 0;
  const calorieTolerance = Math.max(100, Math.round(targetCalories * 0.04));
  const lowerBound = Math.max(0, targetCalories - calorieTolerance);
  const upperBound = targetCalories + calorieTolerance;
  const usedSnackNames = new Set<string>();

  for (let attempt = 0; attempt < Math.max(1, snackPool.length); attempt++) {
    const currentCalories = mainTotal + snackTotal;
    const proteinRemaining = Math.max(0, targetProtein - (mainProtein + snackProtein));
    const proteinCovered = proteinRemaining <= 8;
    if (currentCalories >= lowerBound && proteinCovered) break;

    const shuffledSnacks = seededShuffle(snackPool, seed + 3333 + attempt * 97);
    const uniqueSnacks = shuffledSnacks.filter(snack => !usedSnackNames.has(snack.name));
    const candidateSource = uniqueSnacks.length > 0 ? uniqueSnacks : shuffledSnacks;
    const inRangeCandidates = candidateSource.filter(snack => currentCalories + snack.kcal <= upperBound);
    const candidatePool = inRangeCandidates.length > 0 ? inRangeCandidates : candidateSource;
    const snack = [...candidatePool].sort((a, b) =>
      scoreSnackFit(a, currentCalories, targetCalories, upperBound, proteinRemaining, planType) -
      scoreSnackFit(b, currentCalories, targetCalories, upperBound, proteinRemaining, planType),
    )[0];

    if (!snack) break;

    if (currentCalories + snack.kcal > upperBound && currentCalories >= lowerBound) break;

    snacks.push(snack);
    snackTotal += snack.kcal;
    snackProtein += snack.protein;
    usedSnackNames.add(snack.name);
  }

  // Interleave: Оброк 1, Ужинка 1, Оброк 2, Ужинка 2, Оброк 3, Ужинка 3+
  const result: DayPlan = [];
  for (let i = 0; i < mains.length; i++) {
    result.push({ ...mains[i], type: 'main' });
    if (i < snacks.length) result.push({ ...snacks[i], type: 'snack' });
  }
  for (let i = mains.length; i < snacks.length; i++) {
    result.push({ ...snacks[i], type: 'snack' });
  }

  return result;
}

function diversifyWeekSnackSlots(week: WeekPlan, planType: MealPlanType, seed: number): WeekPlan {
  const snackPool = filterByPlanType(mealsByType('snack'), planType);
  if (snackPool.length <= 1) return week;

  const recentBySlot = new Map<number, string[]>();
  const MAX_RECENT_PER_SLOT = Math.min(3, snackPool.length - 1);

  const diversified = week.map(day => day.map(meal => ({ ...meal })));

  for (let dayIndex = 0; dayIndex < diversified.length; dayIndex++) {
    const day = diversified[dayIndex];
    let snackSlot = 0;

    for (let mealIndex = 0; mealIndex < day.length; mealIndex++) {
      if (day[mealIndex].type !== 'snack') continue;

      const recent = recentBySlot.get(snackSlot) ?? [];
      const current = day[mealIndex];
      const usedInDay = new Set(day.map(meal => meal.name));

      if (recent.includes(current.name)) {
        let candidates = snackPool.filter(snack =>
          snack.name !== current.name &&
          !recent.includes(snack.name) &&
          !usedInDay.has(snack.name),
        );

        if (candidates.length === 0) {
          candidates = snackPool.filter(snack =>
            snack.name !== current.name &&
            !usedInDay.has(snack.name),
          );
        }

        if (candidates.length > 0) {
          const ranked = [...candidates].sort((a, b) =>
            scoreSnackReplacement(current, a) - scoreSnackReplacement(current, b),
          );
          const replacement = seededShuffle(
            ranked.slice(0, Math.min(3, ranked.length)),
            seed + dayIndex * 181 + snackSlot * 37,
          )[0];
          day[mealIndex] = { ...replacement, type: 'snack' };
        }
      }

      const updatedName = day[mealIndex].name;
      const updatedRecent = [...recent, updatedName].slice(-MAX_RECENT_PER_SLOT);
      recentBySlot.set(snackSlot, updatedRecent);
      snackSlot++;
    }
  }

  return diversified;
}

function diversifyWeekMainSlots(week: WeekPlan, planType: MealPlanType, seed: number): WeekPlan {
  const mainPools: Record<0 | 1 | 2, PlanMeal[]> = {
    0: filterByPlanType(mealsByType('breakfast'), planType),
    1: filterByPlanType(mealsByType('lunch'), planType),
    2: filterByPlanType(mealsByType('dinner'), planType),
  };

  const recentBySlot = new Map<number, string[]>();
  const diversified = week.map(day => day.map(meal => ({ ...meal })));

  for (let dayIndex = 0; dayIndex < diversified.length; dayIndex++) {
    const day = diversified[dayIndex];
    const usedInDay = new Set(day.map(meal => meal.name));
    let mainSlot: 0 | 1 | 2 = 0;

    for (let mealIndex = 0; mealIndex < day.length; mealIndex++) {
      if (day[mealIndex].type !== 'main') continue;

      const slotPool = mainPools[mainSlot];
      if (slotPool.length <= 1) {
        mainSlot = (mainSlot + 1) as 0 | 1 | 2;
        continue;
      }

      const current = day[mealIndex];
      const recent = recentBySlot.get(mainSlot) ?? [];
      const maxRecent = Math.min(3, slotPool.length - 1);

      if (recent.includes(current.name)) {
        let candidates = slotPool.filter(meal =>
          meal.name !== current.name &&
          !recent.includes(meal.name) &&
          !usedInDay.has(meal.name),
        );

        if (candidates.length === 0) {
          candidates = slotPool.filter(meal =>
            meal.name !== current.name &&
            !usedInDay.has(meal.name),
          );
        }

        if (candidates.length > 0) {
          const ranked = [...candidates].sort((a, b) =>
            scoreMainReplacement(current, a, planType) - scoreMainReplacement(current, b, planType),
          );
          const replacement = seededShuffle(
            ranked.slice(0, Math.min(4, ranked.length)),
            seed + dayIndex * 211 + mainSlot * 47,
          )[0];

          day[mealIndex] = { ...replacement, type: 'main' };
          usedInDay.delete(current.name);
          usedInDay.add(replacement.name);
        }
      }

      const updatedName = day[mealIndex].name;
      recentBySlot.set(mainSlot, [...recent, updatedName].slice(-maxRecent));
      mainSlot = (mainSlot + 1) as 0 | 1 | 2;
    }
  }

  return diversified;
}

function mainSignature(day: DayPlan): string {
  return day
    .filter(meal => meal.type === 'main')
    .map(meal => meal.name)
    .join(' | ');
}

function diversifyDuplicateDayMainPlans(week: WeekPlan, planType: MealPlanType, seed: number): WeekPlan {
  const mainPools: Record<0 | 1 | 2, PlanMeal[]> = {
    0: filterByPlanType(mealsByType('breakfast'), planType),
    1: filterByPlanType(mealsByType('lunch'), planType),
    2: filterByPlanType(mealsByType('dinner'), planType),
  };

  const diversified = week.map(day => day.map(meal => ({ ...meal })));

  for (let dayIndex = 1; dayIndex < diversified.length; dayIndex++) {
    const previous = diversified[dayIndex - 1];
    const current = diversified[dayIndex];

    if (mainSignature(previous) !== mainSignature(current)) continue;

    const mainIndexes = current
      .map((meal, index) => meal.type === 'main' ? index : -1)
      .filter(index => index >= 0);

    let replaced = false;
    const slotPriority: Array<0 | 1 | 2> = [2, 1, 0];

    for (const slot of slotPriority) {
      if (slot >= mainIndexes.length) continue;

      const mealIndex = mainIndexes[slot];
      const currentMeal = current[mealIndex];
      const slotPool = mainPools[slot];
      const usedInDay = new Set(current.map(meal => meal.name));

      let candidates = slotPool.filter(meal =>
        meal.name !== currentMeal.name &&
        !usedInDay.has(meal.name),
      );

      if (candidates.length === 0) {
        candidates = slotPool.filter(meal => meal.name !== currentMeal.name);
      }

      if (candidates.length === 0) continue;

      const ranked = [...candidates].sort((a, b) =>
        scoreMainReplacement(currentMeal, a, planType) - scoreMainReplacement(currentMeal, b, planType),
      );
      const replacement = seededShuffle(
        ranked.slice(0, Math.min(4, ranked.length)),
        seed + dayIndex * 257 + slot * 41,
      )[0];

      current[mealIndex] = { ...replacement, type: 'main' };

      if (mainSignature(previous) !== mainSignature(current)) {
        replaced = true;
        break;
      }
    }

    if (!replaced) continue;
  }

  return diversified;
}

export function getMealReplacement(
  currentMeal: PlanMeal,
  options: {
    planType: MealPlanType;
    seed: number;
    mealType: 'main' | 'snack';
    mainSlot?: 0 | 1 | 2;
    excludeNames?: string[];
  },
): PlanMeal {
  const { planType, seed, mealType, mainSlot, excludeNames = [] } = options;

  const poolByCategory = mealType === 'snack'
    ? mealsByType('snack')
    : mealsByType(mainSlot === 0 ? 'breakfast' : mainSlot === 1 ? 'lunch' : 'dinner');

  const filteredPool = filterByPlanType(poolByCategory, planType);
  const uniqueCandidates = filteredPool.filter(m =>
    m.name !== currentMeal.name &&
    !excludeNames.includes(m.name),
  );

  const candidates = uniqueCandidates.length > 0
    ? uniqueCandidates
    : filteredPool.filter(m => m.name !== currentMeal.name);

  if (candidates.length === 0) return currentMeal;

  const ranked = [...candidates].sort((a, b) =>
    (scoreSimilarity(currentMeal, a) + (getPlanMacroPenalty(a, planType) * 0.7)) -
    (scoreSimilarity(currentMeal, b) + (getPlanMacroPenalty(b, planType) * 0.7)),
  );
  const top = ranked.slice(0, Math.min(5, ranked.length));
  return seededShuffle(top, seed)[0];
}

export function generateWeekPlan(
  targetCalories: number,
  seed: number,
  planType: MealPlanType,
  targetProtein = 0,
): WeekPlan {
  const baseWeek = Array.from({ length: 7 }, (_, dayIndex) =>
    generateDayPlan(targetCalories, targetProtein, seed + dayIndex * 997, planType)
  );

  const weekWithDiverseMains = diversifyWeekMainSlots(baseWeek, planType, seed + 4444);
  const weekWithoutDuplicateDayMains = diversifyDuplicateDayMainPlans(weekWithDiverseMains, planType, seed + 6666);
  const weekWithDiverseMeals = diversifyWeekSnackSlots(weekWithoutDuplicateDayMains, planType, seed + 7777);

  return weekWithDiverseMeals.map((day, dayIndex) =>
    rebalanceDayPlanCalories(day, targetCalories, targetProtein, seed + dayIndex * 313, planType),
  );
}
