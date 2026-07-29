import type {
  BowelMovementRecord,
  MealRecord,
  MealSubmission,
} from "@/lib/schemas";

const LAST_USER_KEY = "diet-tracker:last-user";
const CACHE_KEY_PREFIX = "diet-tracker:data-cache:v1:";
const CACHE_KEEP_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LocalDataCache = {
  bowelMovements: BowelMovementRecord[];
  meals: MealRecord[];
  savedAt: string;
  submissions: MealSubmission[];
};

function getCacheKey(email: string) {
  return `${CACHE_KEY_PREFIX}${email.trim().toLowerCase()}`;
}

function isQuotaError(error: unknown) {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function getCutoffMs() {
  return Date.now() - CACHE_KEEP_DAYS * DAY_MS;
}

function trimMeals(meals: MealRecord[]) {
  const cutoff = getCutoffMs();
  return meals.filter((meal) => new Date(meal.eatenAt).getTime() >= cutoff);
}

function trimSubmissions(submissions: MealSubmission[]) {
  const cutoff = getCutoffMs();
  return submissions.filter((submission) => {
    const stamp = submission.eatenAt ?? submission.submittedAt;
    return new Date(stamp).getTime() >= cutoff;
  });
}

function trimBowelMovements(movements: BowelMovementRecord[]) {
  const cutoff = getCutoffMs();
  return movements.filter(
    (movement) => new Date(movement.occurredAt).getTime() >= cutoff,
  );
}

function trimCache(data: LocalDataCache): LocalDataCache {
  return {
    bowelMovements: trimBowelMovements(data.bowelMovements),
    meals: trimMeals(data.meals),
    savedAt: data.savedAt,
    submissions: trimSubmissions(data.submissions),
  };
}

function canUseLocalStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function getLastUserEmail() {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const email = window.localStorage.getItem(LAST_USER_KEY);
    return email?.trim() ? email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

export function setLastUserEmail(email: string) {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(LAST_USER_KEY, email.trim().toLowerCase());
  } catch {
    // Ignore private-mode / storage failures.
  }
}

export function clearLastUserEmail() {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // Ignore private-mode / storage failures.
  }
}

export function readLocalDataCache(email: string): LocalDataCache | null {
  if (!canUseLocalStorage()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(getCacheKey(email));
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LocalDataCache>;
    if (!Array.isArray(parsed.meals)) {
      return null;
    }

    return {
      bowelMovements: Array.isArray(parsed.bowelMovements)
        ? parsed.bowelMovements
        : [],
      meals: parsed.meals,
      savedAt:
        typeof parsed.savedAt === "string"
          ? parsed.savedAt
          : new Date().toISOString(),
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
    };
  } catch {
    return null;
  }
}

function writeRaw(email: string, data: LocalDataCache) {
  window.localStorage.setItem(getCacheKey(email), JSON.stringify(data));
}

export function writeLocalDataCache(
  email: string,
  data: Omit<LocalDataCache, "savedAt"> & { savedAt?: string },
) {
  if (!canUseLocalStorage()) {
    return;
  }

  const payload: LocalDataCache = {
    bowelMovements: data.bowelMovements,
    meals: data.meals,
    savedAt: data.savedAt ?? new Date().toISOString(),
    submissions: data.submissions,
  };

  try {
    writeRaw(email, payload);
  } catch (error) {
    if (!isQuotaError(error)) {
      return;
    }

    try {
      writeRaw(email, trimCache(payload));
    } catch {
      // Give up quietly if storage is still unavailable.
    }
  }
}

export function clearLocalDataCache(email: string | null | undefined) {
  if (!email || !canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.removeItem(getCacheKey(email));
  } catch {
    // Ignore private-mode / storage failures.
  }
}

export function readInitialLocalDataCache(): LocalDataCache | null {
  const email = getLastUserEmail();
  if (!email) {
    return null;
  }

  return readLocalDataCache(email);
}
