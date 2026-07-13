"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import type { MealRecord, MacroTotals, TrackedNutrient } from "@/lib/schemas";
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
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [activeForm, setActiveForm] = useState<"meal" | "symptom" | null>(null);
  const [authPending, setAuthPending] = useState(false);
  const [deletingMealId, setDeletingMealId] = useState<string | null>(null);
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
  const [meals, setMeals] = useState<MealRecord[]>([]);
  const [newTrackedNutrient, setNewTrackedNutrient] = useState("");
  const [nutrientOrder, setNutrientOrder] = useState<string[]>([]);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
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

    setTrackedNutrients(nextTrackedNutrients);
    setHiddenCoreNutrients(nextHiddenCoreNutrients);
    setNutrientOrder(nextNutrientOrder);
    setDraftTrackedNutrients(nextTrackedNutrients);
    setDraftHiddenCoreNutrients(nextHiddenCoreNutrients);
    setDraftNutrientOrder(nextNutrientOrder);
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
      setAccessToken(token);
      setUserEmail(data.session?.user.email ?? null);
      applyUserSettings(data.session?.user.user_metadata);
      if (token) {
        loadMeals(token);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const token = session?.access_token ?? null;
      setAccessToken(token);
      setUserEmail(session?.user.email ?? null);
      applyUserSettings(session?.user.user_metadata);
      if (token) {
        loadMeals(token);
      } else {
        setDraftHiddenCoreNutrients([]);
        setDraftNutrientOrder([]);
        setDraftTrackedNutrients([]);
        setHiddenCoreNutrients([]);
        setMeals([]);
        setNutrientOrder([]);
        setAccountMenuOpen(false);
        setSettingsOpen(false);
        setTrackedNutrients([]);
      }
    });

    return () => subscription.unsubscribe();
    // Auth bootstrap should only follow this Supabase client instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase]);

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

  const missingConfig = status
    ? Object.entries(status.configured)
        .filter(([, configured]) => !configured)
        .map(([name]) => name)
    : [];

  function closeSettings() {
    setSettingsOpen(false);
    setNewTrackedNutrient("");
    setDraftHiddenCoreNutrients(hiddenCoreNutrients);
    setDraftNutrientOrder(nutrientOrder);
    setDraftTrackedNutrients(trackedNutrients);
  }

  function openSettings() {
    setAccountMenuOpen(false);
    setDraftHiddenCoreNutrients(hiddenCoreNutrients);
    setDraftNutrientOrder(nutrientOrder);
    setDraftTrackedNutrients(trackedNutrients);
    setNewTrackedNutrient("");
    setSettingsOpen(true);
  }

  async function authenticatedFetch(input: RequestInfo, init: RequestInit = {}) {
    const headers = new Headers(init.headers);

    if (accessToken) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    return fetch(input, { ...init, headers });
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

  async function loadMeals(token = accessToken) {
    if (!token) {
      return;
    }

    const response = await fetch("/api/meals?backfillMissing=1", {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error ?? "Could not load meals.");
    }

    const nextMeals = data.meals as MealRecord[];
    setMeals(nextMeals);
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

    setSavingMealId(mealId);
    setMessage(null);

    try {
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
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not update meal.");
      }

      await loadMeals();
      setEditingMealId(null);
      updateMealCorrection(mealId, "");
      showMessage({ kind: "success", text: "Correction applied." });
    } catch (error) {
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

      showMessage({ kind: "success", text: "Signed in." });
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
    setMealPending(true);
    setMessage(null);

    try {
      const form = event.currentTarget;
      const formData = new FormData(form);
      formData.set(
        "timezone",
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      const response = await authenticatedFetch("/api/meals", {
        body: formData,
        method: "POST",
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error ?? "Could not log meal.");
      }

      form.reset();
      setActiveForm(null);
      await loadMeals();
      showMessage({ kind: "success", text: "Meal saved." });
    } catch (error) {
      showMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Could not log meal.",
      });
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

  function renderNutrientGrid({
    customNutrients,
    macros,
    className = "",
  }: {
    customNutrients: CustomNutrientItem[];
    macros: MacroTotals;
    className?: string;
  }) {
    const nutrientItems = getOrderedNutrientItems({
      customNutrients,
      hiddenCoreNutrients,
      macros,
      nutrientOrder,
    });

    if (nutrientItems.length === 0) {
      return null;
    }

    return (
      <div
        className={`flex flex-wrap items-start gap-x-6 gap-y-2 text-xs ${className}`}
      >
        {nutrientItems.map(({ id, label, value }) => (
          <div className="min-w-14 max-w-24" key={id}>
            <p className="truncate font-semibold leading-tight">{value}</p>
            <p className="truncate text-[11px] leading-tight text-slate-500">
              {label}
            </p>
          </div>
        ))}
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
    const isEditing = editingMealId === meal.id;
    const isExpanded = expandedMealId === meal.id || isEditing;

    return (
      <article
        className="rounded-2xl border border-slate-100 bg-slate-50 p-3"
        key={meal.id}
      >
        <button
          className="w-full text-left"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${getMealTitle(meal)}`}
          onClick={() => setExpandedMealId(isExpanded ? null : meal.id)}
          type="button"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-base font-semibold text-slate-950">
                {getMealTitle(meal)}
              </h3>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {formatMealTimeOfDay(meal.eatenAt)}
              </p>
            </div>
            <span className="rounded-full p-1 text-slate-500">
              <ChevronIcon direction={isExpanded ? "up" : "down"} />
            </span>
          </div>
          {renderNutrientGrid({
            className: "mt-2",
            customNutrients,
            macros,
          })}
        </button>

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

                {macroBreakdown.length > 0 ? (
                  <details className="mt-4 rounded-2xl border border-slate-200 bg-white">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-slate-700">
                      Ingredient macro breakdown
                    </summary>
                    <div className="overflow-x-auto border-t border-slate-100">
                      <table className="min-w-full text-left text-xs text-slate-700">
                        <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Ingredient</th>
                            <th className="px-3 py-2 font-semibold">Amount</th>
                            <th className="px-3 py-2 font-semibold">Cal</th>
                            <th className="px-3 py-2 font-semibold">P</th>
                            <th className="px-3 py-2 font-semibold">C</th>
                            <th className="px-3 py-2 font-semibold">F</th>
                            <th className="px-3 py-2 font-semibold">Fiber</th>
                          </tr>
                        </thead>
                        <tbody>
                          {macroBreakdown.map((ingredient) => (
                            <tr
                              className="border-t border-slate-100"
                              key={`${ingredient.name}-${ingredient.amount}`}
                            >
                              <td className="px-3 py-2 font-medium text-slate-950">
                                {ingredient.name}
                              </td>
                              <td className="px-3 py-2">{ingredient.amount}</td>
                              <td className="px-3 py-2">
                                {Math.round(ingredient.calories)}
                              </td>
                              <td className="px-3 py-2">
                                {Math.round(ingredient.proteinGrams)}g
                              </td>
                              <td className="px-3 py-2">
                                {Math.round(ingredient.carbsGrams)}g
                              </td>
                              <td className="px-3 py-2">
                                {Math.round(ingredient.fatGrams)}g
                              </td>
                              <td className="px-3 py-2">
                                {Math.round(ingredient.fiberGrams)}g
                              </td>
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
                        {ingredient.name}: {ingredient.amount}
                      </li>
                    ))}
                  </ul>
                </div>

              </>
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
                  The model will apply this note to the existing meal, recompute
                  ingredients and macros, and keep the result structured.
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
                    className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                    disabled={savingMealId === meal.id}
                    onClick={() => saveMealCorrection(meal.id)}
                    type="button"
                  >
                    {savingMealId === meal.id ? "Applying..." : "Apply"}
                  </button>
                </div>
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
                aria-label="Open settings"
                className={`flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm ${
                  settingsOpen ? "ring-4 ring-emerald-100" : ""
                }`}
                onClick={() => (settingsOpen ? closeSettings() : openSettings())}
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
                  <div className="absolute right-0 top-12 z-20 w-44 rounded-2xl border border-slate-200 bg-white p-2 text-sm shadow-lg">
                    {userEmail ? (
                      <p className="truncate px-3 py-2 text-xs text-slate-500">
                        {userEmail}
                      </p>
                    ) : null}
                    <button
                      className="w-full rounded-xl px-3 py-2 text-left font-semibold text-red-600 hover:bg-red-50"
                      onClick={() => {
                        setAccountMenuOpen(false);
                        supabase.auth.signOut();
                      }}
                      type="button"
                    >
                      Log out
                    </button>
                  </div>
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
                className={`rounded-full px-5 py-3 text-sm font-semibold ${
                  activeForm === "meal"
                    ? "bg-emerald-500 text-white"
                    : "bg-white text-slate-950 shadow-sm"
                }`}
                onClick={() =>
                  setActiveForm(activeForm === "meal" ? null : "meal")
                }
                type="button"
              >
                + Meal
              </button>
              <button
                className={`rounded-full px-5 py-3 text-sm font-semibold ${
                  activeForm === "symptom"
                    ? "bg-rose-500 text-white"
                    : "bg-white text-slate-950 shadow-sm"
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
                <label className="mt-3 block text-sm font-medium text-slate-700">
                  Optional image
                  <input
                    accept="image/*"
                    className="mt-2 block w-full rounded-2xl border border-slate-200 bg-slate-50 p-3 text-sm"
                    name="photo"
                    type="file"
                  />
                </label>
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
                  macros: todayMacros,
                })}
              </div>

              {todayMeals.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  Meals you log today will show up here.
                </p>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
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
      {accessToken && settingsOpen ? (
        <div className="fixed inset-0 z-50 flex items-end bg-slate-950/40 p-4 sm:items-center sm:justify-center">
          <button
            aria-label="Close settings"
            className="absolute inset-0 h-full w-full cursor-default"
            onClick={closeSettings}
            type="button"
          />
          <section
            aria-modal="true"
            className="relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-xl"
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
    </main>
  );
}
