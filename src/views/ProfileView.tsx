import React, { useEffect, useMemo, useState } from 'react';
import {
  User as UserIcon,
  LogOut,
  X,
  ChevronRight,
  Utensils,
  Camera,
  Scale,
  Flame,
  Beef,
  CalendarDays,
  Shield,
  Target,
  Palette,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../firebase';
import { cn } from '../utils/cn';
import { generateWeekPlan } from '../data/mealPlanData';
import { THEMES, getThemeById, isThemeId, type ThemeId } from '../data/themes';
import { buildBadges, getBadgesByIds, type BadgeWithState } from '../utils/badges';
import {
  applyChallengeSwaps,
  buildChallengePool,
  getChallengeDisplayCount,
  pickChallengeSet,
  type ChallengeItem,
  type ChallengeSwapRecord,
} from '../data/challengeItems';
import { MAX_LEVEL, getLevelFromPoints } from '../utils/leveling';
import type { Meal, Profile, OnboardingData, ProgressPhoto, ViewType, WeightLog } from '../types';

interface Props {
  user: FirebaseUser | null;
  profile: Profile | null;
  firstName: string;
  lastName: string;
  email: string;
  onboardingData: OnboardingData;
  lastWeight: number | null;
  weightHistory: WeightLog[];
  startEditProfile: (data: OnboardingData) => void;
  setView: (v: ViewType) => void;
  handleLogout: () => void;
  openThemeShop?: boolean;
}

function badgeVisual(id: string): {
  icon: React.ElementType;
  edge: string;
  glow: string;
  center: string;
  iconColor: string;
  stamp: string;
} {
  if (id.includes('protein')) {
    return {
      icon: Beef,
      edge: 'from-red-500 to-orange-400',
      glow: 'shadow-[0_0_22px_rgba(239,68,68,0.35)]',
      center: 'from-zinc-900 via-red-950/40 to-zinc-900',
      iconColor: 'text-red-300',
      stamp: 'PR',
    };
  }
  if (id.includes('streak')) {
    return {
      icon: Flame,
      edge: 'from-amber-500 to-orange-400',
      glow: 'shadow-[0_0_22px_rgba(245,158,11,0.35)]',
      center: 'from-zinc-900 via-amber-950/40 to-zinc-900',
      iconColor: 'text-amber-300',
      stamp: 'ST',
    };
  }
  if (id.includes('photo')) {
    return {
      icon: Camera,
      edge: 'from-sky-500 to-blue-400',
      glow: 'shadow-[0_0_22px_rgba(59,130,246,0.35)]',
      center: 'from-zinc-900 via-blue-950/40 to-zinc-900',
      iconColor: 'text-blue-300',
      stamp: 'PH',
    };
  }
  if (id.includes('weight')) {
    return {
      icon: Scale,
      edge: 'from-fuchsia-500 to-violet-400',
      glow: 'shadow-[0_0_22px_rgba(168,85,247,0.35)]',
      center: 'from-zinc-900 via-violet-950/40 to-zinc-900',
      iconColor: 'text-violet-300',
      stamp: 'WG',
    };
  }
  if (id.includes('planner') || id.includes('planned') || id.includes('week')) {
    return {
      icon: CalendarDays,
      edge: 'from-emerald-500 to-teal-400',
      glow: 'shadow-[0_0_22px_rgba(16,185,129,0.35)]',
      center: 'from-zinc-900 via-emerald-950/40 to-zinc-900',
      iconColor: 'text-emerald-300',
      stamp: 'PL',
    };
  }
  if (id.includes('year') || id.includes('month')) {
    return {
      icon: Shield,
      edge: 'from-cyan-500 to-sky-400',
      glow: 'shadow-[0_0_22px_rgba(6,182,212,0.35)]',
      center: 'from-zinc-900 via-cyan-950/40 to-zinc-900',
      iconColor: 'text-cyan-300',
      stamp: 'YR',
    };
  }
  if (id.includes('first')) {
    return {
      icon: Target,
      edge: 'from-lime-500 to-emerald-400',
      glow: 'shadow-[0_0_22px_rgba(132,204,22,0.35)]',
      center: 'from-zinc-900 via-lime-950/40 to-zinc-900',
      iconColor: 'text-lime-300',
      stamp: '1ST',
    };
  }

  if (id.startsWith('theme-unlock-')) {
    const themeVisuals: Record<string, { edge: string; glow: string; center: string; iconColor: string; stamp: string }> = {
      'theme-unlock-1': {
        edge: 'from-emerald-400 to-green-500',
        glow: 'shadow-[0_0_22px_rgba(16,185,129,0.35)]',
        center: 'from-zinc-900 via-emerald-950/40 to-zinc-900',
        iconColor: 'text-emerald-300',
        stamp: 'BG',
      },
      'theme-unlock-2': {
        edge: 'from-blue-400 to-cyan-500',
        glow: 'shadow-[0_0_22px_rgba(56,189,248,0.35)]',
        center: 'from-zinc-900 via-sky-950/40 to-zinc-900',
        iconColor: 'text-sky-300',
        stamp: 'MF',
      },
      'theme-unlock-3': {
        edge: 'from-orange-400 to-amber-500',
        glow: 'shadow-[0_0_22px_rgba(251,146,60,0.35)]',
        center: 'from-zinc-900 via-orange-950/40 to-zinc-900',
        iconColor: 'text-orange-300',
        stamp: 'SM',
      },
      'theme-unlock-4': {
        edge: 'from-teal-400 to-emerald-500',
        glow: 'shadow-[0_0_22px_rgba(45,212,191,0.35)]',
        center: 'from-zinc-900 via-teal-950/40 to-zinc-900',
        iconColor: 'text-teal-300',
        stamp: 'FN',
      },
      'theme-unlock-5': {
        edge: 'from-indigo-400 to-fuchsia-500',
        glow: 'shadow-[0_0_22px_rgba(129,140,248,0.35)]',
        center: 'from-zinc-900 via-indigo-950/40 to-zinc-900',
        iconColor: 'text-indigo-300',
        stamp: 'NX',
      },
      'theme-unlock-6': {
        edge: 'from-rose-400 to-red-500',
        glow: 'shadow-[0_0_22px_rgba(251,113,133,0.35)]',
        center: 'from-zinc-900 via-rose-950/40 to-zinc-900',
        iconColor: 'text-rose-300',
        stamp: 'BR',
      },
      'theme-unlock-7': {
        edge: 'from-pink-400 to-fuchsia-500',
        glow: 'shadow-[0_0_22px_rgba(244,114,182,0.35)]',
        center: 'from-zinc-900 via-pink-950/40 to-zinc-900',
        iconColor: 'text-pink-300',
        stamp: 'PP',
      },
      'theme-unlock-8': {
        edge: 'from-yellow-300 to-amber-500',
        glow: 'shadow-[0_0_22px_rgba(250,204,21,0.35)]',
        center: 'from-zinc-900 via-amber-950/40 to-zinc-900',
        iconColor: 'text-amber-300',
        stamp: 'EG',
      },
    };

    const visual = themeVisuals[id] ?? {
      edge: 'from-violet-400 to-fuchsia-500',
      glow: 'shadow-[0_0_22px_rgba(192,132,252,0.35)]',
      center: 'from-zinc-900 via-violet-950/40 to-zinc-900',
      iconColor: 'text-violet-300',
      stamp: 'TH',
    };

    return {
      icon: Palette,
      edge: visual.edge,
      glow: visual.glow,
      center: visual.center,
      iconColor: visual.iconColor,
      stamp: visual.stamp,
    };
  }

  return {
    icon: Utensils,
    edge: 'from-orange-500 to-amber-400',
    glow: 'shadow-[0_0_22px_rgba(251,146,60,0.35)]',
    center: 'from-zinc-900 via-orange-950/40 to-zinc-900',
    iconColor: 'text-orange-300',
    stamp: 'BD',
  };
}

function BadgeHex({ badge }: { badge: BadgeWithState }) {
  const visual = badgeVisual(badge.id);
  const Icon = visual.icon;

  return (
    <motion.div
      whileTap={{ scale: 0.96 }}
      className={cn(
        'relative w-16 h-16 rounded-[20px] p-[2px] overflow-hidden',
        badge.unlocked ? visual.glow : 'opacity-50',
      )}
    >
      <div className={cn('absolute inset-0 bg-gradient-to-br', visual.edge)} />
      <div className={cn('absolute inset-[2px] rounded-[18px] bg-gradient-to-br', visual.center)} />
      <div className="absolute inset-0 flex items-center justify-center">
        <Icon size={22} className={cn('drop-shadow-sm', visual.iconColor)} />
      </div>
      <div className="absolute top-1.5 right-1.5 text-[8px] font-black text-white/80 tracking-wide">
        {visual.stamp}
      </div>
    </motion.div>
  );
}

function formatBadgeTitle(title: string): string {
  return title
    .replace(/фотографии/gi, 'фото-\nграфии')
    .replace(/дисциплина/gi, 'дисци-\nплина');
}

function dayKey(dateIso: string): string {
  const d = new Date(dateIso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function mondayBasedDayIndex(dateStr: string): number {
  const day = new Date(dateStr).getDay();
  return (day + 6) % 7;
}

function countMealsByType(meals: Meal[], type: string): number {
  return meals.filter(m => m.type === type).length;
}

function countMealItems(meals: Meal[]): number {
  return meals.reduce((sum, meal) => sum + (meal.items?.length || 0), 0);
}

function countPlannedDays(meals: Meal[]): number {
  const plannedDays = new Set<string>();
  meals.forEach(meal => {
    const hasPlannedItem = meal.items?.some(item => String(item.food?.id || '').startsWith('plan-'));
    if (hasPlannedItem) plannedDays.add(dayKey(meal.date));
  });
  return plannedDays.size;
}

function calcDailyNutrition(meals: Meal[]): { calories: number; protein: number } {
  let calories = 0;
  let protein = 0;
  meals.forEach(meal => {
    meal.items?.forEach(item => {
      const amount = item.amount || 0;
      calories += (item.food?.calories || 0) * amount;
      protein += (item.food?.protein || 0) * amount;
    });
  });
  return { calories, protein };
}

function isChallengeCompleted(challenge: ChallengeItem): boolean {
  if (challenge.rangeMode) {
    const lower = challenge.target * 0.9;
    const upper = challenge.target * 1.1;
    return challenge.progress >= lower && challenge.progress <= upper;
  }
  return challenge.progress >= challenge.target;
}

function getPremiumWindowStartMs(profile: Profile | null): number {
  const timestampCandidates = [
    profile?.premiumWindowStartedAt,  // write-once anchor — never rewritten on re-subscribe
    profile?.subscriptionStartedAt,
    profile?.subscriptionTrialStartedAt,
  ];

  for (const candidate of timestampCandidates) {
    const parsed = Date.parse(String(candidate || ''));
    if (Number.isFinite(parsed)) return parsed;
  }

  // Keep non-premium history excluded even when legacy premium timestamps are missing.
  return profile?.isPremium ? Date.now() : Number.NaN;
}

function mealLogStreak(meals: Meal[]): number {
  const dates = new Set(meals.map(m => dayKey(m.date)));
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (dates.has(key)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function getDailyCalorieTarget(profile: Profile | null, dayKeyValue: string): number {
  if (!profile) return 0;

  let target = profile.targetCalories || 0;
  if (profile.mealPlanType && profile.mealPlanSeed) {
    const week = generateWeekPlan(profile.targetCalories, profile.mealPlanSeed, profile.mealPlanType, profile.targetProtein);
    const dayPlan = week[mondayBasedDayIndex(dayKeyValue)];
    target = dayPlan.reduce((sum, meal) => sum + meal.kcal, 0);
  }

  return Math.max(0, target);
}

function getQualifiedStreakDayKeys(profile: Profile | null, meals: Meal[], restoredDayKeys: string[]): Set<string> {
  const caloriesByDay = new Map<string, number>();
  meals.forEach(meal => {
    const key = dayKey(meal.date);
    let totalCalories = caloriesByDay.get(key) || 0;
    meal.items?.forEach(item => {
      totalCalories += (item.food?.calories || 0) * (item.amount || 0);
    });
    caloriesByDay.set(key, totalCalories);
  });

  const qualifiedDays = new Set<string>();
  caloriesByDay.forEach((calories, key) => {
    const target = getDailyCalorieTarget(profile, key);
    if (target > 0 && calories >= target) {
      qualifiedDays.add(key);
    }
  });
  restoredDayKeys.forEach(key => qualifiedDays.add(key));
  return qualifiedDays;
}

function mealLogStreakWithRestores(profile: Profile | null, meals: Meal[], restoredDayKeys: string[]): number {
  const dates = getQualifiedStreakDayKeys(profile, meals, restoredDayKeys);
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
    if (dates.has(key)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function startOfWeek(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfYear(date: Date): Date {
  const d = new Date(date.getFullYear(), 0, 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function countPlannedMeals(meals: Meal[]): number {
  return meals.filter(m => m.items?.some(item => String(item.food?.id || '').startsWith('plan-'))).length;
}

function countProteinTargetDays(meals: Meal[], targetProtein: number): number {
  const byDay = new Map<string, number>();
  meals.forEach(meal => {
    const key = dayKey(meal.date);
    let protein = byDay.get(key) || 0;
    meal.items?.forEach(item => {
      protein += (item.food?.protein || 0) * (item.amount || 0);
    });
    byDay.set(key, protein);
  });
  let hitDays = 0;
  byDay.forEach(value => {
    if (value >= targetProtein) hitDays += 1;
  });
  return hitDays;
}

function PremiumLevelBadge({ level }: { level: number }) {
  const cappedLevel = Math.min(MAX_LEVEL, Math.max(1, level));
  const stage = ((cappedLevel - 1) % 5) + 1;
  const tier = cappedLevel <= 5
    ? 'bronze'
    : cappedLevel <= 10
      ? 'silver'
      : cappedLevel <= 15
        ? 'gold'
        : 'platinum';

  const romanNumerals = ['I', 'II', 'III', 'IV', 'V'];
  const romanNumeral = romanNumerals[stage - 1];

  const tierStyles = {
    bronze: {
      outer: 'from-orange-300 to-orange-600',
      rim: 'from-amber-200 to-orange-500',
      symbol: 'text-amber-100',
      glow: 'bg-orange-400/30',
    },
    silver: {
      outer: 'from-slate-200 to-slate-500',
      rim: 'from-zinc-100 to-slate-400',
      symbol: 'text-slate-100',
      glow: 'bg-slate-300/30',
    },
    gold: {
      outer: 'from-yellow-200 to-amber-500',
      rim: 'from-yellow-100 to-orange-400',
      symbol: 'text-yellow-50',
      glow: 'bg-yellow-300/30',
    },
    platinum: {
      outer: 'from-cyan-200 to-indigo-500',
      rim: 'from-sky-100 to-blue-500',
      symbol: 'text-cyan-50',
      glow: 'bg-cyan-300/30',
    },
  } as const;

  const visual = tierStyles[tier];

  return (
    <div className="absolute -top-0.5 -right-1.5 z-20 pointer-events-none">
      <motion.div
        className={cn('absolute -inset-2 rounded-full blur-[6px]', visual.glow)}
        animate={{ opacity: [0.25, 0.55, 0.25], scale: [0.9, 1.05, 0.9] }}
        transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
      />

      <div className="relative w-8 h-8">
        <div
          className={cn('absolute inset-0 bg-gradient-to-b border border-zinc-700/70 shadow-[0_2px_8px_rgba(0,0,0,0.45)]', visual.outer)}
          style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
        />
        <div
          className={cn('absolute inset-[2px] bg-gradient-to-b border border-white/40', visual.rim)}
          style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
        />
        <div
          className="absolute inset-[4px] bg-gradient-to-b from-indigo-500 via-blue-700 to-indigo-900 border border-blue-200/40"
          style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
        />

        <div className={cn('absolute inset-0 flex items-center justify-center', visual.symbol)}>
          <span className="text-[11px] font-black tracking-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
            {romanNumeral}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ProfileView({
  user, profile, firstName, lastName, email,
  onboardingData, lastWeight, weightHistory,
  startEditProfile, setView, handleLogout, openThemeShop,
}: Props) {
  const [allMeals, setAllMeals] = useState<Meal[]>([]);
  const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
  const [streakRestoreDays, setStreakRestoreDays] = useState<string[]>([]);
  const [purchasedChallengeCompletions, setPurchasedChallengeCompletions] = useState<string[]>([]);
  const [challengeSwaps, setChallengeSwaps] = useState<ChallengeSwapRecord[]>([]);
  const [showBadgeCase, setShowBadgeCase] = useState(false);
  const [showThemeShop, setShowThemeShop] = useState(false);
  const [themePurchaseIds, setThemePurchaseIds] = useState<ThemeId[]>([]);
  const [spentPointsTotal, setSpentPointsTotal] = useState(0);
  const [isThemeActionLoading, setIsThemeActionLoading] = useState(false);
  const [themeFeedback, setThemeFeedback] = useState<string | null>(null);
  const isPremium = profile?.isPremium ?? false;

  const savedPremiumBadgeIds = useMemo(() => {
    // Merge explicit badge unlock list with persisted earned achievement IDs.
    const unlockedIds = Array.isArray(profile?.unlockedBadgeIds)
      ? profile.unlockedBadgeIds.filter((v): v is string => typeof v === 'string')
      : [];
    const earnedAchievementBadgeIds = Array.isArray(profile?.earnedAchievementIds)
      ? profile.earnedAchievementIds
          .filter((v): v is string => typeof v === 'string' && v.startsWith('badge:'))
          .map(v => v.replace('badge:', ''))
      : [];
    return Array.from(new Set([...unlockedIds, ...earnedAchievementBadgeIds]));
  }, [profile?.earnedAchievementIds, profile?.unlockedBadgeIds]);

  useEffect(() => {
    if (!isPremium) {
      setShowThemeShop(false);
      setThemeFeedback(null);
    }
  }, [isPremium]);

  useEffect(() => {
    if (openThemeShop && isPremium) setShowThemeShop(true);
  }, [openThemeShop, isPremium]);

  useEffect(() => {
    if (!user) return;

    const unsubMeals = onSnapshot(
      query(collection(db, 'meals'), where('userId', '==', user.uid)),
      snap => setAllMeals(snap.docs.map(d => ({ id: d.id, ...d.data() } as Meal))),
      err => handleFirestoreError(err, OperationType.LIST, 'meals'),
    );

    const unsubPhotos = onSnapshot(
      query(collection(db, 'progress_photos'), where('userId', '==', user.uid)),
      snap => setPhotos(snap.docs.map(d => ({ id: d.id, ...d.data() } as ProgressPhoto))),
      err => handleFirestoreError(err, OperationType.LIST, 'progress_photos'),
    );

    const unsubStreakRestores = onSnapshot(
      query(collection(db, 'streak_restores'), where('userId', '==', user.uid)),
      snap => setStreakRestoreDays(
        snap.docs
          .map(d => String(d.data().dayKey || ''))
          .filter(Boolean),
      ),
      err => handleFirestoreError(err, OperationType.LIST, 'streak_restores'),
    );

    const unsubChallengeCompletions = onSnapshot(
      query(collection(db, 'challenge_completions'), where('userId', '==', user.uid)),
      snap => setPurchasedChallengeCompletions(
        snap.docs
          .map(d => String(d.data().challengePurchaseKey || ''))
          .filter(Boolean),
      ),
      err => handleFirestoreError(err, OperationType.LIST, 'challenge_completions'),
    );

    const unsubChallengeSwaps = onSnapshot(
      query(collection(db, 'challenge_swaps'), where('userId', '==', user.uid)),
      snap => setChallengeSwaps(
        snap.docs
          .map(d => ({
            section: d.data().section,
            periodKey: String(d.data().periodKey || ''),
            fromChallengeId: String(d.data().fromChallengeId || ''),
            toChallengeId: String(d.data().toChallengeId || ''),
            date: d.data().date ? String(d.data().date) : undefined,
          }))
          .filter(swap =>
            (swap.section === 'daily' || swap.section === 'weekly' || swap.section === 'monthly' || swap.section === 'yearly')
            && !!swap.periodKey
            && !!swap.fromChallengeId
            && !!swap.toChallengeId,
          ) as ChallengeSwapRecord[],
      ),
      err => handleFirestoreError(err, OperationType.LIST, 'challenge_swaps'),
    );

    const unsubThemePurchases = onSnapshot(
      query(collection(db, 'theme_purchases'), where('userId', '==', user.uid)),
      snap => {
        const ids = snap.docs
          .map(d => String(d.data().themeId || ''))
          .filter(isThemeId);
        setThemePurchaseIds(Array.from(new Set(ids)));
      },
      err => handleFirestoreError(err, OperationType.LIST, 'theme_purchases'),
    );

    const unsubPointSpends = onSnapshot(
      query(collection(db, 'point_spends'), where('userId', '==', user.uid)),
      snap => {
        const totalSpent = snap.docs.reduce((sum, d) => {
          const cost = Number(d.data().cost || 0);
          return sum + (Number.isFinite(cost) ? Math.max(0, cost) : 0);
        }, 0);
        setSpentPointsTotal(totalSpent);
      },
      err => handleFirestoreError(err, OperationType.LIST, 'point_spends'),
    );

    return () => {
      unsubMeals();
      unsubPhotos();
      unsubStreakRestores();
      unsubChallengeCompletions();
      unsubChallengeSwaps();
      unsubThemePurchases();
      unsubPointSpends();
    };
  }, [user]);

  const badgeState = useMemo(() => {
      const today = new Date();
      const todayStr = dayKey(today.toISOString());
      const weekStart = startOfWeek(today);
      const weekKey = dayKey(weekStart.toISOString());
      const monthStart = startOfMonth(today);
      const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
      const yearStart = startOfYear(today);
      const yearKey = String(today.getFullYear());

      const premiumWindowStartMs = getPremiumWindowStartMs(profile);
      const hasPremiumWindowStart = Number.isFinite(premiumWindowStartMs);

      const premiumMeals = hasPremiumWindowStart
        ? allMeals.filter(m => new Date(m.date).getTime() >= premiumWindowStartMs)
        : [];
      const premiumPhotos = hasPremiumWindowStart
        ? photos.filter(p => new Date(p.date).getTime() >= premiumWindowStartMs)
        : [];
      const premiumWeightLogs = hasPremiumWindowStart
        ? weightHistory.filter(w => new Date(w.date).getTime() >= premiumWindowStartMs)
        : [];
      const premiumRestoreDays = hasPremiumWindowStart
        ? streakRestoreDays.filter(day => {
            const dayMs = Date.parse(`${day}T00:00:00.000Z`);
            return Number.isFinite(dayMs) && dayMs >= premiumWindowStartMs;
          })
        : [];

      const todayMeals = premiumMeals.filter(m => dayKey(m.date) === todayStr);
      const thisWeekMeals = premiumMeals.filter(m => new Date(m.date) >= weekStart);
      const thisMonthMeals = premiumMeals.filter(m => new Date(m.date) >= monthStart);
      const thisYearMeals = premiumMeals.filter(m => new Date(m.date) >= yearStart);
      const thisWeekWeightLogs = premiumWeightLogs.filter(w => new Date(w.date) >= weekStart);
      const thisMonthWeightLogs = premiumWeightLogs.filter(w => new Date(w.date) >= monthStart);
      const thisYearWeightLogs = premiumWeightLogs.filter(w => new Date(w.date) >= yearStart);
      const thisWeekPhotos = premiumPhotos.filter(p => new Date(p.date) >= weekStart);
      const thisMonthPhotos = premiumPhotos.filter(p => new Date(p.date) >= monthStart);
      const thisYearPhotos = premiumPhotos.filter(p => new Date(p.date) >= yearStart);

      const mealTypesToday = new Set(todayMeals.map(m => m.type));
      const hasBreakfast = mealTypesToday.has('breakfast');
      const hasLunch = mealTypesToday.has('lunch');
      const hasDinner = mealTypesToday.has('dinner');
      const breakfastsToday = countMealsByType(todayMeals, 'breakfast');
      const lunchesToday = countMealsByType(todayMeals, 'lunch');
      const dinnersToday = countMealsByType(todayMeals, 'dinner');
      const snacksToday = countMealsByType(todayMeals, 'snack');

      const nutritionToday = calcDailyNutrition(todayMeals);
      let effectiveTargetCalories = profile?.targetCalories ?? 0;
      let effectiveTargetProtein = profile?.targetProtein ?? 0;

      if (profile?.isPremium && profile.mealPlanType && profile.mealPlanSeed) {
        const week = generateWeekPlan(profile.targetCalories, profile.mealPlanSeed, profile.mealPlanType, profile.targetProtein);
        const dayPlan = week[mondayBasedDayIndex(todayStr)];
        effectiveTargetCalories = dayPlan.reduce((sum, meal) => sum + meal.kcal, 0);
        effectiveTargetProtein = dayPlan.reduce((sum, meal) => sum + meal.protein, 0);
      }

      const proteinGoal = Math.max(1, Math.round(effectiveTargetProtein));
      const calorieGoal = Math.max(1, Math.round(effectiveTargetCalories));

      const plannedMealsAddedWeek = countPlannedMeals(thisWeekMeals);
      const plannedMealsAddedMonth = countPlannedMeals(thisMonthMeals);
      const plannedMealsAddedYear = countPlannedMeals(thisYearMeals);
      const plannedMealsAddedToday = countPlannedMeals(todayMeals);

      const activeMealDaysMonth = new Set(thisMonthMeals.map(m => dayKey(m.date))).size;
      const activeMealDaysYear = new Set(thisYearMeals.map(m => dayKey(m.date))).size;
      const activeMealDaysWeek = new Set(thisWeekMeals.map(m => dayKey(m.date))).size;

      const weekBreakfasts = countMealsByType(thisWeekMeals, 'breakfast');
      const weekLunches = countMealsByType(thisWeekMeals, 'lunch');
      const weekDinners = countMealsByType(thisWeekMeals, 'dinner');
      const weekSnacks = countMealsByType(thisWeekMeals, 'snack');
      const weekProteinHitDays = countProteinTargetDays(thisWeekMeals, proteinGoal);
      const weekMealItems = countMealItems(thisWeekMeals);

      const monthBreakfasts = countMealsByType(thisMonthMeals, 'breakfast');
      const monthLunches = countMealsByType(thisMonthMeals, 'lunch');
      const monthDinners = countMealsByType(thisMonthMeals, 'dinner');
      const monthSnacks = countMealsByType(thisMonthMeals, 'snack');
      const monthProteinHitDays = countProteinTargetDays(thisMonthMeals, proteinGoal);
      const monthPlannedDays = countPlannedDays(thisMonthMeals);
      const monthMealItems = countMealItems(thisMonthMeals);

      const yearBreakfasts = countMealsByType(thisYearMeals, 'breakfast');
      const yearLunches = countMealsByType(thisYearMeals, 'lunch');
      const yearDinners = countMealsByType(thisYearMeals, 'dinner');
      const yearSnacks = countMealsByType(thisYearMeals, 'snack');
      const yearProteinHitDays = countProteinTargetDays(thisYearMeals, proteinGoal);
      const yearPlannedDays = countPlannedDays(thisYearMeals);
      const yearMealItems = countMealItems(thisYearMeals);

      const metrics: Record<string, number> = {
        todayMainMeals: [hasBreakfast, hasLunch, hasDinner].filter(Boolean).length,
        nutritionProtein: Math.round(nutritionToday.protein),
        nutritionCalories: Math.round(nutritionToday.calories),
        breakfastsToday,
        lunchesToday,
        dinnersToday,
        todayMealsCount: todayMeals.length,
        snacksToday,
        plannedMealsAddedToday,
        todayItemCount: countMealItems(todayMeals),
        proteinGoal,
        calorieGoal,
        thisWeekWeightLogsCount: thisWeekWeightLogs.length,
        thisWeekPhotosCount: thisWeekPhotos.length,
        plannedMealsAddedWeek,
        thisWeekMealsCount: thisWeekMeals.length,
        activeMealDaysWeek,
        weekBreakfasts,
        weekLunches,
        weekDinners,
        weekSnacks,
        weekProteinHitDays,
        weekMealItems,
        weekPlannedDays: countPlannedDays(thisWeekMeals),
        activeMealDaysMonth,
        thisMonthMealsCount: thisMonthMeals.length,
        thisMonthWeightLogsCount: thisMonthWeightLogs.length,
        plannedMealsAddedMonth,
        thisMonthPhotosCount: thisMonthPhotos.length,
        monthProteinHitDays,
        monthBreakfasts,
        monthLunches,
        monthDinners,
        monthPlannedDays,
        monthSnacks,
        monthMainMeals: monthBreakfasts + monthLunches + monthDinners,
        monthMealItems,
        activeMealDaysYear,
        thisYearMealsCount: thisYearMeals.length,
        thisYearWeightLogsCount: thisYearWeightLogs.length,
        plannedMealsAddedYear,
        thisYearPhotosCount: thisYearPhotos.length,
        yearProteinHitDays,
        yearBreakfasts,
        yearLunches,
        yearDinners,
        yearPlannedDays,
        yearSnacks,
        yearMainMeals: yearBreakfasts + yearLunches + yearDinners,
        yearMealItems,
      };

      // Only calculate challenges if premium
      const dailyPool = isPremium ? buildChallengePool('daily', metrics) : [];
      const weeklyPool = isPremium ? buildChallengePool('weekly', metrics) : [];
      const monthlyPool = isPremium ? buildChallengePool('monthly', metrics) : [];
      const yearlyPool = isPremium ? buildChallengePool('yearly', metrics) : [];

      const dailyChallenges = applyChallengeSwaps(
        pickChallengeSet(dailyPool, `daily:${todayStr}`, getChallengeDisplayCount('daily')),
        pickChallengeSet(dailyPool, `daily:${todayStr}`, dailyPool.length),
        challengeSwaps,
        'daily',
        todayStr,
      );
      const weeklyChallenges = applyChallengeSwaps(
        pickChallengeSet(weeklyPool, `weekly:${weekKey}`, getChallengeDisplayCount('weekly')),
        pickChallengeSet(weeklyPool, `weekly:${weekKey}`, weeklyPool.length),
        challengeSwaps,
        'weekly',
        weekKey,
      );
      const monthlyChallenges = applyChallengeSwaps(
        pickChallengeSet(monthlyPool, `monthly:${monthKey}`, getChallengeDisplayCount('monthly')),
        pickChallengeSet(monthlyPool, `monthly:${monthKey}`, monthlyPool.length),
        challengeSwaps,
        'monthly',
        monthKey,
      );
      const yearlyChallenges = applyChallengeSwaps(
        pickChallengeSet(yearlyPool, `yearly:${yearKey}`, getChallengeDisplayCount('yearly')),
        pickChallengeSet(yearlyPool, `yearly:${yearKey}`, yearlyPool.length),
        challengeSwaps,
        'yearly',
        yearKey,
      );

      const completedDaily = dailyChallenges.filter(isChallengeCompleted).length;
      const completedWeekly = weeklyChallenges.filter(isChallengeCompleted).length;
      const completedMonthly = monthlyChallenges.filter(isChallengeCompleted).length;
      const completedYearly = yearlyChallenges.filter(isChallengeCompleted).length;

      const streak = mealLogStreakWithRestores(profile, premiumMeals, premiumRestoreDays);
      const daysProteinHit = countProteinTargetDays(premiumMeals, proteinGoal);

      const totalPlannedMeals = countPlannedMeals(premiumMeals);

      const badges = buildBadges({
        allMealsCount: premiumMeals.length,
        photosCount: premiumPhotos.length,
        weightCount: premiumWeightLogs.length,
        unlockedThemesCount: themePurchaseIds.length,
        streak,
        daysProteinHit,
        plannedMealsAddedWeek,
        totalPlannedMeals,
        completedMonthly,
        completedYearly,
      });

      // Deduplicate: a badge earned in a previous period may also be unlocked in the
      // current period — it should only count once for both display and points.
      const earnedBadgeIds = Array.from(new Set([
        ...savedPremiumBadgeIds,
        ...badges.filter(b => b.unlocked).map(b => b.id),
      ]));
      const earnedBadges = getBadgesByIds(earnedBadgeIds);
      
      // Calculate points and level only if premium
      if (!isPremium) {
        const lifetimePoints = Math.max(0, Number(profile?.totalEarnedPoints ?? 0));
        return {
          earnedBadges: getBadgesByIds(savedPremiumBadgeIds),
          level: Math.max(getLevelFromPoints(lifetimePoints), profile?.maxLevelAchieved ?? 1),
          points: lifetimePoints,
        };
      }
      
      const challengePoints = completedDaily * 10 + completedWeekly * 30 + completedMonthly * 150 + completedYearly * 1000;
      const badgePoints = earnedBadges.length * 50;
      const cyclePoints = challengePoints + badgePoints;
      const points = Math.max(Math.max(0, Number(profile?.totalEarnedPoints ?? 0)), cyclePoints);
      const level = Math.max(getLevelFromPoints(points), profile?.maxLevelAchieved ?? 1);

          return { earnedBadges, level, points };
        }, [allMeals, challengeSwaps, isPremium, photos, profile?.maxLevelAchieved, profile?.subscriptionStartedAt, profile?.targetCalories, profile?.targetProtein, profile?.totalEarnedPoints, purchasedChallengeCompletions, savedPremiumBadgeIds, streakRestoreDays, themePurchaseIds.length, weightHistory]);

  // Persist newly earned badges to Firestore
  useEffect(() => {
    if (!user || !isPremium) return;
    const newBadgeIds = badgeState.earnedBadges
      .map(b => b.id)
      .filter(id => !savedPremiumBadgeIds.includes(id));
    
    if (newBadgeIds.length === 0) return;
    
    const mergedBadgeIds = Array.from(new Set([...savedPremiumBadgeIds, ...newBadgeIds]));
    updateDoc(doc(db, 'profiles', user.uid), {
      unlockedBadgeIds: mergedBadgeIds,
    }).catch(error => handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}/unlockedBadgeIds`));
  }, [user, isPremium, badgeState.earnedBadges, savedPremiumBadgeIds]);

  const availablePoints = isPremium ? Math.max(0, badgeState.points - spentPointsTotal) : 0;
  const activeThemeId: ThemeId | null = isThemeId(profile?.activeTheme) ? profile.activeTheme : null;
  const unlockedThemeSet = useMemo(() => {
    const ids = new Set<ThemeId>();
    themePurchaseIds.forEach(id => ids.add(id));
    return ids;
  }, [themePurchaseIds]);

  const handleActivateTheme = async (themeId: ThemeId) => {
    if (!user || !isPremium) return;
    if (!unlockedThemeSet.has(themeId)) return;
    setIsThemeActionLoading(true);
    setThemeFeedback(null);
    try {
      await setDoc(doc(db, 'profiles', user.uid), { activeTheme: themeId }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}/activeTheme`);
      setThemeFeedback('Не успеа менувањето на темата. Пробај повторно.');
    } finally {
      setIsThemeActionLoading(false);
    }
  };

  const handleBuyTheme = async (themeId: ThemeId) => {
    if (!user || !isPremium) return;
    const theme = getThemeById(themeId);
    if (theme.cost <= 0 || unlockedThemeSet.has(themeId)) return;
    if (availablePoints < theme.cost) {
      setThemeFeedback('Немаш доволно поени за оваа тема.');
      return;
    }

    setIsThemeActionLoading(true);
    setThemeFeedback(null);
    try {
      const nowIso = new Date().toISOString();
      const batch = writeBatch(db);

      const spendRef = doc(collection(db, 'point_spends'));
      batch.set(spendRef, {
        userId: user.uid,
        type: 'theme_purchase',
        cost: theme.cost,
        targetThemeId: theme.id,
        date: nowIso,
      });

      const purchaseRef = doc(collection(db, 'theme_purchases'));
      batch.set(purchaseRef, {
        userId: user.uid,
        themeId: theme.id,
        cost: theme.cost,
        type: 'theme_purchase',
        date: nowIso,
      });

      await batch.commit();
      await setDoc(doc(db, 'profiles', user.uid), { activeTheme: theme.id }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'theme_purchase');
      setThemeFeedback('Не успеа купувањето на темата. Пробај повторно.');
    } finally {
      setIsThemeActionLoading(false);
    }
  };

  const newestEarnedBadges = useMemo(
    () => badgeState.earnedBadges.slice(-4).reverse(),
    [badgeState.earnedBadges],
  );

  const statsRows = [
    { label: 'Тежина', value: lastWeight != null ? `${lastWeight} кг` : `${profile?.weight} кг` },
    { label: 'Висина', value: `${profile?.height} цм` },
    { label: 'Години', value: `${profile?.age} год` },
    { label: 'Пол', value: profile?.gender === 'male' ? 'Машко' : 'Женско' },
    {
      label: 'Цел', value:
        profile?.goal === 'cut' ? 'Слабеење' :
        profile?.goal === 'maintenance' ? 'Одржување' :
        profile?.goal === 'bulk' ? 'Маса' : 'Слабеење и мускул',
    },
    {
      label: 'Тренинг', value:
        profile?.trainingFrequency === '0_times' ? 'Не тренирам' :
        profile?.trainingFrequency === '1_2_times' ? '1-2 пати' :
        profile?.trainingFrequency === '3_times' ? '3 пати' :
        profile?.trainingFrequency === '4_5_times' ? '4-5 пати' : 'Секој ден',
    },
    {
      label: 'Дневна активност', value:
        profile?.dailyActivity === 'sedentary' ? 'Минимално' :
        profile?.dailyActivity === 'light' ? 'Малку' :
        profile?.dailyActivity === 'moderate' ? 'Умерено' : 'Многу',
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="px-6 pt-10 space-y-8 safe-area-pt"
    >
      <div className="flex flex-col items-center mb-8">
        <div className="relative w-24 h-24 mb-4">
          <div className="w-full h-full rounded-full bg-zinc-900 border-2 border-emerald-500 overflow-hidden flex items-center justify-center">
            {profile?.profileImage ? (
              <img src={profile.profileImage} alt="Profile" className="w-full h-full object-cover" />
            ) : (
              <UserIcon size={40} className="text-zinc-700" />
            )}
          </div>
          {isPremium && <PremiumLevelBadge level={badgeState.level} />}
        </div>
        <h2 className="text-2xl font-bold">{firstName} {lastName}</h2>
        <p className="text-zinc-500 text-sm">{email}</p>
      </div>

      <div className="bg-zinc-900/50 rounded-3xl border border-zinc-900 overflow-hidden">
        {statsRows.map((item, i) => (
          <div key={i} className={cn('flex justify-between items-center p-5', i !== 0 && 'border-t border-zinc-900')}>
            <span className="text-zinc-500 text-sm uppercase tracking-wider font-medium">{item.label}</span>
            <span className="font-bold">{item.value}</span>
          </div>
        ))}
      </div>

      <div className="bg-zinc-900/70 border border-zinc-800 rounded-3xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-3xl font-black tracking-tight">Освоени значки</h3>
          <span className="text-3xl font-black text-zinc-300">{badgeState.earnedBadges.length}</span>
        </div>

        {newestEarnedBadges.length > 0 ? (
          <>
            <div className="flex gap-3 overflow-x-auto pb-1">
              {newestEarnedBadges.map(badge => (
                <div key={badge.id} className="shrink-0 w-[104px] rounded-2xl border border-zinc-800 bg-zinc-900/60 p-2 flex flex-col items-center text-center gap-1.5">
                  <BadgeHex badge={badge} />
                  <p
                    className="w-full text-center text-[11px] font-semibold leading-tight text-zinc-100"
                    style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                  >
                    {formatBadgeTitle(badge.title)}
                  </p>
                </div>
              ))}
            </div>
            <button
              onClick={() => setShowBadgeCase(true)}
              className="w-full rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-3 font-bold text-zinc-100 flex items-center justify-center gap-2 active:scale-[0.99] transition-transform"
            >
              Види ги сите освоени значки
              <ChevronRight size={16} />
            </button>
          </>
        ) : (
          <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-950/60 p-4 text-center">
            <p className="text-sm text-zinc-300 font-semibold">Се уште немаш освоени значки</p>
            <p className="text-xs text-zinc-500 mt-1">Почни со логирање оброци за да ги отклучиш првите значки.</p>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <button
          onClick={() => {
            startEditProfile(profile ? {
              weight: profile.weight,
              height: profile.height,
              age: profile.age,
              gender: profile.gender,
              activityLevel: profile.activityLevel,
              goal: profile.goal,
              trainingType: profile.trainingType || 'mixed',
              trainingFrequency: profile.trainingFrequency || '3_times',
              dailyActivity: profile.dailyActivity || 'sedentary',
              profileImage: profile.profileImage || '',
            } : onboardingData);
          }}
          className="w-full py-4 rounded-2xl bg-zinc-900 text-white font-bold border border-zinc-800 hover:bg-zinc-800 transition-colors"
        >
          Уреди профил
        </button>
        {isPremium && (
          <button
            onClick={() => {
              setThemeFeedback(null);
              setShowThemeShop(true);
            }}
            className="w-full py-4 rounded-2xl bg-zinc-900 text-white font-bold border border-zinc-800 hover:bg-zinc-800 transition-colors"
          >
            Теми
          </button>
        )}
        <button
          onClick={handleLogout}
          className="w-full py-4 rounded-2xl bg-zinc-900 text-zinc-400 font-bold border border-zinc-800 hover:bg-zinc-800 transition-colors flex items-center justify-center gap-2"
        >
          <LogOut size={20} />
          Одјави се
        </button>
        <p className="text-center text-[10px] text-zinc-600 uppercase tracking-widest mt-2">
          Вашите податоци се безбедно зачувани на вашиот профил
        </p>
      </div>

      <AnimatePresence>
        {isPremium && showThemeShop && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[2150] bg-black/80 backdrop-blur-sm"
            onClick={() => setShowThemeShop(false)}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 18, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute left-4 right-4 top-[calc(env(safe-area-inset-top,0px)+16px)] bottom-[calc(env(safe-area-inset-bottom,0px)+16px)] rounded-3xl border border-zinc-700 bg-zinc-950 p-5 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-2xl font-black">Теми</h4>
                  <p className="text-xs text-zinc-400 mt-1">Достапни поени: {availablePoints}</p>
                </div>
                <button
                  onClick={() => setShowThemeShop(false)}
                  className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 active:scale-90 transition-transform"
                  aria-label="Затвори"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-3">
                {THEMES.map(theme => {
                  const unlocked = unlockedThemeSet.has(theme.id);
                  const active = unlocked && activeThemeId === theme.id;
                  const canBuy = !unlocked && availablePoints >= theme.cost;

                  return (
                    <div key={theme.id} className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-black text-base">{theme.title}</p>
                          <p className="text-xs text-zinc-400">{theme.subtitle}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs font-bold text-zinc-300">{theme.cost} поени</p>
                          {active && <p className="text-[10px] text-emerald-300 mt-1">Активна</p>}
                        </div>
                      </div>

                      <div className="mt-3 flex justify-end">
                        {unlocked ? (
                          <button
                            disabled={active || isThemeActionLoading}
                            onClick={() => void handleActivateTheme(theme.id)}
                            className="px-4 py-2 rounded-xl bg-zinc-800 border border-zinc-700 text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {active ? 'Избрана' : 'Избери'}
                          </button>
                        ) : (
                          <button
                            disabled={!canBuy || isThemeActionLoading}
                            onClick={() => void handleBuyTheme(theme.id)}
                            className="px-4 py-2 rounded-xl bg-emerald-500 text-black text-sm font-bold disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed"
                          >
                            Купи
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {themeFeedback && (
                <p className="mt-4 text-xs text-rose-300 text-center">{themeFeedback}</p>
              )}
            </motion.div>
          </motion.div>
        )}

        {showBadgeCase && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[2100] bg-black/80 backdrop-blur-sm"
            onClick={() => setShowBadgeCase(false)}
          >
            <motion.div
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 18, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="absolute left-4 right-4 top-[calc(env(safe-area-inset-top,0px)+16px)] bottom-[calc(env(safe-area-inset-bottom,0px)+16px)] rounded-3xl border border-zinc-700 bg-zinc-950 p-5 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-2xl font-black">Освоени значки</h4>
                <button
                  onClick={() => setShowBadgeCase(false)}
                  className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 active:scale-90 transition-transform"
                  aria-label="Затвори"
                >
                  <X size={16} />
                </button>
              </div>

              {badgeState.earnedBadges.length > 0 ? (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  {badgeState.earnedBadges.slice().reverse().map(badge => (
                    <motion.div
                      key={badge.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-2.5 flex flex-col items-center text-center gap-1.5"
                    >
                      <BadgeHex badge={badge} />
                      <p
                        className="w-full text-center text-[11px] font-semibold leading-tight text-zinc-100"
                        style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
                      >
                        {formatBadgeTitle(badge.title)}
                      </p>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-zinc-700 bg-zinc-900/60 p-6 text-center text-zinc-400">
                  Нема освоени значки.
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
