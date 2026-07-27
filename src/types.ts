export interface Food {
  id: string;
  name: string;
  name_lowercase: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  defaultPortion?: number;
  portionUnit?: 'g' | 'ml';
}

export interface Profile {
  weight: number;
  height: number;
  age: number;
  gender: string;
  activityLevel: string;
  goal: string;
  trainingType: string;
  trainingFrequency: string;
  dailyActivity?: string;
  profileImage: string;
  targetCalories: number;
  targetProtein: number;
  targetCarbs: number;
  targetFat: number;
  firstName?: string;
  lastName?: string;
  isSetupDone?: boolean;
  isPremium?: boolean;
  subscriptionPlanId?: string;
  subscriptionPlanTitle?: string;
  subscriptionDurationMonths?: number;
  subscriptionPriceMKD?: number;
  subscriptionCurrency?: 'MKD';
  subscriptionStatus?: 'none' | 'trialing' | 'active' | 'expired' | 'canceled';
  subscriptionStartedAt?: string;
  subscriptionExpiresAt?: string;
  subscriptionTrialStartedAt?: string;
  subscriptionTrialEndsAt?: string;
  subscriptionNextChargeAt?: string;
  subscriptionNextPlanId?: string;
  subscriptionNextPlanTitle?: string;
  subscriptionNextPriceMKD?: number;
  subscriptionLastChargeAt?: string;
  subscriptionPaymentLast4?: string;
  subscriptionPlatform?: 'android' | 'ios';
  mealPlanType?: 'high_protein' | 'low_fat' | 'low_carbs' | 'vegetarian' | 'lactose_free';
  mealPlanSeed?: number;
  maxLevelAchieved?: number;
  activeTheme?: 'balanced-green' | 'neon-xp' | 'beast-mode-red' | 'elite-gold' | 'midnight-focus' | 'sunrise-motivation' | 'fresh-nutrition' | 'protein-power';
  unlockedBadgeIds?: string[];
  seenAchievementIds?: string[];
  totalEarnedPoints?: number;
}

export interface Meal {
  id: string;
  type: string;
  date: string;
  items: { food: Food; amount: number }[];
}

export interface WeightLog {
  weight: number;
  date: string;
}

export interface ProgressPhoto {
  id: string;
  userId: string;
  imageData: string;
  date: string;
  weight: number;
}

export interface OnboardingData {
  weight: number;
  height: number;
  age: number;
  gender: string;
  activityLevel: string;
  goal: string;
  trainingType: string;
  trainingFrequency: string;
  dailyActivity: string;
  profileImage: string;
}

export type ViewType = 'auth' | 'onboarding' | 'dashboard' | 'search' | 'weight' | 'profile' | 'google-password' | 'subscription' | 'mealplan' | 'progress-photos' | 'challenges';
export type AuthModeType = 'login' | 'register';
