"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import type { MealRecord, MacroTotals } from "@/lib/schemas";
import { createBrowserSupabaseClient } from "@/lib/supabase-browser";

type AppStatus = {
  configured: {
    allowedEmail: boolean;
    openai: boolean;
    supabase: boolean;
  };
};

type MealEditDraft = {
  cleanedDescription: string;
  eatenAtLocal: string;
  ingredientEstimatesText: string;
  mealTitle: string;
  nutrition: MacroTotals;
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

function getIngredientEstimatesText(meal: MealRecord) {
  if (meal.nutrition.ingredientEstimates?.length) {
    return meal.nutrition.ingredientEstimates
      .map((ingredient) => `${ingredient.name}: ${ingredient.amount}`)
      .join("\n");
  }

  return meal.nutrition.notableIngredients.join("\n");
}

function parseIngredientEstimates(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(":");

      return {
        amount: rest.join(":").trim() || "unknown amount",
        name: name.trim(),
      };
    })
    .filter((ingredient) => ingredient.name);
}

function padDatePart(value: number) {
  return value.toString().padStart(2, "0");
}

function toDateTimeLocalValue(value: string) {
  const date = new Date(value);

  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate()),
  ].join("-") + `T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`;
}

function fromDateTimeLocalValue(value: string) {
  return new Date(value).toISOString();
}

function toMealDraft(meal: MealRecord): MealEditDraft {
  return {
    cleanedDescription: getCleanedDescription(meal),
    eatenAtLocal: toDateTimeLocalValue(meal.eatenAt),
    ingredientEstimatesText: getIngredientEstimatesText(meal),
    mealTitle: getMealTitle(meal),
    nutrition: getMealMacros(meal),
  };
}

function formatMealTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMealTimeOfDay(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMealDay(value: string) {
  const date = new Date(value);

  if (isSameLocalDay(date, new Date())) {
    return "Today";
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

function getMacroItems(macros: MacroTotals) {
  return [
    ["cal", Math.round(macros.calories).toString()],
    ["protein", `${Math.round(macros.proteinGrams)}g`],
    ["carbs", `${Math.round(macros.carbsGrams)}g`],
    ["fat", `${Math.round(macros.fatGrams)}g`],
    ["fiber", `${Math.round(macros.fiberGrams)}g`],
  ] as const;
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
      className="h-5 w-5"
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
      className="h-5 w-5"
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
  const [editingMealId, setEditingMealId] = useState<string | null>(null);
  const [expandedMealId, setExpandedMealId] = useState<string | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [mealDrafts, setMealDrafts] = useState<Record<string, MealEditDraft>>({});
  const [mealPending, setMealPending] = useState(false);
  const [meals, setMeals] = useState<MealRecord[]>([]);
  const [savingMealId, setSavingMealId] = useState<string | null>(null);
  const [showFullLog, setShowFullLog] = useState(false);
  const [message, setMessage] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);
  const [messageVisible, setMessageVisible] = useState(false);
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [symptomPending, setSymptomPending] = useState(false);
  const [userEmail, setUserEmail] = useState<string | null>(null);

  function showMessage(nextMessage: { kind: "error" | "success"; text: string }) {
    setMessageVisible(true);
    setMessage(nextMessage);
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
      if (token) {
        loadMeals(token);
      } else {
        setMeals([]);
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

  async function authenticatedFetch(input: RequestInfo, init: RequestInit = {}) {
    const headers = new Headers(init.headers);

    if (accessToken) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    return fetch(input, { ...init, headers });
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
    setMealDrafts(
      Object.fromEntries(nextMeals.map((meal) => [meal.id, toMealDraft(meal)])),
    );
  }

  function updateMealDraft(
    mealId: string,
    updater: (draft: MealEditDraft) => MealEditDraft,
  ) {
    setMealDrafts((current) => {
      const existing = current[mealId];

      if (!existing) {
        return current;
      }

      return { ...current, [mealId]: updater(existing) };
    });
  }

  function mealNeedsReestimate(meal: MealRecord, draft: MealEditDraft) {
    const currentDraft = toMealDraft(meal);

    return (
      draft.cleanedDescription !== currentDraft.cleanedDescription ||
      draft.ingredientEstimatesText !== currentDraft.ingredientEstimatesText ||
      draft.mealTitle !== currentDraft.mealTitle
    );
  }

  async function saveMealEdit(mealId: string) {
    const draft = mealDrafts[mealId];
    const meal = meals.find((currentMeal) => currentMeal.id === mealId);

    if (!draft || !meal) {
      return;
    }

    const ingredientEstimates = parseIngredientEstimates(
      draft.ingredientEstimatesText,
    );
    const regenerateNutrition = mealNeedsReestimate(meal, draft);
    setSavingMealId(mealId);
    setMessage(null);

    try {
      const response = await authenticatedFetch("/api/meals", {
        body: JSON.stringify({
          cleanedDescription: draft.cleanedDescription,
          eatenAt: fromDateTimeLocalValue(draft.eatenAtLocal),
          id: mealId,
          ingredientEstimates,
          mealTitle: draft.mealTitle,
          nutrition: draft.nutrition,
          regenerateNutrition,
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
      showMessage({
        kind: "success",
        text: regenerateNutrition
          ? "Meal updated and macros re-estimated."
          : "Meal updated.",
      });
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

  function renderMacroGrid(macros: MacroTotals, className = "") {
    return (
      <div className={`grid grid-cols-2 gap-2 text-sm sm:grid-cols-5 ${className}`}>
        {getMacroItems(macros).map(([label, value]) => (
          <div key={label}>
            <p className="font-semibold">{value}</p>
            <p className="text-xs text-slate-500">{label}</p>
          </div>
        ))}
      </div>
    );
  }

  function renderMealCard(meal: MealRecord) {
    const draft = mealDrafts[meal.id] ?? toMealDraft(meal);
    const macros = getMealMacros(meal);
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
        className="rounded-2xl border border-slate-100 bg-slate-50 p-4"
        key={meal.id}
      >
        <button
          className="w-full text-left"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${getMealTitle(meal)}`}
          onClick={() => setExpandedMealId(isExpanded ? null : meal.id)}
          type="button"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-950">
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
          {renderMacroGrid(macros, "mt-3")}
        </button>

        {isExpanded ? (
          <div className="mt-4 border-t border-slate-200 pt-4">
            {!isEditing ? (
              <>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs font-medium text-slate-500">
                    {formatMealTime(meal.eatenAt)}
                  </p>
                  <div className="flex items-center gap-3">
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
                  </div>
                </div>

                <p className="mt-3 text-sm leading-6 text-slate-700">
                  {getCleanedDescription(meal)}
                </p>

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

                {macroBreakdown.length > 0 ||
                meal.nutrition.calculationSummary ||
                meal.nutrition.sanityCheck ? (
                  <div className="mt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Macro basis
                    </p>
                    {meal.nutrition.calculationSummary ? (
                      <p className="mt-2 text-sm leading-6 text-slate-700">
                        {meal.nutrition.calculationSummary}
                      </p>
                    ) : null}
                    {macroBreakdown.length > 0 ? (
                      <ul className="mt-2 space-y-2 text-sm text-slate-700">
                        {macroBreakdown.map((ingredient) => (
                          <li key={`${ingredient.name}-${ingredient.amount}`}>
                            <span className="font-medium">{ingredient.name}</span>:{" "}
                            {ingredient.amount}, {Math.round(ingredient.calories)} cal,{" "}
                            {Math.round(ingredient.proteinGrams)}g protein,{" "}
                            {Math.round(ingredient.carbsGrams)}g carbs,{" "}
                            {Math.round(ingredient.fatGrams)}g fat,{" "}
                            {Math.round(ingredient.fiberGrams)}g fiber
                            <span className="block text-xs text-slate-500">
                              {ingredient.macroBasis}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {meal.nutrition.sanityCheck ? (
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        {meal.nutrition.sanityCheck}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <label className="block text-sm font-medium text-slate-700">
                  Meal title
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                    onChange={(event) =>
                      updateMealDraft(meal.id, (current) => ({
                        ...current,
                        mealTitle: event.target.value,
                      }))
                    }
                    value={draft.mealTitle}
                  />
                </label>

                <label className="mt-3 block text-sm font-medium text-slate-700">
                  Meal time
                  <input
                    className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                    onChange={(event) =>
                      updateMealDraft(meal.id, (current) => ({
                        ...current,
                        eatenAtLocal: event.target.value,
                      }))
                    }
                    type="datetime-local"
                    value={draft.eatenAtLocal}
                  />
                </label>

                <label className="mt-3 block text-sm font-medium text-slate-700">
                  Meal description
                  <textarea
                    className="mt-2 min-h-20 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                    onChange={(event) =>
                      updateMealDraft(meal.id, (current) => ({
                        ...current,
                        cleanedDescription: event.target.value,
                      }))
                    }
                    value={draft.cleanedDescription}
                  />
                </label>

                <label className="mt-3 block text-sm font-medium text-slate-700">
                  Ingredients and amounts
                  <textarea
                    className="mt-2 min-h-24 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                    onChange={(event) =>
                      updateMealDraft(meal.id, (current) => ({
                        ...current,
                        ingredientEstimatesText: event.target.value,
                      }))
                    }
                    placeholder="One per line, like: tofu: 4 oz"
                    value={draft.ingredientEstimatesText}
                  />
                </label>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  {(
                    [
                      ["calories", "Calories"],
                      ["proteinGrams", "Protein g"],
                      ["carbsGrams", "Carbs g"],
                      ["fatGrams", "Fat g"],
                      ["fiberGrams", "Fiber g"],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      className="text-sm font-medium text-slate-700"
                      key={key}
                    >
                      {label}
                      <input
                        className="mt-2 w-full rounded-2xl border border-slate-200 bg-white p-3 text-sm outline-none focus:ring-4 focus:ring-emerald-100"
                        min={0}
                        onChange={(event) =>
                          updateMealDraft(meal.id, (current) => ({
                            ...current,
                            nutrition: {
                              ...current.nutrition,
                              [key]: Number(event.target.value),
                            },
                          }))
                        }
                        type="number"
                        value={draft.nutrition[key]}
                      />
                    </label>
                  ))}
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3">
                  <button
                    className="rounded-full border border-slate-200 px-5 py-3 text-sm font-semibold text-slate-950"
                    onClick={() => setEditingMealId(null)}
                    type="button"
                  >
                    Cancel
                  </button>
                  <button
                    className="rounded-full bg-slate-950 px-5 py-3 text-sm font-semibold text-white disabled:opacity-60"
                    disabled={savingMealId === meal.id}
                    onClick={() => saveMealEdit(meal.id)}
                    type="button"
                  >
                    {savingMealId === meal.id ? "Saving..." : "Save"}
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
            <button
              aria-label={`Signed in as ${userEmail ?? "user"}. Sign out.`}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-950 text-sm font-semibold text-white"
              onClick={() => supabase.auth.signOut()}
              title={`Signed in${userEmail ? ` as ${userEmail}` : ""}. Tap to sign out.`}
              type="button"
            >
              {(userEmail?.[0] ?? "U").toUpperCase()}
            </button>
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

            <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Today&apos;s Meals</h2>
                <button
                  className="text-sm font-medium text-slate-600"
                  onClick={() => loadMeals()}
                  type="button"
                >
                  Refresh
                </button>
              </div>

              <div className="mt-4 rounded-2xl bg-emerald-50 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Today total
                </p>
                {renderMacroGrid(todayMacros, "mt-3")}
              </div>

              {todayMeals.length === 0 ? (
                <p className="mt-3 text-sm text-slate-500">
                  Meals you log today will show up here.
                </p>
              ) : (
                <div className="mt-4 flex flex-col gap-3">
                  {todayMeals.map(renderMealCard)}
                </div>
              )}
            </section>

            <button
              className="rounded-full border border-slate-200 bg-white px-5 py-3 text-sm font-semibold text-slate-950 shadow-sm"
              onClick={() => setShowFullLog((value) => !value)}
              type="button"
            >
              {showFullLog ? "Hide full log" : "View full log"}
            </button>

            {showFullLog ? (
              <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-lg font-semibold">Full Log</h2>

                {meals.length === 0 ? (
                  <p className="mt-3 text-sm text-slate-500">
                    Saved meals will show up here.
                  </p>
                ) : (
                  <div className="mt-4 flex flex-col gap-5">
                    {mealsByDay.map((group) => (
                      <div className="flex flex-col gap-3" key={group.dayKey}>
                        <h3 className="px-1 text-sm font-semibold text-slate-500">
                          {group.dayLabel}
                        </h3>
                        {group.meals.map(renderMealCard)}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
