"use client";

import {
  ChangeEvent,
  FormEvent,
  type TouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { CURRENT_PLANT_VARIETY_VERSION } from "@/lib/plant-variety-rules";
import type {
  MealRecord,
  MealSubmission,
  MacroTotals,
  TrackedNutrient,
} from "@/lib/schemas";
import { createBrowserSupabaseClient } from "@/lib/supabase-browser";

type AppStatus = {
  configured: {
    allowedEmail: boolean;
    openai: boolean;
    supabase: boolean;
  };
};

type CoreMacroKey = keyof MacroTotals;
type CustomNutrientItem = TrackedNutrient & {
  amount: number;
  estimatedMeals: number;
};
type MealPhotoDraft = {
  file: File;
  id: string;
  previewUrl: string;
};
type UploadedMealPhoto = {
  fileId: string;
  fileName: string;
};
type UploadedMealPhotosResult = {
  photos: UploadedMealPhoto[];
  uploadDurationsMs: number[];
};
type PlantVariety = NonNullable<
  MealRecord["nutrition"]["plantVarieties"]
>[number];
type IngredientMacroEstimate = NonNullable<
  MealRecord["nutrition"]["macroBreakdown"]
>[number];
type MacroCalorieKey = "carbsGrams" | "fatGrams" | "proteinGrams";
type ActivityLevel = "general" | "very_active";
type SexForEstimate = "female" | "male";
type AnalyticsSection = "nutrition" | "plants" | "timing";
type OnboardingAnnouncement = {
  id: string;
  message: string;
  target: "install" | "meal" | "settings";
  targetLabel: string;
  title: string;
};
type UserProfile = {
  activityLevel: ActivityLevel;
  ageYears?: number;
  heightInches?: number;
  sex?: SexForEstimate;
  weightPounds?: number;
};
type IngredientBreakdownColumn =
  | {
      id: string;
      key: CoreMacroKey;
      kind: "core";
      label: string;
    }
  | {
      id: string;
      kind: "custom";
      label: string;
      nutrient: TrackedNutrient;
    };

const plantBackfillLockKey = `diet-tracker:plant-backfill:${CURRENT_PLANT_VARIETY_VERSION}`;
const plantBackfillLockDurationMs = 10 * 60 * 1000;
const analyticsSections: { id: AnalyticsSection; label: string }[] = [
  { id: "plants", label: "Plants" },
  { id: "timing", label: "Timing" },
  { id: "nutrition", label: "Nutrition" },
];

const onboardingAnnouncements: OnboardingAnnouncement[] = [
  {
    id: "meal-entry-v1",
    message:
      "Add any combination of text and photos that gives the model enough context to estimate your meal. Include approximate portions when they aren’t obvious. If you’re entering a meal later, tell the model when you ate it—for example, “lunch around 1 PM.” It can use your description, images, recent meal history, and online searches for restaurant menus or packaged foods, so you can reference restaurants or products or upload screenshots of menus. Write naturally—the app will clean up and structure your entry, so grammar and formatting don’t matter. Estimates are approximate, and you can correct them afterward.",
    target: "meal",
    targetLabel: "+ Meal",
    title: "Add meals with maximal laziness",
  },
  {
    id: "nutrient-settings-v1",
    message:
      "Customize the nutrients you care about. You can show, hide, and reorder the default nutrients, or add and remove others such as calcium, iron, or cholesterol.",
    target: "settings",
    targetLabel: "Settings",
    title: "Track what matters to you",
  },
  {
    id: "home-screen-v1",
    message:
      "Add Diet Tracker to your iPhone Home Screen so you can open it like an app instead of returning to Safari each time.",
    target: "install",
    targetLabel: "Add to Home Screen",
    title: "Create an app shortcut",
  },
];

function getOnboardingStorageKey(userEmail: string) {
  return `diet-tracker:onboarding:seen:v1:${userEmail.toLowerCase()}`;
}

function findNextOnboardingAnnouncement(
  seenIds: Set<string>,
  isStandaloneApp: boolean,
) {
  if (isStandaloneApp) {
    return undefined;
  }

  return onboardingAnnouncements.find(({ id }) => !seenIds.has(id));
}

function isRunningStandalone() {
  if (typeof window === "undefined") {
    return false;
  }

  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

const coreMacroItems: {
  format: (macros: MacroTotals) => string;
  key: CoreMacroKey;
  label: string;
}[] = [
  {
    format: (macros) => Math.round(macros.calories).toString(),
    key: "calories",
    label: "cal",
  },
  {
    format: (macros) => `${Math.round(macros.proteinGrams)}g`,
    key: "proteinGrams",
    label: "protein",
  },
  {
    format: (macros) => `${Math.round(macros.carbsGrams)}g`,
    key: "carbsGrams",
    label: "carbs",
  },
  {
    format: (macros) => `${Math.round(macros.fatGrams)}g`,
    key: "fatGrams",
    label: "fat",
  },
  {
    format: (macros) => `${Math.round(macros.fiberGrams)}g`,
    key: "fiberGrams",
    label: "fiber",
  },
];

const macroCalorieReferences: {
  key: MacroCalorieKey;
  maxPercent: number;
  minPercent: number;
  strokeColor: string;
}[] = [
  {
    key: "carbsGrams",
    maxPercent: 65,
    minPercent: 45,
    strokeColor: "#38bdf8",
  },
  {
    key: "fatGrams",
    maxPercent: 35,
    minPercent: 20,
    strokeColor: "#fbbf24",
  },
  {
    key: "proteinGrams",
    maxPercent: 35,
    minPercent: 10,
    strokeColor: "#34d399",
  },
];

const fiberChartReference = {
  label: "Fiber",
  maxGrams: 80,
  minGrams: 40,
  strokeColor: "#8b5cf6",
};

const defaultUserProfile: UserProfile = {
  activityLevel: "general",
};

const mealPhotosBucket = "meal-photos";
const maxMealPhotos = 6;

function roundMilliseconds(value: number) {
  return Math.round(value * 10) / 10;
}

function logClientMealLatency({
  metadata,
  operation,
  outcome,
  stages,
  totalMs,
}: {
  metadata: Record<string, number | number[] | string | null>;
  operation: "create" | "edit";
  outcome: "error" | "success";
  stages: Record<string, number | number[]>;
  totalMs: number;
}) {
  console.info(
    "[meal-latency]",
    JSON.stringify({
      metadata,
      operation,
      outcome,
      source: "client",
      stages,
      totalMs,
    }),
  );
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, milliseconds);
  });
}

function getPhotoFileExtension(file: File) {
  const fromName = file.name.split(".").pop()?.toLowerCase();

  if (fromName && fromName !== file.name && /^[a-z0-9]+$/.test(fromName)) {
    return fromName;
  }

  if (file.type === "image/png") {
    return "png";
  }

  if (file.type === "image/webp") {
    return "webp";
  }

  if (file.type === "image/gif") {
    return "gif";
  }

  return "jpg";
}

const proteinReferences: Record<
  ActivityLevel,
  { label: string; maxGramsPerKg: number; minGramsPerKg: number }
> = {
  general: {
    label: "General",
    maxGramsPerKg: 1.2,
    minGramsPerKg: 0.8,
  },
  very_active: {
    label: "Very active",
    maxGramsPerKg: 2.2,
    minGramsPerKg: 1.6,
  },
};

const calorieActivityFactors: Record<ActivityLevel, number> = {
  general: 1.4,
  very_active: 1.725,
};

function getMealMacros(meal: MealRecord): MacroTotals {
  return meal.correctedNutrition ?? meal.nutrition;
}

function getCleanedDescription(meal: MealRecord) {
  return meal.nutrition.cleanedDescription || meal.description;
}

function getMealTitle(meal: MealRecord) {
  return meal.nutrition.mealTitle || getCleanedDescription(meal) || "Meal";
}

function padDatePart(value: number) {
  return value.toString().padStart(2, "0");
}

function formatMealTimeOfDay(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(new Date(value));
}

function getMinutesOfDay(value: string) {
  const date = new Date(value);

  return date.getHours() * 60 + date.getMinutes();
}

