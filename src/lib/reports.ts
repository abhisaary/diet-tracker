import type {
  MacroTotals,
  MealRecord,
  ReportSummary,
  SymptomRecord,
} from "@/lib/schemas";

const emptyMacros: MacroTotals = {
  calories: 0,
  carbsGrams: 0,
  fatGrams: 0,
  fiberGrams: 0,
  proteinGrams: 0,
};

function getMealMacros(meal: MealRecord): MacroTotals {
  return meal.correctedNutrition ?? meal.nutrition;
}

function addMacros(total: MacroTotals, meal: MealRecord): MacroTotals {
  const macros = getMealMacros(meal);

  return {
    calories: total.calories + macros.calories,
    carbsGrams: total.carbsGrams + macros.carbsGrams,
    fatGrams: total.fatGrams + macros.fatGrams,
    fiberGrams: total.fiberGrams + macros.fiberGrams,
    proteinGrams: total.proteinGrams + macros.proteinGrams,
  };
}

function divideMacros(total: MacroTotals, divisor: number): MacroTotals {
  if (divisor <= 0) {
    return emptyMacros;
  }

  return {
    calories: Math.round(total.calories / divisor),
    carbsGrams: Math.round(total.carbsGrams / divisor),
    fatGrams: Math.round(total.fatGrams / divisor),
    fiberGrams: Math.round(total.fiberGrams / divisor),
    proteinGrams: Math.round(total.proteinGrams / divisor),
  };
}

function daysCovered(meals: MealRecord[], symptoms: SymptomRecord[]) {
  const dates = [
    ...meals.map((meal) => meal.eatenAt),
    ...symptoms.map((symptom) => symptom.occurredAt),
  ].map((value) => value.slice(0, 10));

  return Math.max(new Set(dates).size, 1);
}

function getWeekStart(value: string) {
  const date = new Date(value);
  const day = date.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + diff);

  return date.toISOString().slice(0, 10);
}

function buildWeeklySummaries(
  meals: MealRecord[],
  symptoms: SymptomRecord[],
): ReportSummary["weeklySummaries"] {
  const weeks = new Map<
    string,
    { meals: MealRecord[]; symptoms: SymptomRecord[] }
  >();

  for (const meal of meals) {
    const weekStart = getWeekStart(meal.eatenAt);
    const week = weeks.get(weekStart) ?? { meals: [], symptoms: [] };
    week.meals.push(meal);
    weeks.set(weekStart, week);
  }

  for (const symptom of symptoms) {
    const weekStart = getWeekStart(symptom.occurredAt);
    const week = weeks.get(weekStart) ?? { meals: [], symptoms: [] };
    week.symptoms.push(symptom);
    weeks.set(weekStart, week);
  }

  return [...weeks.entries()]
    .map(([weekStart, week]) => {
      const totals = week.meals.reduce(addMacros, emptyMacros);

      return {
        dailyAverages: divideMacros(totals, 7),
        mealsLogged: week.meals.length,
        symptomsLogged: week.symptoms.length,
        totals,
        weekStart,
      };
    })
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

function buildPossibleAssociations(
  meals: MealRecord[],
  symptoms: SymptomRecord[],
) {
  const triggerCounts = new Map<
    string,
    { mealCount: number; symptomCountWithinSixHours: number }
  >();

  for (const meal of meals) {
    const mealTime = new Date(meal.eatenAt).getTime();
    const triggers = new Set(
      meal.nutrition.possibleTriggers.map((trigger) => trigger.toLowerCase()),
    );

    for (const trigger of triggers) {
      const current = triggerCounts.get(trigger) ?? {
        mealCount: 0,
        symptomCountWithinSixHours: 0,
      };
      const symptomCount = symptoms.filter((symptom) => {
        const symptomTime = new Date(symptom.occurredAt).getTime();
        const hoursAfterMeal = (symptomTime - mealTime) / (1000 * 60 * 60);

        return hoursAfterMeal >= 0 && hoursAfterMeal <= 6;
      }).length;

      triggerCounts.set(trigger, {
        mealCount: current.mealCount + 1,
        symptomCountWithinSixHours:
          current.symptomCountWithinSixHours + symptomCount,
      });
    }
  }

  return [...triggerCounts.entries()]
    .map(([trigger, counts]) => ({
      ...counts,
      note:
        counts.symptomCountWithinSixHours > 0
          ? `${counts.symptomCountWithinSixHours} symptom note(s) were logged within 6 hours of meals tagged ${trigger}.`
          : `No symptom notes were logged within 6 hours of meals tagged ${trigger}.`,
      trigger,
    }))
    .sort(
      (a, b) =>
        b.symptomCountWithinSixHours - a.symptomCountWithinSixHours ||
        b.mealCount - a.mealCount,
    )
    .slice(0, 8);
}

export function buildReportSummary(
  meals: MealRecord[],
  symptoms: SymptomRecord[],
): ReportSummary {
  const sortedMeals = [...meals].sort(
    (a, b) => new Date(b.eatenAt).getTime() - new Date(a.eatenAt).getTime(),
  );
  const sortedSymptoms = [...symptoms].sort(
    (a, b) =>
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  const totals = sortedMeals.reduce(addMacros, emptyMacros);

  return {
    dailyAverages: divideMacros(totals, daysCovered(sortedMeals, sortedSymptoms)),
    generatedAt: new Date().toISOString(),
    meals: sortedMeals,
    mealsLogged: sortedMeals.length,
    possibleAssociations: buildPossibleAssociations(sortedMeals, sortedSymptoms),
    symptoms: sortedSymptoms,
    symptomsLogged: sortedSymptoms.length,
    totals,
    weeklySummaries: buildWeeklySummaries(sortedMeals, sortedSymptoms),
  };
}
