import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Crown, ChevronLeft, Lock, Check, X,
  Sparkles, Camera, Flame, ScanLine, Palette
} from 'lucide-react';
import { cn } from '../utils/cn';
// InfoModal import removed
import type { Profile, ViewType } from '../types';

interface FeatureItem {
  icon: React.ElementType;
  title: string;
  description: string;
  color: string;
  bg: string;
  border: string;
  action?: ViewType;
}

const FEATURES: FeatureItem[] = [
  {
    icon: ScanLine,
    title: 'Скенирање преку баркод',
    description: 'Скенирај баркод на производ и автоматски додај ги макроата и калориите.',
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20',
  },
  {
    icon: Sparkles,
    title: 'AI план за исхрана',
    description: 'Автоматски генерирај 7-дневен план за исхрана според твојата цел.',
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    action: 'mealplan' as ViewType,
  },
  {
    icon: Camera,
    title: 'Фотографии за прогрес',
    description: 'Документирај ја трансформацијата со датумски фотографии на телото.',
    color: 'text-pink-400',
    bg: 'bg-pink-500/10',
    border: 'border-pink-500/20',
  },
  {
    icon: Flame,
    title: 'Предизвици, значки и нивоа',
    description: 'Остварувај цели, освојувај значки, одржувај стрик и напредувај низ нивоата.',
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
  },
  {
    icon: Palette,
    title: 'Теми',
    description: 'Отклучи и менувај визуелни теми за персонализиран изглед на апликацијата.',
    color: 'text-emerald-400',
    bg: 'bg-emerald-500/10',
    border: 'border-emerald-500/20',
  },
];

interface Props {
  profile: Profile | null;
  setView: (v: ViewType) => void;
  onSubscribe: (plan: SubscriptionPlan) => Promise<void>;
  isTrialEligible: boolean;
  // Only provided on iOS — App Review (3.1.1) requires a visible restore-purchases affordance.
  onRestorePurchases?: () => Promise<{ restored: boolean; message: string }>;
}

interface SubscriptionPlan {
  id: 'trial-7-days' | 'monthly' | 'half-yearly' | 'yearly';
  title: string;
  months: number;
  priceMKD: number;
  perMonthMKD: number;
  subtitle: string;
  savingsText?: string;
  badgeText?: string;
  isTrial?: boolean;
}

const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
  {
    id: 'trial-7-days',
    title: '7 дена пробен период',
    months: 1,
    priceMKD: 0,
    perMonthMKD: 0,
    subtitle: '0 МКД денес, наплата на почеток на 8-миот ден (1 месец)',
    badgeText: 'FREE TRIAL',
    isTrial: true,
  },
  {
    id: 'monthly',
    title: '1 месец',
    months: 1,
    priceMKD: 300,
    perMonthMKD: 300,
    subtitle: 'Еднократна месечна наплата',
  },
  {
    id: 'half-yearly',
    title: '6 месеци',
    months: 6,
    priceMKD: 1500,
    perMonthMKD: 250,
    subtitle: 'Наплата на секои 6 месеци',
    savingsText: 'Заштеди 16.44%',
  },
  {
    id: 'yearly',
    title: '1 година',
    months: 12,
    priceMKD: 2400,
    perMonthMKD: 200,
    subtitle: 'Најдобра вредност за 12 месеци',
    savingsText: 'Заштеди 33.11%',
    badgeText: 'Best Seller',
  },
];

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

function formatCardNumber(value: string): string {
  const digits = digitsOnly(value).slice(0, 16);
  const chunks = digits.match(/.{1,4}/g);
  return chunks ? chunks.join(' ') : '';
}

