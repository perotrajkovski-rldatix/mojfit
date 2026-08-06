import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronLeft, ChevronDown, CheckCircle2, Medal, Flame, Trophy, Utensils, Camera, Scale, CalendarDays, Shield, Target, Beef, Palette, Plus, X } from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import { collection, doc, onSnapshot, query, setDoc, where, writeBatch } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../firebase';
import { generateWeekPlan } from '../data/mealPlanData';
import type { Meal, Profile, ProgressPhoto, ViewType, WeightLog } from '../types';
import { buildBadges, type BadgeWithState } from '../utils/badges';
import { getBadgesByIds } from '../utils/badges';
import {
	applyChallengeSwaps,
	buildChallengePool,
	getChallengeDisplayCount,
	pickChallengeSet,
	type ChallengeItem,
	type ChallengeSection,
	type ChallengeSwapRecord,
} from '../data/challengeItems';
import { isThemeId, type ThemeId } from '../data/themes';
import { MAX_LEVEL, getLevelFromPoints, getLevelProgress } from '../utils/leveling';

interface Props {
	user: FirebaseUser | null;
	profile: Profile | null;
	weightHistory: WeightLog[];
	setView: (v: ViewType) => void;
	focusAchievementId?: string | null;
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

function dayKeyFromDate(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

function mondayBasedDayIndex(dateStr: string): number {
	const day = new Date(dateStr).getDay();
	return (day + 6) % 7;
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
		const key = dayKeyFromDate(cursor);
		if (dates.has(key)) {
			streak += 1;
			cursor.setDate(cursor.getDate() - 1);
		} else {
			break;
		}
	}
	return streak;
}

function findRevivableDay(profile: Profile | null, meals: Meal[], restoredDayKeys: string[]): string | null {
	const completedDaySet = getQualifiedStreakDayKeys(profile, meals, restoredDayKeys);

	const cursor = new Date();
	cursor.setHours(0, 0, 0, 0);
	cursor.setDate(cursor.getDate() - 1);

	for (let i = 0; i < 120; i += 1) {
		const missingKey = dayKeyFromDate(cursor);
		if (!completedDaySet.has(missingKey)) {
			const nextDay = new Date(cursor);
			nextDay.setDate(nextDay.getDate() + 1);
			const prevDay = new Date(cursor);
			prevDay.setDate(prevDay.getDate() - 1);

			const nextKey = dayKeyFromDate(nextDay);
			const prevKey = dayKeyFromDate(prevDay);
			const isBridgeableGap = completedDaySet.has(nextKey) && completedDaySet.has(prevKey);

			if (isBridgeableGap && !completedDaySet.has(missingKey)) {
				return missingKey;
			}
		}
		cursor.setDate(cursor.getDate() - 1);
	}

	return null;
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

function challengeCompletionPurchaseCost(section: 'daily' | 'weekly' | 'monthly' | 'yearly'): number {
	if (section === 'daily') return 30;
	if (section === 'weekly') return 80;
	if (section === 'monthly') return 500;
	return 1500;
}

function challengeSwapPurchaseCost(section: 'daily' | 'weekly' | 'monthly' | 'yearly'): number {
	if (section === 'daily') return 15;
	if (section === 'weekly') return 40;
	if (section === 'monthly') return 250;
	return 750;
}

function challengeCompletionKey(section: 'daily' | 'weekly' | 'monthly' | 'yearly', periodKey: string, challengeId: string): string {
	return `${section}:${periodKey}:${challengeId}`;
}

function challengeSwapKey(section: 'daily' | 'weekly' | 'monthly' | 'yearly', periodKey: string, challengeId: string): string {
	return `${section}:${periodKey}:${challengeId}`;
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
			whileHover={badge.unlocked ? { y: -2, scale: 1.03 } : undefined}
			whileTap={{ scale: 0.96 }}
			className={`relative w-16 h-16 rounded-[20px] p-[2px] overflow-hidden ${badge.unlocked ? visual.glow : 'opacity-50 grayscale'}`}>
			<div className={`absolute inset-0 bg-gradient-to-br ${visual.edge}`} />
			<div className={`absolute inset-[2px] rounded-[18px] bg-gradient-to-br ${visual.center}`} />
			<div className="absolute inset-0 flex items-center justify-center">
				<Icon
					size={22}
					className={`${visual.iconColor} drop-shadow-sm`}
				/>
			</div>
			<div className="absolute top-1.5 right-1.5 text-[8px] font-black text-white/80 tracking-wide">{visual.stamp}</div>
		</motion.div>
	);
}

function formatBadgeTitle(title: string): string {
	return title
		.replace(/фотографии/gi, 'фото-\nграфии')
		.replace(/дисциплина/gi, 'дисци-\nплина');
}

function ChallengeLevelBadge({ level }: { level: number }) {
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
			glow: 'bg-orange-400/25',
		},
		silver: {
			outer: 'from-slate-200 to-slate-500',
			rim: 'from-zinc-100 to-slate-400',
			symbol: 'text-slate-100',
			glow: 'bg-slate-300/25',
		},
		gold: {
			outer: 'from-yellow-200 to-amber-500',
			rim: 'from-yellow-100 to-orange-400',
			symbol: 'text-yellow-50',
			glow: 'bg-yellow-300/25',
		},
		platinum: {
			outer: 'from-cyan-200 to-indigo-500',
			rim: 'from-sky-100 to-blue-500',
			symbol: 'text-cyan-50',
			glow: 'bg-cyan-300/25',
		},
	} as const;

	const visual = tierStyles[tier];

	return (
		<div className="relative w-8 h-8 mx-auto mb-1">
			<motion.div
				className={`absolute -inset-2 rounded-full blur-[6px] ${visual.glow}`}
				animate={{ opacity: [0.2, 0.45, 0.2], scale: [0.92, 1.04, 0.92] }}
				transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
			/>
			<div
				className={`absolute inset-0 bg-gradient-to-b border border-zinc-700/70 shadow-[0_2px_8px_rgba(0,0,0,0.45)] ${visual.outer}`}
				style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
			/>
			<div
				className={`absolute inset-[2px] bg-gradient-to-b border border-white/40 ${visual.rim}`}
				style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
			/>
			<div
				className="absolute inset-[4px] bg-gradient-to-b from-indigo-500 via-blue-700 to-indigo-900 border border-blue-200/40"
				style={{ clipPath: 'polygon(50% 0, 95% 25%, 95% 75%, 50% 100%, 5% 75%, 5% 25%)' }}
			/>
			<div className={`absolute inset-0 flex items-center justify-center ${visual.symbol}`}>
				<span className="text-[11px] font-black tracking-tight drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">{romanNumeral}</span>
			</div>
		</div>
	);
}

