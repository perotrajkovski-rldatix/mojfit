import React from 'react';
import { Check, Camera } from 'lucide-react';
import { motion } from 'motion/react';
import { LineChart, Line, XAxis, YAxis, Tooltip as RechartsTooltip, CartesianGrid, ResponsiveContainer } from 'recharts';
import { Input } from '../components/Input';
import type { WeightLog, ViewType } from '../types';

interface Props {
  weightHistory: WeightLog[];
  todayWeight: string;
  setTodayWeight: (v: string) => void;
  authError: string | null;
  logWeight: (w: number) => void;
  isPremium: boolean;
  setView: (v: ViewType) => void;
}

export default function WeightView({ weightHistory, todayWeight, setTodayWeight, authError, logWeight, isPremium, setView }: Props) {
  const today = new Date();
  const alreadyLoggedToday = weightHistory.some(log => {
    const logDate = new Date(log.date);
    return logDate.getFullYear() === today.getFullYear()
      && logDate.getMonth() === today.getMonth()
      && logDate.getDate() === today.getDate();
  });

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="px-6 pt-10 space-y-6 safe-area-pt"
    >
      <h2 className="text-2xl font-bold">Следење тежина</h2>

      <div className="bg-zinc-900 rounded-[32px] p-6">
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height={256}>
            <LineChart data={weightHistory} margin={{ top: 20, right: 20, left: -20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#18181b" vertical={false} />
              <XAxis
                dataKey="date"
                stroke="#52525b"
                fontSize={10}
                tickFormatter={val => new Date(val).toLocaleDateString('mk-MK', { month: 'short', day: 'numeric' })}
              />
              <YAxis
                stroke="#52525b"
                fontSize={10}
                domain={['dataMin - 2', 'dataMax + 2']}
                label={{ value: 'кг', angle: -90, position: 'insideLeft', fill: '#52525b', fontSize: 10 }}
              />
              <RechartsTooltip
                contentStyle={{ backgroundColor: '#18181b', border: 'none', borderRadius: '12px', fontSize: '12px' }}
                itemStyle={{ color: '#10b981' }}
                labelFormatter={val => new Date(val).toLocaleDateString('mk-MK', { day: 'numeric', month: 'long', year: 'numeric' })}
              />
              <Line
                type="monotone"
                dataKey="weight"
                stroke="#10b981"
                strokeWidth={3}
                dot={{ fill: '#10b981', strokeWidth: 2, r: 4 }}
                activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {!alreadyLoggedToday && (
        <div className="bg-zinc-900 rounded-3xl p-6">
          <h4 className="text-sm text-zinc-500 mb-4">Внеси денешна тежина</h4>
          <div className="flex gap-2">
            <Input
              type="number"
              placeholder="кг"
              value={todayWeight}
              onChange={e => setTodayWeight(e.target.value)}
            />
            <button
              onClick={() => logWeight(Number(todayWeight))}
              className="bg-emerald-500 text-black px-6 rounded-xl font-bold"
            >
              <Check size={20} />
            </button>
          </div>
          {authError && (
            <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="mt-3 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
              {authError}
            </motion.div>
          )}
        </div>
      )}

      {isPremium && (
        <button
          onClick={() => setView('progress-photos')}
          className="w-full flex items-center justify-center gap-2 py-4 bg-cyan-600 hover:bg-cyan-500 active:scale-95 text-white font-bold text-base rounded-2xl transition-all"
        >
          <Camera size={20} className="text-cyan-100" />
          Фотографии за прогрес
        </button>
      )}

      <div className="space-y-2">
        {weightHistory.slice().reverse().map((log, i) => (
          <div key={i} className="flex justify-between items-center p-4 bg-zinc-900/30 rounded-xl">
            <span className="text-zinc-400">{new Date(log.date).toLocaleDateString('mk-MK')}</span>
            <span className="font-bold">{log.weight} кг</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
