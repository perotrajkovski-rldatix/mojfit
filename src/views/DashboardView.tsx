import React, { useMemo } from 'react';
import { Plus, Utensils, Trash2, ChevronLeft, ChevronRight, Sparkles, Trophy, Flame } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';
import { cn } from '../utils/cn';
import { getWeekDays, isToday, localDateStr } from '../utils/dashboardDate';
import { MK_MONTHS, MK_DAYS_SHORT } from '../data/foods';
import type { Profile, Meal, ViewType } from '../types';

interface MacroTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface Props {
  profile: Profile | null;
  meals: Meal[];
  planDayTargets?: MacroTargets | null;
  dayCalorieProgressByDate?: Record<string, number>;
  streakFlameDates?: Set<string>;
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  calendarViewDate: Date;
  setCalendarViewDate: (d: Date) => void;
  showMonthCalendar: boolean;
  setShowMonthCalendar: (v: boolean) => void;
  setView: (v: ViewType) => void;
  setSelectedMealType: (t: string) => void;
  deleteMeal: (id: string) => void;
}

export default function DashboardView({
  profile, meals,
  planDayTargets,
  dayCalorieProgressByDate,
  streakFlameDates,
  selectedDate, setSelectedDate,
  calendarViewDate, setCalendarViewDate,
  showMonthCalendar, setShowMonthCalendar,
  setView, setSelectedMealType, deleteMeal,
}: Props) {

  const getCalendarDayColorClass = (percent: number): string => {
    if (percent <= 0) return '';
    if (percent <= 20) return 'bg-red-500 text-white';
    if (percent <= 40) return 'bg-orange-500 text-black';
    if (percent <= 60) return 'bg-yellow-400 text-black';
    if (percent <= 80) return 'bg-lime-400 text-black';
    return 'bg-emerald-500 text-black';
  };

  const totals = useMemo(() => {
    return meals.reduce(
      (acc, meal) => {
        meal.items.forEach(item => {
          if (item.food) {
            acc.calories += (item.food.calories || 0) * item.amount;
            acc.protein += (item.food.protein || 0) * item.amount;
            acc.carbs += (item.food.carbs || 0) * item.amount;
            acc.fat += (item.food.fat || 0) * item.amount;
          }
        });
        return acc;
      },
      { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );
  }, [meals]);

  const isPremium = profile?.isPremium ?? false;
  const activePlanTargets = isPremium ? planDayTargets : null;
  const targetCalories = activePlanTargets?.calories ?? profile?.targetCalories ?? 0;
  const targetProtein = activePlanTargets?.protein ?? profile?.targetProtein ?? 0;
  const targetCarbs = activePlanTargets?.carbs ?? profile?.targetCarbs ?? 0;
  const targetFat = activePlanTargets?.fat ?? profile?.targetFat ?? 0;


  const weekDays = getWeekDays();
  const todayStr = localDateStr(new Date());
  const canEditMealsForSelectedDate = selectedDate === todayStr;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="px-6 pt-10 safe-area-pt space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => { setCalendarViewDate(new Date(selectedDate)); setShowMonthCalendar(!showMonthCalendar); }}
          className="text-3xl font-bold tracking-tight text-left hover:text-emerald-500 transition-colors"
        >
          {isToday(new Date(selectedDate))
            ? 'Денес'
            : `${new Date(selectedDate).getDate()} ${MK_MONTHS[new Date(selectedDate).getMonth()]}`}
        </button>
        {profile?.isPremium && (
          <button
            onClick={() => setView('challenges')}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 transition-all text-black font-bold text-xs"
          >
            <Trophy size={14} />
            Предизвици
          </button>
        )}
      </div>

      {/* Week day picker */}
      <div className="relative">
        <div className="flex justify-between items-center overflow-x-auto no-scrollbar gap-2 py-2">
          {weekDays.map((day, i) => {
            const dateStr = localDateStr(day);
            const isActive = selectedDate === dateStr;
            const isFuture = dateStr > localDateStr(new Date());
            return (
              <button
                key={i}
                onClick={() => !isFuture && setSelectedDate(dateStr)}
                disabled={isFuture}
                className={cn(
                  'flex flex-col items-center min-w-[50px] py-3 rounded-2xl border transition-all',
                  isActive ? 'bg-emerald-500 border-emerald-500 text-black' : 'bg-zinc-900/50 border-zinc-800 text-zinc-500',
                  isFuture && 'opacity-30 cursor-not-allowed',
                )}
              >
                <span className="text-[10px] uppercase font-bold mb-1">{MK_DAYS_SHORT[day.getDay()]}</span>
                <span className="text-lg font-bold">{day.getDate()}</span>
              </button>
            );
          })}
        </div>
        {/* Month calendar overlay */}
        <AnimatePresence>
          {showMonthCalendar && (
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => setShowMonthCalendar(false)} />
              {(() => {
                const year = calendarViewDate.getFullYear();
                const month = calendarViewDate.getMonth();
                const daysInMonth = new Date(year, month + 1, 0).getDate();
                const firstDay = new Date(year, month, 1).getDay();
                const days: React.ReactNode[] = [];
                for (let i = 0; i < firstDay; i++) days.push(<div key={`e-${i}`} className="p-2" />);
                const todayStr = localDateStr(new Date());
                for (let i = 1; i <= daysInMonth; i++) {
                  const d = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
                  const isFuture = d > todayStr;
                  const dayProgress = dayCalorieProgressByDate?.[d] ?? 0;
                  const dayColorClass = getCalendarDayColorClass(dayProgress);
                  const showFlame = !!profile?.isPremium && (streakFlameDates?.has(d) ?? false);
                  days.push(
                    <button
                      key={i}
                      disabled={isFuture}
                      onClick={() => { if (isFuture) return; setSelectedDate(d); setCalendarViewDate(new Date(year, month, i, 12)); setShowMonthCalendar(false); }}
                      className={cn(
                        'relative p-2 rounded-lg text-sm transition-colors',
                        selectedDate === d && 'font-bold ring-2 ring-emerald-500/70',
                        dayColorClass || 'text-zinc-300',
                        !dayColorClass && selectedDate !== d && 'hover:bg-zinc-800',
                        !dayColorClass && selectedDate === d && 'bg-zinc-800',
                        isFuture && 'opacity-25 cursor-not-allowed',
                      )}
                    >
                      {i}
                      {showFlame && (
                        <motion.span
                          aria-hidden="true"
                          className="absolute -top-1 -right-1 text-orange-400 drop-shadow-[0_0_6px_rgba(251,146,60,0.75)]"
                          animate={{ y: [0, -2, 0], scale: [1, 1.12, 1], opacity: [0.85, 1, 0.85] }}
                          transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
                        >
                          <Flame size={16} fill="currentColor" />
                        </motion.span>
                      )}
                    </button>,
                  );
                }
                return (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="absolute top-0 left-0 right-0 bg-zinc-900 border border-zinc-800 rounded-3xl p-6 z-[100] shadow-2xl"
                  >
                    <div className="flex justify-between items-center mb-6">
                      <button onClick={() => setCalendarViewDate(new Date(year, month - 1, 1))} className="p-2 text-emerald-500 hover:bg-emerald-500/10 rounded-full transition-colors"><ChevronLeft size={20} /></button>
                      <h3 className="font-bold text-lg">{MK_MONTHS[month]} {year}</h3>
                      <button onClick={() => { const next = new Date(year, month + 1, 1); if (next <= new Date()) setCalendarViewDate(next); }} className={cn('p-2 rounded-full transition-colors', new Date(year, month + 1, 1) <= new Date() ? 'text-emerald-500 hover:bg-emerald-500/10' : 'text-zinc-700 cursor-not-allowed')}><ChevronRight size={20} /></button>
                    </div>
                    <div className="grid grid-cols-7 gap-1 text-center mb-4">
                      {MK_DAYS_SHORT.map((d, i) => <span key={i} className="text-[10px] text-zinc-500 uppercase font-bold">{d}</span>)}
                    </div>
                    <div className="grid grid-cols-7 gap-1">{days}</div>
                  </motion.div>
                );
              })()}
            </>
          )}
        </AnimatePresence>
      </div>

      {/* Calorie Card */}
      <div className="bg-zinc-900 rounded-[32px] p-8 relative overflow-hidden">
        <div className="relative z-10">
          <h3 className="text-zinc-400 text-sm mb-1">Преостанати калории</h3>
          <div className="flex items-baseline gap-2 mb-4">
            <span className={`text-5xl font-bold tracking-tighter ${(targetCalories - totals.calories) < 0 ? 'text-red-500' : ''}`}>
              {(targetCalories - totals.calories) < 0
                ? `+${Math.abs(Math.round(targetCalories - totals.calories))}`
                : Math.round(targetCalories - totals.calories)}
            </span>
            <span className="text-zinc-500">kcal</span>
          </div>
          <div className="w-full bg-zinc-800 h-2 rounded-full mb-6">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(100, (totals.calories / (targetCalories || 1)) * 100)}%` }}
              className={`${totals.calories > targetCalories ? 'bg-red-500' : 'bg-emerald-500'} h-full rounded-full`}
            />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <p className="text-[10px] uppercase text-zinc-500 mb-1">Калории</p>
              <p className="text-sm font-bold text-white">{Math.round(targetCalories)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500 mb-1 text-emerald-500">Протеин</p>
              <p className="text-sm font-bold text-emerald-500">{Math.round(targetProtein)}г</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500 mb-1 text-blue-500">Јаглех.</p>
              <p className="text-sm font-bold text-blue-500">{Math.round(targetCarbs)}г</p>
            </div>
            <div>
              <p className="text-[10px] uppercase text-zinc-500 mb-1 text-amber-500">Масти</p>
              <p className="text-sm font-bold text-amber-500">{Math.round(targetFat)}г</p>
            </div>
          </div>
        </div>
      </div>

      {/* Macros Card */}
      <div className="bg-zinc-900 rounded-[32px] p-6">
        <h3 className="text-lg font-semibold mb-6">Нутриенти</h3>
        <div className="flex justify-between items-center">
          {[
            { label: 'Протеини', val: totals.protein, target: targetProtein, color: '#10b981' },
            { label: 'Јаглехидрати', val: totals.carbs, target: targetCarbs, color: '#3b82f6' },
            { label: 'Масти', val: totals.fat, target: targetFat, color: '#f59e0b' },
          ].map(m => (
            <div key={m.label} className="flex flex-col items-center">
              <div className="w-16 h-16 relative mb-2">
                <ResponsiveContainer width={64} height={64} minWidth={0} minHeight={0}>
                  <PieChart>
                    <Pie
                      data={[{ value: m.val }, { value: Math.max(0, (m.target || 0) - m.val) }]}
                      innerRadius={24} outerRadius={30} paddingAngle={0} dataKey="value"
                      startAngle={90} endAngle={-270}
                    >
                      <Cell fill={m.color} />
                      <Cell fill="#27272a" />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] font-bold">{Math.round(m.val)}г</span>
                </div>
              </div>
              <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{m.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Premium actions */}
      {profile?.isPremium && isToday(new Date(selectedDate)) && (
        <div className="mt-4">
          <button
            className="w-full flex items-center justify-center gap-2 py-4 bg-purple-600 hover:bg-purple-500 active:scale-95 text-white font-bold text-base rounded-2xl transition-all"
            onClick={() => setView('mealplan')}
          >
            <Sparkles size={20} className="text-amber-300" />
            План за исхрана
          </button>
        </div>
      )}

      {/* Meals List */}
      <div className="space-y-3 relative">
        {['breakfast', 'lunch', 'dinner', 'snack'].map(type => {
          const mealName = type === 'breakfast' ? 'Појадок' : type === 'lunch' ? 'Ручек' : type === 'dinner' ? 'Вечера' : 'Ужина';
          const typeMeals = meals.filter(m => m.type === type);
          const allItems = typeMeals.flatMap(m => m.items);
          const mealCals = allItems.reduce((sum, i) => sum + (i.food?.calories || 0) * i.amount, 0);

          return (
            <div key={type} className="space-y-2">
              <div className="bg-zinc-900/50 rounded-2xl p-4 flex justify-between items-center border border-zinc-900 relative">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-10 bg-zinc-900 rounded-xl flex items-center justify-center text-zinc-400">
                    <Utensils size={20} />
                  </div>
                  <div>
                    <h4 className="font-medium">{mealName}</h4>
                    <p className="text-xs text-zinc-500">{mealCals > 0 ? `${Math.round(mealCals)} kcal` : 'Додади оброк'}</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (!canEditMealsForSelectedDate) return;
                    setSelectedMealType(type);
                    setView('search');
                  }}
                  disabled={!canEditMealsForSelectedDate}
                  className={cn(
                    'w-8 h-8 rounded-full flex items-center justify-center transition-transform',
                    canEditMealsForSelectedDate
                      ? 'bg-emerald-500 text-black active:scale-90'
                      : 'bg-zinc-800 text-zinc-600 cursor-not-allowed',
                  )}
                >
                  <Plus size={20} />
                </button>

              </div>
              {typeMeals.map(meal =>
                meal.items.map((item, idx) => (
                  <div key={`${meal.id}-${idx}`} className="ml-4 bg-zinc-900/30 p-3 rounded-xl flex justify-between items-center border border-zinc-900/50 group">
                    <div className="flex-1">
                      <p className="text-sm font-medium">{item.food?.name || 'Непозната храна'}</p>
                      <p className="text-[10px] text-zinc-500 uppercase font-bold">
                        {Math.round(item.amount * 100)}{item.food?.portionUnit === 'ml' ? 'мл' : 'г'} • {Math.round((item.food?.calories || 0) * item.amount)} kcal
                      </p>
                      <div className="flex gap-2 text-[10px] font-bold text-zinc-600 mt-1">
                        <span>П: {Math.round((item.food?.protein || 0) * item.amount)}г</span>
                        <span>Ј: {Math.round((item.food?.carbs || 0) * item.amount)}г</span>
                        <span>М: {Math.round((item.food?.fat || 0) * item.amount)}г</span>
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        if (!canEditMealsForSelectedDate) return;
                        deleteMeal(meal.id);
                      }}
                      disabled={!canEditMealsForSelectedDate}
                      className={cn(
                        'p-2 transition-colors',
                        canEditMealsForSelectedDate ? 'text-red-500 active:scale-90' : 'text-zinc-700 cursor-not-allowed',
                      )}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                )),
              )}
            </div>
          );
        })}
      </div>

    </motion.div>
  );
}