export default function ChallengesView({ user, profile, weightHistory, setView, focusAchievementId = null }: Props) {
	const STREAK_RESTORE_COST = 500;
	const isPremium = profile?.isPremium === true;
	const collapsedSections = {
		daily: false,
		weekly: false,
		monthly: false,
		yearly: false,
	};

	const [allMeals, setAllMeals] = useState<Meal[]>([]);
	const [photos, setPhotos] = useState<ProgressPhoto[]>([]);
	const [streakRestoreDays, setStreakRestoreDays] = useState<string[]>([]);
	const [purchasedChallengeCompletions, setPurchasedChallengeCompletions] = useState<string[]>([]);
	const [challengeSwaps, setChallengeSwaps] = useState<ChallengeSwapRecord[]>([]);
	const [themePurchaseIds, setThemePurchaseIds] = useState<ThemeId[]>([]);
	const [spentPointsTotal, setSpentPointsTotal] = useState<number>(0);
	const [expandedSections, setExpandedSections] = useState(collapsedSections);
	const [highlightChallengeId, setHighlightChallengeId] = useState<string | null>(null);
	const [highlightBadgeId, setHighlightBadgeId] = useState<string | null>(null);
	const [isSpendModalOpen, setIsSpendModalOpen] = useState(false);
	const [selectedSpendOption, setSelectedSpendOption] = useState<'streak_restore' | 'challenge_complete' | 'challenge_swap' | null>(null);
	const [selectedChallengeKey, setSelectedChallengeKey] = useState<string | null>(null);
	const [selectedSwapKey, setSelectedSwapKey] = useState<string | null>(null);
	const [isPurchasingRestore, setIsPurchasingRestore] = useState(false);
	const [spendFeedback, setSpendFeedback] = useState<string | null>(null);
	const lastHandledFocusId = useRef<string | null>(null);

	useEffect(() => {
		if (!focusAchievementId) {
			lastHandledFocusId.current = null;
			return;
		}
		if (lastHandledFocusId.current === focusAchievementId) return;
		lastHandledFocusId.current = focusAchievementId;

		if (focusAchievementId.startsWith('challenge:')) {
			const parts = focusAchievementId.split(':');
			const section = parts[1] as 'daily' | 'weekly' | 'monthly' | 'yearly' | undefined;
			const challengeId = parts.slice(3).join(':');
			if (section && ['daily', 'weekly', 'monthly', 'yearly'].includes(section)) {
				setExpandedSections(prev => ({ ...prev, [section]: true }));
			}
			if (challengeId) {
				setHighlightChallengeId(challengeId);
				const t = window.setTimeout(() => setHighlightChallengeId(null), 3500);
				return () => window.clearTimeout(t);
			}
		}

		if (focusAchievementId.startsWith('badge:')) {
			const badgeId = focusAchievementId.replace('badge:', '');
			if (badgeId) {
				setHighlightBadgeId(badgeId);
				const t = window.setTimeout(() => setHighlightBadgeId(null), 3500);
				return () => window.clearTimeout(t);
			}
		}
	}, [focusAchievementId]);

	useEffect(() => {
		if (isPremium) return;
		setIsSpendModalOpen(false);
		setSelectedSpendOption(null);
		setSelectedChallengeKey(null);
		setSelectedSwapKey(null);
		setSpendFeedback(null);
	}, [isPremium]);

	useEffect(() => {
		if (!isSpendModalOpen) return;
		const html = document.documentElement;
		const body = document.body;
		const prevHtmlOverflow = html.style.overflow;
		const prevBodyOverflow = body.style.overflow;
		html.style.overflow = 'hidden';
		body.style.overflow = 'hidden';
		return () => {
			html.style.overflow = prevHtmlOverflow;
			body.style.overflow = prevBodyOverflow;
		};
	}, [isSpendModalOpen]);

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
			snap => {
				const days = snap.docs
					.map(d => String(d.data().dayKey || ''))
					.filter(Boolean);
				setStreakRestoreDays(days);
			},
			err => handleFirestoreError(err, OperationType.LIST, 'streak_restores'),
		);

		const unsubChallengeCompletions = onSnapshot(
			query(collection(db, 'challenge_completions'), where('userId', '==', user.uid)),
			snap => {
				const keys = snap.docs
					.map(d => String(d.data().challengePurchaseKey || ''))
					.filter(Boolean);
				setPurchasedChallengeCompletions(keys);
			},
			err => handleFirestoreError(err, OperationType.LIST, 'challenge_completions'),
		);

		const unsubChallengeSwaps = onSnapshot(
			query(collection(db, 'challenge_swaps'), where('userId', '==', user.uid)),
			snap => {
				const swaps = snap.docs.reduce<ChallengeSwapRecord[]>((rows, d) => {
					const section = d.data().section;
					const periodKey = String(d.data().periodKey || '');
					const fromChallengeId = String(d.data().fromChallengeId || '');
					const toChallengeId = String(d.data().toChallengeId || '');
					const date = d.data().date ? String(d.data().date) : undefined;

					if ((section !== 'daily' && section !== 'weekly' && section !== 'monthly' && section !== 'yearly') || !periodKey || !fromChallengeId || !toChallengeId) {
						return rows;
					}

					rows.push({ section, periodKey, fromChallengeId, toChallengeId, date });
					return rows;
				}, []);
				setChallengeSwaps(swaps);
			},
			err => handleFirestoreError(err, OperationType.LIST, 'challenge_swaps'),
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

		return () => {
			unsubMeals();
			unsubPhotos();
			unsubStreakRestores();
			unsubChallengeCompletions();
			unsubChallengeSwaps();
			unsubPointSpends();
			unsubThemePurchases();
		};
	}, [user]);

	const computed = useMemo(() => {
		const today = new Date();
		const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
		const weekStart = startOfWeek(today);
		const weekKey = dayKey(weekStart.toISOString());
		const monthStart = startOfMonth(today);
		const monthKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
		const yearStart = startOfYear(today);
		const yearKey = `${today.getFullYear()}`;

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

		const earnedBadgeIdsFromProfile = Array.isArray(profile?.unlockedBadgeIds)
			? profile.unlockedBadgeIds.filter((v): v is string => typeof v === 'string')
			: [];
		const earnedBadgeIdsFromAchievements = Array.isArray(profile?.earnedAchievementIds)
			? profile.earnedAchievementIds
				.filter((v): v is string => typeof v === 'string' && v.startsWith('badge:'))
				.map(v => v.replace('badge:', ''))
			: [];
		const persistedEarnedBadgeIds = Array.from(new Set([
			...earnedBadgeIdsFromProfile,
			...earnedBadgeIdsFromAchievements,
		]));

		if (!isPremium) {
			const lifetimePoints = Math.max(0, Number(profile?.totalEarnedPoints ?? 0));
			return {
				dailyChallenges: [] as ChallengeItem[],
				weeklyChallenges: [] as ChallengeItem[],
				monthlyChallenges: [] as ChallengeItem[],
				yearlyChallenges: [] as ChallengeItem[],
				badges: getBadgesByIds(persistedEarnedBadgeIds),
				streak: 0,
				earnedPoints: lifetimePoints,
				challengePoints: 0,
				badgePoints: persistedEarnedBadgeIds.length * 50,
				level: Math.max(getLevelFromPoints(lifetimePoints), profile?.maxLevelAchieved ?? 1),
				todayKey: todayStr,
				weekKey,
				monthKey,
				yearKey,
				dailyRankedPool: [] as ChallengeItem[],
				weeklyRankedPool: [] as ChallengeItem[],
				monthlyRankedPool: [] as ChallengeItem[],
				yearlyRankedPool: [] as ChallengeItem[],
			};
		}

		const purchasedCompletions = new Set(purchasedChallengeCompletions);

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

		const dailyPool = buildChallengePool('daily', metrics);
		const weeklyPool = buildChallengePool('weekly', metrics);
		const monthlyPool = buildChallengePool('monthly', metrics);
		const yearlyPool = buildChallengePool('yearly', metrics);

		const dailyRankedPool = pickChallengeSet(dailyPool, `daily:${todayStr}`, dailyPool.length);
		const weeklyRankedPool = pickChallengeSet(weeklyPool, `weekly:${weekKey}`, weeklyPool.length);
		const monthlyRankedPool = pickChallengeSet(monthlyPool, `monthly:${monthKey}`, monthlyPool.length);
		const yearlyRankedPool = pickChallengeSet(yearlyPool, `yearly:${yearKey}`, yearlyPool.length);

		const dailyChallenges = applyChallengeSwaps(
			pickChallengeSet(dailyPool, `daily:${todayStr}`, getChallengeDisplayCount('daily')),
			dailyRankedPool,
			challengeSwaps,
			'daily',
			todayStr,
		);
		const weeklyChallenges = applyChallengeSwaps(
			pickChallengeSet(weeklyPool, `weekly:${weekKey}`, getChallengeDisplayCount('weekly')),
			weeklyRankedPool,
			challengeSwaps,
			'weekly',
			weekKey,
		);
		const monthlyChallenges = applyChallengeSwaps(
			pickChallengeSet(monthlyPool, `monthly:${monthKey}`, getChallengeDisplayCount('monthly')),
			monthlyRankedPool,
			challengeSwaps,
			'monthly',
			monthKey,
		);
		const yearlyChallenges = applyChallengeSwaps(
			pickChallengeSet(yearlyPool, `yearly:${yearKey}`, getChallengeDisplayCount('yearly')),
			yearlyRankedPool,
			challengeSwaps,
			'yearly',
			yearKey,
		);

		const completedWithPurchase = (section: 'daily' | 'weekly' | 'monthly' | 'yearly', periodKey: string, challenge: ChallengeItem): boolean =>
			isChallengeCompleted(challenge) || purchasedCompletions.has(challengeCompletionKey(section, periodKey, challenge.id));

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
			completedMonthly: monthlyChallenges.filter(isChallengeCompleted).length,
			completedYearly: yearlyChallenges.filter(isChallengeCompleted).length,
		});

		const unlockedBadgeIds = new Set<string>(persistedEarnedBadgeIds);
		badges.forEach(b => {
			if (b.unlocked) unlockedBadgeIds.add(b.id);
		});
		const mergedBadges = badges.map(b => ({
			...b,
			unlocked: b.unlocked || unlockedBadgeIds.has(b.id),
		}));

		const completedDaily = dailyChallenges.filter(isChallengeCompleted).length;
		const completedWeekly = weeklyChallenges.filter(isChallengeCompleted).length;
		const completedMonthly = monthlyChallenges.filter(isChallengeCompleted).length;
		const completedYearly = yearlyChallenges.filter(isChallengeCompleted).length;
		const unlockedBadges = mergedBadges.filter(b => b.unlocked).length;

		const challengePoints = completedDaily * 10 + completedWeekly * 30 + completedMonthly * 150 + completedYearly * 1000;
		const badgePoints = unlockedBadges * 50;
		const cycleEarnedPoints = challengePoints + badgePoints;
		const earnedPoints = Math.max(Math.max(0, Number(profile?.totalEarnedPoints ?? 0)), cycleEarnedPoints);
		const level = getLevelFromPoints(earnedPoints);

		return {
			dailyChallenges,
			weeklyChallenges,
			monthlyChallenges,
			yearlyChallenges,
			badges: mergedBadges,
			streak,
			earnedPoints,
			challengePoints,
			badgePoints,
			level,
			todayKey: todayStr,
			weekKey,
			monthKey,
			yearKey,
			dailyRankedPool,
			weeklyRankedPool,
			monthlyRankedPool,
			yearlyRankedPool,
		};
	}, [allMeals, challengeSwaps, isPremium, photos, profile, purchasedChallengeCompletions, streakRestoreDays, themePurchaseIds.length, weightHistory]);

	const availablePoints = isPremium ? Math.max(0, computed.earnedPoints - spentPointsTotal) : 0;
	const maxAchievedLevel = Math.max(computed.level, profile?.maxLevelAchieved ?? 1);
	const purchasedChallengeCompletionSet = useMemo(() => new Set(purchasedChallengeCompletions), [purchasedChallengeCompletions]);
	const challengeSpendOptions = useMemo(() => {
		const rows: { key: string; title: string; cost: number; section: 'daily' | 'weekly' | 'monthly' | 'yearly'; sectionLabel: string }[] = [];
		const sections: Array<{ section: 'daily' | 'weekly' | 'monthly' | 'yearly'; sectionLabel: string; periodKey: string; items: ChallengeItem[] }> = [
			{ section: 'daily', sectionLabel: 'Дневен', periodKey: computed.todayKey, items: computed.dailyChallenges },
			{ section: 'weekly', sectionLabel: 'Неделен', periodKey: computed.weekKey, items: computed.weeklyChallenges },
			{ section: 'monthly', sectionLabel: 'Месечен', periodKey: computed.monthKey, items: computed.monthlyChallenges },
			{ section: 'yearly', sectionLabel: 'Годишен', periodKey: computed.yearKey, items: computed.yearlyChallenges },
		];

		sections.forEach(({ section, sectionLabel, periodKey, items }) => {
			items.forEach(challenge => {
				const key = challengeCompletionKey(section, periodKey, challenge.id);
				const alreadyCompleted = isChallengeCompleted(challenge) || purchasedChallengeCompletionSet.has(key);
				if (!alreadyCompleted) {
					rows.push({
						key,
						title: challenge.title,
						cost: challengeCompletionPurchaseCost(section),
						section,
						sectionLabel,
					});
				}
			});
		});

		return rows;
	}, [computed.dailyChallenges, computed.monthKey, computed.monthlyChallenges, computed.todayKey, computed.weekKey, computed.weeklyChallenges, computed.yearKey, computed.yearlyChallenges, purchasedChallengeCompletionSet]);
	const challengeSwapOptions = useMemo(() => {
		const rows: {
			key: string;
			title: string;
			cost: number;
			section: ChallengeSection;
			sectionLabel: string;
			periodKey: string;
			challengeId: string;
		}[] = [];
		const sections: Array<{ section: ChallengeSection; sectionLabel: string; periodKey: string; items: ChallengeItem[]; pool: ChallengeItem[] }> = [
			{ section: 'daily', sectionLabel: 'Дневен', periodKey: computed.todayKey, items: computed.dailyChallenges, pool: computed.dailyRankedPool },
			{ section: 'weekly', sectionLabel: 'Неделен', periodKey: computed.weekKey, items: computed.weeklyChallenges, pool: computed.weeklyRankedPool },
			{ section: 'monthly', sectionLabel: 'Месечен', periodKey: computed.monthKey, items: computed.monthlyChallenges, pool: computed.monthlyRankedPool },
			{ section: 'yearly', sectionLabel: 'Годишен', periodKey: computed.yearKey, items: computed.yearlyChallenges, pool: computed.yearlyRankedPool },
		];

		sections.forEach(({ section, sectionLabel, periodKey, items, pool }) => {
			const displayedIds = new Set(items.map(item => item.id));
			items.forEach(challenge => {
				const hasReplacementCandidate = pool.some(candidate => !displayedIds.has(candidate.id));
				if (!hasReplacementCandidate) return;

				rows.push({
					key: challengeSwapKey(section, periodKey, challenge.id),
					title: challenge.title,
					cost: challengeSwapPurchaseCost(section),
					section,
					sectionLabel,
					periodKey,
					challengeId: challenge.id,
				});
			});
		});

		return rows;
	}, [computed.dailyChallenges, computed.dailyRankedPool, computed.monthKey, computed.monthlyChallenges, computed.monthlyRankedPool, computed.todayKey, computed.weekKey, computed.weeklyChallenges, computed.weeklyRankedPool, computed.yearKey, computed.yearlyChallenges, computed.yearlyRankedPool]);
	const selectedChallengeOption = challengeSpendOptions.find(option => option.key === selectedChallengeKey) ?? null;
	const selectedSwapOption = challengeSwapOptions.find(option => option.key === selectedSwapKey) ?? null;
	const revivableDay = useMemo(() => findRevivableDay(profile, allMeals, streakRestoreDays), [allMeals, profile, streakRestoreDays]);
	const revivableDayDisplay = revivableDay
		? new Date(`${revivableDay}T00:00:00`).toLocaleDateString('mk-MK', {
			day: '2-digit',
			month: 'long',
			year: 'numeric',
		})
		: null;

	const levelProgress = getLevelProgress(computed.earnedPoints);
	const isMaxLevel = maxAchievedLevel >= MAX_LEVEL;
	const levelProgressPct = isMaxLevel ? 100 : levelProgress.progressPct;
	const pointsToNextLevel = isMaxLevel ? 0 : levelProgress.pointsToNextLevel;
	const canBuySelectedOption =
		(selectedSpendOption === 'streak_restore'
			? !!revivableDay && availablePoints >= STREAK_RESTORE_COST
			: selectedSpendOption === 'challenge_complete'
				? !!selectedChallengeOption && availablePoints >= selectedChallengeOption.cost
				: selectedSpendOption === 'challenge_swap'
					? !!selectedSwapOption && availablePoints >= selectedSwapOption.cost
				: false)
		&& !isPurchasingRestore;

	useEffect(() => {
		if (selectedSpendOption !== 'challenge_complete') return;
		if (!challengeSpendOptions.some(option => option.key === selectedChallengeKey)) {
			setSelectedChallengeKey(challengeSpendOptions[0]?.key ?? null);
		}
	}, [challengeSpendOptions, selectedChallengeKey, selectedSpendOption]);

	useEffect(() => {
		if (selectedSpendOption !== 'challenge_swap') return;
		if (!challengeSwapOptions.some(option => option.key === selectedSwapKey)) {
			setSelectedSwapKey(challengeSwapOptions[0]?.key ?? null);
		}
	}, [challengeSwapOptions, selectedSpendOption, selectedSwapKey]);

	useEffect(() => {
		if (!user || !isPremium) return;
		if (computed.level <= (profile?.maxLevelAchieved ?? 1)) return;

		setDoc(
			doc(db, 'profiles', user.uid),
			{ maxLevelAchieved: computed.level },
			{ merge: true },
		).catch(error => handleFirestoreError(error, OperationType.UPDATE, 'profiles/maxLevelAchieved'));
	}, [computed.level, isPremium, profile?.maxLevelAchieved, user]);

	const handleStreakRestorePurchase = async () => {
		if (!user || !isPremium || !revivableDay) return;
		if (availablePoints < STREAK_RESTORE_COST || isPurchasingRestore) return;

		setIsPurchasingRestore(true);
		setSpendFeedback(null);
		try {
			const nowIso = new Date().toISOString();
			const batch = writeBatch(db);

			const spendRef = doc(collection(db, 'point_spends'));
			batch.set(spendRef, {
				userId: user.uid,
				type: 'streak_restore',
				cost: STREAK_RESTORE_COST,
				targetDayKey: revivableDay,
				date: nowIso,
			});

			const restoreRef = doc(collection(db, 'streak_restores'));
			batch.set(restoreRef, {
				userId: user.uid,
				dayKey: revivableDay,
				cost: STREAK_RESTORE_COST,
				type: 'streak_restore',
				date: nowIso,
			});

			await batch.commit();
			setSpendFeedback(null);
			setSelectedSpendOption(null);
			setSelectedChallengeKey(null);
			setIsSpendModalOpen(false);
		} catch (error) {
			handleFirestoreError(error, OperationType.CREATE, 'streak_restore_purchase');
			setSpendFeedback('Не успеа купувањето. Пробај повторно.');
		} finally {
			setIsPurchasingRestore(false);
		}
	};

	const handleChallengeCompletionPurchase = async () => {
		if (!user || !isPremium || !selectedChallengeOption) return;
		if (availablePoints < selectedChallengeOption.cost || isPurchasingRestore) return;

		setIsPurchasingRestore(true);
		setSpendFeedback(null);
		try {
			const nowIso = new Date().toISOString();
			const batch = writeBatch(db);

			const spendRef = doc(collection(db, 'point_spends'));
			batch.set(spendRef, {
				userId: user.uid,
				type: 'challenge_complete',
				cost: selectedChallengeOption.cost,
				targetChallengeKey: selectedChallengeOption.key,
				date: nowIso,
			});

			const completionRef = doc(collection(db, 'challenge_completions'));
			batch.set(completionRef, {
				userId: user.uid,
				challengePurchaseKey: selectedChallengeOption.key,
				type: 'challenge_complete',
				cost: selectedChallengeOption.cost,
				date: nowIso,
			});

			await batch.commit();
			setSpendFeedback(null);
			setSelectedSpendOption(null);
			setSelectedChallengeKey(null);
			setIsSpendModalOpen(false);
		} catch (error) {
			handleFirestoreError(error, OperationType.CREATE, 'challenge_completion_purchase');
			setSpendFeedback('Не успеа купувањето. Пробај повторно.');
		} finally {
			setIsPurchasingRestore(false);
		}
	};

	const handleChallengeSwapPurchase = async () => {
		if (!user || !isPremium || !selectedSwapOption) return;
		if (availablePoints < selectedSwapOption.cost || isPurchasingRestore) return;

		const sectionState = selectedSwapOption.section === 'daily'
			? { items: computed.dailyChallenges, pool: computed.dailyRankedPool }
			: selectedSwapOption.section === 'weekly'
				? { items: computed.weeklyChallenges, pool: computed.weeklyRankedPool }
				: selectedSwapOption.section === 'monthly'
					? { items: computed.monthlyChallenges, pool: computed.monthlyRankedPool }
					: { items: computed.yearlyChallenges, pool: computed.yearlyRankedPool };
		const displayedIds = new Set(sectionState.items.map(item => item.id));
		const replacementCandidates = sectionState.pool.filter(candidate => !displayedIds.has(candidate.id));
		if (replacementCandidates.length === 0) {
			setSpendFeedback('Нема достапен нов предизвик за замена во оваа група.');
			return;
		}
		const replacement = replacementCandidates[Math.floor(Math.random() * replacementCandidates.length)];

		setIsPurchasingRestore(true);
		setSpendFeedback(null);
		try {
			const nowIso = new Date().toISOString();
			const batch = writeBatch(db);

			const spendRef = doc(collection(db, 'point_spends'));
			batch.set(spendRef, {
				userId: user.uid,
				type: 'challenge_swap',
				cost: selectedSwapOption.cost,
				targetChallengeKey: selectedSwapOption.key,
				targetReplacementId: replacement.id,
				date: nowIso,
			});

			const swapRef = doc(collection(db, 'challenge_swaps'));
			batch.set(swapRef, {
				userId: user.uid,
				section: selectedSwapOption.section,
				periodKey: selectedSwapOption.periodKey,
				fromChallengeId: selectedSwapOption.challengeId,
				toChallengeId: replacement.id,
				cost: selectedSwapOption.cost,
				type: 'challenge_swap',
				date: nowIso,
			});

			await batch.commit();
			setSpendFeedback(null);
			setSelectedSpendOption(null);
			setSelectedChallengeKey(null);
			setSelectedSwapKey(null);
			setIsSpendModalOpen(false);
		} catch (error) {
			handleFirestoreError(error, OperationType.CREATE, 'challenge_swap_purchase');
			setSpendFeedback('Не успеа менувањето на предизвикот. Пробај повторно.');
		} finally {
			setIsPurchasingRestore(false);
		}
	};

	const ChallengeCard = ({ title, progress, target, completed, rangeMode = false, highlighted = false }: { title: string; progress: number; target: number; completed: boolean; rangeMode?: boolean; highlighted?: boolean }) => {
		const ratio = completed ? 1 : Math.min(1, progress / Math.max(1, target));
		const displayProgress = completed ? target : Math.round(progress);
		return (
			<div className={`bg-zinc-900 border rounded-2xl p-4 transition-all duration-300 ${highlighted ? 'border-emerald-400 shadow-[0_0_0_1px_rgba(52,211,153,0.6),0_0_26px_rgba(16,185,129,0.25)]' : 'border-zinc-800'}`}>
				<div className="flex items-start justify-between gap-3 mb-2">
					<p className="font-semibold text-sm leading-snug">{title}</p>
					{completed ? (
						<CheckCircle2
							size={16}
							className="text-emerald-400 shrink-0"
						/>
					) : (
						<div className="w-4 h-4 rounded-full border border-zinc-600 shrink-0" />
					)}
				</div>
				<div className="h-2 rounded-full bg-zinc-800 overflow-hidden mb-2">
					<div
						className="h-full bg-emerald-500"
						style={{ width: `${Math.round(ratio * 100)}%` }}
					/>
				</div>
				<p className="text-xs text-zinc-500">
					{displayProgress} / {target}
					{rangeMode && ' (цела: +/-10%)'}
				</p>
			</div>
		);
	};

	const toggleSection = (sectionKey: 'daily' | 'weekly' | 'monthly' | 'yearly') => {
		setExpandedSections(prev => {
			const isCurrentlyOpen = prev[sectionKey];
			return {
				daily: false,
				weekly: false,
				monthly: false,
				yearly: false,
				[sectionKey]: !isCurrentlyOpen,
			};
		});
	};

	const ChallengeDropdownSection = ({ sectionKey, title, items }: { sectionKey: 'daily' | 'weekly' | 'monthly' | 'yearly'; title: string; items: ChallengeItem[] }) => {
		const isOpen = expandedSections[sectionKey];
		const periodKey = sectionKey === 'daily'
			? computed.todayKey
			: sectionKey === 'weekly'
				? computed.weekKey
				: sectionKey === 'monthly'
					? computed.monthKey
					: computed.yearKey;

		return (
			<motion.div
				layout
				transition={{
					layout: {
						duration: 0.6,
						ease: [0.22, 1, 0.36, 1],
					},
				}}
				className="space-y-1.5">
				<button
					onClick={() => toggleSection(sectionKey)}
					className="w-full bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-3.5 flex items-center justify-between active:scale-[0.99] transition-transform">
					<span className="text-sm font-bold text-zinc-300 uppercase tracking-wider">{title}</span>

					<motion.div
						animate={{ rotate: isOpen ? 180 : 0 }}
						transition={{ duration: 1, ease: [0.22, 1, 0.36, 1] }}>
						<ChevronDown
							size={16}
							className="text-zinc-400"
						/>
					</motion.div>
				</button>

				<AnimatePresence mode="wait">
					{isOpen && (
						<motion.div
							layout
							initial={{
								opacity: 0,
								height: 0,
							}}
							animate={{
								opacity: 1,
								height: 'auto',
							}}
							exit={{
								opacity: 0,
								height: 0,
							}}
							transition={{
								height: {
									duration: 0.6,
									ease: [0.22, 1, 0.36, 1],
								},
								opacity: {
									duration: 0.4,
								},
							}}
							className="overflow-hidden">
							<div className="space-y-2 pt-1">
								{items.map((c, index) => (
									<motion.div
										key={c.id}
										initial={{
											opacity: 0,
											y: -8,
										}}
										animate={{
											opacity: 1,
											y: 0,
										}}
										exit={{
											opacity: 0,
											y: -8,
										}}
										transition={{
											duration: 0.3,
											delay: index * 0.05,
										}}>
										<ChallengeCard
											title={c.title}
											progress={c.progress}
											target={c.target}
											completed={isChallengeCompleted(c) || purchasedChallengeCompletionSet.has(challengeCompletionKey(sectionKey, periodKey, c.id))}
											rangeMode={c.rangeMode}
											highlighted={highlightChallengeId === c.id}
										/>
									</motion.div>
								))}
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</motion.div>
		);
	};

	return (
		<>
		<motion.div
			key="challenges"
			initial={{ opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			className={`${isSpendModalOpen ? 'pointer-events-none' : ''} px-6 pt-10 pb-36 safe-area-pt space-y-4`}
			style={{ minHeight: '100dvh' }}>
			<div className="flex items-center gap-3">
				<button
					onClick={() => setView('dashboard')}
					className="p-2 bg-zinc-900 rounded-xl active:scale-90 transition-transform">
					<ChevronLeft size={20} />
				</button>
				<h2 className="text-xl font-bold">Предизвици и значки</h2>
			</div>

			<div className="grid grid-cols-3 gap-3">
				<div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-center">
					<div className="h-8 mb-1 flex items-center justify-center">
						<ChallengeLevelBadge level={maxAchievedLevel} />
					</div>
					<p className="text-xs text-zinc-500">Ниво</p>
					<p className="font-black text-lg">{maxAchievedLevel}</p>
				</div>
				<div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-center">
					<div className="h-8 mb-1 flex items-center justify-center">
						<Flame
							size={28}
							className="text-orange-400"
						/>
					</div>
					<p className="text-xs text-zinc-500">Streak</p>
					<p className="font-black text-lg">{computed.streak}</p>
				</div>
				<div className="relative bg-zinc-900 border border-zinc-800 rounded-2xl p-4 text-center">
					<button
						onClick={() => {
							setSpendFeedback(null);
							setSelectedSpendOption(null);
							setSelectedChallengeKey(null);
							setSelectedSwapKey(null);
							setIsSpendModalOpen(true);
						}}
						className="absolute top-2 right-2 w-6 h-6 rounded-full border border-zinc-700 bg-zinc-950/80 text-zinc-200 hover:text-white hover:border-zinc-500 transition-colors flex items-center justify-center"
						aria-label="Потроши поени">
						<Plus size={14} />
					</button>
					<div className="h-8 mb-1 flex items-center justify-center">
						<Medal
							size={28}
							className="text-emerald-400"
						/>
					</div>
					<p className="text-xs text-zinc-500">Поени</p>
					<p className="font-black text-lg">{availablePoints}</p>
				</div>
			</div>

			<div className="bg-zinc-900/70 border border-zinc-800 rounded-2xl p-4 space-y-2">
				<div className="flex items-center justify-between text-xs text-zinc-400">
					<span>Прогрес на ниво</span>
					<span>{isMaxLevel ? 'MAX' : `${pointsToNextLevel} до следно`}</span>
				</div>
				<div className="h-2.5 rounded-full bg-zinc-800 overflow-hidden">
					<div className="h-full bg-gradient-to-r from-emerald-400 to-cyan-400" style={{ width: `${levelProgressPct}%` }} />
				</div>
				<p className="text-[11px] text-zinc-500 text-center">
					Предизвици: {computed.challengePoints} • Значки: {computed.badgePoints} • Потрошени: {spentPointsTotal}
				</p>
			</div>

			<ChallengeDropdownSection
				sectionKey="daily"
				title="Дневни предизвици"
				items={computed.dailyChallenges}
			/>
			<ChallengeDropdownSection
				sectionKey="weekly"
				title="Неделни предизвици"
				items={computed.weeklyChallenges}
			/>
			<ChallengeDropdownSection
				sectionKey="monthly"
				title="Месечни предизвици"
				items={computed.monthlyChallenges}
			/>
			<ChallengeDropdownSection
				sectionKey="yearly"
				title="Годишни предизвици"
				items={computed.yearlyChallenges}
			/>

			<div className="space-y-3">
				<h3 className="text-sm font-bold text-zinc-400 uppercase tracking-wider">Значки</h3>
				<div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
					<div className="flex items-center justify-end mb-4">
						<p className="text-xs text-zinc-400 font-semibold">
							{computed.badges.filter(b => b.unlocked).length} / {computed.badges.length}
						</p>
					</div>
					<div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
						{computed.badges.map(b => (
							<motion.div
								key={b.id}
								whileTap={{ scale: 0.98 }}
								className={`rounded-2xl p-3 border text-center transition-all duration-300 ${highlightBadgeId === b.id ? 'border-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.6),0_0_26px_rgba(245,158,11,0.25)]' : ''} ${b.unlocked ? 'bg-zinc-900 border-zinc-700 text-zinc-100' : 'bg-zinc-950 border-zinc-800 text-zinc-500'}`}>
								<div className="flex justify-center mb-2">
									<BadgeHex badge={b} />
								</div>
								<p
									className="text-[11px] font-bold leading-tight min-h-[30px]"
									style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', wordBreak: 'break-word' }}
								>
									{formatBadgeTitle(b.title)}
								</p>
							</motion.div>
						))}
					</div>
				</div>
			</div>
		</motion.div>

		<AnimatePresence>
			{isSpendModalOpen && (
				<motion.div
					className="fixed inset-0 z-[120] bg-black/60 backdrop-blur-sm px-4"
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					onClick={() => {
						setIsSpendModalOpen(false);
						setSelectedSpendOption(null);
						setSelectedChallengeKey(null);
					}}>
					<motion.div
						initial={{ opacity: 0, y: 18, scale: 0.97 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 12, scale: 0.98 }}
						transition={{ duration: 0.2, ease: 'easeOut' }}
						onClick={e => e.stopPropagation()}
						className="w-full max-w-md rounded-3xl border border-zinc-700 bg-zinc-950 shadow-[0_24px_80px_rgba(0,0,0,0.45)] absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
						<div className="flex items-center justify-between px-5 pt-5 pb-2">
							<h3 className="text-lg font-black">Достапни поени: <span className="text-zinc-100 font-bold">{availablePoints}</span></h3>
							<button
								onClick={() => {
									setIsSpendModalOpen(false);
									setSelectedSpendOption(null);
									setSelectedChallengeKey(null);
									setSelectedSwapKey(null);
								}}
								className="w-8 h-8 rounded-full border border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white hover:border-zinc-500 transition-colors flex items-center justify-center"
								aria-label="Затвори">
								<X size={15} />
							</button>
						</div>

						<div className="px-5 pb-5 space-y-3">
							<p className="text-sm text-zinc-400">Одберете на што ќе ги потрошите поените.</p>

							<button
								type="button"
								onClick={() => {
									setSelectedSpendOption('streak_restore');
									setSelectedChallengeKey(null);
									setSelectedSwapKey(null);
									setSpendFeedback(null);
								}}
								aria-pressed={selectedSpendOption === 'streak_restore'}
								className={`w-full rounded-2xl border bg-zinc-900/80 p-4 space-y-2 text-left transition-all ${selectedSpendOption === 'streak_restore' ? 'border-emerald-500 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]' : 'border-zinc-800'}`}>
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-bold">Продолжи streak</p>
										<p className="text-xs text-zinc-400">Пополнува 1 пропуштен ден и streak-от продолжува.</p>
									</div>
									<div className="px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-bold">{STREAK_RESTORE_COST} поени</div>
								</div>

								<p className="text-xs text-zinc-500">
									{revivableDayDisplay ? `Ќе се врати денот: ${revivableDayDisplay}` : 'Нема пропуштен ден што може да се врати во моментот.'}
								</p>
							</button>

							<button
								type="button"
								onClick={() => {
									setSelectedSpendOption('challenge_complete');
									if (!selectedChallengeKey) {
										setSelectedChallengeKey(challengeSpendOptions[0]?.key ?? null);
									}
									setSelectedSwapKey(null);
									setSpendFeedback(null);
								}}
								aria-pressed={selectedSpendOption === 'challenge_complete'}
								className={`w-full rounded-2xl border bg-zinc-900/80 p-4 space-y-2 text-left transition-all ${selectedSpendOption === 'challenge_complete' ? 'border-emerald-500 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]' : 'border-zinc-800'}`}>
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-bold">Комплетирај предизвик</p>
										<p className="text-xs text-zinc-400">Плати поени и означи еден некомплетиран предизвик како завршен.</p>
									</div>
								</div>

								{challengeSpendOptions.length > 0 ? (
									<select
										value={selectedChallengeKey ?? ''}
										onChange={e => setSelectedChallengeKey(e.target.value || null)}
										className="w-full mt-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3 pr-10 py-2 text-sm text-zinc-100">
										{challengeSpendOptions.map(option => (
											<option key={option.key} value={option.key}>
												{option.sectionLabel}: {option.title} ({option.cost} поени)
											</option>
										))}
									</select>
								) : (
									<p className="text-xs text-zinc-500">Нема некомплетирани предизвици за купување.</p>
								)}
							</button>

							<button
								type="button"
								onClick={() => {
									setSelectedSpendOption('challenge_swap');
									if (!selectedSwapKey) {
										setSelectedSwapKey(challengeSwapOptions[0]?.key ?? null);
									}
									setSelectedChallengeKey(null);
									setSpendFeedback(null);
								}}
								aria-pressed={selectedSpendOption === 'challenge_swap'}
								className={`w-full rounded-2xl border bg-zinc-900/80 p-4 space-y-2 text-left transition-all ${selectedSpendOption === 'challenge_swap' ? 'border-emerald-500 shadow-[0_0_0_1px_rgba(16,185,129,0.45)]' : 'border-zinc-800'}`}>
								<div className="flex items-center justify-between gap-3">
									<div>
										<p className="text-sm font-bold">Смени предизвик</p>
										<p className="text-xs text-zinc-400">Замени активен предизвик со случаен друг од истата група.</p>
									</div>
								</div>

								{challengeSwapOptions.length > 0 ? (
									<select
										value={selectedSwapKey ?? ''}
										onChange={e => setSelectedSwapKey(e.target.value || null)}
										className="w-full mt-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3 pr-10 py-2 text-sm text-zinc-100">
										{challengeSwapOptions.map(option => (
											<option key={option.key} value={option.key}>
												{option.sectionLabel}: {option.title} (случаен нов предизвик, {option.cost} поени)
											</option>
										))}
									</select>
								) : (
									<p className="text-xs text-zinc-500">Нема достапни предизвици за замена во моментот.</p>
								)}
							</button>

							<button
								onClick={() => {
									if (selectedSpendOption === 'streak_restore') {
										void handleStreakRestorePurchase();
									}
									if (selectedSpendOption === 'challenge_complete') {
										void handleChallengeCompletionPurchase();
									}
									if (selectedSpendOption === 'challenge_swap') {
										void handleChallengeSwapPurchase();
									}
								}}
								disabled={!canBuySelectedOption}
								className="w-full mt-1 rounded-xl py-2.5 font-bold text-sm bg-emerald-500 text-black disabled:bg-zinc-800 disabled:text-zinc-500 disabled:cursor-not-allowed transition-colors">
								{isPurchasingRestore ? 'Се процесира...' : 'Купи'}
							</button>

						</div>
					</motion.div>
				</motion.div>
			)}
		</AnimatePresence>
		</>
	);
}