function formatExpiry(value: string): string {
  const digits = digitsOnly(value).slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function getTrialDaysLeft(trialEndsAt?: string): number {
  if (!trialEndsAt) return 0;
  const end = new Date(trialEndsAt).getTime();
  const now = Date.now();
  const msLeft = end - now;
  if (msLeft <= 0) return 0;
  return Math.ceil(msLeft / (1000 * 60 * 60 * 24));
}

function formatSubscriptionDate(dateIso?: string): string | null {
  if (!dateIso) return null;
  const parsed = new Date(dateIso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('mk-MK', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function getSubscriptionActiveDays(startIso?: string): number | null {
  if (!startIso) return null;
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return null;
  const diffMs = Date.now() - start.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24)) + 1;
}

export default function SubscriptionView({ profile, setView, onSubscribe, isTrialEligible, onRestorePurchases }: Props) {
  // Info modal state removed
  const isPremium = profile?.isPremium ?? false;
  const [restoreStatus, setRestoreStatus] = useState<'idle' | 'loading'>('idle');
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);
  const isTrialing = profile?.subscriptionStatus === 'trialing';
  const trialDaysLeft = getTrialDaysLeft(profile?.subscriptionTrialEndsAt);
  const subscriptionStartDate = formatSubscriptionDate(profile?.subscriptionStartedAt);
  const subscriptionExpiresDate = formatSubscriptionDate(profile?.subscriptionExpiresAt);
  const nextChargeDate = formatSubscriptionDate(profile?.subscriptionNextChargeAt);
  const activeSubscriptionDays = getSubscriptionActiveDays(profile?.subscriptionStartedAt);
  const subscriptionStatusLabel =
    profile?.subscriptionStatus === 'trialing' ? 'Пробен период' :
    profile?.subscriptionStatus === 'active' ? 'Активна претплата' :
    profile?.subscriptionStatus === 'expired' ? 'Истечена претплата' : 'Premium';
  const ctaRef = useRef<HTMLDivElement>(null);
  const [showPlansModal, setShowPlansModal] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState<SubscriptionPlan['id']>('monthly');
  const [isSubmittingPlan, setIsSubmittingPlan] = useState(false);
  const [subscribeError, setSubscribeError] = useState<string | null>(null);

  const availablePlans = SUBSCRIPTION_PLANS.filter(plan => {
    if (plan.id === 'trial-7-days') return isTrialEligible;
    if (plan.id === 'monthly') return !isTrialEligible;
    return true;
  });

  useEffect(() => {
    if (!(showPlansModal && !isPremium)) return;

    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, [showPlansModal, isPremium]);

  useEffect(() => {
    if (availablePlans.some(plan => plan.id === selectedPlanId)) return;
    setSelectedPlanId(availablePlans[0]?.id ?? 'monthly');
  }, [availablePlans, selectedPlanId]);

  const selectedPlan = availablePlans.find(plan => plan.id === selectedPlanId) ?? availablePlans[0];

  const handleLockedFeatureClick = () => {
    ctaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleRestorePurchases = async () => {
    if (!onRestorePurchases || restoreStatus === 'loading') return;
    setRestoreStatus('loading');
    setRestoreMessage(null);
    try {
      const result = await onRestorePurchases();
      setRestoreMessage(result.message);
    } catch (error) {
      setRestoreMessage(error instanceof Error && error.message
        ? error.message
        : 'Настана проблем при обновување. Обиди се повторно.');
    } finally {
      setRestoreStatus('idle');
    }
  };

  const handleSubscribe = async () => {
    if (isSubmittingPlan) return;
    setIsSubmittingPlan(true);
    setSubscribeError(null);
    try {
      await onSubscribe(selectedPlan);
      setShowPlansModal(false);
    } catch (error) {
      if (error instanceof Error && error.message) {
        setSubscribeError(error.message);
      } else {
        setSubscribeError('Настана проблем при активирање. Обиди се повторно.');
      }
    } finally {
      setIsSubmittingPlan(false);
    }
  };

  return (
    <>
      <motion.div
        key="subscription"
        initial={{ opacity: 0, x: 20 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: -20 }}
        className="px-6 pt-10 pb-36 safe-area-pt overflow-y-auto"
        style={{ minHeight: '100dvh' }}
      >
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button onClick={() => setView('dashboard')} className="p-2 bg-zinc-900 rounded-xl">
            <ChevronLeft size={20} />
          </button>
          <h2 className="text-xl font-bold">Претплата</h2>
        </div>

        {/* Hero Banner */}
        <div className="relative rounded-[28px] overflow-hidden mb-8 bg-gradient-to-br from-amber-500/20 via-yellow-500/10 to-zinc-900 border border-amber-500/30 p-7">
          <div className="absolute top-0 right-0 w-40 h-40 bg-amber-500/10 rounded-full -translate-y-10 translate-x-10 blur-2xl" />
          <div className="relative">
            <div className="w-14 h-14 bg-amber-500/20 rounded-2xl flex items-center justify-center mb-4 border border-amber-500/30">
              <Crown size={28} className="text-amber-400" />
            </div>
            {isPremium ? (
              <>
                <div className="inline-flex items-center gap-2 bg-amber-500/20 border border-amber-500/40 rounded-full px-3 py-1 mb-3">
                  <div className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
                  <span className="text-xs font-bold text-amber-400 uppercase tracking-wider">Активна претплата</span>
                </div>
                <h3 className="text-2xl font-bold mb-1">МојФит Premium</h3>
                <p className="text-zinc-400 text-sm">Имаш пристап до сите premium функции.</p>
                <div className="mt-4 bg-black/30 border border-amber-500/25 rounded-2xl p-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] uppercase tracking-wider text-zinc-400">Статус на претплата</p>
                  </div>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-zinc-500">План</span>
                      <span className="text-zinc-100 font-semibold text-right">{profile?.subscriptionPlanTitle || 'Premium'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-zinc-500">Активна од</span>
                      <span className="text-zinc-100 font-semibold text-right">{subscriptionStartDate || '-'}</span>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-2xl font-bold mb-2">МојФит Premium</h3>
                <p className="text-zinc-400 text-sm leading-relaxed">
                  Отклучи ги сите напредни функции и достигни ги своите цели побрзо.
                </p>
              </>
            )}
          </div>
        </div>

        {/* Features */}
        <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-4 px-1">
          {isPremium ? 'Твои функции' : 'Вклучено во Premium'}
        </h3>

        <div className="space-y-3 mb-8">
          {FEATURES.map((f, i) => {
            const Icon = f.icon;
            return (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.06 }}
                className={cn(
                  'relative flex items-center gap-4 p-4 bg-zinc-900 rounded-2xl border transition-all select-none',
                  !isPremium ? 'border-zinc-800 cursor-pointer' : cn('border', f.border),
                )}
                onClick={!isPremium ? handleLockedFeatureClick : undefined}
                role={!isPremium ? 'button' : undefined}
                tabIndex={!isPremium ? 0 : undefined}
              >
                <div className={cn('w-11 h-11 rounded-xl flex items-center justify-center shrink-0', f.bg)}>
                  <Icon size={22} className={f.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className={cn('font-semibold text-sm', !isPremium && 'text-zinc-400')}>{f.title}</p>
                  <p className="text-xs text-zinc-600 mt-0.5 leading-relaxed">{f.description}</p>
                </div>
                {isPremium ? (
                  <div className="w-7 h-7 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                    <Check size={14} className="text-emerald-400" />
                  </div>
                ) : (
                  <Lock size={16} className="text-zinc-600 shrink-0" />
                )}
              </motion.div>
            );
          })}
          {/* Info Modal removed */}
        </div>

        {/* CTA / Status */}
        {!isPremium && (
          <div ref={ctaRef} className="bg-gradient-to-br from-amber-500/15 to-zinc-900 border border-amber-500/30 rounded-[24px] p-6">
            <div className="text-center mb-5">
              <p className="text-3xl font-black mb-1">
                Premium <span className="text-lg font-bold text-zinc-400">планови</span>
              </p>
              <p className="text-xs text-zinc-500">Одбери план што ти одговара</p>
            </div>
            <button
              onClick={() => setShowPlansModal(true)}
              className="w-full py-4 bg-amber-500 hover:bg-amber-400 active:scale-95 text-black font-bold text-base rounded-2xl transition-all flex items-center justify-center gap-2"
            >
              <Crown size={20} />
              Претплати се
            </button>
          </div>
        )}

        {onRestorePurchases && (
          <div className="mt-5 text-center">
            <button
              onClick={handleRestorePurchases}
              disabled={restoreStatus === 'loading'}
              className="text-xs font-semibold text-zinc-400 hover:text-zinc-200 disabled:opacity-60 underline underline-offset-2"
            >
              {restoreStatus === 'loading' ? 'Се обновува...' : 'Обнови претплата (Restore Purchases)'}
            </button>
            {restoreMessage && (
              <p className="mt-2 text-xs text-zinc-500">{restoreMessage}</p>
            )}
          </div>
        )}
      </motion.div>

      <AnimatePresence>
        {showPlansModal && !isPremium && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] bg-black/75 backdrop-blur-sm px-4 py-8 flex items-center justify-center"
            onClick={() => !isSubmittingPlan && setShowPlansModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.98 }}
              transition={{ type: 'spring', stiffness: 220, damping: 22 }}
              className="w-full max-w-md max-h-[90dvh] overflow-y-auto bg-zinc-950 border border-zinc-800 rounded-3xl p-5"
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-lg font-bold">Одбери претплата</h3>
                  <p className="text-xs text-zinc-500 mt-0.5">Избери план и продолжи со активирање.</p>
                </div>
                <button
                  onClick={() => setShowPlansModal(false)}
                  disabled={isSubmittingPlan}
                  className="w-9 h-9 rounded-xl bg-zinc-900 text-zinc-400 flex items-center justify-center"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="space-y-3">
                {availablePlans.map(plan => {
                  const isSelected = selectedPlanId === plan.id;
                  return (
                    <button
                      key={plan.id}
                      onClick={() => setSelectedPlanId(plan.id)}
                      className={cn(
                        'w-full text-left rounded-2xl p-4 border transition-all relative overflow-hidden',
                        isSelected ? 'border-emerald-400 bg-emerald-500/10' : 'border-zinc-800 bg-zinc-900/80',
                      )}
                    >
                      {plan.badgeText && (
                        <span className="absolute top-0 right-0 text-[10px] font-black uppercase tracking-wider bg-emerald-400 text-black px-3 py-1 rounded-bl-xl">
                          {plan.badgeText}
                        </span>
                      )}
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-bold text-white">{plan.title}</p>
                          <p className="text-xs text-zinc-400 mt-1">{plan.subtitle}</p>
                        </div>
                        <div className="text-right mt-2">
                          {plan.isTrial ? (
                            <>
                              <p className="text-2xl font-black text-white leading-none">0 <span className="text-xs font-bold text-zinc-400">МКД денес</span></p>
                              <p className="text-xs text-zinc-500 mt-1">Потоа 300 МКД/месец</p>
                            </>
                          ) : (
                            <>
                              <p className="text-2xl font-black text-white leading-none">{plan.perMonthMKD} <span className="text-xs font-bold text-zinc-400">МКД/мес</span></p>
                              <p className="text-xs text-zinc-500 mt-1">Вкупно {plan.priceMKD} МКД</p>
                            </>
                          )}
                        </div>
                      </div>
                      {plan.savingsText && (
                        <div className="mt-3 inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 px-2.5 py-1 text-[11px] font-bold">
                          {plan.savingsText}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={handleSubscribe}
                disabled={isSubmittingPlan}
                className="mt-5 w-full py-4 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-black font-bold text-base rounded-2xl transition-all flex items-center justify-center gap-2"
              >
                <Crown size={19} />
                {isSubmittingPlan
                  ? 'Се активира...'
                  : selectedPlan.isTrial
                    ? 'Започни 7 дена пробен период'
                    : `Претплати се • ${selectedPlan.priceMKD} МКД`}
              </button>
              {subscribeError && (
                <p className="mt-3 text-xs text-rose-300 text-center">{subscribeError}</p>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
