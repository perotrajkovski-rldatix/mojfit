import React, { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Activity, Home, TrendingUp, User as UserIcon, Crown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
  deleteUser,
  User as FirebaseUser,
  GoogleAuthProvider,
  signInWithPopup,
  updatePassword,
  signInWithCredential,
  getAdditionalUserInfo,
} from 'firebase/auth';
import {
  doc, setDoc, getDoc, collection, query, where,
  onSnapshot, addDoc, updateDoc, deleteDoc, getDocs,
  getDocFromServer, orderBy, runTransaction,
} from 'firebase/firestore';
import { auth, db, OperationType, handleFirestoreError } from './firebase';
import { cn } from './utils/cn';
import { getFriendlyErrorMessage } from './utils/errors';
import { calculateMacros } from './utils/macros';
import { buildBadges } from './utils/badges';
import {
  applyChallengeSwaps,
  buildChallengePool,
  getChallengeDisplayCount,
  pickChallengeSet,
  type ChallengeSwapRecord,
  type ChallengeItem,
} from './data/challengeItems';
import { isThemeId, type ThemeId } from './data/themes';
import type { Profile, Meal, WeightLog, OnboardingData, ViewType, AuthModeType, ProgressPhoto } from './types';
import { generateWeekPlan } from './data/mealPlanData';
import type { MealPlanType, PlanMeal } from './data/mealPlanData';
import ErrorBoundary from './ErrorBoundary';
import AuthView from './views/AuthView';
import GooglePasswordView from './views/GooglePasswordView';
import OnboardingView from './views/OnboardingView';
import DashboardView from './views/DashboardView';
import SearchView from './views/SearchView';
import WeightView from './views/WeightView';
import ProfileView from './views/ProfileView';
import SubscriptionView from './views/SubscriptionView';
import AiMealPlanView from './views/AiMealPlanView';
import ProgressPhotosView from './views/ProgressPhotosView';
import ChallengesView from './views/ChallengesView';
import { PlayBilling, isPlayBillingBridgeAvailable, type BillingProduct } from './plugins/playBilling';
import { StoreKitBilling, isStoreKitBridgeAvailable } from './plugins/storeKitBilling';

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    // Firebase connection issue
  }
}
testConnection();

export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isSameLocalDay(dateStr: string, date: Date): boolean {
  return dateStr === localDateStr(date);
}

function mondayBasedDayIndex(dateStr: string): number {
  const day = new Date(dateStr).getDay();
  return (day + 6) % 7;
}

interface AchievementToast {
  id: string;
  title: string;
  kind: 'challenge' | 'badge';
}

interface SubscriptionPlanInput {
  id: 'trial-7-days' | 'monthly' | 'half-yearly' | 'yearly';
  months: number;
  priceMKD: number;
  title: string;
}

const TRIAL_DAYS = 7;
const MONTHLY_PRICE_MKD = 300;
const PLAY_BILLING_UNAVAILABLE_MESSAGE = 'Инсталираната Android верзија нема Play Billing поддршка. Ажурирај ја апликацијата од најновиот Closed Testing build на Google Play.';
const ANDROID_SUBSCRIPTION_PRODUCT_IDS: Record<SubscriptionPlanInput['id'], string[]> = {
  'trial-7-days': ['mojfit_monthly'],
  monthly: ['mojfit_monthly'],
  'half-yearly': ['mojfit_half_yearly'],
  yearly: ['mojfit_yearly'],
};

function isAndroidPlayBillingFlow(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

function ensureAndroidPlayBillingAvailable(): void {
  if (isAndroidPlayBillingFlow() && !isPlayBillingBridgeAvailable()) {
    throw new Error(PLAY_BILLING_UNAVAILABLE_MESSAGE);
  }
}

function isPlayBillingUnimplementedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('playbilling')
    && message.includes('not implemented')
    && message.includes('android');
}

// iOS has no client-selectable trial "offer" like Play — a free trial is an Introductory
// Offer configured once on the monthly product in App Store Connect and auto-applied by
// the system for eligible accounts, so trial and monthly map to the same product id.
const IOS_STOREKIT_UNAVAILABLE_MESSAGE = 'Оваа верзија на апликацијата нема поддршка за претплата преку App Store. Ажурирај ја апликацијата од најновата верзија.';
const IOS_SUBSCRIPTION_PRODUCT_IDS: Record<SubscriptionPlanInput['id'], string> = {
  'trial-7-days': 'mojfit_monthly',
  monthly: 'mojfit_monthly',
  'half-yearly': 'mojfit_half_yearly',
  yearly: 'mojfit_yearly',
};

function isIOSPurchaseFlow(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';
}

function ensureIOSStoreKitAvailable(): void {
  if (isIOSPurchaseFlow() && !isStoreKitBridgeAvailable()) {
    throw new Error(IOS_STOREKIT_UNAVAILABLE_MESSAGE);
  }
}

// Existing profiles predate this field and were only ever granted via Android — default
// to 'android' so today's Play subscribers keep being validated/revoked exactly as before.
function subscriptionOwnerPlatform(profile: Profile | null): 'android' | 'ios' {
  return profile?.subscriptionPlatform === 'ios' ? 'ios' : 'android';
}