function getAverage(values: number[]) {
  return values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function getCircularMeanMinutes(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const radians = values.map((value) => (value / (24 * 60)) * Math.PI * 2);
  const meanSine = getAverage(radians.map(Math.sin)) ?? 0;
  const meanCosine = getAverage(radians.map(Math.cos)) ?? 0;
  const angle = Math.atan2(meanSine, meanCosine);

  return (((angle < 0 ? angle + Math.PI * 2 : angle) / (Math.PI * 2)) * 24 * 60);
}

function formatClockMinutes(value: number | null) {
  if (value === null) {
    return "--";
  }

  const roundedMinutes = Math.round(value / 5) * 5;
  const date = new Date(2000, 0, 1, 0, roundedMinutes);

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function formatDurationMinutes(value: number | null) {
  if (value === null) {
    return "--";
  }

  const roundedMinutes = Math.round(value / 5) * 5;
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatPrimaryIngredientAmount(amount: string) {
  const trimmedAmount = amount.trim();
  const measurementUnits =
    "(?:mg|g|kg|ml|l|oz|lb|grams?|kilograms?|milliliters?|ounces?|pounds?)";
  const measurementValue =
    `(?:about\\s+|approx\\.?\\s+|[~≈]\\s*)?[\\d./\\s–—-]+\\s*${measurementUnits}`;
  const parentheticalMeasurement = new RegExp(
    `\\s*\\(${measurementValue}\\)\\s*$`,
    "i",
  );
  const separatedMeasurement = new RegExp(
    `\\s*(?:\\/|,)\\s*${measurementValue}\\s*$`,
    "i",
  );
  const primaryAmount = trimmedAmount
    .replace(parentheticalMeasurement, "")
    .replace(separatedMeasurement, "")
    .trim();

  return primaryAmount || trimmedAmount;
}

function formatMealDay(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (isSameLocalDay(date, today)) {
    return "Today";
  }

  if (isSameLocalDay(date, yesterday)) {
    return "Yesterday";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "full",
  }).format(date);
}

function getLocalDayKey(value: string) {
  const date = new Date(value);

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-");
}

function isSameLocalDay(first: Date, second: Date) {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function isMealToday(meal: MealRecord) {
  return isSameLocalDay(new Date(meal.eatenAt), new Date());
}

function addLocalDays(date: Date, days: number) {
  const nextDate = new Date(date);
  nextDate.setDate(nextDate.getDate() + days);

  return nextDate;
}

function getPlantVarietyKey(name: string) {
  const normalizedName = name
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const aliases: Record<string, string> = {
    "garbanzo bean": "chickpea",
    "garbanzo beans": "chickpea",
    chickpeas: "chickpea",
    "soy bean": "soybean",
    soybeans: "soybean",
  };

  return aliases[normalizedName] ?? normalizedName;
}

function getUniquePlantCount(meals: MealRecord[]) {
  const plants = new Set<string>();

  for (const meal of meals) {
    for (const variety of meal.nutrition.plantVarieties ?? []) {
      const key = getPlantVarietyKey(variety.name);

      if (key) {
        plants.add(key);
      }
    }
  }

  return plants.size;
}

function getLocalDaySerial(date: Date) {
  return (
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) /
    (24 * 60 * 60 * 1000)
  );
}

function getPlantDiversitySnapshot(
  meals: MealRecord[],
  evaluationDate: Date,
) {
  const evaluationDay = getLocalDaySerial(evaluationDate);
  const latestPlants = new Map<
    string,
    { lastSeenDay: number; variety: PlantVariety }
  >();

  for (const meal of meals) {
    const mealDay = getLocalDaySerial(new Date(meal.eatenAt));

    if (mealDay > evaluationDay) {
      continue;
    }

    for (const variety of meal.nutrition.plantVarieties ?? []) {
      const key = getPlantVarietyKey(variety.name);
      const current = latestPlants.get(key);

      if (key && (!current || mealDay > current.lastSeenDay)) {
        latestPlants.set(key, {
          lastSeenDay: mealDay,
          variety: { ...variety, name: key },
        });
      }
    }
  }

  const activePlants = [...latestPlants.values()]
    .map(({ lastSeenDay, variety }) => {
      const daysSinceSeen = evaluationDay - lastSeenDay;

      return {
        ...variety,
        weight: Math.max(0, 1 - daysSinceSeen / 14),
      };
    })
    .filter((plant) => plant.weight > 0)
    .sort(
      (first, second) =>
        second.weight - first.weight || first.name.localeCompare(second.name),
    );

  return {
    activePlants,
    score: activePlants.reduce((total, plant) => total + plant.weight, 0),
  };
}

function getMealMacroTotals(meals: MealRecord[]): MacroTotals {
  return meals.reduce(
    (totals, meal) => {
      const macros = getMealMacros(meal);

      return {
        calories: totals.calories + macros.calories,
        carbsGrams: totals.carbsGrams + macros.carbsGrams,
        fatGrams: totals.fatGrams + macros.fatGrams,
        fiberGrams: totals.fiberGrams + macros.fiberGrams,
        proteinGrams: totals.proteinGrams + macros.proteinGrams,
      };
    },
    {
      calories: 0,
      carbsGrams: 0,
      fatGrams: 0,
      fiberGrams: 0,
      proteinGrams: 0,
    },
  );
}

function divideMacroTotals(macros: MacroTotals, divisor: number): MacroTotals {
  if (divisor <= 0) {
    return {
      calories: 0,
      carbsGrams: 0,
      fatGrams: 0,
      fiberGrams: 0,
      proteinGrams: 0,
    };
  }

  return {
    calories: macros.calories / divisor,
    carbsGrams: macros.carbsGrams / divisor,
    fatGrams: macros.fatGrams / divisor,
    fiberGrams: macros.fiberGrams / divisor,
    proteinGrams: macros.proteinGrams / divisor,
  };
}

function getMacroCalories(macros: MacroTotals, key: MacroCalorieKey) {
  return key === "fatGrams" ? macros[key] * 9 : macros[key] * 4;
}

function getMacroCaloriePercent(macros: MacroTotals, key: MacroCalorieKey) {
  if (macros.calories <= 0) {
    return null;
  }

  return Math.round((getMacroCalories(macros, key) / macros.calories) * 100);
}

function getRangeStatus(value: number | null, min: number, max: number) {
  if (value === null) {
    return "unknown";
  }

  return value >= min && value <= max ? "in-range" : "out-of-range";
}

function getRangeTextClass(status: "in-range" | "out-of-range" | "unknown") {
  if (status === "in-range") {
    return "font-semibold text-emerald-700";
  }

  if (status === "out-of-range") {
    return "font-semibold text-red-700";
  }

  return "text-slate-500";
}

function getOptionalPositiveNumber(value: unknown) {
  const numberValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;

  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function getHeightInchesFromParts(feet: number | undefined, inches: number | undefined) {
  return feet || inches ? (feet ?? 0) * 12 + (inches ?? 0) : undefined;
}

function isActivityLevel(value: unknown): value is ActivityLevel {
  return value === "general" || value === "very_active";
}

function isSexForEstimate(value: unknown): value is SexForEstimate {
  return value === "female" || value === "male";
}

function parseUserProfile(value: unknown): UserProfile {
  if (!value || typeof value !== "object") {
    return defaultUserProfile;
  }

  return {
    activityLevel:
      "activityLevel" in value && isActivityLevel(value.activityLevel)
        ? value.activityLevel
        : defaultUserProfile.activityLevel,
    ageYears:
      "ageYears" in value ? getOptionalPositiveNumber(value.ageYears) : undefined,
    heightInches:
      "heightInches" in value
        ? getOptionalPositiveNumber(value.heightInches)
        : undefined,
    sex:
      "sex" in value && isSexForEstimate(value.sex) ? value.sex : undefined,
    weightPounds:
      "weightPounds" in value
        ? getOptionalPositiveNumber(value.weightPounds)
        : undefined,
  };
}

function getWeightKg(profile: UserProfile) {
  return profile.weightPounds ? profile.weightPounds / 2.20462 : null;
}

function getProteinGramsPerKg(macros: MacroTotals, profile: UserProfile) {
  const weightKg = getWeightKg(profile);

  return weightKg ? macros.proteinGrams / weightKg : null;
}

function formatGramsPerKg(value: number | null) {
  return value === null ? "--" : `${(Math.round(value * 10) / 10).toFixed(1)}g/kg`;
}

function getEstimatedMaintenanceCalories(profile: UserProfile) {
  if (
    !profile.ageYears ||
    !profile.heightInches ||
    !profile.sex ||
    !profile.weightPounds
  ) {
    return null;
  }

  const weightKg = profile.weightPounds / 2.20462;
  const heightCm = profile.heightInches * 2.54;
  const sexAdjustment = profile.sex === "male" ? 5 : -161;
  const bmr =
    10 * weightKg + 6.25 * heightCm - 5 * profile.ageYears + sexAdjustment;

  return Math.round(bmr * calorieActivityFactors[profile.activityLevel]);
}

function getCalorieReferenceRange(profile: UserProfile) {
  const maintenanceCalories = getEstimatedMaintenanceCalories(profile);

  if (!maintenanceCalories) {
    return null;
  }

  return {
    max: Math.round(maintenanceCalories * 1.15),
    min: Math.round(maintenanceCalories * 0.85),
    target: maintenanceCalories,
  };
}

function isCoreMacroKey(value: unknown): value is CoreMacroKey {
  return (
    typeof value === "string" &&
    coreMacroItems.some((macroItem) => macroItem.key === value)
  );
}

function parseHiddenCoreNutrients(value: unknown): CoreMacroKey[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isCoreMacroKey);
}

function getCoreNutrientId(key: CoreMacroKey) {
  return `core:${key}`;
}

function getCustomNutrientId(nutrient: Pick<TrackedNutrient, "name">) {
  return `custom:${nutrient.name}`;
}

function parseNutrientOrder(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function getDefaultNutrientOrder(trackedNutrients: TrackedNutrient[]) {
  return [
    ...coreMacroItems.map((macroItem) => getCoreNutrientId(macroItem.key)),
    ...trackedNutrients.map(getCustomNutrientId),
  ];
}

function reconcileNutrientOrder(
  order: string[],
  trackedNutrients: TrackedNutrient[],
) {
  const availableIds = new Set(getDefaultNutrientOrder(trackedNutrients));
  const orderedIds = order.filter((item) => availableIds.has(item));
  const missingIds = [...availableIds].filter((item) => !orderedIds.includes(item));

  return [...orderedIds, ...missingIds];
}

function areStringArraysEqual(first: string[], second: string[]) {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

function areTrackedNutrientsEqual(
  first: TrackedNutrient[],
  second: TrackedNutrient[],
) {
  return (
    first.length === second.length &&
    first.every(
      (item, index) =>
        item.name === second[index]?.name && item.unit === second[index]?.unit,
    )
  );
}

function areProfilesEqual(first: UserProfile, second: UserProfile) {
  return (
    first.activityLevel === second.activityLevel &&
    first.ageYears === second.ageYears &&
    first.heightInches === second.heightInches &&
    first.sex === second.sex &&
    first.weightPounds === second.weightPounds
  );
}

function getOrderedNutrientItems({
  customNutrients,
  hiddenCoreNutrients,
  macros,
  nutrientOrder,
}: {
  customNutrients: CustomNutrientItem[];
  hiddenCoreNutrients: CoreMacroKey[];
  macros: MacroTotals;
  nutrientOrder: string[];
}) {
  return reconcileNutrientOrder(nutrientOrder, customNutrients).flatMap((id) => {
    if (id.startsWith("core:")) {
      const key = id.slice("core:".length);

      if (!isCoreMacroKey(key) || hiddenCoreNutrients.includes(key)) {
        return [];
      }

      const macroItem = coreMacroItems.find((item) => item.key === key);

      return macroItem
        ? [
            {
              id,
              label: macroItem.label,
              value: macroItem.format(macros),
            },
          ]
        : [];
    }

    const name = id.slice("custom:".length);
    const nutrient = customNutrients.find(
      (customNutrient) => customNutrient.name === name,
    );

    if (!nutrient) {
      return [];
    }

    return [
      {
        id,
        label: formatNutrientName(nutrient.name),
        value:
          nutrient.estimatedMeals > 0
            ? formatCustomNutrientAmount(nutrient.amount, nutrient.unit)
            : "--",
      },
    ];
  });
}

function getIngredientBreakdownColumns({
  hiddenCoreNutrients,
  nutrientOrder,
  trackedNutrients,
}: {
  hiddenCoreNutrients: CoreMacroKey[];
  nutrientOrder: string[];
  trackedNutrients: TrackedNutrient[];
}): IngredientBreakdownColumn[] {
  return reconcileNutrientOrder(nutrientOrder, trackedNutrients).flatMap<
    IngredientBreakdownColumn
  >((id): IngredientBreakdownColumn[] => {
      if (id.startsWith("core:")) {
        const key = id.slice("core:".length);

        if (!isCoreMacroKey(key) || hiddenCoreNutrients.includes(key)) {
          return [];
        }

        const macroItem = coreMacroItems.find((item) => item.key === key);

        return macroItem
          ? [
              {
                id,
                key,
                kind: "core" as const,
                label: formatNutrientName(macroItem.label),
              },
            ]
          : [];
      }

      const name = id.slice("custom:".length);
      const nutrient = trackedNutrients.find((item) => item.name === name);

      return nutrient
        ? [
            {
              id,
              kind: "custom" as const,
              label: formatNutrientName(nutrient.name),
              nutrient,
            },
          ]
        : [];
  });
}

function formatIngredientBreakdownValue(
  ingredient: IngredientMacroEstimate,
  column: IngredientBreakdownColumn,
) {
  if (column.kind === "core") {
    return (
      coreMacroItems.find((item) => item.key === column.key)?.format(ingredient) ??
      "--"
    );
  }

  const estimate = ingredient.customNutrients?.find(
    (item) =>
      item.name === column.nutrient.name && item.unit === column.nutrient.unit,
  );

  return estimate
    ? formatCustomNutrientAmount(estimate.amount, estimate.unit)
    : "--";
}

function normalizeNutrientName(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function formatNutrientName(value: string) {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferStandardNutrientUnit(name: string) {
  if (name.includes("vitamin d")) {
    return "IU";
  }

  if (
    name.includes("sugar") ||
    name.includes("fiber") ||
    name.includes("fat") ||
    name.includes("protein") ||
    name.includes("carb")
  ) {
    return "g";
  }

  return "mg";
}

function parseTrackedNutrients(value: unknown): TrackedNutrient[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((nutrient) => {
      if (
        !nutrient ||
        typeof nutrient !== "object" ||
        !("name" in nutrient)
      ) {
        return null;
      }

      const name = normalizeNutrientName(String(nutrient.name));
      const unit =
        "unit" in nutrient && nutrient.unit
          ? String(nutrient.unit).trim()
          : inferStandardNutrientUnit(name);

      return name && unit ? { name, unit } : null;
    })
    .filter((nutrient): nutrient is TrackedNutrient => Boolean(nutrient));
}

function parseTrackedNutrientInput(value: string): TrackedNutrient | null {
  const name = normalizeNutrientName(value);

  if (!name) {
    return null;
  }

  return { name, unit: inferStandardNutrientUnit(name) };
}

function getCustomNutrientAmount(meal: MealRecord, nutrient: TrackedNutrient) {
  return (
    meal.nutrition.customNutrients?.find(
      (customNutrient) =>
        normalizeNutrientName(customNutrient.name) === nutrient.name &&
        customNutrient.unit.toLowerCase() === nutrient.unit.toLowerCase(),
    )?.amount ?? null
  );
}

function getCustomNutrientItems(
  meals: MealRecord[],
  trackedNutrients: TrackedNutrient[],
) {
  return trackedNutrients.map((nutrient) => ({
    ...nutrient,
    amount: meals.reduce((total, meal) => {
      const amount = getCustomNutrientAmount(meal, nutrient);

      return amount === null ? total : total + amount;
    }, 0),
    estimatedMeals: meals.filter(
      (meal) => getCustomNutrientAmount(meal, nutrient) !== null,
    ).length,
  }));
}

function formatCustomNutrientAmount(amount: number, unit: string) {
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;

  return `${rounded}${unit === "amount" ? "" : unit}`;
}

function ChevronIcon({ direction }: { direction: "down" | "up" }) {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d={direction === "up" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5" />
      <path d="M14 11v5" />
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h14" />
    </svg>
  );
}

function CautionIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 3 2.5 20h19L12 3Z" />
      <path d="M12 9v5" />
      <path d="M12 17h.01" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <path d="M8 16v-5" />
      <path d="M12 16V8" />
      <path d="M16 16v-3" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
      <path d="M9.9 5.2A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17.2 17.2 0 0 1-3.2 4.1" />
      <path d="M6.1 6.6C3.5 8.2 2 12 2 12s3.5 7 10 7a10.7 10.7 0 0 0 5-1.2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M4 7h10" />
      <path d="M18 7h2" />
      <circle cx="16" cy="7" r="2" />
      <path d="M4 17h2" />
      <path d="M10 17h10" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M12 16V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}

function toStatusMessage(
  kind: "error" | "success" | null,
  message: string | null,
  visible = true,
) {
  if (!kind || !message) {
    return null;
  }

  const className =
    kind === "error"
      ? "border-red-200 bg-red-50 text-red-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700";

  return (
    <div
      className={`rounded-2xl border p-3 text-sm transition-opacity duration-500 ${
        visible ? "opacity-100" : "opacity-0"
      } ${className}`}
    >
      {message}
    </div>
  );
}

export default function Home() {
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const installOnboardingTargetRef = useRef<HTMLButtonElement | null>(null);
  const plantBackfillRunning = useRef(false);
  const mealOnboardingTargetRef = useRef<HTMLButtonElement | null>(null);
  const mealLoadSequenceRef = useRef(0);
  const analyticsSwipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const onboardingModalRef = useRef<HTMLElement | null>(null);
  const settingsOnboardingTargetRef = useRef<HTMLButtonElement | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<"meal" | "symptom" | null>(null);
  const [analyticsOpen, setAnalyticsOpen] = useState(false);
  const [analyticsSection, setAnalyticsSection] =
    useState<AnalyticsSection>("plants");
  const [authPending, setAuthPending] = useState(false);
  const [deletingMealId, setDeletingMealId] = useState<string | null>(null);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [isStandaloneApp, setIsStandaloneApp] = useState(isRunningStandalone);
  const [draftProfile, setDraftProfile] = useState<UserProfile>(defaultUserProfile);
  const [draftHiddenCoreNutrients, setDraftHiddenCoreNutrients] = useState<
    CoreMacroKey[]
  >([]);
  const [draggedNutrientId, setDraggedNutrientId] = useState<string | null>(null);
  const [draftNutrientOrder, setDraftNutrientOrder] = useState<string[]>([]);
  const [draftTrackedNutrients, setDraftTrackedNutrients] = useState<
    TrackedNutrient[]
  >([]);
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  const [expandedMealId, setExpandedMealId] = useState<string | null>(null);
  const [hiddenCoreNutrients, setHiddenCoreNutrients] = useState<CoreMacroKey[]>(
    [],
  );
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [mealCorrections, setMealCorrections] = useState<Record<string, string>>({});
  const [mealPending, setMealPending] = useState(false);
  const [mealPhotos, setMealPhotos] = useState<MealPhotoDraft[]>([]);
  const mealPhotosRef = useRef<MealPhotoDraft[]>([]);
  const [meals, setMeals] = useState<MealRecord[]>([]);
  const [newTrackedNutrient, setNewTrackedNutrient] = useState("");
  const [nutrientOrder, setNutrientOrder] = useState<string[]>([]);
  const [pendingMealSubmissions, setPendingMealSubmissions] = useState<
    MealSubmission[]
  >([]);
  const [profile, setProfile] = useState<UserProfile>(defaultUserProfile);
  const [profilePending, setProfilePending] = useState(false);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
  const [activeOnboardingId, setActiveOnboardingId] = useState<string | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsPending, setSettingsPending] = useState(false);
  const [showFullLog, setShowFullLog] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [messageVisible, setMessageVisible] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [symptomPending, setSymptomPending] = useState(false);
  const [trackedNutrients, setTrackedNutrients] = useState<TrackedNutrient[]>([]);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  function showMessage(nextMessage: { kind: "error" | "success"; text: string }) {
    setMessageVisible(true);
    setMessage(nextMessage);
  }

  function addMealPhotos(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";

    if (!files.length) {
      return;
    }

    const availableSlots = maxMealPhotos - mealPhotosRef.current.length;
    const filesToAdd = files.slice(0, Math.max(availableSlots, 0));
    const additions = filesToAdd.map((file) => ({
      file,
      id: crypto.randomUUID(),
      previewUrl: URL.createObjectURL(file),
    }));
    const nextPhotos = [...mealPhotosRef.current, ...additions];

    mealPhotosRef.current = nextPhotos;
    setMealPhotos(nextPhotos);

    if (files.length > filesToAdd.length) {
      showMessage({
        kind: "error",
        text: `Only ${maxMealPhotos} images can be added to one meal.`,
      });
    }
  }

  function clearMealPhotos() {
    mealPhotosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
    mealPhotosRef.current = [];
    setMealPhotos([]);
  }

  function removeMealPhoto(photoId: string) {
    const photo = mealPhotosRef.current.find((item) => item.id === photoId);

    if (photo) {
      URL.revokeObjectURL(photo.previewUrl);
    }

    const nextPhotos = mealPhotosRef.current.filter((item) => item.id !== photoId);
    mealPhotosRef.current = nextPhotos;
    setMealPhotos(nextPhotos);
  }

  function applyUserSettings(metadata: Record<string, unknown> | undefined) {
    const nextTrackedNutrients = parseTrackedNutrients(
      metadata?.trackedNutrients,
    );
    const nextHiddenCoreNutrients = parseHiddenCoreNutrients(
      metadata?.hiddenCoreNutrients,
    );
    const nextNutrientOrder = reconcileNutrientOrder(
      parseNutrientOrder(metadata?.nutrientOrder),
      nextTrackedNutrients,
    );
    const nextProfile = parseUserProfile(metadata?.userProfile);

    setTrackedNutrients(nextTrackedNutrients);
    setHiddenCoreNutrients(nextHiddenCoreNutrients);
    setNutrientOrder(nextNutrientOrder);
    setProfile(nextProfile);
    setDraftProfile(nextProfile);
    setDraftTrackedNutrients(nextTrackedNutrients);
    setDraftHiddenCoreNutrients(nextHiddenCoreNutrients);
    setDraftNutrientOrder(nextNutrientOrder);
  }

  function activateOnboarding(
    announcement: OnboardingAnnouncement | undefined,
  ) {
    setActiveOnboardingId(announcement?.id ?? null);

    if (announcement?.target === "install") {
      setAccountMenuOpen(true);
    }
  }

  function showFirstUnseenOnboarding(userEmail: string) {
    try {
      const storedIds = JSON.parse(
        window.localStorage.getItem(getOnboardingStorageKey(userEmail)) ?? "[]",
      );
      const seenIds = new Set(
        Array.isArray(storedIds)
          ? storedIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      activateOnboarding(
        findNextOnboardingAnnouncement(seenIds, isStandaloneApp),
      );
    } catch {
      activateOnboarding(
        findNextOnboardingAnnouncement(new Set(), isStandaloneApp),
      );
    }
  }

  function dismissActiveOnboarding() {
    if (!activeOnboardingId || !userEmail) {
      setActiveOnboardingId(null);
      return;
    }

    try {
      const storedIds = JSON.parse(
        window.localStorage.getItem(getOnboardingStorageKey(userEmail)) ?? "[]",
      );
      const seenIds = new Set(
        Array.isArray(storedIds)
          ? storedIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      seenIds.add(activeOnboardingId);
      window.localStorage.setItem(
        getOnboardingStorageKey(userEmail),
        JSON.stringify([...seenIds]),
      );
      activateOnboarding(
        findNextOnboardingAnnouncement(seenIds, isStandaloneApp),
      );
    } catch {
      const availableAnnouncements = isStandaloneApp
        ? []
        : onboardingAnnouncements;
      const activeIndex = availableAnnouncements.findIndex(
        ({ id }) => id === activeOnboardingId,
      );
      activateOnboarding(availableAnnouncements[activeIndex + 1]);
    }
  }

  useEffect(() => {
    fetch("/api/status")
      .then((response) => response.json())
      .then((nextStatus: AppStatus) => setStatus(nextStatus))
      .catch(() => {
        showMessage({ kind: "error", text: "Could not load app status." });
      });

    supabase.auth.getSession().then(({ data }) => {
      const token = data.session?.access_token ?? null;
      const email = data.session?.user.email ?? null;
      setAccessToken(token);
      setUserEmail(email);
      applyUserSettings(data.session?.user.user_metadata);
      if (token && email) {
        showFirstUnseenOnboarding(email);
        loadMeals(token);
      } else {
        setActiveOnboardingId(null);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      const email = session?.user.email ?? null;
      setAccessToken(token);
      setUserEmail(email);
      applyUserSettings(session?.user.user_metadata);
      if (token && email) {
        showFirstUnseenOnboarding(email);
        loadMeals(token);
      } else {
        setActiveOnboardingId(null);
        setDraftHiddenCoreNutrients([]);
        setDraftNutrientOrder([]);
        setDraftTrackedNutrients([]);
        setHiddenCoreNutrients([]);
        setInstallHelpOpen(false);
        setMeals([]);
        setNutrientOrder([]);
        setPendingMealSubmissions([]);
        setProfile(defaultUserProfile);
        setDraftProfile(defaultUserProfile);
        setAccountMenuOpen(false);
        setAnalyticsOpen(false);
        setSettingsOpen(false);
        setTrackedNutrients([]);
      }
    });

    return () => subscription.unsubscribe();
    // Auth bootstrap should only follow this Supabase client instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

  useEffect(() => {
    const displayModeQuery = window.matchMedia("(display-mode: standalone)");
    const updateStandaloneMode = () =>
      setIsStandaloneApp(isRunningStandalone());

    displayModeQuery.addEventListener("change", updateStandaloneMode);

    return () =>
      displayModeQuery.removeEventListener("change", updateStandaloneMode);
  }, []);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    let reconciliationTimers: number[] = [];

    function reconcileStoredMeals() {
      void loadMeals(accessToken, false).catch((error) => {
        console.error("Could not reconcile meals after app resume:", error);
      });
    }

    function refreshMealsAfterResume() {
      if (document.visibilityState !== "visible") {
        return;
      }

      reconciliationTimers.forEach((timer) => window.clearTimeout(timer));
      reconciliationTimers = [0, 15_000, 60_000].map((delay) =>
        window.setTimeout(reconcileStoredMeals, delay),
      );
    }

    document.addEventListener("visibilitychange", refreshMealsAfterResume);

    return () => {
      document.removeEventListener("visibilitychange", refreshMealsAfterResume);
      reconciliationTimers.forEach((timer) => window.clearTimeout(timer));
    };
    // Resume reconciliation should only restart when the authenticated token changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  const hasProcessingMealSubmissions = pendingMealSubmissions.some(
    (submission) => submission.status === "processing",
  );

  useEffect(() => {
    if (!accessToken || !hasProcessingMealSubmissions) {
      return;
    }

    let polling = false;

    async function pollMealSubmissions() {
      if (polling || document.visibilityState !== "visible") {
        return;
      }

      polling = true;

      try {
        await loadMeals(accessToken, false);
      } catch (error) {
        console.error("Could not refresh processing meals:", error);
      } finally {
        polling = false;
      }
    }

    const firstPoll = window.setTimeout(pollMealSubmissions, 1_000);
    const pollInterval = window.setInterval(pollMealSubmissions, 4_000);

    return () => {
      window.clearTimeout(firstPoll);
      window.clearInterval(pollInterval);
    };
    // Polling should restart only when authentication or processing state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, hasProcessingMealSubmissions]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const fadeTimer = window.setTimeout(() => setMessageVisible(false), 3500);
    const clearTimer = window.setTimeout(() => setMessage(null), 4000);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(clearTimer);
    };
  }, [message]);

  useEffect(
    () => () => {
      mealPhotosRef.current.forEach((photo) =>
        URL.revokeObjectURL(photo.previewUrl),
      );
    },
    [],
  );

  useEffect(() => {
    if (
      !settingsOpen &&
      !analyticsOpen &&
      !activeOnboardingId &&
      !installHelpOpen
    ) {
      return;
    }

    const scrollPosition = activeOnboardingId ? 0 : window.scrollY;
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyPosition = document.body.style.position;
    const previousBodyTop = document.body.style.top;
    const previousBodyWidth = document.body.style.width;
    const previousDocumentOverflow = document.documentElement.style.overflow;

    if (activeOnboardingId) {
      window.scrollTo(0, 0);
    }

    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.width = "100%";
    document.documentElement.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.position = previousBodyPosition;
      document.body.style.top = previousBodyTop;
      document.body.style.width = previousBodyWidth;
      document.documentElement.style.overflow = previousDocumentOverflow;
      window.scrollTo(0, scrollPosition);
    };
  }, [activeOnboardingId, analyticsOpen, installHelpOpen, settingsOpen]);

  const missingConfig = status
    ? Object.entries(status.configured)
        .filter(([, configured]) => !configured)
        .map(([name]) => name)
    : [];
  const activeOnboardingAnnouncement =
    onboardingAnnouncements.find(({ id }) => id === activeOnboardingId) ?? null;

  useEffect(() => {
    if (!activeOnboardingAnnouncement) {
      return;
    }

    const modal = onboardingModalRef.current;
    const target =
      activeOnboardingAnnouncement.target === "meal"
        ? mealOnboardingTargetRef.current
        : activeOnboardingAnnouncement.target === "settings"
          ? settingsOnboardingTargetRef.current
          : installOnboardingTargetRef.current;

    if (!modal || !target) {
      return;
    }

    const updateModalTop = () => {
      const targetBottom = target.getBoundingClientRect().bottom;
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      modal.style.setProperty(
        "--onboarding-modal-top",
        `${Math.ceil(targetBottom + 16)}px`,
      );
      modal.style.setProperty(
        "--onboarding-modal-max-height",
        `${Math.max(240, Math.floor(viewportHeight - targetBottom - 32))}px`,
      );
    };
    const frameId = window.requestAnimationFrame(updateModalTop);

    window.addEventListener("resize", updateModalTop);
    window.visualViewport?.addEventListener("resize", updateModalTop);
    window.visualViewport?.addEventListener("scroll", updateModalTop);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", updateModalTop);
      window.visualViewport?.removeEventListener("resize", updateModalTop);
      window.visualViewport?.removeEventListener("scroll", updateModalTop);
    };
  }, [activeOnboardingAnnouncement]);

  function closeSettings() {
    setSettingsOpen(false);
    setNewTrackedNutrient("");
    setDraftHiddenCoreNutrients(hiddenCoreNutrients);
    setDraftNutrientOrder(nutrientOrder);
    setDraftTrackedNutrients(trackedNutrients);
  }

  function openSettings() {
    setAccountMenuOpen(false);
    setAnalyticsOpen(false);
    setDraftHiddenCoreNutrients(hiddenCoreNutrients);
    setDraftNutrientOrder(nutrientOrder);
    setDraftTrackedNutrients(trackedNutrients);
    setNewTrackedNutrient("");
    setSettingsOpen(true);
  }

  function openAnalytics() {
    setAccountMenuOpen(false);
    setSettingsOpen(false);
    setAnalyticsOpen(true);

    if (
      accessToken &&
      meals.some(
        (meal) =>
          meal.nutrition.plantVarietyVersion !==
          CURRENT_PLANT_VARIETY_VERSION,
      )
    ) {
      void backfillPlantVarieties(accessToken);
    }
  }

  function moveAnalyticsSection(direction: -1 | 1) {
    const currentIndex = analyticsSections.findIndex(
      (section) => section.id === analyticsSection,
    );
    const nextIndex = Math.min(
      analyticsSections.length - 1,
      Math.max(0, currentIndex + direction),
    );
    const nextSection = analyticsSections[nextIndex];

    if (nextSection) {
      setAnalyticsSection(nextSection.id);
    }
  }

  function handleAnalyticsTouchStart(event: TouchEvent<HTMLElement>) {
    const touch = event.touches[0];

    analyticsSwipeStartRef.current = touch
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  }

  function handleAnalyticsTouchEnd(event: TouchEvent<HTMLElement>) {
    const start = analyticsSwipeStartRef.current;
    const touch = event.changedTouches[0];

    analyticsSwipeStartRef.current = null;

    if (!start || !touch) {
      return;
    }

    const horizontalDistance = touch.clientX - start.x;
    const verticalDistance = touch.clientY - start.y;

    if (
      Math.abs(horizontalDistance) < 48 ||
      Math.abs(horizontalDistance) <= Math.abs(verticalDistance)
    ) {
      return;
    }

    moveAnalyticsSection(horizontalDistance < 0 ? 1 : -1);
  }

  async function authenticatedFetch(input: RequestInfo, init: RequestInit = {}) {
    const headers = new Headers(init.headers);

    if (accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    return fetch(input, { ...init, headers });
  }

  async function removeUploadedMealPhotos(photos: UploadedMealPhoto[]) {
    if (!photos.length) {
      return;
    }

    await supabase.storage
      .from(mealPhotosBucket)
      .remove(photos.map((photo) => photo.fileId));
  }

  async function uploadMealPhotosToStorage(
    photos: File[],
    userId: string,
  ): Promise<UploadedMealPhotosResult> {
    const uploadId = crypto.randomUUID();
    const pathDate = new Date().toISOString().slice(0, 10);
    const uploadedPhotos: UploadedMealPhoto[] = [];
    const uploadDurationsMs: number[] = [];

    try {
      for (const [index, photo] of photos.entries()) {
        const uploadStartedAt = performance.now();
        const fileName = `${uploadId}-${index + 1}.${getPhotoFileExtension(photo)}`;
        const fileId = `${userId}/${pathDate}/${fileName}`;
        const { error } = await supabase.storage
          .from(mealPhotosBucket)
          .upload(fileId, photo, {
            contentType: photo.type || "image/jpeg",
            upsert: false,
          });

        if (error) {
          throw error;
        }

        uploadedPhotos.push({ fileId, fileName });
        uploadDurationsMs.push(
          roundMilliseconds(performance.now() - uploadStartedAt),
        );
      }
    } catch (error) {
      await removeUploadedMealPhotos(uploadedPhotos);
      throw error;
    }

    return {
      photos: uploadedPhotos,
      uploadDurationsMs,
    };
  }

  async function saveUserSettings() {
    setSettingsPending(true);
    setMessage(null);

    try {
      const { data, error } = await supabase.auth.updateUser({
        data: {
          hiddenCoreNutrients: draftHiddenCoreNutrients,
          nutrientOrder: reconcileNutrientOrder(
            draftNutrientOrder,
            draftTrackedNutrients,
          ),
          trackedNutrients: draftTrackedNutrients,
        },
      });

      if (error) {
        throw error;
      }

      applyUserSettings(data.user.user_metadata);
      setSettingsOpen(false);
      setNewTrackedNutrient("");
    } catch (error) {
      showMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Could not update settings.",
      });
    } finally {
      setSettingsPending(false);
    }
  }

  function updateDraftProfile(updates: Partial<UserProfile>) {
    setDraftProfile((current) => ({ ...current, ...updates }));
  }

  async function saveUserProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfilePending(true);
    setMessage(null);

    try {
      const nextProfile: UserProfile = {
        activityLevel: draftProfile.activityLevel,
        ageYears: draftProfile.ageYears,
        heightInches: draftProfile.heightInches,
        sex: draftProfile.sex,
        weightPounds: draftProfile.weightPounds,
      };
      const { data, error } = await supabase.auth.updateUser({
        data: { userProfile: nextProfile },
      });

      if (error) {
        throw error;
      }

      const savedProfile = parseUserProfile(data.user.user_metadata?.userProfile);
      setProfile(savedProfile);
      setDraftProfile(savedProfile);
    } catch (error) {
      showMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Could not update profile.",
      });
    } finally {
      setProfilePending(false);
    }
  }

  function toggleDraftCoreNutrient(key: CoreMacroKey) {
    setDraftHiddenCoreNutrients((current) =>
      current.includes(key)
        ? current.filter((hiddenKey) => hiddenKey !== key)
        : [...current, key],
    );
  }

  function moveDraftNutrientBefore(draggedId: string, targetId: string) {
    if (draggedId === targetId) {
      return;
    }

    setDraftNutrientOrder((current) => {
      const nextOrder = reconcileNutrientOrder(current, draftTrackedNutrients);
      const draggedIndex = nextOrder.indexOf(draggedId);
      const targetIndex = nextOrder.indexOf(targetId);

      if (draggedIndex === -1 || targetIndex === -1) {
        return nextOrder;
      }

      const reordered = [...nextOrder];
      const [item] = reordered.splice(draggedIndex, 1);
      const adjustedTargetIndex =
        draggedIndex < targetIndex ? targetIndex - 1 : targetIndex;

      reordered.splice(adjustedTargetIndex, 0, item);

      return reordered;
    });
  }

  function addTrackedNutrient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const nutrient = parseTrackedNutrientInput(newTrackedNutrient);

    if (!nutrient) {
      showMessage({ kind: "error", text: "Add a nutrient name first." });
      return;
    }

    const alreadyTracked = draftTrackedNutrients.some(
      (trackedNutrient) => trackedNutrient.name === nutrient.name,
    );

    if (alreadyTracked) {
      showMessage({ kind: "error", text: "That nutrient is already tracked." });
      return;
    }

    setDraftTrackedNutrients((current) => [...current, nutrient]);
    setDraftNutrientOrder((current) => [
      ...reconcileNutrientOrder(current, draftTrackedNutrients),
      getCustomNutrientId(nutrient),
    ]);
    setNewTrackedNutrient("");
  }

  function removeTrackedNutrient(nutrient: TrackedNutrient) {
    setDraftTrackedNutrients((current) =>
      current.filter((trackedNutrient) => trackedNutrient.name !== nutrient.name),
    );
    setDraftNutrientOrder((current) =>
      current.filter((id) => id !== getCustomNutrientId(nutrient)),
    );
  }

  async function backfillPlantVarieties(token: string) {
    if (plantBackfillRunning.current) {
      return;
    }

    const existingLock = Number(
      window.localStorage.getItem(plantBackfillLockKey),
    );

    if (
      Number.isFinite(existingLock) &&
      Date.now() - existingLock < plantBackfillLockDurationMs
    ) {
      return;
    }

    const lockStartedAt = Date.now();
    window.localStorage.setItem(plantBackfillLockKey, String(lockStartedAt));
    plantBackfillRunning.current = true;

    try {
      for (let batchIndex = 0; batchIndex < 50; batchIndex += 1) {
        const response = await fetch("/api/meals/regenerate", {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          method: "PUT",
        });
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error ?? "Could not backfill plant history.");
        }

        if (data.remaining === 0 || data.processed === 0) {
          break;
        }
      }

      await loadMeals(token, false);
    } catch (error) {
      console.error("Plant history backfill failed:", error);
    } finally {
      if (
        window.localStorage.getItem(plantBackfillLockKey) ===
        String(lockStartedAt)
      ) {
        window.localStorage.removeItem(plantBackfillLockKey);
      }
      plantBackfillRunning.current = false;
    }
  }

  function upsertMealSubmission(submission: MealSubmission) {
    setPendingMealSubmissions((current) => [
      submission,
      ...current.filter((item) => item.id !== submission.id),
    ]);
  }

  async function loadMeals(token = accessToken, shouldBackfillPlants = true) {
    if (!token) {
      return;
    }

    const loadSequence = mealLoadSequenceRef.current + 1;
    mealLoadSequenceRef.current = loadSequence;
    const query = shouldBackfillPlants ? "?backfillMissing=1" : "";
    const response = await fetch(`/api/meals${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error ?? "Could not load meals.");
    }

    if (loadSequence !== mealLoadSequenceRef.current) {
      return;
    }

    const nextMeals = data.meals as MealRecord[];
    const storedSubmissions = (data.submissions ?? []) as MealSubmission[];
    setMeals(nextMeals);
    const storedMealIds = new Set(nextMeals.map((meal) => meal.id));
    const storedSubmissionIds = new Set(
      storedSubmissions.map((submission) => submission.id),
    );
    setPendingMealSubmissions((current) => [
      ...storedSubmissions.filter(
        (submission) => !storedMealIds.has(submission.id),
      ),
      ...current.filter(
        (submission) =>
          !storedMealIds.has(submission.id) &&
          !storedSubmissionIds.has(submission.id),
      ),
    ]);

    if (
      shouldBackfillPlants &&
      nextMeals.some(
        (meal) =>
          meal.nutrition.plantVarietyVersion !==
          CURRENT_PLANT_VARIETY_VERSION,
      )
    ) {
      void backfillPlantVarieties(token);
    }
  }

  function updateMealCorrection(mealId: string, correction: string) {
    setMealCorrections((current) => ({ ...current, [mealId]: correction }));
  }

  async function saveMealCorrection(mealId: string) {
    const correction = mealCorrections[mealId]?.trim();

    if (!correction) {
      showMessage({ kind: "error", text: "Add a correction before saving." });
      return;
    }

    const latencyStartedAt = performance.now();
    const latencyStages: Record<string, number | number[]> = {};
    const latencyMetadata: Record<string, number | number[] | string | null> = {
      requestId: null,
      serverTiming: null,
    };
    setSavingMealId(mealId);
    setMessage(null);

    try {
      const apiStartedAt = performance.now();
      const response = await authenticatedFetch("/api/meals", {
        body: JSON.stringify({
          correction,
          id: mealId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "PATCH",
      });
      latencyStages.apiRequestMs = roundMilliseconds(
        performance.now() - apiStartedAt,
      );
      latencyMetadata.requestId =
        response.headers.get("X-Meal-Request-Id");
      latencyMetadata.serverTiming = response.headers.get("Server-Timing");
      const responseParseStartedAt = performance.now();
      const data = await response.json();
      latencyStages.responseParseMs = roundMilliseconds(
        performance.now() - responseParseStartedAt,
      );

      if (!response.ok) {
        throw new Error(data.error ?? "Could not update meal.");
      }

      const refreshStartedAt = performance.now();
      await loadMeals();
      latencyStages.refreshMs = roundMilliseconds(
        performance.now() - refreshStartedAt,
      );
      setEditingMealId(null);
      updateMealCorrection(mealId, "");
      const paintStartedAt = performance.now();
      await waitForNextPaint();
      latencyStages.paintMs = roundMilliseconds(
        performance.now() - paintStartedAt,
      );
      logClientMealLatency({
        metadata: latencyMetadata,
        operation: "edit",
        outcome: "success",
        stages: latencyStages,
        totalMs: roundMilliseconds(performance.now() - latencyStartedAt),
      });
      showMessage({ kind: "success", text: "Correction applied." });
    } catch (error) {
      logClientMealLatency({
        metadata: latencyMetadata,
        operation: "edit",
        outcome: "error",
        stages: latencyStages,
        totalMs: roundMilliseconds(performance.now() - latencyStartedAt),
      });
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not update meal.",
      });
    } finally {
      setSavingMealId(null);
    }
  }

  async function deleteMeal(mealId: string) {
    const meal = meals.find((currentMeal) => currentMeal.id === mealId);
    const confirmed = window.confirm(
      `Delete ${meal ? getMealTitle(meal) : "this meal"}?`,
    );

    if (!confirmed) {
      return;
    }

    setDeletingMealId(mealId);
    setMessage(null);

    try {
      const response = await authenticatedFetch("/api/meals", {
        body: JSON.stringify({ id: mealId }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not delete meal.");
      }

      setEditingMealId((current) => (current === mealId ? null : current));
      setExpandedMealId((current) => (current === mealId ? null : current));
      await loadMeals();
      showMessage({ kind: "success", text: "Meal deleted." });
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not delete meal.",
      });
    } finally {
      setDeletingMealId(null);
    }
  }

  async function dismissMealSubmission(submissionId: string) {
    try {
      const response = await authenticatedFetch("/api/meals", {
        body: JSON.stringify({ id: submissionId, submission: true }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "DELETE",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not dismiss meal.");
      }

      setPendingMealSubmissions((current) =>
        current.filter((submission) => submission.id !== submissionId),
      );
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not dismiss meal.",
      });
    }
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthPending(true);
    setMessage(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });

      if (error) {
        throw error;
      }
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Sign-in failed.",
      });
    } finally {
      setAuthPending(false);
    }
  }

  async function createAccount() {
    setAuthPending(true);
    setMessage(null);

    try {
      const { data, error } = await supabase.auth.signUp({
        email: loginEmail,
        options: {
          emailRedirectTo:
            process.env.NEXT_PUBLIC_APP_URL ?? window.location.origin,
        },
        password: loginPassword,
      });

      if (error) {
        throw error;
      }

      showMessage({
        kind: "success",
        text: data.session
          ? "Account created and signed in."
          : "Account created. Check your email if Supabase requires confirmation, then sign in.",
      });
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not create account.",
      });
    } finally {
      setAuthPending(false);
    }
  }

  async function submitMeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const latencyStartedAt = performance.now();
    const latencyStages: Record<string, number | number[]> = {};
    const latencyMetadata: Record<string, number | number[] | string | null> = {
      requestId: null,
      serverTiming: null,
    };
    let latencyLogged = false;
    setMealPending(true);
    setMessage(null);
    let pendingMealId: string | null = null;
    let requestStarted = false;
    let failureConfirmed = false;
    let persistedFailureReceived = false;
    let uploadedPhotos: UploadedMealPhoto[] = [];

    try {
      const form = event.currentTarget;
      const formData = new FormData(form);
      const description = String(formData.get("description") ?? "").trim();
      const photos = mealPhotosRef.current.map((photo) => photo.file);
      latencyMetadata.photoBytes = photos.reduce(
        (total, photo) => total + photo.size,
        0,
      );
      latencyMetadata.photoCount = photos.length;

      if (!description && !photos.length) {
        showMessage({
          kind: "error",
          text: "Add a meal note or image before saving.",
        });
        return;
      }

      if (photos.length > maxMealPhotos) {
        showMessage({
          kind: "error",
          text: `Add no more than ${maxMealPhotos} images per meal.`,
        });
        return;
      }

      pendingMealId = crypto.randomUUID();
      const submittedAt = new Date().toISOString();
      const pendingMeal: MealSubmission = {
        createdAt: submittedAt,
        description: description || "Image-only meal",
        id: pendingMealId,
        photos: [],
        status: "processing",
        submittedAt,
        updatedAt: submittedAt,
      };

      setPendingMealSubmissions((current) => [pendingMeal, ...current]);
      form.reset();
      clearMealPhotos();
      setActiveForm(null);
      const {
        data: { session },
      } = await (async () => {
        const sessionStartedAt = performance.now();

        try {
          return await supabase.auth.getSession();
        } finally {
          latencyStages.sessionMs = roundMilliseconds(
            performance.now() - sessionStartedAt,
          );
        }
      })();

      if (!session) {
        throw new Error("Sign in before logging a meal.");
      }

      const uploadStartedAt = performance.now();
      const uploadResult = await uploadMealPhotosToStorage(
        photos,
        session.user.id,
      );
      latencyStages.photoUploadMs = roundMilliseconds(
        performance.now() - uploadStartedAt,
      );
      latencyStages.photoUploadsMs = uploadResult.uploadDurationsMs;
      uploadedPhotos = uploadResult.photos;
      const apiStartedAt = performance.now();
      requestStarted = true;
      const mealRequestBody = JSON.stringify({
        clientMealId: pendingMealId,
        description,
        photos: uploadedPhotos,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const sendMealRequest = () =>
        authenticatedFetch("/api/meals", {
          body: mealRequestBody,
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
      let response: Response;

      try {
        response = await sendMealRequest();
      } catch {
        latencyMetadata.transportRetries = 1;
        await wait(1_500);
        response = await sendMealRequest();
      }
      latencyStages.apiRequestMs = roundMilliseconds(
        performance.now() - apiStartedAt,
      );
      latencyMetadata.requestId =
        response.headers.get("X-Meal-Request-Id");
      latencyMetadata.serverTiming = response.headers.get("Server-Timing");
      const responseParseStartedAt = performance.now();
      const data = await response.json().catch(() => ({}));
      latencyStages.responseParseMs = roundMilliseconds(
        performance.now() - responseParseStartedAt,
      );
      const storedSubmission = data.submission as MealSubmission | undefined;

      if (storedSubmission) {
        upsertMealSubmission(storedSubmission);
      }

      if (!response.ok) {
        failureConfirmed = true;
        persistedFailureReceived = storedSubmission?.status === "failed";

        if (!storedSubmission) {
          const cleanupStartedAt = performance.now();
          await removeUploadedMealPhotos(uploadedPhotos);
          latencyStages.photoCleanupMs = roundMilliseconds(
            performance.now() - cleanupStartedAt,
          );
        }

        throw new Error(data.error ?? "Could not log meal.");
      }

      const refreshStartedAt = performance.now();
      await loadMeals(undefined, response.status !== 202);
      latencyStages.refreshMs = roundMilliseconds(
        performance.now() - refreshStartedAt,
      );
      const paintStartedAt = performance.now();
      await waitForNextPaint();
      latencyStages.paintMs = roundMilliseconds(
        performance.now() - paintStartedAt,
      );
      logClientMealLatency({
        metadata: latencyMetadata,
        operation: "create",
        outcome: "success",
        stages: latencyStages,
        totalMs: roundMilliseconds(performance.now() - latencyStartedAt),
      });
      latencyLogged = true;

      if (response.status !== 202) {
        showMessage({ kind: "success", text: "Meal saved." });
      }
    } catch (error) {
      if (!latencyLogged) {
        logClientMealLatency({
          metadata: latencyMetadata,
          operation: "create",
          outcome: "error",
          stages: latencyStages,
          totalMs: roundMilliseconds(performance.now() - latencyStartedAt),
        });
        latencyLogged = true;
      }

      if (
        pendingMealId &&
        (!requestStarted || failureConfirmed) &&
        !persistedFailureReceived
      ) {
        const errorMessage =
          error instanceof Error ? error.message : "Could not log meal.";
        setPendingMealSubmissions((current) =>
          current.map((meal) =>
            meal.id === pendingMealId
              ? {
                  ...meal,
                  errorMessage,
                  status: "failed",
                  updatedAt: new Date().toISOString(),
                }
              : meal,
          ),
        );
      }

      if (requestStarted && !failureConfirmed) {
        void loadMeals(undefined, false).catch(() => undefined);
      } else {
        showMessage({
          kind: "error",
          text: error instanceof Error ? error.message : "Could not log meal.",
        });
      }
    } finally {
      setMealPending(false);
    }
  }

  async function submitSymptom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSymptomPending(true);
    setMessage(null);

    try {
      const form = event.currentTarget;
      const formData = new FormData(form);
      const response = await authenticatedFetch("/api/symptoms", {
        body: formData,
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not log symptom.");
      }

      form.reset();
      setActiveForm(null);
      showMessage({ kind: "success", text: "Symptom saved." });
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not log symptom.",
      });
    } finally {
      setSymptomPending(false);
    }
  }

  const todayMeals = meals.filter(isMealToday);
  const todayMacros = getMealMacroTotals(todayMeals);
  const todayCustomNutrients = getCustomNutrientItems(
    todayMeals,
    trackedNutrients,
  );
  const todayDayKey = getLocalDayKey(new Date().toISOString());
  const currentDay = new Date();
  const thirtyDayStartKey = getLocalDayKey(addLocalDays(currentDay, -29).toISOString());
  const sevenDayKeys = Array.from({ length: 7 }, (_, index) =>
    getLocalDayKey(addLocalDays(currentDay, index - 6).toISOString()),
  );
  const savedNutrientOrder = reconcileNutrientOrder(
    nutrientOrder,
    trackedNutrients,
  );
  const draftSavedNutrientOrder = reconcileNutrientOrder(
    draftNutrientOrder,
    draftTrackedNutrients,
  );
  const settingsChanged =
    !areStringArraysEqual(hiddenCoreNutrients, draftHiddenCoreNutrients) ||
    !areStringArraysEqual(savedNutrientOrder, draftSavedNutrientOrder) ||
    !areTrackedNutrientsEqual(trackedNutrients, draftTrackedNutrients);
  const profileChanged = !areProfilesEqual(profile, draftProfile);
  const mealsByDay = meals.reduce<
    { dayKey: string; dayLabel: string; meals: MealRecord[] }[]
  >((groups, meal) => {
    const dayKey = getLocalDayKey(meal.eatenAt);
    const existingGroup = groups.find((group) => group.dayKey === dayKey);

    if (existingGroup) {
      existingGroup.meals.push(meal);
      return groups;
    }

    groups.push({
      dayKey,
      dayLabel: formatMealDay(meal.eatenAt),
      meals: [meal],
    });

    return groups;
  }, []);
  const historyMealsByDay = mealsByDay.filter(
    (group) => group.dayKey !== todayDayKey,
  );
  const mealsByDayKey = mealsByDay.reduce<Record<string, MealRecord[]>>(
    (groups, group) => ({
      ...groups,
      [group.dayKey]: group.meals,
    }),
    {},
  );
  const thirtyDayMealsByDay = mealsByDay.filter(
    (group) => group.dayKey >= thirtyDayStartKey && group.meals.length > 0,
  );
  const thirtyDayMealCount = thirtyDayMealsByDay.reduce(
    (count, group) => count + group.meals.length,
    0,
  );
  const thirtyDayLoggedDays = thirtyDayMealsByDay.length;
  const thirtyDayAverageMacros = divideMacroTotals(
    getMealMacroTotals(thirtyDayMealsByDay.flatMap((group) => group.meals)),
    thirtyDayLoggedDays,
  );
  const thirtyDayAverageCustomNutrients = getCustomNutrientItems(
    thirtyDayMealsByDay.flatMap((group) => group.meals),
    trackedNutrients,
  ).map((nutrient) => ({
    ...nutrient,
    amount:
      thirtyDayLoggedDays > 0 ? nutrient.amount / thirtyDayLoggedDays : 0,
  }));
  const sevenDayMacroRows = sevenDayKeys.map((dayKey) => {
    const dayMeals = mealsByDayKey[dayKey] ?? [];
    const macros = getMealMacroTotals(dayMeals);

    return {
      dayKey,
      macros,
      mealCount: dayMeals.length,
    };
  });
  const thirtyDayChrononutritionDays = thirtyDayMealsByDay.map((group) => {
    const mealsByTime = [...group.meals].sort(
      (first, second) =>
        new Date(first.eatenAt).getTime() - new Date(second.eatenAt).getTime(),
    );
    const mealTimes = mealsByTime.map((meal) =>
      new Date(meal.eatenAt).getTime(),
    );
    const firstMeal = mealsByTime[0];
    const lastMeal = mealsByTime[mealsByTime.length - 1];
    const gaps = mealTimes.slice(1).map((time, index) => {
      const previousTime = mealTimes[index];

      return previousTime === undefined ? 0 : (time - previousTime) / 60_000;
    });

    return {
      firstMinutes: firstMeal ? getMinutesOfDay(firstMeal.eatenAt) : null,
      gaps: gaps.filter((gap) => gap > 0),
      lastMinutes: lastMeal ? getMinutesOfDay(lastMeal.eatenAt) : null,
      windowMinutes:
        mealTimes.length > 1
          ? (mealTimes[mealTimes.length - 1] - mealTimes[0]) / 60_000
          : null,
    };
  });
  const firstMealMinutes = thirtyDayChrononutritionDays.flatMap((day) =>
    day.firstMinutes === null ? [] : [day.firstMinutes],
  );
  const lastMealMinutes = thirtyDayChrononutritionDays.flatMap((day) =>
    day.lastMinutes === null ? [] : [day.lastMinutes],
  );
  const eatingWindowMinutes = thirtyDayChrononutritionDays.flatMap((day) =>
    day.windowMinutes === null ? [] : [day.windowMinutes],
  );
  const intermealGapMinutes = thirtyDayChrononutritionDays.flatMap(
    (day) => day.gaps,
  );
  const chrononutritionMetrics = [
    {
      detail: "first meal",
      id: "first-meal",
      value: formatClockMinutes(getCircularMeanMinutes(firstMealMinutes)),
    },
    {
      detail: "last meal",
      id: "last-meal",
      value: formatClockMinutes(getCircularMeanMinutes(lastMealMinutes)),
    },
    {
      detail: "eating window",
      id: "eating-window",
      value: formatDurationMinutes(getAverage(eatingWindowMinutes)),
    },
    {
      detail: "between meals",
      id: "intermeal-gap",
      value: formatDurationMinutes(getAverage(intermealGapMinutes)),
    },
  ];
  const sevenDayMealTimingRows = sevenDayKeys.map((dayKey) => {
    const mealMinutes = (mealsByDayKey[dayKey] ?? [])
      .map((meal) => getMinutesOfDay(meal.eatenAt))
      .sort((first, second) => first - second);

    return {
      date: new Date(`${dayKey}T12:00:00`),
      dayKey,
      firstMinutes: mealMinutes[0] ?? null,
      lastMinutes: mealMinutes[mealMinutes.length - 1] ?? null,
    };
  });
  const calorieReference = getCalorieReferenceRange(profile);
  const proteinReference = proteinReferences[profile.activityLevel];
  const proteinGramsPerKg = getProteinGramsPerKg(
    thirtyDayAverageMacros,
    profile,
  );
  const thirtyDayNutritionMetrics = [
    ...coreMacroItems
      .filter((macroItem) => !hiddenCoreNutrients.includes(macroItem.key))
      .map((macroItem) => {
        const macroReference = macroCalorieReferences.find(
          (reference) => reference.key === macroItem.key,
        );
        const caloriePercent = macroReference
          ? getMacroCaloriePercent(thirtyDayAverageMacros, macroReference.key)
          : null;
        let detail = "daily average";
        let referenceMax: number | undefined;
        let referenceMin: number | undefined;
        let status: "in-range" | "out-of-range" | "unknown" = "unknown";
        let strokeColor = "#64748b";
        let trendPoints = sevenDayMacroRows.map((row) => ({
          dayKey: row.dayKey,
          value: row.mealCount > 0 ? row.macros.calories : null,
        }));

        if (macroItem.key === "calories") {
          detail = calorieReference
            ? `~${calorieReference.target} target`
            : "kcal/day";
          status = calorieReference
            ? getRangeStatus(
                thirtyDayAverageMacros.calories,
                calorieReference.min,
                calorieReference.max,
              )
            : "unknown";
          referenceMax = calorieReference?.max;
          referenceMin = calorieReference?.min;
          strokeColor = "#0ea5e9";
        } else if (macroItem.key === "proteinGrams") {
          detail = profile.weightPounds
            ? formatGramsPerKg(proteinGramsPerKg)
            : "g/day";
          status = profile.weightPounds
            ? getRangeStatus(
                proteinGramsPerKg,
                proteinReference.minGramsPerKg,
                proteinReference.maxGramsPerKg,
              )
            : "unknown";
          referenceMax = profile.weightPounds
            ? proteinReference.maxGramsPerKg
            : undefined;
          referenceMin = profile.weightPounds
            ? proteinReference.minGramsPerKg
            : undefined;
          strokeColor = macroReference?.strokeColor ?? "#34d399";
          trendPoints = sevenDayMacroRows.map((row) => ({
            dayKey: row.dayKey,
            value:
              row.mealCount > 0
                ? profile.weightPounds
                  ? getProteinGramsPerKg(row.macros, profile)
                  : row.macros.proteinGrams
                : null,
          }));
        } else if (macroItem.key === "fiberGrams") {
          detail = "g/day";
          status = getRangeStatus(
            thirtyDayAverageMacros.fiberGrams,
            fiberChartReference.minGrams,
            fiberChartReference.maxGrams,
          );
          referenceMax = fiberChartReference.maxGrams;
          referenceMin = fiberChartReference.minGrams;
          strokeColor = fiberChartReference.strokeColor;
          trendPoints = sevenDayMacroRows.map((row) => ({
            dayKey: row.dayKey,
            value: row.mealCount > 0 ? row.macros.fiberGrams : null,
          }));
        } else if (macroReference) {
          detail =
            caloriePercent === null ? "daily average" : `${caloriePercent}% kcal`;
          status = getRangeStatus(
            caloriePercent,
            macroReference.minPercent,
            macroReference.maxPercent,
          );
          referenceMax = macroReference.maxPercent;
          referenceMin = macroReference.minPercent;
          strokeColor = macroReference.strokeColor;
          trendPoints = sevenDayMacroRows.map((row) => ({
            dayKey: row.dayKey,
            value:
              row.mealCount > 0
                ? getMacroCaloriePercent(row.macros, macroReference.key)
                : null,
          }));
        }

        return {
          detail,
          id: macroItem.key,
          label: formatNutrientName(macroItem.label),
          referenceMax,
          referenceMin,
          status,
          strokeColor,
          trendPoints,
          value: macroItem.format(thirtyDayAverageMacros),
        };
      }),
    ...thirtyDayAverageCustomNutrients.map((nutrient) => {
      const trendPoints = sevenDayKeys.map((dayKey) => {
        const dayMeals = mealsByDayKey[dayKey] ?? [];
        const trendNutrient = getCustomNutrientItems(
          dayMeals,
          [nutrient],
        )[0];

        return {
          dayKey,
          value:
            dayMeals.length > 0 && trendNutrient.estimatedMeals > 0
              ? trendNutrient.amount
              : null,
        };
      });

      return {
        detail:
          nutrient.unit === "amount" ? "amount/day" : `${nutrient.unit}/day`,
        id: `${nutrient.name}-${nutrient.unit}`,
        label: formatNutrientName(nutrient.name),
        referenceMax: undefined,
        referenceMin: undefined,
        status: "unknown" as const,
        strokeColor: "#64748b",
        trendPoints,
        value:
          nutrient.estimatedMeals > 0
            ? formatCustomNutrientAmount(nutrient.amount, nutrient.unit)
            : "--",
      };
    }),
  ];
  const plantDiversityAnalysis = useMemo(() => {
    const referenceDate = new Date(`${todayDayKey}T12:00:00`);
    const analyzedMealDays = meals
      .filter((meal) => meal.nutrition.plantVarieties !== undefined)
      .map((meal) => getLocalDaySerial(new Date(meal.eatenAt)));
    const firstAnalyzedDay =
      analyzedMealDays.length > 0 ? Math.min(...analyzedMealDays) : null;
    const points = Array.from({ length: 56 }, (_, index) => {
      const date = addLocalDays(referenceDate, index - 55);
      const snapshot = getPlantDiversitySnapshot(meals, date);
      const hasTrackingData =
        firstAnalyzedDay !== null &&
        getLocalDaySerial(date) >= firstAnalyzedDay;

      return {
        date,
        dayKey: getLocalDayKey(date.toISOString()),
        snapshot,
        value: hasTrackingData ? snapshot.score : null,
      };
    });
    const firstTrackedPointIndex = points.findIndex(
      (point) => point.value !== null,
    );
    const chartPoints =
      firstTrackedPointIndex === -1
        ? []
        : points.slice(firstTrackedPointIndex);

    return {
      chartPoints,
      chartWidthPercent: Math.max(
        35,
        (chartPoints.length / points.length) * 100,
      ),
      current: points[points.length - 1].snapshot,
    };
  }, [meals, todayDayKey]);
  const draftHeightFeet = draftProfile.heightInches
    ? Math.floor(draftProfile.heightInches / 12)
    : "";
  const draftHeightInchesRemainder = draftProfile.heightInches
    ? Math.round((draftProfile.heightInches % 12) * 10) / 10
    : "";

  function renderNutrientGrid({
    customNutrients,
    macros,
    className = "",
    empty = false,
    plantCount,
  }: {
    customNutrients: CustomNutrientItem[];
    macros: MacroTotals;
    className?: string;
    empty?: boolean;
    plantCount?: number;
  }) {
    const nutrientItems = getOrderedNutrientItems({
      customNutrients,
      hiddenCoreNutrients,
      macros,
      nutrientOrder,
    });

    if (nutrientItems.length === 0 && plantCount === undefined) {
      return null;
    }

    return (
      <div
        className={`flex flex-wrap items-start gap-x-6 gap-y-2 text-xs ${className}`}
      >
        {nutrientItems.map(({ id, label, value }) => (
          <div className="min-w-14 max-w-24" key={id}>
            <p className="truncate font-semibold leading-tight">
              {empty ? "--" : value}
            </p>
            <p className="truncate text-[11px] leading-tight text-slate-500">
              {label}
            </p>
          </div>
        ))}
        {plantCount !== undefined ? (
          <div className="min-w-14 max-w-24">
            <p className="truncate font-semibold leading-tight">
              {empty ? "--" : plantCount}
            </p>
            <p className="truncate text-[11px] leading-tight text-slate-500">
              plant varieties
            </p>
          </div>
        ) : null}
      </div>
    );
  }

  function renderMiniTrendChart({
    points,
    referenceMax,
    referenceMin,
    strokeColor,
  }: {
    points: { dayKey: string; value: number | null }[];
    referenceMax?: number;
    referenceMin?: number;
    strokeColor: string;
  }) {
    const values = points
      .map((point) => point.value)
      .filter((value): value is number => value !== null);

    if (values.length === 0) {
      return (
        <p className="mt-1 text-[10px] leading-4 text-slate-400">
          No 7-day data
        </p>
      );
    }

    const bounds = {
      bottom: 30,
      height: 24,
      left: 0,
      right: 220,
      top: 6,
      width: 220,
    };
    const maxValue = Math.max(...values, referenceMax ?? 0, 1);
    const yMax = Math.max(1, maxValue * 1.18);
    const xStep = bounds.width / Math.max(points.length - 1, 1);
    const yForValue = (value: number) =>
      bounds.bottom - Math.min(Math.max(value, 0), yMax) * (bounds.height / yMax);
    const chartPoints = points.flatMap((point, index) =>
      point.value === null
        ? []
        : [
            {
              ...point,
              x: bounds.left + index * xStep,
              y: yForValue(point.value),
            },
          ],
    );
    const referenceTop =
      referenceMax === undefined ? null : yForValue(referenceMax);
    const referenceBottom =
      referenceMin === undefined ? null : yForValue(referenceMin);

    return (
      <svg
        aria-label="Last 7 days trend"
        className="h-auto w-full overflow-visible"
        role="img"
        viewBox="0 0 220 36"
      >
        <line
          className="stroke-slate-200"
          vectorEffect="non-scaling-stroke"
          x1={bounds.left}
          x2={bounds.left}
          y1={bounds.top}
          y2={bounds.bottom}
        />
        <line
          className="stroke-slate-200"
          vectorEffect="non-scaling-stroke"
          x1={bounds.left}
          x2={bounds.right}
          y1={bounds.bottom}
          y2={bounds.bottom}
        />
        {referenceTop !== null && referenceBottom !== null ? (
          <rect
            fill={strokeColor}
            fillOpacity="0.14"
            height={referenceBottom - referenceTop}
            width={bounds.width}
            x={bounds.left}
            y={referenceTop}
          />
        ) : null}
        {chartPoints.length > 1 ? (
          <polyline
            fill="none"
            points={chartPoints.map((point) => `${point.x},${point.y}`).join(" ")}
            stroke={strokeColor}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {chartPoints.map((point) => (
          <circle
            cx={point.x}
            cy={point.y}
            fill={strokeColor}
            key={point.dayKey}
            r="2.75"
            stroke="white"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
    );
  }

  function renderMealTimingChart(
    points: {
      date: Date;
      dayKey: string;
      firstMinutes: number | null;
      lastMinutes: number | null;
    }[],
  ) {
    const bounds = {
      bottom: 87,
      left: 34,
      right: 296,
      top: 5,
      width: 262,
    };
    const rowHeight = 11;
    const xForMinutes = (minutes: number) =>
      bounds.left + (minutes / (24 * 60)) * bounds.width;

    return (
      <svg
        aria-label="First to last meal for the last 7 days"
        className="h-auto w-full overflow-visible"
        role="img"
        viewBox="0 0 300 100"
      >
        {points.map((point, index) => {
          const y = bounds.top + index * rowHeight + 4;

          return (
            <g key={point.dayKey}>
              <text
                fill="#94a3b8"
                fontSize="7"
                textAnchor="start"
                x="0"
                y={y + 2}
              >
                {new Intl.DateTimeFormat(undefined, {
                  weekday: "short",
                }).format(point.date)}
              </text>
              <line
                stroke="#e2e8f0"
                strokeLinecap="round"
                strokeWidth="2"
                x1={bounds.left}
                x2={bounds.right}
                y1={y}
                y2={y}
              />
              {point.firstMinutes !== null && point.lastMinutes !== null ? (
                <>
                  <line
                    stroke="#0ea5e9"
                    strokeLinecap="round"
                    strokeWidth="4"
                    x1={xForMinutes(point.firstMinutes)}
                    x2={xForMinutes(point.lastMinutes)}
                    y1={y}
                    y2={y}
                  />
                  <circle
                    cx={xForMinutes(point.firstMinutes)}
                    cy={y}
                    fill="#0369a1"
                    r="2.5"
                  />
                  <circle
                    cx={xForMinutes(point.lastMinutes)}
                    cy={y}
                    fill="#0369a1"
                    r="2.5"
                  />
                </>
              ) : null}
            </g>
          );
        })}
        {[0, 12 * 60, 24 * 60].map((minutes) => {
          const x = xForMinutes(minutes);

          return (
            <g key={minutes}>
              <line
                stroke="#cbd5e1"
                strokeWidth="1"
                x1={x}
                x2={x}
                y1={bounds.bottom - 3}
                y2={bounds.bottom + 1}
              />
              <text
                fill="#94a3b8"
                fontSize="7"
                textAnchor={
                  minutes === 0
                    ? "start"
                    : minutes === 24 * 60
                      ? "end"
                      : "middle"
                }
                x={x}
                y="98"
              >
                {minutes === 12 * 60 ? "12p" : "12a"}
              </text>
            </g>
          );
        })}
      </svg>
    );
  }

  function renderPlantDiversityChart(
    points: {
      date: Date;
      dayKey: string;
      value: number | null;
    }[],
  ) {
    const values = points
      .map((point) => point.value)
      .filter((value): value is number => value !== null);

    if (values.length === 0) {
      return (
        <p className="text-xs text-slate-400">No history yet.</p>
      );
    }

    const bounds = {
      bottom: 44,
      height: 40,
      left: 2,
      right: 298,
      top: 4,
      width: 296,
    };
    const yMax = Math.max(5, Math.ceil(Math.max(...values) * 1.15));
    const xStep = bounds.width / Math.max(points.length - 1, 1);
    const yForValue = (value: number) =>
      bounds.bottom - Math.min(Math.max(value, 0), yMax) * (bounds.height / yMax);
    const chartPoints = points.flatMap((point, index) =>
      point.value === null
        ? []
        : [
            {
              ...point,
              x: bounds.left + index * xStep,
              y: yForValue(point.value),
            },
          ],
    );
    const lastPoint = chartPoints[chartPoints.length - 1];
    const weeklyTickIndexes: number[] = [];

    for (let index = points.length - 1; index >= 0; index -= 7) {
      weeklyTickIndexes.unshift(index);
    }

    return (
      <svg
        aria-label="Weekly plant diversity trend"
        className="h-auto w-full overflow-visible"
        role="img"
        viewBox="0 0 300 64"
      >
        <line
          className="stroke-slate-200"
          vectorEffect="non-scaling-stroke"
          x1={bounds.left}
          x2={bounds.right}
          y1={bounds.bottom}
          y2={bounds.bottom}
        />
        {weeklyTickIndexes.map((index) => {
          const point = points[index];
          const x = bounds.left + index * xStep;

          return (
            <g key={point.dayKey}>
              <line
                className="stroke-slate-300"
                vectorEffect="non-scaling-stroke"
                x1={x}
                x2={x}
                y1={bounds.bottom}
                y2={bounds.bottom + 4}
              />
              <text
                fill="#94a3b8"
                fontSize="7"
                textAnchor={
                  index === 0
                    ? "start"
                    : index === points.length - 1
                      ? "end"
                      : "middle"
                }
                x={x}
                y="60"
              >
                {new Intl.DateTimeFormat(undefined, {
                  month: "numeric",
                  day: "numeric",
                }).format(point.date)}
              </text>
            </g>
          );
        })}
        {chartPoints.length > 1 ? (
          <polyline
            fill="none"
            points={chartPoints.map((point) => `${point.x},${point.y}`).join(" ")}
            stroke="#10b981"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.5"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
        {lastPoint ? (
          <circle
            cx={lastPoint.x}
            cy={lastPoint.y}
            fill="#10b981"
            r="3.5"
            stroke="white"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
    );
  }

  function renderPendingMealCard(meal: MealSubmission) {
    const isError = meal.status === "failed";

    return (
      <article
        className={`rounded-2xl border p-3 ${
          isError
            ? "border-red-100 bg-red-50"
            : "border-slate-200 bg-slate-50"
        }`}
        key={meal.id}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-base font-semibold text-slate-950">
              {meal.description}
            </h3>
            <p className="mt-1 text-xs font-medium text-slate-500">
              {formatMealTimeOfDay(meal.createdAt)}
            </p>
            {renderProcessingPill(
              isError ? "Could not estimate meal" : "Estimating nutrition...",
              isError,
            )}
          </div>
          {isError ? (
            <button
              className="rounded-full px-2 py-1 text-xs font-semibold text-red-600"
              onClick={() => void dismissMealSubmission(meal.id)}
              type="button"
            >
              Dismiss
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  function renderProcessingPill(label: string, isError = false) {
    return (
      <div
        className={`mt-3 inline-flex items-center gap-2 rounded-full bg-white px-3 py-1 text-xs font-semibold ${
          isError ? "text-red-700" : "text-emerald-700"
        }`}
      >
        {isError ? null : (
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-emerald-200 border-t-emerald-600" />
        )}
        {label}
      </div>
    );
  }

  function renderMealCard(meal: MealRecord) {
    const macros = getMealMacros(meal);
    const customNutrients = getCustomNutrientItems([meal], trackedNutrients);
    const ingredients =
      meal.nutrition.ingredientEstimates?.length
        ? meal.nutrition.ingredientEstimates
        : meal.nutrition.notableIngredients.map((name) => ({
            amount: "estimated amount",
            name,
          }));
    const macroBreakdown = meal.nutrition.macroBreakdown ?? [];
    const ingredientBreakdownColumns = getIngredientBreakdownColumns({
      hiddenCoreNutrients,
      nutrientOrder,
      trackedNutrients,
    });
    const cautions = meal.nutrition.cautions ?? [];
    const isEditing = editingMealId === meal.id;
    const isExpanded = expandedMealId === meal.id || isEditing;

    return (
      <article
        className={`relative rounded-2xl border bg-slate-50 p-3 ${
          cautions.length > 0
            ? "border-amber-200 shadow-[0_0_0_1px_rgba(251,191,36,0.14)]"
            : "border-slate-100"
        }`}
        key={meal.id}
      >
        {cautions.length > 0 ? (
          <span
            aria-label="Meal caution"
            className="absolute -right-1.5 -top-1.5 rounded-full border border-amber-200 bg-white p-1.5 text-amber-600 shadow-sm"
            title="Meal caution"
          >
            <CautionIcon />
          </span>
        ) : null}
        <div className="flex items-start gap-2">
          <button
            className="min-w-0 flex-1 text-left"
            aria-label={`${isExpanded ? "Collapse" : "Expand"} ${getMealTitle(meal)}`}
            onClick={() => setExpandedMealId(isExpanded ? null : meal.id)}
            type="button"
          >
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-slate-950">
                {getMealTitle(meal)}
              </h3>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {formatMealTimeOfDay(meal.eatenAt)}
              </p>
            </div>
            {renderNutrientGrid({
              className: "mt-2",
              customNutrients,
              macros,
            })}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <button
              aria-label={`${isExpanded ? "Collapse" : "Expand"} ${getMealTitle(meal)}`}
              className="rounded-full p-1 text-slate-500"
              onClick={() => setExpandedMealId(isExpanded ? null : meal.id)}
              type="button"
            >
              <ChevronIcon direction={isExpanded ? "up" : "down"} />
            </button>
          </div>
        </div>

        {isExpanded ? (
          <div className="mt-3 border-t border-slate-200 pt-3">
            {!isEditing ? (
              <>
                <div className="flex items-start gap-3">
                  <p className="min-w-0 flex-1 text-sm leading-6 text-slate-700">
                    {getCleanedDescription(meal)}
                  </p>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      aria-label={`Edit ${getMealTitle(meal)}`}
                      className="rounded-full p-1 text-slate-600"
                      onClick={() => {
                        setEditingMealId(meal.id);
                        setExpandedMealId(meal.id);
                      }}
                      title="Edit"
                      type="button"
                    >
                      <PencilIcon />
                    </button>
                    <button
                      aria-label={`Delete ${getMealTitle(meal)}`}
                      className="rounded-full p-1 text-red-600 disabled:opacity-50"
                      disabled={deletingMealId === meal.id}
                      onClick={() => deleteMeal(meal.id)}
                      title="Delete"
                      type="button"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>

                {cautions.length > 0 ? (
                  <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                    <div className="space-y-3">
                      {cautions.map((caution) => (
                        <div key={`${caution.label}-${caution.description}`}>
                          <p className="font-semibold">{caution.label}</p>
                          <p className="mt-1 leading-5">{caution.description}</p>
                          {caution.ingredients.length > 0 ? (
                            <p className="mt-1 text-xs opacity-80">
                              Main culprits: {caution.ingredients.join(", ")}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {macroBreakdown.length > 0 ? (
                  <details className="mt-4 rounded-2xl border border-slate-200 bg-white">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">
                      Ingredient macro breakdown
                    </summary>
                    <div className="overflow-x-auto border-t border-slate-100">
                      <table className="min-w-max text-left text-xs text-slate-700">
                        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="sticky left-0 z-20 min-w-36 max-w-48 bg-slate-50 px-3 py-2 font-semibold shadow-[1px_0_0_0_#e2e8f0]">
                              Ingredient
                            </th>
                            <th className="whitespace-nowrap px-3 py-2 font-semibold">
                              Amount
                            </th>
                            {ingredientBreakdownColumns.map((column) => (
                              <th
                                className="min-w-16 whitespace-nowrap px-3 py-2 text-right font-semibold"
                                key={column.id}
                              >
                                {column.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {macroBreakdown.map((ingredient) => (
                            <tr
                              className="border-t border-slate-100"
                              key={`${ingredient.name}-${ingredient.amount}`}
                            >
                              <td className="sticky left-0 z-10 min-w-36 max-w-48 bg-white px-3 py-2 font-medium text-slate-950 shadow-[1px_0_0_0_#e2e8f0]">
                                {ingredient.name}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2">
                                {ingredient.amount}
                              </td>
                              {ingredientBreakdownColumns.map((column) => (
                                <td
                                  className="whitespace-nowrap px-3 py-2 text-right"
                                  key={column.id}
                                >
                                  {formatIngredientBreakdownValue(
                                    ingredient,
                                    column,
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Ingredients
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-slate-700">
                    {ingredients.map((ingredient) => (
                      <li key={`${ingredient.name}-${ingredient.amount}`}>
                        {ingredient.name}:{" "}
                        {formatPrimaryIngredientAmount(ingredient.amount)}
                      </li>
                    ))}
                  </ul>
                </div>

              </>
            ) : (
              <>
                {savingMealId === meal.id ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <p className="text-sm font-semibold text-slate-950">
                      Updating meal
                    </p>
                    <p className="mt-1 text-sm leading-5 text-slate-600">
                      Applying your correction and recalculating ingredients and
                      macros.
                    </p>
                    {renderProcessingPill("Updating nutrition...")}
                  </div>
                ) : (
                  <>
                    <label className="block text-sm font-medium text-slate-700">
                      Correction
                      <textarea
                        className="mt-2 min-h-24 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                        onChange={(event) =>
                          updateMealCorrection(meal.id, event.target.value)
                        }
                        placeholder="e.g. actually it had full-fat yogurt, or closer to 5 tbsp peanut butter"
                        value={mealCorrections[meal.id] ?? ""}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      The model will apply this note to the existing meal,
                      recompute ingredients and macros, and keep the result
                      structured.
                    </p>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <button
                        className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-950"
                        onClick={() => {
                          setEditingMealId(null);
                          updateMealCorrection(meal.id, "");
                        }}
                        type="button"
                      >
                        Cancel
                      </button>
                      <button
                        className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
                        onClick={() => saveMealCorrection(meal.id)}
                        type="button"
                      >
                        Apply
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        ) : null}
      </article>
    );
  }

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-slate-50 px-4 py-6 text-slate-950">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Diet Tracker
            </h1>
          </div>
          {accessToken ? (
            <div className="flex shrink-0 items-center gap-2">
              <button
                aria-label="Open trends"
                className={`flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm ${
                  analyticsOpen ? "ring-4 ring-sky-100" : ""
                }`}
                onClick={() =>
                  analyticsOpen ? setAnalyticsOpen(false) : openAnalytics()
                }
                title="Trends"
                type="button"
              >
                <ChartIcon />
              </button>
              <button
                aria-label="Open settings"
                className={`flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm ${
                  settingsOpen ? "ring-4 ring-emerald-100" : ""
                } ${
                  activeOnboardingAnnouncement?.target === "settings"
                    ? "pointer-events-none relative z-[80] ring-4 ring-emerald-300"
                    : ""
                }`}
                onClick={() => (settingsOpen ? closeSettings() : openSettings())}
                ref={settingsOnboardingTargetRef}
                title="Settings"
                type="button"
              >
                <SettingsIcon />
              </button>
              <div className="relative">
                <button
                  aria-expanded={accountMenuOpen}
                  aria-label={`Account menu${userEmail ? ` for ${userEmail}` : ""}`}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-950 text-sm font-semibold text-white"
                  onClick={() => setAccountMenuOpen((value) => !value)}
                  title={userEmail ? `Signed in as ${userEmail}` : "Account"}
                  type="button"
                >
                  {(userEmail?.[0] ?? "U").toUpperCase()}
                </button>
                {accountMenuOpen ? (
                  <>
                    <button
                      aria-label="Close account menu"
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setAccountMenuOpen(false)}
                      type="button"
                    />
                    <div
                      className={`absolute right-0 top-12 w-72 rounded-2xl border border-slate-200 bg-white p-3 text-sm shadow-lg ${
                        activeOnboardingAnnouncement?.target === "install"
                          ? "z-auto"
                          : "z-20"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        {userEmail ? (
                          <p className="min-w-0 truncate py-1 text-xs text-slate-500">
                            {userEmail}
                          </p>
                        ) : null}
                        <button
                          className="shrink-0 rounded-full px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                          onClick={() => {
                            setAccountMenuOpen(false);
                            supabase.auth.signOut();
                          }}
                          type="button"
                        >
                          Log out
                        </button>
                      </div>
                      {!isStandaloneApp ? (
                        <button
                          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 ${
                            activeOnboardingAnnouncement?.target === "install"
                              ? "pointer-events-none relative z-[80] ring-4 ring-emerald-300"
                              : ""
                          }`}
                          onClick={() => {
                            setAccountMenuOpen(false);
                            setInstallHelpOpen(true);
                          }}
                          ref={installOnboardingTargetRef}
                          type="button"
                        >
                          <ShareIcon />
                          Add to Home Screen
                        </button>
                      ) : null}
                      <form
                        className="mt-3 border-t border-slate-100 pt-3"
                        onSubmit={saveUserProfile}
                      >
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Profile
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <fieldset className="text-xs font-medium text-slate-600">
                            <legend>Height</legend>
                            <div className="mt-1 grid grid-cols-2 gap-1">
                              <input
                                aria-label="Height feet"
                                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                                inputMode="numeric"
                                min="0"
                                onChange={(event) => {
                                  const feet = getOptionalPositiveNumber(
                                    event.target.value,
                                  );
                                  const inches =
                                    typeof draftHeightInchesRemainder === "number"
                                      ? draftHeightInchesRemainder
                                      : 0;

                                  updateDraftProfile({
                                    heightInches: getHeightInchesFromParts(
                                      feet,
                                      inches,
                                    ),
                                  });
                                }}
                                placeholder="ft"
                                step="1"
                                type="number"
                                value={draftHeightFeet}
                              />
                              <input
                                aria-label="Height inches"
                                className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                                inputMode="decimal"
                                min="0"
                                onChange={(event) => {
                                  const feet =
                                    typeof draftHeightFeet === "number"
                                      ? draftHeightFeet
                                      : 0;
                                  const inches = getOptionalPositiveNumber(
                                    event.target.value,
                                  );

                                  updateDraftProfile({
                                    heightInches: getHeightInchesFromParts(
                                      feet,
                                      inches,
                                    ),
                                  });
                                }}
                                placeholder="in"
                                step="0.5"
                                type="number"
                                value={draftHeightInchesRemainder}
                              />
                            </div>
                          </fieldset>
                          <label className="text-xs font-medium text-slate-600">
                            Weight
                            <input
                              className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                              inputMode="decimal"
                              min="1"
                              onChange={(event) =>
                                updateDraftProfile({
                                  weightPounds: getOptionalPositiveNumber(
                                    event.target.value,
                                  ),
                                })
                              }
                              placeholder="lb"
                              step="0.1"
                              type="number"
                              value={draftProfile.weightPounds ?? ""}
                            />
                          </label>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <label className="text-xs font-medium text-slate-600">
                            Age
                            <input
                              className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                              inputMode="numeric"
                              min="1"
                              onChange={(event) =>
                                updateDraftProfile({
                                  ageYears: getOptionalPositiveNumber(
                                    event.target.value,
                                  ),
                                })
                              }
                              placeholder="years"
                              step="1"
                              type="number"
                              value={draftProfile.ageYears ?? ""}
                            />
                          </label>
                          <label className="text-xs font-medium text-slate-600">
                            Sex
                            <select
                              className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                              onChange={(event) =>
                                updateDraftProfile({
                                  sex: event.target.value
                                    ? (event.target.value as SexForEstimate)
                                    : undefined,
                                })
                              }
                              value={draftProfile.sex ?? ""}
                            >
                              <option value="">Not set</option>
                              <option value="female">Female</option>
                              <option value="male">Male</option>
                            </select>
                          </label>
                        </div>
                        <label className="mt-2 block text-xs font-medium text-slate-600">
                          Activity
                          <select
                            className="mt-1 h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                            onChange={(event) =>
                              updateDraftProfile({
                                activityLevel: event.target.value as ActivityLevel,
                              })
                            }
                            value={draftProfile.activityLevel}
                          >
                            <option value="general">General</option>
                            <option value="very_active">Very active</option>
                          </select>
                        </label>
                        <p className="mt-2 text-[11px] leading-4 text-slate-500">
                          Weight powers protein g/kg. Age, sex, height, weight,
                          and activity power estimated maintenance calories.
                        </p>
                        <button
                          className="mt-3 w-full rounded-full bg-slate-950 px-4 py-2 text-xs font-semibold text-white disabled:opacity-50"
                          disabled={profilePending || !profileChanged}
                          type="submit"
                        >
                          {profilePending ? "Saving..." : "Save profile"}
                        </button>
                      </form>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        {missingConfig.length > 0
          ? toStatusMessage(
              "error",
              `Missing configuration: ${missingConfig.join(", ")}`,
            )
          : null}

        {toStatusMessage(
          message?.kind ?? null,
          message?.text ?? null,
          messageVisible,
        )}

        {!accessToken ? (
          <form
            className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"
            onSubmit={submitLogin}
          >
            <label className="text-sm font-medium text-slate-700">
              Email
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-base outline-none focus:ring-4 focus:ring-emerald-100"
                onChange={(event) => setLoginEmail(event.target.value)}
                placeholder="you@example.com"
                required
                type="email"
                value={loginEmail}
              />
            </label>
            <label className="mt-3 block text-sm font-medium text-slate-700">
              Password
              <input
                className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-base outline-none focus:ring-4 focus:ring-emerald-100"
                minLength={8}
                onChange={(event) => setLoginPassword(event.target.value)}
                required
                type="password"
                value={loginPassword}
              />
            </label>
            <button
              className="mt-3 w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
              disabled={authPending}
              type="submit"
            >
              {authPending ? "Working..." : "Sign in"}
            </button>
            <button
              className="mt-2 w-full rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-950 disabled:opacity-60"
              disabled={authPending || !loginEmail || loginPassword.length < 8}
              onClick={createAccount}
              type="button"
            >
              Create account
            </button>
          </form>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <button
                className={`rounded-full border px-5 py-3 text-sm font-semibold ${
                  activeForm === "meal"
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : "border-emerald-500 bg-white text-emerald-700"
                } ${
                  activeOnboardingAnnouncement?.target === "meal"
                    ? "pointer-events-none relative z-[80] ring-4 ring-emerald-300"
                    : ""
                }`}
                onClick={() =>
                  setActiveForm(activeForm === "meal" ? null : "meal")
                }
                ref={mealOnboardingTargetRef}
                type="button"
              >
                + Meal
              </button>
              <button
                className={`rounded-full border px-5 py-3 text-sm font-semibold ${
                  activeForm === "symptom"
                    ? "border-rose-500 bg-rose-500 text-white"
                    : "border-rose-500 bg-white text-rose-600"
                }`}
                onClick={() =>
                  setActiveForm(activeForm === "symptom" ? null : "symptom")
                }
                type="button"
              >
                + Symptom
              </button>
            </div>

            {activeForm === "meal" ? (
              <form
                className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"
                onSubmit={submitMeal}
              >
                <textarea
                  className="min-h-32 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-base outline-none focus:ring-4 focus:ring-emerald-100"
                  name="description"
                  placeholder="What did you eat? Optional if adding an image."
                />
                {mealPhotos.length < maxMealPhotos ? (
                  <label className="mt-3 flex w-full cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
                    <input
                      accept="image/*"
                      className="sr-only"
                      multiple
                      onChange={addMealPhotos}
                      type="file"
                    />
                    {mealPhotos.length > 0 ? "Add more photos" : "Add photos"}
                  </label>
                ) : null}
                {mealPhotos.length > 0 ? (
                  <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-slate-700">
                        {mealPhotos.length} of {maxMealPhotos}{" "}
                        {mealPhotos.length === 1 ? "photo" : "photos"} added
                      </p>
                      <button
                        className="text-xs font-semibold text-red-600"
                        onClick={clearMealPhotos}
                        type="button"
                      >
                        Remove all
                      </button>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      {mealPhotos.map((photo, index) => (
                        <div
                          className="relative aspect-square overflow-hidden rounded-xl bg-slate-200"
                          key={photo.id}
                        >
                          <div
                            aria-label={`Selected meal photo ${index + 1}`}
                            className="h-full w-full bg-cover bg-center"
                            role="img"
                            style={{ backgroundImage: `url("${photo.previewUrl}")` }}
                          />
                          <button
                            aria-label={`Remove selected meal photo ${index + 1}`}
                            className="absolute right-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full bg-slate-950/75 text-lg leading-none text-white shadow-sm"
                            onClick={() => removeMealPhoto(photo.id)}
                            type="button"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <button
                  className="mt-3 w-full rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={mealPending}
                  type="submit"
                >
                  {mealPending ? "Saving..." : "Save meal"}
                </button>
              </form>
            ) : null}

            {activeForm === "symptom" ? (
              <form
                className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm"
                onSubmit={submitSymptom}
              >
                <textarea
                  className="min-h-32 w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-base outline-none focus:ring-4 focus:ring-rose-100"
                  name="note"
                  placeholder="What are you noticing?"
                  required
                />
                <button
                  className="mt-3 w-full rounded-full bg-rose-500 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                  disabled={symptomPending}
                  type="submit"
                >
                  {symptomPending ? "Saving..." : "Save symptom"}
                </button>
              </form>
            ) : null}

            <section className="rounded-3xl border border-slate-200 bg-white p-3 shadow-sm">
              <h2 className="text-lg font-semibold">Today&apos;s Meals</h2>

              <div className="mt-3 rounded-2xl bg-emerald-50 p-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Today total
                </p>
                {renderNutrientGrid({
                  className: "mt-2",
                  customNutrients: todayCustomNutrients,
                  empty: todayMeals.length === 0,
                  macros: todayMacros,
                  plantCount: getUniquePlantCount(todayMeals),
                })}
              </div>

              {todayMeals.length === 0 && pendingMealSubmissions.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  Meals you log today will show up here.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  {pendingMealSubmissions.map(renderPendingMealCard)}
                  {todayMeals.map(renderMealCard)}
                </div>
              )}

              <button
                className="mt-4 w-full rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-950 shadow-sm"
                onClick={() => setShowFullLog((value) => !value)}
                type="button"
              >
                {showFullLog ? "Hide history" : "View history"}
              </button>

              {showFullLog ? (
                historyMealsByDay.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">
                    Previous meals will show up here.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-col gap-5">
                    {historyMealsByDay.map((group) => (
                      <div className="flex flex-col gap-3" key={group.dayKey}>
                        <h3 className="px-1 text-sm font-semibold text-slate-500">
                          {group.dayLabel}
                        </h3>
                        <div className="rounded-2xl bg-emerald-50 p-3">
                          <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                            Day total
                          </p>
                          {renderNutrientGrid({
                            className: "mt-2",
                            customNutrients: getCustomNutrientItems(
                              group.meals,
                              trackedNutrients,
                            ),
                            macros: getMealMacroTotals(group.meals),
                            plantCount: getUniquePlantCount(group.meals),
                          })}
                        </div>
                        {group.meals.map(renderMealCard)}
                      </div>
                    ))}
                  </div>
                )
              ) : null}
            </section>
          </>
        )}
      </div>
      {accessToken && activeOnboardingAnnouncement ? (
        <div className="fixed inset-0 z-[70] overflow-hidden overscroll-none bg-slate-950/50 sm:flex sm:items-center sm:justify-center sm:p-4">
          <button
            aria-label="Dismiss onboarding message"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={dismissActiveOnboarding}
            type="button"
          />
          <section
            aria-labelledby="onboarding-title"
            aria-modal="true"
            className="absolute left-1/2 top-[var(--onboarding-modal-top,15rem)] z-10 flex max-h-[var(--onboarding-modal-max-height,calc(100dvh-16rem))] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 flex-col overflow-hidden rounded-3xl bg-white p-6 shadow-xl sm:relative sm:inset-auto sm:max-h-[calc(100dvh-2rem)] sm:w-full sm:translate-x-0"
            ref={onboardingModalRef}
            role="dialog"
          >
            <h2
              className="text-2xl font-semibold tracking-tight"
              id="onboarding-title"
            >
              {activeOnboardingAnnouncement.title}
            </h2>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-bold text-emerald-800">
                {activeOnboardingAnnouncement.target === "settings" ? (
                  <SettingsIcon />
                ) : null}
                {activeOnboardingAnnouncement.target === "install" ? (
                  <ShareIcon />
                ) : null}
                {activeOnboardingAnnouncement.targetLabel}
              </span>
            </div>
            <div className="mt-3 min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]">
              <p className="pr-1 text-sm leading-7 text-slate-600">
                {activeOnboardingAnnouncement.message}
              </p>
            </div>
            <button
              className="mt-5 w-full shrink-0 rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
              onClick={dismissActiveOnboarding}
              type="button"
            >
              Continue
            </button>
          </section>
        </div>
      ) : null}
      {accessToken && installHelpOpen ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center overscroll-contain bg-slate-950/50 p-4">
          <button
            aria-label="Close Add to Home Screen instructions"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setInstallHelpOpen(false)}
            type="button"
          />
          <section
            aria-labelledby="install-help-title"
            aria-modal="true"
            className="relative z-10 w-full max-w-md rounded-3xl bg-white p-6 shadow-xl"
            role="dialog"
          >
            <h2
              className="text-2xl font-semibold tracking-tight"
              id="install-help-title"
            >
              Add to Home Screen
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-500">
              On your iPhone, follow these steps to open Diet Tracker like an
              app.
            </p>
            <ol className="mt-5 space-y-3">
              <li className="flex gap-3 rounded-2xl bg-slate-50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">
                  1
                </span>
                <p className="text-sm leading-6 text-slate-700">
                  Press the <strong>•••</strong> icon in the bottom-right
                  corner of Safari.
                </p>
              </li>
              <li className="flex gap-3 rounded-2xl bg-slate-50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">
                  2
                </span>
                <p className="text-sm leading-6 text-slate-700">
                  Tap the{" "}
                  <span className="inline-flex items-center gap-1 font-semibold text-slate-950">
                    Share <ShareIcon />
                  </span>{" "}
                  button.
                </p>
              </li>
              <li className="flex gap-3 rounded-2xl bg-slate-50 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-950 text-xs font-semibold text-white">
                  3
                </span>
                <p className="text-sm leading-6 text-slate-700">
                  Scroll down and tap <strong>Add to Home Screen</strong>, then
                  tap <strong>Add</strong>.
                </p>
              </li>
            </ol>
            <button
              className="mt-5 w-full rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white"
              onClick={() => setInstallHelpOpen(false)}
              type="button"
            >
              Done
            </button>
          </section>
        </div>
      ) : null}
      {accessToken && settingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-slate-950/40 p-4">
          <button
            aria-label="Close settings"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closeSettings}
            type="button"
          />
          <section
            aria-modal="true"
            className="relative z-10 max-h-[85vh] w-full max-w-md overscroll-contain overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Settings</h2>
                <p className="mt-1 text-sm leading-6 text-slate-500">
                  Choose which nutrients appear in the meal cards. The model
                  still estimates everything it needs in the background.
                </p>
              </div>
            </div>

            <div className="mt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Nutrients
              </p>
              <div className="mt-2 divide-y divide-slate-100 rounded-2xl border border-slate-200">
                {reconcileNutrientOrder(
                  draftNutrientOrder,
                  draftTrackedNutrients,
                ).map((id) => {
                  if (id.startsWith("core:")) {
                    const key = id.slice("core:".length);

                    if (!isCoreMacroKey(key)) {
                      return null;
                    }

                    const macroItem = coreMacroItems.find(
                      (item) => item.key === key,
                    );
                    const isHidden = draftHiddenCoreNutrients.includes(key);

                    if (!macroItem) {
                      return null;
                    }

                    return (
                      <div
                        className={`flex items-center justify-between gap-3 px-3 py-2 ${
                          draggedNutrientId === id ? "bg-emerald-50" : ""
                        }`}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={(event) => {
                          event.preventDefault();
                          if (draggedNutrientId) {
                            moveDraftNutrientBefore(draggedNutrientId, id);
                          }
                          setDraggedNutrientId(null);
                        }}
                        key={id}
                      >
                        <span
                          className="cursor-grab text-slate-400 active:cursor-grabbing"
                          draggable={!settingsPending}
                          onDragEnd={() => setDraggedNutrientId(null)}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", id);
                            setDraggedNutrientId(id);
                          }}
                        >
                          <DragHandleIcon />
                        </span>
                        <span className="min-w-0 flex-1 text-sm font-medium text-slate-800">
                          {formatNutrientName(macroItem.label)}
                        </span>
                        <button
                          aria-label={`${isHidden ? "Show" : "Hide"} ${macroItem.label}`}
                          className={`rounded-full p-2 disabled:opacity-60 ${
                            isHidden ? "text-slate-400" : "text-emerald-600"
                          }`}
                          disabled={settingsPending}
                          onClick={() => toggleDraftCoreNutrient(macroItem.key)}
                          title={isHidden ? "Show" : "Hide"}
                          type="button"
                        >
                          {isHidden ? <EyeOffIcon /> : <EyeIcon />}
                        </button>
                      </div>
                    );
                  }

                  const name = id.slice("custom:".length);
                  const nutrient = draftTrackedNutrients.find(
                    (trackedNutrient) => trackedNutrient.name === name,
                  );

                  if (!nutrient) {
                    return null;
                  }

                  return (
                    <div
                      className={`flex items-center justify-between gap-3 px-3 py-2 ${
                        draggedNutrientId === id ? "bg-emerald-50" : ""
                      }`}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        if (draggedNutrientId) {
                          moveDraftNutrientBefore(draggedNutrientId, id);
                        }
                        setDraggedNutrientId(null);
                      }}
                      key={id}
                    >
                      <span
                        className="cursor-grab text-slate-400 active:cursor-grabbing"
                        draggable={!settingsPending}
                        onDragEnd={() => setDraggedNutrientId(null)}
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", id);
                          setDraggedNutrientId(id);
                        }}
                      >
                        <DragHandleIcon />
                      </span>
                      <span className="min-w-0 flex-1 text-sm font-medium text-slate-800">
                        {formatNutrientName(nutrient.name)}
                      </span>
                      <button
                        aria-label={`Delete ${nutrient.name}`}
                        className="rounded-full p-2 text-red-600 disabled:opacity-60"
                        disabled={settingsPending}
                        onClick={() => removeTrackedNutrient(nutrient)}
                        title="Delete"
                        type="button"
                      >
                        <TrashIcon />
                      </button>
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-500">
                Add names only, like calcium or iron. New custom nutrients are
                estimated for future meals and corrections after you save.
              </p>
            </div>

            <form className="mt-3 flex gap-2" onSubmit={addTrackedNutrient}>
              <input
                className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                disabled={settingsPending}
                onChange={(event) => setNewTrackedNutrient(event.target.value)}
                placeholder="e.g. calcium, iron, vitamin d"
                value={newTrackedNutrient}
              />
              <button
                className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                disabled={settingsPending}
                type="submit"
              >
                Add
              </button>
            </form>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <button
                className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-950"
                disabled={settingsPending}
                onClick={closeSettings}
                type="button"
              >
                Cancel
              </button>
              <button
                className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                disabled={settingsPending || !settingsChanged}
                onClick={saveUserSettings}
                type="button"
              >
                {settingsPending ? "Saving..." : "Save"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {accessToken && analyticsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center overscroll-contain bg-slate-950/40 p-4">
          <button
            aria-label="Close trends"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={() => setAnalyticsOpen(false)}
            type="button"
          />
          <section
            aria-modal="true"
            className="relative z-10 max-h-[85vh] w-full max-w-2xl overscroll-contain overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
            role="dialog"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">Trends</h2>
              </div>
              <button
                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"
                onClick={() => setAnalyticsOpen(false)}
                type="button"
              >
                Close
              </button>
            </div>

            <div
              aria-label="Trend section"
              className="mt-4 grid grid-cols-3 rounded-full bg-slate-100 p-1"
              role="tablist"
            >
              {analyticsSections.map((section) => {
                const isActive = analyticsSection === section.id;

                return (
                  <button
                    aria-controls={`analytics-panel-${section.id}`}
                    aria-selected={isActive}
                    className={`rounded-full px-3 py-2 text-xs font-semibold transition ${
                      isActive
                        ? "bg-slate-950 text-white shadow-sm"
                        : "text-slate-600"
                    }`}
                    key={section.id}
                    onClick={() => setAnalyticsSection(section.id)}
                    role="tab"
                    type="button"
                  >
                    {section.label}
                  </button>
                );
              })}
            </div>

            <div
              className="touch-pan-y"
              onTouchEnd={handleAnalyticsTouchEnd}
              onTouchStart={handleAnalyticsTouchStart}
            >
              {analyticsSection === "plants" ? (
                <section
                  className="mt-4"
                  id="analytics-panel-plants"
                  role="tabpanel"
                >
              <h3 className="text-sm font-semibold text-slate-950">
                Weekly plant diversity
              </h3>
              <div className="mt-2 flex items-center gap-4">
                <p className="w-20 shrink-0 text-4xl font-semibold text-emerald-700">
                  {plantDiversityAnalysis.current.score.toFixed(1)}
                </p>
                <div className="flex min-w-0 flex-1 items-center">
                  <div
                    className="min-w-28 max-w-full rounded-xl bg-slate-50 px-2 py-1"
                    style={{
                      width: `${plantDiversityAnalysis.chartWidthPercent}%`,
                    }}
                  >
                    {renderPlantDiversityChart(
                      plantDiversityAnalysis.chartPoints,
                    )}
                  </div>
                </div>
              </div>

              <details className="mt-3 rounded-2xl border border-slate-200">
                <summary className="cursor-pointer px-3 py-2.5 text-sm font-semibold text-slate-700">
                  Plants from the last 14 days
                </summary>
                <div className="border-t border-slate-100 px-3 py-3">
                  {plantDiversityAnalysis.current.activePlants.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {plantDiversityAnalysis.current.activePlants.map((plant) => (
                        <span
                          className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800"
                          key={getPlantVarietyKey(plant.name)}
                        >
                          {formatNutrientName(plant.name)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">No plants counted.</p>
                  )}
                </div>
              </details>
                </section>
              ) : null}

              {analyticsSection === "timing" ? (
                <section
                  className="mt-4"
                  id="analytics-panel-timing"
                  role="tabpanel"
                >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-950">
                  Chrononutrition
                </h3>
                <p className="text-xs text-slate-500">
                  30-day averages
                </p>
              </div>

              {thirtyDayLoggedDays === 0 ? (
                <p className="mt-3 rounded-2xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
                  Log meals to see timing patterns.
                </p>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {chrononutritionMetrics.map((metric) => (
                      <div
                        className="rounded-xl bg-sky-50 px-3 py-2"
                        key={metric.id}
                      >
                        <p className="text-base font-semibold text-sky-950">
                          {metric.value}
                        </p>
                        <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-700">
                          {metric.detail}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-xs font-semibold text-slate-700">
                        First → last meal
                      </p>
                      <p className="text-[10px] text-slate-500">Last 7 days</p>
                    </div>
                    <div className="mt-1">
                      {renderMealTimingChart(sevenDayMealTimingRows)}
                    </div>
                  </div>
                </>
              )}
                </section>
              ) : null}

              {analyticsSection === "nutrition" ? (
                <section
                  className="mt-4"
                  id="analytics-panel-nutrition"
                  role="tabpanel"
                >
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold text-slate-950">
                  Daily nutrition
                </h3>
                <p className="text-xs text-slate-500">
                  {thirtyDayLoggedDays} days, {thirtyDayMealCount} meals
                </p>
              </div>

              {thirtyDayLoggedDays === 0 ? (
                <p className="mt-3 rounded-2xl border border-dashed border-slate-200 p-3 text-sm text-slate-500">
                  Log meals to see nutrition averages.
                </p>
              ) : (
                <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
                  <div className="grid grid-cols-[minmax(0,0.75fr)_4.5rem_minmax(7rem,1.3fr)] items-center gap-2 bg-slate-50 px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                    <span>Nutrient</span>
                    <span className="text-right">30d avg</span>
                    <span>7d trend</span>
                  </div>
                  <div>
                    {thirtyDayNutritionMetrics.map((metric) => (
                      <div
                        className="grid grid-cols-[minmax(0,0.75fr)_4.5rem_minmax(7rem,1.3fr)] items-center gap-2 border-t border-slate-100 px-3 py-1.5"
                        key={metric.id}
                      >
                        <p className="truncate text-xs font-medium text-slate-700">
                          {metric.label}
                        </p>
                        <div className="min-w-0 text-right">
                          <p
                            className={`truncate text-xs ${getRangeTextClass(
                              metric.status,
                            )}`}
                          >
                            {metric.value}
                          </p>
                          <p className="truncate text-[8px] leading-3 text-slate-400">
                            {metric.detail}
                          </p>
                        </div>
                        <div className="min-w-0">
                          {renderMiniTrendChart({
                            points: metric.trendPoints,
                            referenceMax: metric.referenceMax,
                            referenceMin: metric.referenceMin,
                            strokeColor: metric.strokeColor,
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
                </section>
              ) : null}
            </div>

          </section>
        </div>
      ) : null}
    </main>
  );
}