function addDays(baseDate: Date, days: number): Date {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(baseDate: Date, months: number): Date {
  const d = new Date(baseDate);
  d.setMonth(d.getMonth() + months);
  return d;
}

function expectedBillingPeriods(planId: SubscriptionPlanInput['id'], months: number): string[] {
  if (planId === 'yearly') return ['P1Y', 'P12M'];
  return [`P${months}M`];
}

function pickPlayProductForPlan(
  products: BillingProduct[],
  candidateProductIds: string[],
  planId: SubscriptionPlanInput['id'],
  months: number,
): BillingProduct | null {
  const candidates = products.filter(p => candidateProductIds.includes(p.productId));
  if (candidates.length === 0) return null;

  const desiredPeriods = expectedBillingPeriods(planId, months);
  const periodMatchedCandidates = candidates.filter(
    p => p.billingPeriod && desiredPeriods.includes(p.billingPeriod),
  );
  const scopedCandidates = periodMatchedCandidates.length > 0 ? periodMatchedCandidates : candidates;

  // Trial and monthly can share the same product/billing period, so we prefer an
  // offer-backed SKU for trial and a base-plan SKU for plain monthly.
  if (planId === 'trial-7-days') {
    const trialCandidate = scopedCandidates.find(p => Boolean(p.offerId));
    if (trialCandidate) return trialCandidate;
  }

  if (planId === 'monthly') {
    const monthlyCandidate = scopedCandidates.find(p => !p.offerId);
    if (monthlyCandidate) return monthlyCandidate;
  }

  return scopedCandidates[0] || null;
}

function startOfLocalDay(baseDate: Date): Date {
  const d = new Date(baseDate);
  d.setHours(0, 0, 0, 0);
  return d;
}

function normalizeEmailAddress(rawEmail?: string | null): string {
  return String(rawEmail || '').trim().toLowerCase();
}

function getTrialUsageDocId(email: string): string {
  return encodeURIComponent(normalizeEmailAddress(email));
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

function dayKey(dateIso: string): string {
  const d = new Date(dateIso);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
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

function mealLogStreak(meals: Meal[]): number {
  const dates = new Set(meals.map(m => dayKey(m.date)));
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = dayKey(cursor.toISOString());
    if (dates.has(key)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

function mealLogStreakWithRestores(meals: Meal[], restoredDayKeys: string[]): number {
  const dates = new Set(meals.map(m => dayKey(m.date)));
  restoredDayKeys.forEach(k => dates.add(k));
  let streak = 0;
  const cursor = new Date();
  while (true) {
    const key = dayKey(cursor.toISOString());
    if (dates.has(key)) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
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

function AppContent() {
  const [view, setView] = useState<ViewType>('auth');
  const [authMode, setAuthMode] = useState<AuthModeType>('login');
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [meals, setMeals] = useState<Meal[]>([]);
  const [weightHistory, setWeightHistory] = useState<WeightLog[]>([]);
  const [isEditingProfile, setIsEditingProfile] = useState(false);
  const profileSnapshot = useRef<{firstName: string; lastName: string; onboardingData: OnboardingData} | null>(null);
  const savingRef = useRef(false);
  const accountDeletionInFlightRef = useRef(false);
  const [showMonthCalendar, setShowMonthCalendar] = useState(false);
  const [needsPasswordSetup, setNeedsPasswordSetup] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAppReady, setIsAppReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [selectedDate, setSelectedDate] = useState(() => localDateStr(new Date()));
  const [calendarViewDate, setCalendarViewDate] = useState(new Date());
  const [todayWeight, setTodayWeight] = useState('');

  // Form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingData, setOnboardingData] = useState<OnboardingData>({
    weight: 70, height: 175, age: 25,
    gender: 'male', activityLevel: 'moderate',
    goal: 'maintenance', trainingType: 'mixed',
    trainingFrequency: '3_times', dailyActivity: 'sedentary',
    profileImage: '',
  });

  // Selected meal type for search
  const [selectedMealType, setSelectedMealType] = useState('breakfast');
  const [allMealsForAchievements, setAllMealsForAchievements] = useState<Meal[]>([]);
  const [allPhotosForAchievements, setAllPhotosForAchievements] = useState<ProgressPhoto[]>([]);
  const [streakRestoreDaysForAchievements, setStreakRestoreDaysForAchievements] = useState<string[]>([]);
  const [challengeSwapsForAchievements, setChallengeSwapsForAchievements] = useState<ChallengeSwapRecord[]>([]);
  const [seenAchievementIds, setSeenAchievementIds] = useState<string[]>([]);
  const [seenAchievementsReady, setSeenAchievementsReady] = useState(false);
  const [achievementQueue, setAchievementQueue] = useState<AchievementToast[]>([]);
  const [activeAchievement, setActiveAchievement] = useState<AchievementToast | null>(null);
  const [focusedAchievementId, setFocusedAchievementId] = useState<string | null>(null);
  const [purchasedThemeIds, setPurchasedThemeIds] = useState<ThemeId[]>([]);
  const subscriptionSyncInFlightRef = useRef(false);
  const [playEntitled, setPlayEntitled] = useState(false);
  const [iosEntitled, setIosEntitled] = useState(false);
  const [isTrialEligible, setIsTrialEligible] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [showOfflinePremiumPopup, setShowOfflinePremiumPopup] = useState(false);
  const offlinePremiumPopupShownRef = useRef(false);

  useEffect(() => {
    const trialEmail = normalizeEmailAddress(user?.email || email);
    if (!trialEmail) {
      setIsTrialEligible(false);
      return;
    }

    const hasSubscriptionHistory = Boolean(
      profile?.subscriptionTrialStartedAt
      || profile?.subscriptionPlanId
      || profile?.subscriptionStartedAt
      || profile?.subscriptionLastChargeAt
      || (profile?.subscriptionStatus && profile.subscriptionStatus !== 'none'),
    );

    if (hasSubscriptionHistory) {
      setIsTrialEligible(false);
      return;
    }

    if (profile?.subscriptionTrialStartedAt) {
      setIsTrialEligible(false);
      return;
    }

    let cancelled = false;

    const checkTrialEligibility = async () => {
      try {
        const trialUsageSnap = await getDoc(doc(db, 'trial_usage', getTrialUsageDocId(trialEmail)));
        if (trialUsageSnap.exists()) {
          if (!cancelled) {
            setIsTrialEligible(false);
          }
          return;
        }

        const trialUsageByEmailSnap = await getDocs(
          query(collection(db, 'trial_usage'), where('email', '==', trialEmail)),
        );
        if (!cancelled) {
          setIsTrialEligible(trialUsageByEmailSnap.empty);
        }
      } catch (error) {
        if (!cancelled) {
          setIsTrialEligible(false);
        }
        handleFirestoreError(error, OperationType.GET, `trial_usage/${getTrialUsageDocId(trialEmail)}`);
      }
    };

    checkTrialEligibility();

    return () => {
      cancelled = true;
    };
  }, [
    user?.uid,
    user?.email,
    email,
    profile?.subscriptionTrialStartedAt,
    profile?.subscriptionPlanId,
    profile?.subscriptionStartedAt,
    profile?.subscriptionLastChargeAt,
    profile?.subscriptionStatus,
  ]);

  useEffect(() => {
    if (!user) {
      setPurchasedThemeIds([]);
      return;
    }

    const unsubThemePurchases = onSnapshot(
      query(collection(db, 'theme_purchases'), where('userId', '==', user.uid)),
      snap => {
        const ids = snap.docs
          .map(d => String(d.data().themeId || ''))
          .filter(isThemeId);
        setPurchasedThemeIds(Array.from(new Set(ids)));
      },
      err => handleFirestoreError(err, OperationType.LIST, 'theme_purchases'),
    );

    return () => unsubThemePurchases();
  }, [user]);

  const hasUnlockedActiveTheme = useMemo(() => {
    const rawTheme = profile?.activeTheme;
    return profile?.isPremium === true && isThemeId(rawTheme) && purchasedThemeIds.includes(rawTheme);
  }, [profile?.activeTheme, profile?.isPremium, purchasedThemeIds]);

  useEffect(() => {
    if (hasUnlockedActiveTheme && isThemeId(profile?.activeTheme)) {
      document.documentElement.setAttribute('data-ui-theme', profile.activeTheme);
      return;
    }
    document.documentElement.removeAttribute('data-ui-theme');
  }, [hasUnlockedActiveTheme, profile?.activeTheme]);

  useEffect(() => {
    if (!user || !profile || subscriptionSyncInFlightRef.current) return;
    if (!profile.isPremium || profile.subscriptionStatus !== 'trialing') return;

    const chargeCandidates = [
      profile.subscriptionTrialEndsAt,
      profile.subscriptionNextChargeAt,
    ]
      .map(value => new Date(String(value || '')).getTime())
      .filter(value => !Number.isNaN(value));

    if (chargeCandidates.length === 0) return;
    const nextChargeTime = Math.min(...chargeCandidates);
    if (Date.now() < nextChargeTime) return;

    const promoteTrialToMonthly = async () => {
      if (isAndroidPlayBillingFlow() && subscriptionOwnerPlatform(profile) === 'android') {
        try {
          ensureAndroidPlayBillingAvailable();
          const candidateProductIds = ANDROID_SUBSCRIPTION_PRODUCT_IDS['trial-7-days'];
          const { purchases } = await PlayBilling.getActiveSubscriptions();
          const trialPurchase = purchases.find(p => candidateProductIds.includes(p.productId));
          if (!trialPurchase || !trialPurchase.autoRenewing) {
            return;
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `profiles/${user.uid}/trial-play-validation`);
          return;
        }
      } else if (isIOSPurchaseFlow() && subscriptionOwnerPlatform(profile) === 'ios') {
        try {
          ensureIOSStoreKitAvailable();
          const trialProductId = IOS_SUBSCRIPTION_PRODUCT_IDS['trial-7-days'];
          const { purchases } = await StoreKitBilling.getActiveSubscriptions();
          const trialPurchase = purchases.find(p => p.productId === trialProductId);
          if (!trialPurchase || !trialPurchase.autoRenewing) {
            return;
          }
        } catch (error) {
          handleFirestoreError(error, OperationType.GET, `profiles/${user.uid}/trial-storekit-validation`);
          return;
        }
      }

      const now = new Date();
      const monthlyExpiresAt = addMonths(now, 1).toISOString();
      subscriptionSyncInFlightRef.current = true;

      updateDoc(doc(db, 'profiles', user.uid), {
        isPremium: true,
        subscriptionStatus: 'active',
        subscriptionPlanId: 'monthly',
        subscriptionPlanTitle: '1 месец',
        subscriptionDurationMonths: 1,
        subscriptionPriceMKD: MONTHLY_PRICE_MKD,
        subscriptionCurrency: 'MKD',
        // Preserve the original trial start so trial-period data stays inside the premium window.
        // Only set subscriptionStartedAt if it wasn't already recorded during the trial purchase.
        ...(profile.subscriptionStartedAt ? {} : { subscriptionStartedAt: now.toISOString() }),
        subscriptionExpiresAt: monthlyExpiresAt,
        subscriptionLastChargeAt: now.toISOString(),
        subscriptionNextPlanId: 'monthly',
        subscriptionNextPlanTitle: '1 месец',
        subscriptionNextPriceMKD: MONTHLY_PRICE_MKD,
        subscriptionNextChargeAt: monthlyExpiresAt,
      })
        .catch(error => handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}`))
        .finally(() => {
          subscriptionSyncInFlightRef.current = false;
        });
    };

    promoteTrialToMonthly();
  }, [profile, user]);

  useEffect(() => {
    if (!user || !profile || subscriptionSyncInFlightRef.current) return;
    if (!profile.isPremium) return;
    if (profile.subscriptionStartedAt) return;

    subscriptionSyncInFlightRef.current = true;
    const nowIso = new Date().toISOString();

    updateDoc(doc(db, 'profiles', user.uid), {
      subscriptionStartedAt: nowIso,
      ...(profile.subscriptionStatus === 'trialing' && !profile.subscriptionTrialStartedAt
        ? { subscriptionTrialStartedAt: nowIso }
        : {}),
    })
      .catch(error => handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}/subscriptionStartedAt`))
      .finally(() => {
        subscriptionSyncInFlightRef.current = false;
      });
  }, [profile, user]);

  useEffect(() => {
    if (!isAndroidPlayBillingFlow()) return;
    if (!isPlayBillingBridgeAvailable()) {
      console.warn(PLAY_BILLING_UNAVAILABLE_MESSAGE);
      return;
    }
    if (!user) return;

    let cancelled = false;
    let inFlight = false;

    const syncPlayEntitlement = async () => {
      if (inFlight || subscriptionSyncInFlightRef.current) return;
      inFlight = true;
      subscriptionSyncInFlightRef.current = true;

      try {
        const candidateProductIds = Array.from(
          new Set(
            Object.values(ANDROID_SUBSCRIPTION_PRODUCT_IDS).flat(),
          ),
        );
        const { purchases } = await PlayBilling.getActiveSubscriptions();
        const activePlaySubscription = purchases.find(p => candidateProductIds.includes(p.productId));
        const hasSubscriptionHistory = !!(
          profile?.subscriptionPlanId
          || profile?.subscriptionStatus === 'active'
          || profile?.subscriptionStatus === 'trialing'
          || profile?.subscriptionStartedAt
          || profile?.subscriptionTrialStartedAt
        );

        if (activePlaySubscription) {
          // After account/profile deletion, do not auto-restore premium on a fresh profile.
          if (!hasSubscriptionHistory) {
            setPlayEntitled(false);
            return;
          }

          // Subscription is active in Google Play
          setPlayEntitled(true);

          // If auto-renewing is false and we've passed expiration, revoke on expiration
          if (!activePlaySubscription.autoRenewing && profile?.subscriptionExpiresAt) {
            const expiresTime = new Date(profile.subscriptionExpiresAt).getTime();
            if (Date.now() >= expiresTime) {
              // Expired and not auto-renewing — revoke
              await updateDoc(doc(db, 'profiles', user.uid), {
                isPremium: false,
                subscriptionStatus: 'expired',
              });
              return;
            }
          }

          // If auto-renewing is true and expiration date is in the past, it auto-renewed
          if (activePlaySubscription.autoRenewing && profile?.subscriptionExpiresAt) {
            const expiresTime = new Date(profile.subscriptionExpiresAt).getTime();
            if (Date.now() >= expiresTime) {
              // Auto-renewed — update expiration to next period (add plan duration)
              const planDuration = profile?.subscriptionDurationMonths || 1;
              const newExpiresAt = addMonths(new Date(), planDuration).toISOString();
              await updateDoc(doc(db, 'profiles', user.uid), {
                isPremium: true,
                subscriptionStatus: 'active',
                subscriptionExpiresAt: newExpiresAt,
                subscriptionNextChargeAt: newExpiresAt,
                subscriptionLastChargeAt: new Date().toISOString(),
                subscriptionPlatform: 'android',
              });
              return;
            }
          }

          // Normal active case — ensure premium is set
          if (!profile?.isPremium) {
            const nowIso = new Date().toISOString();
            await updateDoc(doc(db, 'profiles', user.uid), {
              isPremium: true,
              subscriptionStatus: 'active',
              subscriptionStartedAt: nowIso,
              subscriptionPlatform: 'android',
            });
          }
        } else {
          // No active subscription in Google Play. Only revoke if this profile's subscription
          // was actually granted via Android — otherwise it may be a valid subscription the
          // same account purchased on iOS, which Android has no authority to cancel.
          setPlayEntitled(false);
          if (profile?.isPremium && subscriptionOwnerPlatform(profile) === 'android') {
            await updateDoc(doc(db, 'profiles', user.uid), {
              isPremium: false,
              subscriptionStatus: 'expired',
            });
          }
        }
      } catch (error) {
        // Log silently — billing may be temporarily unavailable; interval will retry
        console.warn('Play entitlement sync error:', error);
      } finally {
        inFlight = false;
        subscriptionSyncInFlightRef.current = false;
      }
    };

    syncPlayEntitlement();
    // Check every 5 seconds to catch subscription expiration immediately
    const interval = window.setInterval(syncPlayEntitlement, 5000);

    // Re-sync when the app comes back to the foreground (e.g. returning from Google Play payment UI)
    const foregroundListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) syncPlayEntitlement();
    });

    // Re-sync when the plugin fires a purchaseRestored event (app was killed during payment)
    const purchaseRestoredListener = PlayBilling.addListener('purchaseRestored', () => {
      syncPlayEntitlement();
    });

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      foregroundListener.then(h => h.remove());
      purchaseRestoredListener.then(h => h.remove());
      if (cancelled) {
        inFlight = false;
      }
    };
  }, [user?.uid, profile?.isPremium, profile?.subscriptionStatus]);

  // Mirrors the Android Play Billing entitlement-sync effect above, adapted for StoreKit 2.
  useEffect(() => {
    if (!isIOSPurchaseFlow()) return;
    if (!isStoreKitBridgeAvailable()) return;
    if (!user) return;

    let cancelled = false;
    let inFlight = false;

    const syncIOSEntitlement = async () => {
      if (inFlight || subscriptionSyncInFlightRef.current) return;
      inFlight = true;
      subscriptionSyncInFlightRef.current = true;

      try {
        const candidateProductIds = Array.from(new Set(Object.values(IOS_SUBSCRIPTION_PRODUCT_IDS)));
        const { purchases } = await StoreKitBilling.getActiveSubscriptions();
        const activeIOSSubscription = purchases.find(p => candidateProductIds.includes(p.productId));
        const hasSubscriptionHistory = !!(
          profile?.subscriptionPlanId
          || profile?.subscriptionStatus === 'active'
          || profile?.subscriptionStatus === 'trialing'
          || profile?.subscriptionStartedAt
          || profile?.subscriptionTrialStartedAt
        );

        if (activeIOSSubscription) {
          // After account/profile deletion, do not auto-restore premium on a fresh profile.
          if (!hasSubscriptionHistory) {
            setIosEntitled(false);
            return;
          }

          // Subscription is active in the App Store
          setIosEntitled(true);

          // If auto-renewing is false and we've passed expiration, revoke on expiration
          if (!activeIOSSubscription.autoRenewing && profile?.subscriptionExpiresAt) {
            const expiresTime = new Date(profile.subscriptionExpiresAt).getTime();
            if (Date.now() >= expiresTime) {
              await updateDoc(doc(db, 'profiles', user.uid), {
                isPremium: false,
                subscriptionStatus: 'expired',
              });
              return;
            }
          }

          // If auto-renewing is true and expiration date is in the past, it auto-renewed
          if (activeIOSSubscription.autoRenewing && profile?.subscriptionExpiresAt) {
            const expiresTime = new Date(profile.subscriptionExpiresAt).getTime();
            if (Date.now() >= expiresTime) {
              const planDuration = profile?.subscriptionDurationMonths || 1;
              const newExpiresAt = addMonths(new Date(), planDuration).toISOString();
              await updateDoc(doc(db, 'profiles', user.uid), {
                isPremium: true,
                subscriptionStatus: 'active',
                subscriptionExpiresAt: newExpiresAt,
                subscriptionNextChargeAt: newExpiresAt,
                subscriptionLastChargeAt: new Date().toISOString(),
                subscriptionPlatform: 'ios',
              });
              return;
            }
          }

          // Normal active case — ensure premium is set
          if (!profile?.isPremium) {
            const nowIso = new Date().toISOString();
            await updateDoc(doc(db, 'profiles', user.uid), {
              isPremium: true,
              subscriptionStatus: 'active',
              subscriptionStartedAt: nowIso,
              subscriptionPlatform: 'ios',
            });
          }
        } else {
          // No active App Store subscription. Only revoke if this profile's subscription was
          // actually granted via iOS — otherwise it may be a valid subscription the same
          // account purchased on Android, which iOS has no authority to cancel.
          setIosEntitled(false);
          if (profile?.isPremium && subscriptionOwnerPlatform(profile) === 'ios') {
            await updateDoc(doc(db, 'profiles', user.uid), {
              isPremium: false,
              subscriptionStatus: 'expired',
            });
          }
        }
      } catch (error) {
        // Log silently — StoreKit may be temporarily unavailable; interval will retry
        console.warn('StoreKit entitlement sync error:', error);
      } finally {
        inFlight = false;
        subscriptionSyncInFlightRef.current = false;
      }
    };

    syncIOSEntitlement();
    // Check every 5 seconds to catch subscription expiration immediately
    const interval = window.setInterval(syncIOSEntitlement, 5000);

    // Re-sync when the app comes back to the foreground (e.g. returning from an App Store sheet)
    const foregroundListener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) syncIOSEntitlement();
    });

    // Re-sync when the plugin fires a purchaseRestored event (renewal, restore, or a purchase
    // that completed after the app was killed mid-flow)
    const purchaseRestoredListener = StoreKitBilling.addListener('purchaseRestored', () => {
      syncIOSEntitlement();
    });

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      foregroundListener.then(h => h.remove());
      purchaseRestoredListener.then(h => h.remove());
      if (cancelled) {
        inFlight = false;
      }
    };
  }, [user?.uid, profile?.isPremium, profile?.subscriptionStatus]);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    if (!isAppReady || !(profile?.isPremium || playEntitled || iosEntitled) || isOnline) return;
    if (offlinePremiumPopupShownRef.current) return;

    offlinePremiumPopupShownRef.current = true;
    setShowOfflinePremiumPopup(true);
  }, [isAppReady, profile?.isPremium, playEntitled, iosEntitled, isOnline]);

  const planDayTargets = useMemo(() => {
    if (!profile?.isPremium || !profile.mealPlanType || !profile.mealPlanSeed) return null;
    const week = generateWeekPlan(
      profile.targetCalories,
      profile.mealPlanSeed,
      profile.mealPlanType,
      profile.targetProtein,
    );
    const dayPlan = week[mondayBasedDayIndex(selectedDate)];
    return {
      calories: dayPlan.reduce((s, m) => s + m.kcal, 0),
      protein: dayPlan.reduce((s, m) => s + m.protein, 0),
      carbs: dayPlan.reduce((s, m) => s + m.carbs, 0),
      fat: dayPlan.reduce((s, m) => s + m.fat, 0),
    };
  }, [profile, selectedDate]);

  const { dayCalorieProgressByDate, streakFlameDates } = useMemo(() => {
    if (!profile) {
      return {
        dayCalorieProgressByDate: {} as Record<string, number>,
        streakFlameDates: new Set<string>(),
      };
    }

    const caloriesByDay = new Map<string, number>();
    allMealsForAchievements.forEach(meal => {
      const key = dayKey(meal.date);
      let mealCalories = 0;
      meal.items?.forEach(item => {
        mealCalories += (item.food?.calories || 0) * (item.amount || 0);
      });
      caloriesByDay.set(key, (caloriesByDay.get(key) || 0) + mealCalories);
    });

    const dayProgressResult: Record<string, number> = {};
    const reachedGoalByDay: Record<string, boolean> = {};
    const weeklyPlan = (profile.isPremium && profile.mealPlanType && profile.mealPlanSeed)
      ? generateWeekPlan(
        profile.targetCalories,
        profile.mealPlanSeed,
        profile.mealPlanType,
        profile.targetProtein,
      )
      : null;

    caloriesByDay.forEach((calories, key) => {
      let target = profile.targetCalories || 0;

      if (weeklyPlan) {
        const dayPlan = weeklyPlan[mondayBasedDayIndex(key)];
        target = dayPlan.reduce((sum, meal) => sum + meal.kcal, 0);
      }

      reachedGoalByDay[key] = target > 0 && calories >= target;
      if (target > 0) {
        dayProgressResult[key] = Math.max(0, Math.min(100, (calories / target) * 100));
      }
    });

    if (!profile.isPremium) {
      return {
        dayCalorieProgressByDate: dayProgressResult,
        streakFlameDates: new Set<string>(),
      };
    }

    const isNextDay = (prevKey: string, nextKey: string): boolean => {
      const [y, m, d] = prevKey.split('-').map(Number);
      const next = new Date(y, (m || 1) - 1, d || 1);
      next.setDate(next.getDate() + 1);
      return localDateStr(next) === nextKey;
    };

    const sortedDayKeys = Object.keys(reachedGoalByDay).sort();
    const streakDates = new Set<string>();
    let currentRun: string[] = [];

    const flushRun = () => {
      if (currentRun.length >= 2) currentRun.forEach(day => streakDates.add(day));
      currentRun = [];
    };

    sortedDayKeys.forEach(day => {
      if (!reachedGoalByDay[day]) {
        flushRun();
        return;
      }

      if (currentRun.length === 0) {
        currentRun = [day];
        return;
      }

      const prev = currentRun[currentRun.length - 1];
      if (isNextDay(prev, day)) {
        currentRun.push(day);
      } else {
        flushRun();
        currentRun = [day];
      }
    });
    flushRun();

    return {
      dayCalorieProgressByDate: dayProgressResult,
      streakFlameDates: streakDates,
    };
  }, [allMealsForAchievements, profile]);

  // --- Auth listener ---
  useEffect(() => {
    let unsubUser: () => void = () => {};
    let unsubProfile: () => void = () => {};
    let unsubWeight: () => void = () => {};

    const unsubscribe = onAuthStateChanged(auth, firebaseUser => {
      unsubUser(); unsubProfile(); unsubWeight();

      if (firebaseUser?.uid) {
        setUser(firebaseUser);
        const uid = firebaseUser.uid;

        unsubUser = onSnapshot(doc(db, 'users', uid), snap => {
          if (snap.exists()) {
            const d = snap.data();
            setFirstName(d.firstName || '');
            setLastName(d.lastName || '');
            setEmail(d.email || firebaseUser.email || '');
            // Restore needsPasswordSetup after a page refresh (e.g. COOP during Google popup)
            if (d.isGoogleUser && d.hasSetPassword === false) {
              setNeedsPasswordSetup(true);
            }
          }
        }, error => { if (auth.currentUser) handleFirestoreError(error, OperationType.GET, `users/${uid}`); });

        unsubProfile = onSnapshot(doc(db, 'profiles', uid), snap => {
          if (snap.exists()) {
            const pData = snap.data() as Profile;
            if (pData.isPremium === undefined) {
              pData.isPremium = false;
            }
            setProfile(pData);
            setOnboardingData(prev => ({
              ...prev,
              weight: pData.weight ?? prev.weight,
              height: pData.height ?? prev.height,
              age: pData.age ?? prev.age,
              gender: pData.gender ?? prev.gender,
              activityLevel: pData.activityLevel ?? prev.activityLevel,
              goal: pData.goal ?? prev.goal,
              trainingType: pData.trainingType ?? prev.trainingType,
              trainingFrequency: pData.trainingFrequency || '3_times',
              dailyActivity: pData.dailyActivity || 'sedentary',
              profileImage: pData.profileImage || '',
            }));
            if (!accountDeletionInFlightRef.current) {
              if (pData.isSetupDone) {
                if (!savingRef.current) setView(prev => {
                  if (prev === 'google-password') return 'google-password';
                  if (prev === 'auth' || prev === 'onboarding') return 'dashboard';
                  return prev;
                });
              } else {
                if (!savingRef.current) setView(prev => prev === 'google-password' ? 'google-password' : 'onboarding');
              }
            }
          } else {
            // No profile yet — new or interrupted registration
            // For Google users, ensure password setup step is shown in onboarding
            const isGoogleProvider = firebaseUser.providerData?.some((p: any) => p.providerId === 'google.com');
            if (isGoogleProvider) setNeedsPasswordSetup(true);
            if (!savingRef.current && !accountDeletionInFlightRef.current) setView(prev => prev === 'google-password' ? 'google-password' : 'onboarding');
          }
          if (!savingRef.current && !accountDeletionInFlightRef.current) setLoading(false);
          setIsAppReady(true);
        }, error => { if (auth.currentUser) handleFirestoreError(error, OperationType.GET, `profiles/${uid}`); });

        unsubWeight = onSnapshot(
          query(collection(db, 'weight_logs'), where('userId', '==', uid), orderBy('date', 'asc')),
          snap => setWeightHistory(snap.docs.map(d => d.data() as WeightLog)),
          error => { if (auth.currentUser) handleFirestoreError(error, OperationType.LIST, 'weight_logs'); },
        );
      } else {
        setUser(null); setProfile(null);
        setPlayEntitled(false);
        setView(prev => prev === 'onboarding' ? 'onboarding' : 'auth');
        setLoading(false); setIsAppReady(true);
      }
    });

    return () => { unsubscribe(); unsubUser(); unsubProfile(); unsubWeight(); };
  }, []);

  // --- Meals listener (changes with selected date) ---
  useEffect(() => {
    if (!user) return;
    const startOfDay = new Date(selectedDate); startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(selectedDate); endOfDay.setHours(23, 59, 59, 999);

    const unsub = onSnapshot(
      query(
        collection(db, 'meals'),
        where('userId', '==', user.uid),
        where('date', '>=', startOfDay.toISOString()),
        where('date', '<=', endOfDay.toISOString()),
      ),
      snap => setMeals(snap.docs.map(d => ({ id: d.id, ...d.data() } as Meal))),
      error => handleFirestoreError(error, OperationType.LIST, 'meals'),
    );
    return () => unsub();
  }, [user, selectedDate]);

  // --- Full activity listeners for global achievements ---
  useEffect(() => {
    if (!user) {
      setAllMealsForAchievements([]);
      setAllPhotosForAchievements([]);
      setStreakRestoreDaysForAchievements([]);
      setChallengeSwapsForAchievements([]);
      return;
    }

    const unsubMeals = onSnapshot(
      query(collection(db, 'meals'), where('userId', '==', user.uid)),
      snap => setAllMealsForAchievements(snap.docs.map(d => ({ id: d.id, ...d.data() } as Meal))),
      error => handleFirestoreError(error, OperationType.LIST, 'meals'),
    );

    const unsubPhotos = onSnapshot(
      query(collection(db, 'progress_photos'), where('userId', '==', user.uid)),
      snap => setAllPhotosForAchievements(snap.docs.map(d => ({ id: d.id, ...d.data() } as ProgressPhoto))),
      error => handleFirestoreError(error, OperationType.LIST, 'progress_photos'),
    );

    const unsubRestores = onSnapshot(
      query(collection(db, 'streak_restores'), where('userId', '==', user.uid)),
      snap => setStreakRestoreDaysForAchievements(
        snap.docs
          .map(d => String(d.data().dayKey || ''))
          .filter(Boolean),
      ),
      error => handleFirestoreError(error, OperationType.LIST, 'streak_restores'),
    );

    const unsubChallengeSwaps = onSnapshot(
      query(collection(db, 'challenge_swaps'), where('userId', '==', user.uid)),
      snap => setChallengeSwapsForAchievements(
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
      error => handleFirestoreError(error, OperationType.LIST, 'challenge_swaps'),
    );

    return () => {
      unsubMeals();
      unsubPhotos();
      unsubRestores();
      unsubChallengeSwaps();
    };
  }, [user]);

  useEffect(() => {
    if (!user) {
      setSeenAchievementIds([]);
      setSeenAchievementsReady(false);
      setAchievementQueue([]);
      setActiveAchievement(null);
      return;
    }

    if (!profile?.isPremium) {
      setSeenAchievementsReady(false);
      setAchievementQueue([]);
      setActiveAchievement(null);
      return;
    }

    // Read seen achievement IDs from Firestore profile (not localStorage)
    const savedIds = profile.seenAchievementIds || [];
    if (Array.isArray(savedIds)) {
      setSeenAchievementIds(savedIds.filter((v): v is string => typeof v === 'string'));
    } else {
      setSeenAchievementIds([]);
    }
    setSeenAchievementsReady(true);
  }, [user, profile?.isPremium, profile?.seenAchievementIds]);

  const completedAchievements = useMemo(() => {
    if (!profile || !profile.isPremium) return [] as AchievementToast[];

    const today = new Date();
    const todayStr = dayKey(today.toISOString());
    const weekStart = startOfWeek(today);
    const monthStart = startOfMonth(today);
    const yearStart = startOfYear(today);
    const weekKey = dayKey(weekStart.toISOString());
    const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const yearKey = String(today.getFullYear());

    const premiumWindowStartMs = getPremiumWindowStartMs(profile);
    const hasPremiumWindowStart = Number.isFinite(premiumWindowStartMs);

    const premiumMeals = hasPremiumWindowStart
      ? allMealsForAchievements.filter(m => new Date(m.date).getTime() >= premiumWindowStartMs)
      : [];
    const premiumPhotos = hasPremiumWindowStart
      ? allPhotosForAchievements.filter(p => new Date(p.date).getTime() >= premiumWindowStartMs)
      : [];
    const premiumWeightLogs = hasPremiumWindowStart
      ? weightHistory.filter(w => new Date(w.date).getTime() >= premiumWindowStartMs)
      : [];
    const premiumRestoreDays = hasPremiumWindowStart
      ? streakRestoreDaysForAchievements.filter(day => {
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
    let effectiveTargetCalories = profile.targetCalories ?? 0;
    let effectiveTargetProtein = profile.targetProtein ?? 0;

    if (profile.isPremium && profile.mealPlanType && profile.mealPlanSeed) {
      const week = generateWeekPlan(
        profile.targetCalories,
        profile.mealPlanSeed,
        profile.mealPlanType,
        profile.targetProtein,
      );
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

    const dailyPool = buildChallengePool('daily', metrics);
    const weeklyPool = buildChallengePool('weekly', metrics);
    const monthlyPool = buildChallengePool('monthly', metrics);
    const yearlyPool = buildChallengePool('yearly', metrics);

    const dailyChallenges = applyChallengeSwaps(
      pickChallengeSet(dailyPool, `daily:${todayStr}`, getChallengeDisplayCount('daily')),
      pickChallengeSet(dailyPool, `daily:${todayStr}`, dailyPool.length),
      challengeSwapsForAchievements,
      'daily',
      todayStr,
    );
    const weeklyChallenges = applyChallengeSwaps(
      pickChallengeSet(weeklyPool, `weekly:${weekKey}`, getChallengeDisplayCount('weekly')),
      pickChallengeSet(weeklyPool, `weekly:${weekKey}`, weeklyPool.length),
      challengeSwapsForAchievements,
      'weekly',
      weekKey,
    );
    const monthlyChallenges = applyChallengeSwaps(
      pickChallengeSet(monthlyPool, `monthly:${monthKey}`, getChallengeDisplayCount('monthly')),
      pickChallengeSet(monthlyPool, `monthly:${monthKey}`, monthlyPool.length),
      challengeSwapsForAchievements,
      'monthly',
      monthKey,
    );
    const yearlyChallenges = applyChallengeSwaps(
      pickChallengeSet(yearlyPool, `yearly:${yearKey}`, getChallengeDisplayCount('yearly')),
      pickChallengeSet(yearlyPool, `yearly:${yearKey}`, yearlyPool.length),
      challengeSwapsForAchievements,
      'yearly',
      yearKey,
    );

    const streak = mealLogStreakWithRestores(premiumMeals, premiumRestoreDays);
    const daysProteinHit = countProteinTargetDays(premiumMeals, proteinGoal);
    const totalPlannedMeals = countPlannedMeals(premiumMeals);

    const badges = buildBadges({
      allMealsCount: premiumMeals.length,
      photosCount: premiumPhotos.length,
      weightCount: premiumWeightLogs.length,
      unlockedThemesCount: purchasedThemeIds.length,
      streak,
      daysProteinHit,
      plannedMealsAddedWeek,
      totalPlannedMeals,
      completedMonthly: monthlyChallenges.filter(isChallengeCompleted).length,
      completedYearly: yearlyChallenges.filter(isChallengeCompleted).length,
    });

    const challengeItems: AchievementToast[] = [
      ...dailyChallenges.filter(isChallengeCompleted).map(c => ({ id: `challenge:daily:${todayStr}:${c.id}`, title: c.title, kind: 'challenge' as const })),
      ...weeklyChallenges.filter(isChallengeCompleted).map(c => ({ id: `challenge:weekly:${weekKey}:${c.id}`, title: c.title, kind: 'challenge' as const })),
      ...monthlyChallenges.filter(isChallengeCompleted).map(c => ({ id: `challenge:monthly:${monthKey}:${c.id}`, title: c.title, kind: 'challenge' as const })),
      ...yearlyChallenges.filter(isChallengeCompleted).map(c => ({ id: `challenge:yearly:${yearKey}:${c.id}`, title: c.title, kind: 'challenge' as const })),
    ];

    const badgeItems: AchievementToast[] = badges
      .filter(b => b.unlocked)
      .map(b => ({ id: `badge:${b.id}`, title: b.title, kind: 'badge' as const }));

    return [...challengeItems, ...badgeItems];
  }, [allMealsForAchievements, allPhotosForAchievements, challengeSwapsForAchievements, profile, purchasedThemeIds.length, streakRestoreDaysForAchievements, weightHistory]);

  useEffect(() => {
    if (!user || !profile?.isPremium) return;
    if (!seenAchievementsReady) return;
    if (seenAchievementIds.length === 0 && completedAchievements.length === 0) return;

    const unseen = completedAchievements.filter(a => !seenAchievementIds.includes(a.id));
    if (unseen.length === 0) return;

    const unseenIds = unseen.map(a => a.id);
    const mergedSeen = Array.from(new Set([...seenAchievementIds, ...unseenIds]));
    setSeenAchievementIds(mergedSeen);

    // Write seen achievement IDs to Firestore profile instead of localStorage
    if (user) {
      updateDoc(doc(db, 'profiles', user.uid), {
        seenAchievementIds: mergedSeen,
      }).catch(error => handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}/seenAchievementIds`));
    }

    setAchievementQueue(prev => {
      const existingIds = new Set(prev.map(p => p.id));
      if (activeAchievement) existingIds.add(activeAchievement.id);
      const add = unseen.filter(item => !existingIds.has(item.id));
      return add.length > 0 ? [...prev, ...add] : prev;
    });
  }, [activeAchievement, completedAchievements, seenAchievementIds, seenAchievementsReady, user, profile?.isPremium]);

  useEffect(() => {
    if (activeAchievement || achievementQueue.length === 0) return;
    setActiveAchievement(achievementQueue[0]);
    setAchievementQueue(prev => prev.slice(1));
  }, [activeAchievement, achievementQueue]);

  useEffect(() => {
    if (!activeAchievement) return;
    const t = window.setTimeout(() => setActiveAchievement(null), 5000);
    return () => window.clearTimeout(t);
  }, [activeAchievement]);

  useEffect(() => {
    if (view !== 'challenges' || !focusedAchievementId) return;
    const t = window.setTimeout(() => setFocusedAchievementId(null), 800);
    return () => window.clearTimeout(t);
  }, [view, focusedAchievementId]);

  // Clear search state when leaving search view
  useEffect(() => {
    if (view !== 'onboarding') return;
    const stepsCount = 9 + ((!user && authMode === 'register') || needsPasswordSetup ? 1 : 0);
    if (onboardingStep >= stepsCount) setOnboardingStep(Math.max(0, stepsCount - 1));
  }, [view, user, authMode, onboardingStep, needsPasswordSetup]);

  // Close month calendar when navigating away from dashboard
  useEffect(() => {
    if (view !== 'dashboard') setShowMonthCalendar(false);
  }, [view]);

  // Scroll to top after view change
  useEffect(() => {
    // Keep reset aligned with fade transitions so the outgoing view doesn't jump.
    const delay = 300;
    const timer = setTimeout(() => {
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    }, delay);
    return () => clearTimeout(timer);
  }, [view]);

  // Clear sensitive fields whenever the auth screen is shown
  useEffect(() => {
    if (view === 'auth') {
      setPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowConfirmPassword(false);
      setAuthError(null);
    }
  }, [view]);

  // Lock scroll when month calendar is open
  useEffect(() => {
    document.body.style.overflow = showMonthCalendar ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [showMonthCalendar]);

  // Android back button handler
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const handler = CapacitorApp.addListener('backButton', () => {
      if (showMonthCalendar) { setShowMonthCalendar(false); return; }
      if (isEditingProfile) { handleCancelEditProfile(); return; }
      if (view === 'search') { setView('dashboard'); return; }
      if (view === 'weight' || view === 'profile' || view === 'subscription' || view === 'progress-photos' || view === 'challenges' || view === 'mealplan') { setView('dashboard'); return; }
      if (view === 'onboarding' && onboardingStep > 0) { setOnboardingStep(s => s - 1); return; }
      if (view === 'onboarding' && onboardingStep === 0) {
        if (user) handleLogout(); else setView('auth');
        return;
      }
      if (view === 'dashboard') { CapacitorApp.minimizeApp(); return; }
      if (view === 'auth') { CapacitorApp.minimizeApp(); return; }
    });
    return () => { handler.then(h => h.remove()); };
  }, [view, showMonthCalendar, isEditingProfile, onboardingStep, user]);

  // --- Image upload with compression ---
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAuthError(null);

    const reader = new FileReader();
    reader.onloadend = () => {
      const img = new Image();
      img.onload = () => {
        const MAX_SIDE = 400;
        const MAX_BYTES = 250 * 1024;
        let { width, height } = img;
        if (width > MAX_SIDE || height > MAX_SIDE) {
          if (width > height) { height = Math.round((height / width) * MAX_SIDE); width = MAX_SIDE; }
          else { width = Math.round((width / height) * MAX_SIDE); height = MAX_SIDE; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
        let quality = 0.85;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length > MAX_BYTES && quality > 0.1) {
          quality -= 0.1;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        setOnboardingData(prev => ({ ...prev, profileImage: dataUrl }));
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  // --- Auth handlers ---
  const handleAuth = async () => {
    if (!email) { setAuthError('Ве молиме внесете е-пошта.'); return; }
    if (authMode === 'login') {
      if (!password) { setAuthError('Ве молиме внесете лозинка.'); return; }
      flushSync(() => { setLoading(true); setAuthError(null); });
      try {
        await signInWithEmailAndPassword(auth, email, password);
      } catch (err: any) {
        setAuthError(getFriendlyErrorMessage(err));
      } finally { setLoading(false); }
    } else {
      if (!firstName || !lastName) { setAuthError('Ве молиме внесете име и презиме.'); return; }
      setAuthError(null); setView('onboarding'); setOnboardingStep(0);
    }
  };

  const handleGoogleAuth = async () => {
    flushSync(() => { setLoading(true); setAuthError(null); });
    try {
      let firebaseUser: FirebaseUser;
      let isNewUser = false;
      if (Capacitor.isNativePlatform()) {
        await GoogleAuth.initialize({
          clientId: '145514988309-e1qs6ctiubml3b4cepuod5s3oudjqdiq.apps.googleusercontent.com',
          scopes: ['profile', 'email'],
          grantOfflineAccess: true,
        });
        try { await GoogleAuth.signOut(); } catch { /* ignore if not signed in */ }
        const googleUser = await GoogleAuth.signIn();
        if (!googleUser.authentication.idToken) throw new Error('Неуспешна најава со Google: Недостасува idToken.');
        const credential = GoogleAuthProvider.credential(googleUser.authentication.idToken);
        const result = await signInWithCredential(auth, credential);
        firebaseUser = result.user;
        isNewUser = getAdditionalUserInfo(result)?.isNewUser ?? false;
      } else {
        const result = await signInWithPopup(auth, new GoogleAuthProvider());
        firebaseUser = result.user;
        isNewUser = getAdditionalUserInfo(result)?.isNewUser ?? false;
      }

      // Also treat as new if user doc doesn't exist yet (partial registration)
      if (!isNewUser) {
        try {
          const snap = await getDoc(doc(db, 'users', firebaseUser.uid));
          if (!snap.exists()) isNewUser = true;
        } catch { /* treat as existing on error */ }
      }

      if (isNewUser) {
        const [fName, ...lNameParts] = (firebaseUser.displayName || '').split(' ');
        try {
          await setDoc(doc(db, 'users', firebaseUser.uid), {
            email: firebaseUser.email || '',
            firstName: fName || 'Корисник',
            lastName: lNameParts.join(' ') || '',
            createdAt: new Date().toISOString(),
            isGoogleUser: true,
            hasSetPassword: false,
          });
        } catch (e) { handleFirestoreError(e, OperationType.CREATE, `users/${firebaseUser.uid}`); }
        setNeedsPasswordSetup(true);
        setPassword('');
        setConfirmPassword('');
        setView('onboarding');
        setOnboardingStep(0);
        setLoading(false);
      }
      // For existing users: keep loading=true — the profile onSnapshot listener
      // will call setLoading(false) and setView('dashboard') when data arrives.
    } catch (err: any) {
      // 12501 = user cancelled the Google sign-in dialog — not a real error
      const msg = String(err?.message || err?.code || err || '');
      if (!msg.includes('12501') && !msg.toLowerCase().includes('cancel')) {
        setAuthError(getFriendlyErrorMessage(err));
      }
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    const isGoogleUser = user?.providerData?.some(p => p.providerId === 'google.com');
    if (Capacitor.isNativePlatform() && isGoogleUser) {
      try {
        await GoogleAuth.initialize({
          clientId: '145514988309-e1qs6ctiubml3b4cepuod5s3oudjqdiq.apps.googleusercontent.com',
          scopes: ['profile', 'email'],
          grantOfflineAccess: true,
        });
      } catch {
        // Ignore init errors and still try Firebase signOut below.
      }
      try { await GoogleAuth.signOut(); } catch { /* ignore */ }
    }
    await signOut(auth);
    // Reset all state so the app is clean for the next user
    setUser(null);
    setProfile(null);
    setMeals([]);
    setWeightHistory([]);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirmPassword(false);
    setFirstName('');
    setLastName('');
    setAuthMode('login');
    setAuthError(null);
    setOnboardingStep(0);
    setOnboardingData({ weight: 70, height: 175, age: 25, gender: 'male', activityLevel: 'moderate', goal: 'maintenance', trainingType: 'mixed', trainingFrequency: '3_times', dailyActivity: 'sedentary', profileImage: '' });
    setNeedsPasswordSetup(false);
    setIsEditingProfile(false);
    setSelectedDate(localDateStr(new Date()));
    setTodayWeight('');
    setShowMonthCalendar(false);
    setView('auth');
  };

  const handleDeleteAccount = async () => {
    if (!user) return;

    accountDeletionInFlightRef.current = true;
    flushSync(() => setLoading(true));

    const uid = user.uid;
    const nowIso = new Date().toISOString();
    const deletionEmail = normalizeEmailAddress(user.email || email);
    const userScopedCollections = [
      'meals',
      'weight_logs',
      'progress_photos',
      'streak_restores',
      'challenge_completions',
      'challenge_swaps',
      'theme_purchases',
      'point_spends',
    ];

    setAuthError(null);

    try {
      // Best-effort cleanup: explicitly reset premium/subscription state before hard deletion.
      try {
        await updateDoc(doc(db, 'profiles', uid), {
          isPremium: false,
          subscriptionStatus: 'expired',
          subscriptionPlanId: null,
          subscriptionPlanTitle: null,
          subscriptionDurationMonths: null,
          subscriptionPriceMKD: null,
          subscriptionCurrency: null,
          subscriptionStartedAt: null,
          subscriptionExpiresAt: null,
          subscriptionTrialStartedAt: null,
          subscriptionTrialEndsAt: null,
          subscriptionNextChargeAt: null,
          subscriptionNextPlanId: null,
          subscriptionNextPlanTitle: null,
          subscriptionNextPriceMKD: null,
          subscriptionLastChargeAt: null,
          subscriptionPaymentLast4: null,
          premiumRevokedAt: nowIso,
        });
      } catch {
        // Ignore cleanup write failures and continue with hard delete.
      }

      // Best-effort audit marker for deletion events (helps future diagnostics).
      if (deletionEmail) {
        try {
          await setDoc(doc(db, 'account_deletion_audit', encodeURIComponent(deletionEmail)), {
            email: deletionEmail,
            lastUserId: uid,
            deletedAt: nowIso,
            hadPremium: profile?.isPremium === true,
          }, { merge: true });
        } catch {
          // Ignore audit marker failures and continue with hard delete.
        }
      }

      // Delete all user data from Firestore collections
      for (const collectionName of userScopedCollections) {
        const snap = await getDocs(
          query(collection(db, collectionName), where('userId', '==', uid)),
        );
        await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
      }

      // Delete user profile and user documents
      await deleteDoc(doc(db, 'profiles', uid));
      await deleteDoc(doc(db, 'users', uid));

      // Clear client-side premium-related caches before logout.
      setPlayEntitled(false);
      try {
        localStorage.removeItem(`mojfit:seen-achievements:${uid}`);
      } catch {
        // Ignore localStorage failures.
      }

      // Delete the user account from Firebase Auth
      try {
        await deleteUser(user);
      } catch (authError: any) {
        // Profile already deleted, but show error about auth account
        setAuthError('Профилот е избришан. ' + getFriendlyErrorMessage(authError));
      }
      
      // Log out
      await handleLogout();
    } catch (error: any) {
      setAuthError(getFriendlyErrorMessage(error));
      setLoading(false);
      throw error;
    } finally {
      accountDeletionInFlightRef.current = false;
    }
  };

  // --- Onboarding / profile save ---
  const handleOnboarding = async () => {
    savingRef.current = true;
    setAuthError(null);
    flushSync(() => setLoading(true));
    try {
      let activeUser = user;
      if (!activeUser) {
        if (!password || password !== confirmPassword) {
          setAuthError('Лозинките не се совпаѓаат или се празни.');
          setLoading(false); return;
        }
        try {
          const cred = await createUserWithEmailAndPassword(auth, email, password);
          activeUser = cred.user;
          await setDoc(doc(db, 'users', activeUser.uid), { email, firstName, lastName, createdAt: new Date().toISOString() });
        } catch (err: any) {
          setAuthError(getFriendlyErrorMessage(err));
          setLoading(false); return;
        }
      } else if (needsPasswordSetup) {
        if (!password || password !== confirmPassword) {
          setAuthError('Лозинките не се совпаѓаат или се празни.');
          setLoading(false); return;
        }
        try {
          await updatePassword(activeUser, password);
          await updateDoc(doc(db, 'users', activeUser.uid), { hasSetPassword: true });
          setNeedsPasswordSetup(false);
        } catch (err: any) {
          setAuthError(getFriendlyErrorMessage(err));
          setLoading(false); return;
        }
      }

      const lastWeight = (isEditingProfile && weightHistory.length > 0
        ? weightHistory[weightHistory.length - 1].weight
        : onboardingData.weight) ?? profile?.weight ?? 0;
      const macros = calculateMacros({ ...onboardingData, weight: lastWeight });
      const profileData = {
        ...onboardingData,
        weight: lastWeight,
        userId: activeUser.uid,
        ...macros,
        isSetupDone: true,
        isPremium: profile?.isPremium ?? false,
        ...(profile?.subscriptionPlanId ? { subscriptionPlanId: profile.subscriptionPlanId } : {}),
        ...(profile?.subscriptionPlanTitle ? { subscriptionPlanTitle: profile.subscriptionPlanTitle } : {}),
        ...(typeof profile?.subscriptionDurationMonths === 'number' ? { subscriptionDurationMonths: profile.subscriptionDurationMonths } : {}),
        ...(typeof profile?.subscriptionPriceMKD === 'number' ? { subscriptionPriceMKD: profile.subscriptionPriceMKD } : {}),
        ...(profile?.subscriptionCurrency ? { subscriptionCurrency: profile.subscriptionCurrency } : {}),
        ...(profile?.subscriptionStatus ? { subscriptionStatus: profile.subscriptionStatus } : {}),
        ...(profile?.subscriptionStartedAt ? { subscriptionStartedAt: profile.subscriptionStartedAt } : {}),
        ...(profile?.subscriptionExpiresAt ? { subscriptionExpiresAt: profile.subscriptionExpiresAt } : {}),
        ...(profile?.subscriptionTrialStartedAt ? { subscriptionTrialStartedAt: profile.subscriptionTrialStartedAt } : {}),
        ...(profile?.subscriptionTrialEndsAt ? { subscriptionTrialEndsAt: profile.subscriptionTrialEndsAt } : {}),
        ...(profile?.subscriptionNextChargeAt ? { subscriptionNextChargeAt: profile.subscriptionNextChargeAt } : {}),
        ...(profile?.subscriptionNextPlanId ? { subscriptionNextPlanId: profile.subscriptionNextPlanId } : {}),
        ...(profile?.subscriptionNextPlanTitle ? { subscriptionNextPlanTitle: profile.subscriptionNextPlanTitle } : {}),
        ...(typeof profile?.subscriptionNextPriceMKD === 'number' ? { subscriptionNextPriceMKD: profile.subscriptionNextPriceMKD } : {}),
        ...(profile?.subscriptionLastChargeAt ? { subscriptionLastChargeAt: profile.subscriptionLastChargeAt } : {}),
        ...(profile?.subscriptionPaymentLast4 ? { subscriptionPaymentLast4: profile.subscriptionPaymentLast4 } : {}),
        ...(isThemeId(profile?.activeTheme) ? { activeTheme: profile.activeTheme } : {}),
        ...(profile?.mealPlanType ? { mealPlanType: profile.mealPlanType } : {}),
        ...(typeof profile?.mealPlanSeed === 'number' ? { mealPlanSeed: profile.mealPlanSeed } : {}),
      };

      try {
        await setDoc(doc(db, 'profiles', activeUser.uid), profileData);
      } catch (e) { handleFirestoreError(e, OperationType.UPDATE, `profiles/${activeUser.uid}`); }

      if (isEditingProfile) {
        try {
          await setDoc(doc(db, 'users', activeUser.uid), {
            firstName: firstName.trim(), lastName: lastName.trim(), email: activeUser.email || email,
          }, { merge: true });
        } catch (e) { handleFirestoreError(e, OperationType.UPDATE, `users/${activeUser.uid}`); }
      }

      if (!isEditingProfile) {
        try {
          await addDoc(collection(db, 'weight_logs'), {
            userId: activeUser.uid, weight: onboardingData.weight, date: new Date().toISOString(),
          });
        } catch (e) { handleFirestoreError(e, OperationType.CREATE, 'weight_logs'); }
      }

      setView(isEditingProfile ? 'profile' : 'dashboard');
    } catch (error) {
      // Error handled silently
    } finally { savingRef.current = false; setLoading(false); }
  };

  const handleStartEditProfile = (newOnboardingData: OnboardingData) => {
    profileSnapshot.current = { firstName, lastName, onboardingData: newOnboardingData };
    setOnboardingData(newOnboardingData);
    setIsEditingProfile(true);
    setView('onboarding');
  };

  const handleCancelEditProfile = () => {
    if (profileSnapshot.current) {
      setFirstName(profileSnapshot.current.firstName);
      setLastName(profileSnapshot.current.lastName);
      setOnboardingData(profileSnapshot.current.onboardingData);
      profileSnapshot.current = null;
    }
    setIsEditingProfile(false);
    setView('profile');
  };

  // --- Google password set ---
  const handleSetGooglePassword = async () => {
    if (!user) return;
    if (password !== confirmPassword) { setAuthError('Лозинките не се совпаѓаат.'); return; }
    if (password.length < 6) { setAuthError('Лозинката мора да има најмалку 6 карактери.'); return; }
    flushSync(() => setLoading(true));
    try {
      await updatePassword(user, password);
      await updateDoc(doc(db, 'users', user.uid), { hasSetPassword: true });
      setView('onboarding');
      setOnboardingStep(prev => prev + 1);
    } catch (error: any) {
      setAuthError(getFriendlyErrorMessage(error));
    } finally { setLoading(false); }
  };

  // --- Meal / weight actions ---
  const deleteMeal = async (mealId: string) => {
    try {
      await deleteDoc(doc(db, 'meals', mealId));
    } catch (error) { handleFirestoreError(error, OperationType.DELETE, `meals/${mealId}`); }
  };

  const logWeight = async (weight: number) => {
    if (!user || !profile) return;
    if (!weight || weight <= 0) { setAuthError('Ве молиме внесете валидна тежина.'); return; }
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const snap = await getDocs(query(
        collection(db, 'weight_logs'),
        where('userId', '==', user.uid),
        where('date', '>=', today.toISOString()),
        where('date', '<', tomorrow.toISOString()),
      ));
      if (!snap.empty) return;

      await addDoc(collection(db, 'weight_logs'), { userId: user.uid, weight, date: new Date().toISOString() });

      const updatedData = { ...onboardingData, weight, height: profile.height, age: profile.age, gender: profile.gender, trainingFrequency: profile.trainingFrequency, goal: profile.goal };
      const macros = calculateMacros(updatedData);
      const updatedProfile = { ...profile, weight, ...macros };
      await setDoc(doc(db, 'profiles', user.uid), updatedProfile);
      setProfile(updatedProfile);
      setOnboardingData(updatedData);
      setTodayWeight('');
      setAuthError(null);
    } catch (error) { handleFirestoreError(error, OperationType.CREATE, 'weight_logs'); }
  };

  const saveMealPlanPreference = async (planType: MealPlanType, seed: number) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'profiles', user.uid), {
        mealPlanType: planType,
        mealPlanSeed: seed,
      });
      setProfile(prev => prev ? { ...prev, mealPlanType: planType, mealPlanSeed: seed } : prev);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `profiles/${user.uid}`);
    }
  };

  const addPlannedMealToDailyProgress = async (
    meal: PlanMeal,
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack',
  ) => {
    if (!user) return;
    if (!isSameLocalDay(selectedDate, new Date())) return;
    try {
      await addDoc(collection(db, 'meals'), {
        userId: user.uid,
        type: mealType,
        date: new Date().toISOString(),
        items: [{
          food: {
            id: `plan-${Date.now()}`,
            name: meal.name,
            name_lowercase: meal.name.toLowerCase(),
            calories: meal.kcal,
            protein: meal.protein,
            carbs: meal.carbs,
            fat: meal.fat,
          },
          amount: 1,
        }],
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'meals');
    }
  };

  const activateSubscription = async (plan: SubscriptionPlanInput) => {
    try {
      if (!user || !profile) throw new Error('profile-not-ready');

      const now = new Date();

      if (plan.id === 'trial-7-days') {
        const trialEmail = normalizeEmailAddress(user.email || email);
        if (!trialEmail) {
          throw new Error('Не можеме да активираме пробен период без валидна е-пошта.');
        }

        const trialUsageRef = doc(db, 'trial_usage', getTrialUsageDocId(trialEmail));
        const trialUsageSnap = await getDoc(trialUsageRef);
        if (trialUsageSnap.exists()) {
          throw new Error('Оваа е-пошта веќе има искористено бесплатен пробен период.');
        }

        if (isAndroidPlayBillingFlow()) {
          ensureAndroidPlayBillingAvailable();
          const candidateProductIds = ANDROID_SUBSCRIPTION_PRODUCT_IDS['trial-7-days'];
          const { products } = await PlayBilling.getProducts({ productIds: candidateProductIds });
          const selectedProduct = pickPlayProductForPlan(products, candidateProductIds, 'trial-7-days', 1);

          if (!selectedProduct) {
            throw new Error('Не е пронајден активен Play производ за 7-дневен пробен период.');
          }

          await PlayBilling.purchaseSubscription({
            productId: selectedProduct.productId,
            offerToken: selectedProduct.offerToken,
          });
          setPlayEntitled(true);
        } else if (isIOSPurchaseFlow()) {
          ensureIOSStoreKitAvailable();
          const iosProductId = IOS_SUBSCRIPTION_PRODUCT_IDS['trial-7-days'];
          const { products } = await StoreKitBilling.getProducts({ productIds: [iosProductId] });
          const selectedProduct = products.find(p => p.productId === iosProductId);

          if (!selectedProduct) {
            throw new Error('Не е пронајден активен App Store производ за 7-дневен пробен период.');
          }

          await StoreKitBilling.purchaseSubscription({ productId: selectedProduct.productId });
          setIosEntitled(true);
        }

        const purchasePlatform: Profile['subscriptionPlatform'] = isAndroidPlayBillingFlow()
          ? 'android'
          : isIOSPurchaseFlow()
            ? 'ios'
            : undefined;

        const profileRef = doc(db, 'profiles', user.uid);
        const trialEndsAt = addDays(startOfLocalDay(now), TRIAL_DAYS).toISOString();
        const nextChargeAt = trialEndsAt;
        const nowIso = now.toISOString();
        const updatedProfile: Profile = {
          ...profile,
          isPremium: true,
          subscriptionStatus: 'trialing',
          subscriptionPlanId: 'trial-7-days',
          subscriptionPlanTitle: '7 дена пробен период',
          subscriptionDurationMonths: 1,
          subscriptionPriceMKD: 0,
          subscriptionCurrency: 'MKD',
          subscriptionStartedAt: nowIso,
          subscriptionTrialStartedAt: nowIso,
          subscriptionTrialEndsAt: trialEndsAt,
          subscriptionNextChargeAt: nextChargeAt,
          subscriptionNextPlanId: 'monthly',
          subscriptionNextPlanTitle: '1 месец',
          subscriptionNextPriceMKD: MONTHLY_PRICE_MKD,
          subscriptionPlatform: purchasePlatform,
        };

        await runTransaction(db, async transaction => {
          const trialUsageSnap = await transaction.get(trialUsageRef);
          if (trialUsageSnap.exists()) {
            throw new Error('Оваа е-пошта веќе има искористено бесплатен пробен период.');
          }

          transaction.update(profileRef, {
            isPremium: true,
            subscriptionStatus: 'trialing',
            subscriptionPlanId: 'trial-7-days',
            subscriptionPlanTitle: '7 дена пробен период',
            subscriptionDurationMonths: 1,
            subscriptionPriceMKD: 0,
            subscriptionCurrency: 'MKD',
            subscriptionStartedAt: nowIso,
            subscriptionTrialStartedAt: nowIso,
            subscriptionTrialEndsAt: trialEndsAt,
            subscriptionNextChargeAt: nextChargeAt,
            subscriptionNextPlanId: 'monthly',
            subscriptionNextPlanTitle: '1 месец',
            subscriptionNextPriceMKD: MONTHLY_PRICE_MKD,
            subscriptionPaymentLast4: null,
            subscriptionPlatform: purchasePlatform,
          });

          transaction.set(trialUsageRef, {
            email: trialEmail,
            used: true,
            usedAt: nowIso,
            userId: user.uid,
            trialPlanId: 'trial-7-days',
            nextPlanId: 'monthly',
          });
        });
        setProfile(updatedProfile);
        return;
      }

      if (isAndroidPlayBillingFlow()) {
        ensureAndroidPlayBillingAvailable();
        const candidateProductIds = ANDROID_SUBSCRIPTION_PRODUCT_IDS[plan.id];
        const { products } = await PlayBilling.getProducts({ productIds: candidateProductIds });
        const selectedProduct = pickPlayProductForPlan(products, candidateProductIds, plan.id, plan.months);

        if (!selectedProduct) {
          throw new Error('Не е пронајден активен Play производ за избраниот пакет.');
        }

        await PlayBilling.purchaseSubscription({
          productId: selectedProduct.productId,
          offerToken: selectedProduct.offerToken,
        });
        setPlayEntitled(true);
      } else if (isIOSPurchaseFlow()) {
        ensureIOSStoreKitAvailable();
        const iosProductId = IOS_SUBSCRIPTION_PRODUCT_IDS[plan.id];
        const { products } = await StoreKitBilling.getProducts({ productIds: [iosProductId] });
        const selectedProduct = products.find(p => p.productId === iosProductId);

        if (!selectedProduct) {
          throw new Error('Не е пронајден активен App Store производ за избраниот пакет.');
        }

        await StoreKitBilling.purchaseSubscription({ productId: selectedProduct.productId });
        setIosEntitled(true);
      }

      const purchasePlatform: Profile['subscriptionPlatform'] = isAndroidPlayBillingFlow()
        ? 'android'
        : isIOSPurchaseFlow()
          ? 'ios'
          : undefined;

      const subscriptionExpiresAt = addMonths(now, plan.months).toISOString();
      const updatedProfile: Profile = {
        ...profile,
        isPremium: true,
        subscriptionStatus: 'active',
        subscriptionPlanId: plan.id,
        subscriptionPlanTitle: plan.title,
        subscriptionDurationMonths: plan.months,
        subscriptionPriceMKD: plan.priceMKD,
        subscriptionCurrency: 'MKD',
        subscriptionStartedAt: now.toISOString(),
        subscriptionExpiresAt,
        subscriptionNextChargeAt: subscriptionExpiresAt,
        subscriptionNextPlanId: plan.id,
        subscriptionNextPlanTitle: plan.title,
        subscriptionNextPriceMKD: plan.priceMKD,
        subscriptionLastChargeAt: now.toISOString(),
        subscriptionPaymentLast4: undefined,
        subscriptionPlatform: purchasePlatform,
      };

      await updateDoc(doc(db, 'profiles', user.uid), {
        isPremium: true,
        subscriptionStatus: 'active',
        subscriptionPlanId: plan.id,
        subscriptionPlanTitle: plan.title,
        subscriptionDurationMonths: plan.months,
        subscriptionPriceMKD: plan.priceMKD,
        subscriptionCurrency: 'MKD',
        subscriptionStartedAt: now.toISOString(),
        subscriptionExpiresAt,
        subscriptionNextChargeAt: subscriptionExpiresAt,
        subscriptionNextPlanId: plan.id,
        subscriptionNextPlanTitle: plan.title,
        subscriptionNextPriceMKD: plan.priceMKD,
        subscriptionLastChargeAt: now.toISOString(),
        subscriptionTrialStartedAt: null,
        subscriptionTrialEndsAt: null,
        subscriptionPaymentLast4: null,
        subscriptionPlatform: purchasePlatform,
      });
      setProfile(updatedProfile);
    } catch (error) {
      if (isAndroidPlayBillingFlow() && isPlayBillingUnimplementedError(error)) {
        throw new Error(PLAY_BILLING_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
  };

  // Required by App Review (3.1.1) as a visible restore affordance. Forces StoreKit to
  // reconcile with Apple's servers, then reconciles Firestore the same way the periodic
  // entitlement-sync effect above does; that effect keeps running afterward as usual.
  const restoreIOSPurchases = async (): Promise<{ restored: boolean; message: string }> => {
    if (!user) throw new Error('profile-not-ready');
    ensureIOSStoreKitAvailable();

    const candidateProductIds = Array.from(new Set(Object.values(IOS_SUBSCRIPTION_PRODUCT_IDS)));
    const { purchases } = await StoreKitBilling.restorePurchases();
    const activeIOSSubscription = purchases.find(p => candidateProductIds.includes(p.productId));

    if (!activeIOSSubscription) {
      setIosEntitled(false);
      return { restored: false, message: 'Не е пронајдена активна претплата за обновување.' };
    }

    setIosEntitled(true);
    if (!profile?.isPremium) {
      const nowIso = new Date().toISOString();
      await updateDoc(doc(db, 'profiles', user.uid), {
        isPremium: true,
        subscriptionStatus: 'active',
        subscriptionStartedAt: profile?.subscriptionStartedAt || nowIso,
        subscriptionPlatform: 'ios',
      });
    }
    return { restored: true, message: 'Претплатата е успешно вратена.' };
  };

  const effectiveIsPremium = (profile?.isPremium ?? false) || playEntitled || iosEntitled;

  // --- Loading splash ---
  if (!isAppReady || loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <motion.div
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.8, repeat: Infinity, repeatType: 'reverse', ease: 'easeInOut' }}
          className="w-24 h-24 bg-emerald-500 rounded-3xl flex items-center justify-center shadow-lg shadow-emerald-500/20"
        >
          <Activity size={48} className="text-black" />
        </motion.div>
      </div>
    );
  }

  // --- Full-screen views (no nav bar) ---
  if (view === 'google-password') {
    return (
      <GooglePasswordView
        password={password} setPassword={setPassword}
        confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
        showPassword={showPassword} setShowPassword={setShowPassword}
        showConfirmPassword={showConfirmPassword} setShowConfirmPassword={setShowConfirmPassword}
        loading={loading} authError={authError}
        handleSetGooglePassword={handleSetGooglePassword} handleLogout={handleLogout}
      />
    );
  }

  if (view === 'auth') {
    return (
      <AuthView
        authMode={authMode} setAuthMode={mode => {
          setAuthMode(mode);
          setAuthError(null);
          setPassword('');
          setConfirmPassword('');
          setShowPassword(false);
          setShowConfirmPassword(false);
          setFirstName('');
          setLastName('');
          setOnboardingStep(0);
          if (mode === 'register') {
            setOnboardingData({
              weight: 70,
              height: 175,
              age: 25,
              gender: 'male',
              activityLevel: 'moderate',
              goal: 'maintenance',
              trainingType: 'mixed',
              trainingFrequency: '3_times',
              dailyActivity: 'sedentary',
              profileImage: '',
            });
          }
        }}
        email={email} setEmail={setEmail}
        password={password} setPassword={setPassword}
        firstName={firstName} setFirstName={setFirstName}
        lastName={lastName} setLastName={setLastName}
        showPassword={showPassword} setShowPassword={setShowPassword}
        loading={loading} authError={authError}
        handleAuth={handleAuth} handleGoogleAuth={handleGoogleAuth}
      />
    );
  }

  if (!user && view !== 'onboarding') {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center p-6">
        <div className="text-center">
          <div className="w-20 h-20 bg-emerald-500 rounded-3xl mx-auto mb-6 flex items-center justify-center shadow-lg shadow-emerald-500/20">
            <Activity size={40} className="text-black" />
          </div>
          <h1 className="text-2xl font-bold mb-4">Ве молиме најавете се</h1>
          <button onClick={() => setView('auth')} className="px-8 py-4 bg-emerald-500 text-black rounded-2xl font-bold">
            Кон најава
          </button>
        </div>
      </div>
    );
  }

  if (view === 'onboarding') {
    return (
      <OnboardingView
        user={user} profile={profile} authMode={authMode}
        firstName={firstName} lastName={lastName}
        isEditingProfile={isEditingProfile} setIsEditingProfile={setIsEditingProfile}
        onboardingStep={onboardingStep} setOnboardingStep={setOnboardingStep}
        onboardingData={onboardingData} setOnboardingData={setOnboardingData}
        password={password} setPassword={setPassword}
        confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
        showPassword={showPassword} setShowPassword={setShowPassword}
        showConfirmPassword={showConfirmPassword} setShowConfirmPassword={setShowConfirmPassword}
        needsPasswordSetup={needsPasswordSetup}
        loading={loading} authError={authError}
        handleOnboarding={handleOnboarding} handleLogout={handleLogout}
        handleImageUpload={handleImageUpload} setView={setView}
        setFirstName={setFirstName} setLastName={setLastName}
        cancelEditProfile={handleCancelEditProfile}
        handleDeleteAccount={handleDeleteAccount}
      />
    );
  }

  // --- Main app shell (dashboard / search / weight / profile) ---

  return (
    <>
      {typeof document !== 'undefined' && createPortal(
        <AnimatePresence>
          {activeAchievement && effectiveIsPremium && (
            <motion.div
              initial={{ y: -20, opacity: 0, scale: 0.96 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -16, opacity: 0, scale: 0.98 }}
              role="button"
              tabIndex={0}
              onClick={() => {
                if (effectiveIsPremium) {
                  setFocusedAchievementId(activeAchievement.id);
                  setView('challenges');
                }
                setActiveAchievement(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (effectiveIsPremium) {
                    setFocusedAchievementId(activeAchievement.id);
                    setView('challenges');
                  }
                  setActiveAchievement(null);
                }
              }}
                className={`fixed left-1/2 -translate-x-1/2 w-[calc(100vw-24px)] max-w-sm rounded-2xl border px-4 py-3 shadow-2xl backdrop-blur-md cursor-pointer pointer-events-auto ${activeAchievement.kind === 'badge' ? 'bg-amber-950/95 border-amber-400/70 text-amber-100' : 'bg-emerald-950/95 border-emerald-400/70 text-emerald-100'}`}
                style={{ zIndex: 2147483647, top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
            >
              <p className="text-[10px] uppercase tracking-widest font-black opacity-90">
                {activeAchievement.kind === 'badge' ? 'Нова значка' : 'Предизвик завршен'}
              </p>
              <p className="text-sm font-bold mt-1 leading-snug">{activeAchievement.title}</p>
              <p className="text-[10px] mt-1 opacity-80">Допри за детали</p>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}

      <AnimatePresence>
        {showOfflinePremiumPopup && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setShowOfflinePremiumPopup(false)}
          >
            <motion.div
              initial={{ y: 14, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 12, opacity: 0 }}
              className="w-full max-w-sm rounded-2xl bg-zinc-950 border border-zinc-800 p-5"
              onClick={e => e.stopPropagation()}
            >
              <h3 className="text-lg font-bold mb-2">Немаш интернет</h3>
              <p className="text-sm text-zinc-300 mb-4">
                Premium е активен, но офлајн некои функции можат да бидат ограничени додека нема конекција.
              </p>
              <button
                onClick={() => setShowOfflinePremiumPopup(false)}
                className="w-full py-3 rounded-xl bg-emerald-500 text-black font-bold"
              >
                Разбирам
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={cn('min-h-screen bg-black text-white pb-32 max-w-md mx-auto relative', hasUnlockedActiveTheme && 'app-theme')}>

      {/* Views */}
      <AnimatePresence mode="wait">
        {view === 'dashboard' && (
          <DashboardView
            key="dashboard"
            profile={profile} meals={meals}
            planDayTargets={planDayTargets}
            dayCalorieProgressByDate={dayCalorieProgressByDate}
            streakFlameDates={streakFlameDates}
            selectedDate={selectedDate} setSelectedDate={setSelectedDate}
            calendarViewDate={calendarViewDate} setCalendarViewDate={setCalendarViewDate}
            showMonthCalendar={showMonthCalendar} setShowMonthCalendar={setShowMonthCalendar}
            setView={setView} setSelectedMealType={setSelectedMealType}
            deleteMeal={deleteMeal}
          />
        )}
        {view === 'search' && (
          <SearchView
            key="search"
            user={user} isPremium={effectiveIsPremium} selectedMealType={selectedMealType}
            selectedDate={selectedDate} setView={setView}
          />
        )}
        {view === 'weight' && (
          <WeightView
            key="weight"
            weightHistory={weightHistory}
            todayWeight={todayWeight} setTodayWeight={setTodayWeight}
            authError={authError} logWeight={logWeight}
            isPremium={effectiveIsPremium}
            setView={setView}
          />
        )}
        {view === 'progress-photos' && (
          <ProgressPhotosView
            key="progress-photos"
            user={user}
            currentWeight={weightHistory.length > 0 ? weightHistory[weightHistory.length - 1].weight : (profile?.weight ?? 0)}
            setView={setView}
          />
        )}
        {view === 'profile' && (
          <ProfileView
            key="profile"
            user={user}
            profile={profile} firstName={firstName} lastName={lastName} email={email}
            onboardingData={onboardingData}
            lastWeight={weightHistory.length > 0 ? weightHistory[weightHistory.length - 1].weight : null}
            weightHistory={weightHistory}
            startEditProfile={handleStartEditProfile} setView={setView}
            handleLogout={handleLogout}
          />
        )}
        {view === 'subscription' && (
          <SubscriptionView
            key="subscription"
            profile={profile}
            setView={setView}
            onSubscribe={activateSubscription}
            isTrialEligible={isTrialEligible}
            onRestorePurchases={isIOSPurchaseFlow() ? restoreIOSPurchases : undefined}
          />
        )}
        {view === 'mealplan' && effectiveIsPremium && (
          <AiMealPlanView
            key="mealplan"
            profile={profile}
            userId={user?.uid ?? null}
            meals={meals}
            setView={setView}
            saveMealPlanPreference={saveMealPlanPreference}
            addPlannedMealToDailyProgress={addPlannedMealToDailyProgress}
          />
        )}
        {view === 'challenges' && effectiveIsPremium && (
          <ChallengesView
            key="challenges"
            user={user}
            profile={profile}
            weightHistory={weightHistory}
            setView={setView}
            focusAchievementId={focusedAchievementId}
          />
        )}
      </AnimatePresence>

      {/* Navigation Bar */}
      <div className="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-black/90 backdrop-blur-2xl border-t border-zinc-900 px-8 pt-4 pb-8 flex justify-between items-center z-50 safe-area-pb">
        <button onClick={() => setView('dashboard')} className={cn('p-2 transition-colors active:scale-90', view === 'dashboard' ? 'text-emerald-500' : 'text-zinc-600')}>
          <Home size={24} />
        </button>
        <button onClick={() => setView('weight')} className={cn('p-2 transition-colors active:scale-90', view === 'weight' ? 'text-emerald-500' : 'text-zinc-600')}>
          <TrendingUp size={24} />
        </button>
        <button onClick={() => setView('subscription')} className={cn('p-2 transition-colors active:scale-90', view === 'subscription' ? 'text-amber-400' : 'text-zinc-600')}>
          <Crown size={24} />
        </button>
        <button onClick={() => setView('profile')} className={cn('p-2 transition-colors active:scale-90', view === 'profile' ? 'text-emerald-500' : 'text-zinc-600')}>
          <UserIcon size={24} />
        </button>
      </div>
      </div>
    </>
  );
}
